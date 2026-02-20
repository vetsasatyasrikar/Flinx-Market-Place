const functions = require('firebase-functions');
const admin = require('firebase-admin');

// Initialize admin SDK
admin.initializeApp();

// Stripe setup: Use functions config to store secrets:
// ---------------------------
// Notification helpers (SendGrid email + Twilio SMS)
// Configure using functions config:
// firebase functions:config:set sendgrid.key="SG..." twilio.account_sid="..." twilio.auth_token="..." twilio.from="+123..."
// ---------------------------
const sg = (() => {
  try { return require('@sendgrid/mail'); } catch (e) { return null; }
})();
const twilioSDK = (() => {
  try { return require('twilio'); } catch (e) { return null; }
})();

const sendgridKey = functions.config().sendgrid && functions.config().sendgrid.key;
const twilioConfig = functions.config().twilio || null;
if (sg && sendgridKey) sg.setApiKey(sendgridKey);

async function sendNotificationsForPayment(paymentDoc){
  try{
    const payment = paymentDoc.data();
    const listingSnap = await admin.firestore().collection('listings').doc(payment.listingId).get();
    const listing = listingSnap.exists ? listingSnap.data() : null;

    // fetch owner and renter user docs by uid
    const usersRef = admin.firestore().collection('users');
    const ownerSnap = await usersRef.where('uid','==', payment.ownerId).limit(1).get();
    const renterSnap = await usersRef.where('uid','==', payment.renterId).limit(1).get();
    const owner = !ownerSnap.empty ? ownerSnap.docs[0].data() : null;
    const renter = !renterSnap.empty ? renterSnap.docs[0].data() : null;

    const subject = `Payment received for ${listing ? listing.title : 'your listing'}`;
    const text = `Payment of ${payment.amount} ${payment.currency} received for listing ${listing ? listing.title : payment.listingId}.\nPayment ID: ${payment.stripeSessionId||payment.razorpayPaymentId||''}`;

    // Send emails via SendGrid
    if(sg && sendgridKey){
      const msgs = [];
      if(owner && owner.email) msgs.push({ to: owner.email, from: 'no-reply@campusxchange.example', subject, text });
      if(renter && renter.email) msgs.push({ to: renter.email, from: 'no-reply@campusxchange.example', subject: 'Payment successful', text: `You paid ${payment.amount} ${payment.currency} for ${listing ? listing.title : ''}` });
      if(msgs.length) await sg.send(msgs);
    }

    // Send SMS via Twilio
    if(twilioSDK && twilioConfig && twilioConfig.account_sid && twilioConfig.auth_token && twilioConfig.from){
      const client = twilioSDK(twilioConfig.account_sid, twilioConfig.auth_token);
      if(owner && owner.phone){
        await client.messages.create({ body: `Your listing ${listing ? listing.title : ''} was paid ${payment.amount} ${payment.currency}.`, from: twilioConfig.from, to: owner.phone });
      }
      if(renter && renter.phone){
        await client.messages.create({ body: `You paid ${payment.amount} ${payment.currency} for ${listing ? listing.title : ''}.`, from: twilioConfig.from, to: renter.phone });
      }
    }

  } catch(err){ console.error('Notification error', err.message || err); }
}
// firebase functions:config:set stripe.secret="sk_test_..." stripe.webhook_secret="whsec_..."
const stripeSecret = functions.config().stripe && functions.config().stripe.secret;
const stripeWebhookSecret = functions.config().stripe && functions.config().stripe.webhook_secret;
let Stripe = null;
if (stripeSecret) {
  Stripe = require('stripe')(stripeSecret);
} else {
  console.warn('Stripe secret not configured. Set functions config: stripe.secret');
}

// Cloud Function: cleanupListingImage
// Trigger: Firestore onDelete for documents in 'listings' collection
// Purpose: When a listing is deleted, remove associated image from Firebase Storage to avoid orphaned files.
// Notes: This is server-side and more reliable than attempting client-side cleanup.
exports.cleanupListingImage = functions.firestore
  .document('listings/{listingId}')
  .onDelete(async (snap, context) => {
    const data = snap.data();
    if (!data) return null;
    const imageUrl = data.imageUrl;
    if (!imageUrl) return null;

    try {
      const match = imageUrl.match(/\/o\/([^?]+)/);
      if (!match || !match[1]) return null;
      const encodedPath = match[1];
      const filePath = decodeURIComponent(encodedPath);

      const bucket = admin.storage().bucket();
      const file = bucket.file(filePath);
      await file.delete();
      console.log('Deleted storage file:', filePath);
    } catch (err) {
      console.error('Error deleting storage file for listing:', err.message || err);
    }

    return null;
  });

// ---------------------------
// Stripe Checkout: createCheckoutSession (callable)
// - Creates a Stripe Checkout session for a listing rental payment
// - Records a payment placeholder in Firestore; final confirmation handled in webhook
// ---------------------------
exports.createCheckoutSession = functions.https.onCall(async (data, context) => {
  // Ensure authenticated
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Request not authenticated');
  if (!Stripe) throw new functions.https.HttpsError('failed-precondition', 'Stripe not configured');

  const { listingId } = data;
  if (!listingId) throw new functions.https.HttpsError('invalid-argument', 'listingId required');

  // fetch listing
  const snap = await admin.firestore().collection('listings').doc(listingId).get();
  if (!snap.exists) throw new functions.https.HttpsError('not-found', 'Listing not found');
  const listing = snap.data();

  const amount = Math.round((listing.price || 0) * 100); // convert to cents/paise based on currency

  try {
    const session = await Stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{ price_data: { currency: 'inr', product_data: { name: listing.title }, unit_amount: amount }, quantity: 1 }],
      mode: 'payment',
      success_url: `${functions.config().firebase.hosting_url || 'https://your-app.web.app'}/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${functions.config().firebase.hosting_url || 'https://your-app.web.app'}/`,
      metadata: { listingId, ownerId: listing.ownerId, renterId: context.auth.uid }
    });

    // create a payment record in Firestore with status 'created'
    await admin.firestore().collection('payments').add({
      listingId,
      ownerId: listing.ownerId,
      renterId: context.auth.uid,
      amount: listing.price || 0,
      currency: 'INR',
      stripeSessionId: session.id,
      status: 'created',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { url: session.url };
  } catch (err) {
    console.error('Stripe create session error', err);
    throw new functions.https.HttpsError('internal', 'Stripe session creation failed');
  }
});

// ---------------------------
// Stripe webhook endpoint to confirm payments
// - Use stripe.webhooks.constructEvent with raw body
// - On checkout.session.completed, mark payment record as 'paid'
// ---------------------------
exports.stripeWebhook = functions.https.onRequest(async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event = req.body;

  if (stripeWebhookSecret) {
    try {
      event = Stripe.webhooks.constructEvent(req.rawBody, sig, stripeWebhookSecret);
    } catch (err) {
      console.error('Webhook signature verification failed.', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    try {
      // find payment by stripeSessionId
      const paymentsRef = admin.firestore().collection('payments');
      const q = await paymentsRef.where('stripeSessionId', '==', session.id).limit(1).get();
      if (!q.empty) {
        const pdoc = q.docs[0];
        await pdoc.ref.update({ status: 'paid', paidAt: admin.firestore.FieldValue.serverTimestamp(), paymentIntent: session.payment_intent });
        // send notifications
        await sendNotificationsForPayment(pdoc);
      }
      // Optionally, create a rental transaction
    } catch (err) {
      console.error('Error updating payment record', err.message || err);
    }
  }

  res.json({ received: true });
});

// ---------------------------
// Razorpay support (callable)
// - createRazorpayOrder: creates a Razorpay order for a listing
// - verifyRazorpayPayment: verifies signature and updates payment record
// ---------------------------
const Razorpay = (() => {
  try {
    return require('razorpay');
  } catch (e) {
    console.warn('Razorpay SDK not installed. Set functions config and install dependencies.');
    return null;
  }
})();

const razorConfig = functions.config().razorpay || null;
let razorInstance = null;
if (Razorpay && razorConfig && razorConfig.key_id && razorConfig.key_secret) {
  razorInstance = new Razorpay({ key_id: razorConfig.key_id, key_secret: razorConfig.key_secret });
} else {
  console.warn('Razorpay not configured. Set functions config razorpay.key_id and razorpay.key_secret');
}

exports.createRazorpayOrder = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Request not authenticated');
  if (!razorInstance) throw new functions.https.HttpsError('failed-precondition', 'Razorpay not configured');

  const { listingId } = data;
  if (!listingId) throw new functions.https.HttpsError('invalid-argument', 'listingId required');

  const snap = await admin.firestore().collection('listings').doc(listingId).get();
  if (!snap.exists) throw new functions.https.HttpsError('not-found', 'Listing not found');
  const listing = snap.data();

  const amount = Math.round((listing.price || 0) * 100); // paise
  try {
    const options = {
      amount,
      currency: 'INR',
      receipt: `listing_${listingId}_${Date.now()}`,
      notes: { listingId, ownerId: listing.ownerId, renterId: context.auth.uid }
    };
    const order = await razorInstance.orders.create(options);

    // record payment
    await admin.firestore().collection('payments').add({
      listingId,
      ownerId: listing.ownerId,
      renterId: context.auth.uid,
      amount: listing.price || 0,
      currency: 'INR',
      razorpayOrderId: order.id,
      status: 'created',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { orderId: order.id, keyId: razorConfig.key_id };
  } catch (err) {
    console.error('Razorpay create order error', err);
    throw new functions.https.HttpsError('internal', 'Razorpay order creation failed');
  }
});

const crypto = require('crypto');
exports.verifyRazorpayPayment = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Request not authenticated');
  if (!razorConfig || !razorConfig.key_secret) throw new functions.https.HttpsError('failed-precondition', 'Razorpay not configured');

  const { razorpay_payment_id, razorpay_order_id, razorpay_signature } = data;
  if (!razorpay_payment_id || !razorpay_order_id || !razorpay_signature) throw new functions.https.HttpsError('invalid-argument', 'Missing payment data');

  const generated_signature = crypto.createHmac('sha256', razorConfig.key_secret).update(razorpay_order_id + '|' + razorpay_payment_id).digest('hex');
  if (generated_signature !== razorpay_signature) {
    throw new functions.https.HttpsError('permission-denied', 'Invalid signature');
  }

  // mark payment record
  const paymentsRef = admin.firestore().collection('payments');
  const q = await paymentsRef.where('razorpayOrderId', '==', razorpay_order_id).limit(1).get();
  if (!q.empty) {
    const pdoc = q.docs[0];
    await pdoc.ref.update({ status: 'paid', paidAt: admin.firestore.FieldValue.serverTimestamp(), razorpayPaymentId: razorpay_payment_id });
    // notify users
    await sendNotificationsForPayment(pdoc);
  }

  return { success: true };
});
