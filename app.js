// app.js (module)
// CampusXchange Lite - Vanilla JS single-page app using Firebase (Auth, Firestore, Storage)
// Replace the firebaseConfig object with your project's values.

// Import Firebase modular SDK from CDN
import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js';
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js';
import {
  getFirestore,
  collection,
  addDoc,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  updateDoc,
  deleteDoc,
  serverTimestamp,
  limit
} from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';
import { getStorage, ref as sref, uploadBytes, getDownloadURL } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-storage.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-functions.js';

// ---------------------------
// Firebase config (placeholders)
// ---------------------------
const firebaseConfig = {
  apiKey: 'REPLACE_API_KEY',
  authDomain: 'REPLACE_AUTH_DOMAIN',
  projectId: 'REPLACE_PROJECT_ID',
  storageBucket: 'REPLACE_STORAGE_BUCKET',
  messagingSenderId: 'REPLACE_MESSAGING_SENDER_ID',
  appId: 'REPLACE_APP_ID'
};

// Initialize Firebase services
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);
const functionsClient = getFunctions(app);
const paymentModal = new bootstrap.Modal(document.getElementById('paymentModal'));

// On app load, check for Stripe session_id in URL and show status
window.addEventListener('load', async ()=>{
  const params = new URLSearchParams(window.location.search);
  if(params.has('session_id')){
    const sessionId = params.get('session_id');
    await checkStripePaymentStatus(sessionId);
  }
});

// ---------------------------
// Helper DOM refs
// ---------------------------
const btnLogin = document.getElementById('btn-login');
const btnLogout = document.getElementById('btn-logout');
const userEmail = document.getElementById('user-email');
const statusMsg = document.getElementById('status-msg');
const loginModal = new bootstrap.Modal(document.getElementById('loginModal'));
const createModal = new bootstrap.Modal(document.getElementById('createListingModal'));
const adminModal = new bootstrap.Modal(document.getElementById('adminPanel'));
const chatModalEl = document.getElementById('chatModal');
const chatModal = new bootstrap.Modal(chatModalEl);

// Current app state
let currentUser = null; // extended user document
let pollIntervals = {};
let currentChatListing = null;

// ---------------------------
// Authentication flows
// - Restrict emails to @lpu.in domain (client + rules)
// - After registration, store a user document with hostel and role
// ---------------------------
document.getElementById('btn-login').addEventListener('click', ()=>loginModal.show());
document.getElementById('btn-logout').addEventListener('click', async ()=>{
  await signOut(auth);
});
document.getElementById('nav-profile').addEventListener('click', ()=>{
  openProfileModal();
});

const authForm = document.getElementById('auth-form');
let authMode = 'login';
document.getElementById('btn-switch-to-register').addEventListener('click', ()=>{
  authMode = 'register';
  document.getElementById('btn-auth').textContent = 'Register';
});

authForm.addEventListener('submit', async (e)=>{
  e.preventDefault();
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  const hostel = document.getElementById('auth-hostel').value;
  const phone = document.getElementById('auth-phone').value.trim();
  const emailPref = document.getElementById('auth-emailpref').checked;

  // Client-side enforcement of domain
  if(!email.endsWith('@lpu.in')){ alert('Please use your @lpu.in email'); return; }

  try{
    if(authMode === 'register'){
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      // create user doc in Firestore with phone and emailPref
      await addDoc(collection(db, 'users'), {
        uid: cred.user.uid,
        email,
        hostel,
        phone: phone || '',
        emailNotifications: !!emailPref,
        role: 'user',
        clickedCategories: [],
        createdAt: serverTimestamp()
      });
    } else {
      await signInWithEmailAndPassword(auth, email, password);
    }
    loginModal.hide();
  }catch(err){ console.error(err); alert(err.message); }
});

// Listen to auth state and load extended user doc
onAuthStateChanged(auth, async (u)=>{
  if(u){
    // fetch user doc
    const usersSnap = await getDocs(query(collection(db,'users'), where('uid','==', u.uid), limit(1)));
    if(usersSnap.empty){
      // Shouldn't happen: create minimal user record with unknown hostel
      await addDoc(collection(db, 'users'), { uid: u.uid, email: u.email, hostel: '', role: 'user', createdAt: serverTimestamp() });
    }
    const userDoc = usersSnap.docs[0] ? usersSnap.docs[0] : null;
    currentUser = userDoc ? { id: userDoc.id, ...userDoc.data() } : null;
    userEmail.textContent = u.email;
    btnLogin.classList.add('d-none');
    btnLogout.classList.remove('d-none');
    statusMsg.textContent = `Signed in as ${u.email}`;

    // show admin nav if role=admin
    if(currentUser && currentUser.role === 'admin') document.getElementById('nav-admin').classList.remove('d-none');
    else document.getElementById('nav-admin').classList.add('d-none');
    // show profile button
    document.getElementById('nav-profile').classList.remove('d-none');
    document.getElementById('nav-profile').textContent = 'Profile';

  } else {
    currentUser = null;
    userEmail.textContent = '';
    btnLogin.classList.remove('d-none');
    btnLogout.classList.add('d-none');
    statusMsg.textContent = 'Not signed in';
    document.getElementById('nav-profile').classList.add('d-none');
  }
  // refresh listing view
  loadListings();
});

// ---------------------------
// Create listing -> upload image to Storage and create Firestore doc
// Only allowed for authenticated users (client side check)
// ---------------------------
document.getElementById('listing-form').addEventListener('submit', async (e)=>{
  e.preventDefault();
  if(!auth.currentUser){ alert('Please login first'); return; }
  const title = document.getElementById('listing-title').value.trim();
  const desc = document.getElementById('listing-desc').value.trim();
  const price = parseFloat(document.getElementById('listing-price').value);
  const category = document.getElementById('listing-category').value;
  const hostel = document.getElementById('listing-hostel').value;
  const type = document.getElementById('listing-type').value;
  const file = document.getElementById('listing-image').files[0];

  try{
    let imageUrl = '';
    if(file){
      const path = `listings/${auth.currentUser.uid}/${Date.now()}_${file.name}`;
      const ref = sref(storage, path);
      await uploadBytes(ref, file);
      imageUrl = await getDownloadURL(ref);
    }

    await addDoc(collection(db, 'listings'), {
      title, description: desc, price, category, hostel, type,
      imageUrl, ownerId: auth.currentUser.uid, createdAt: serverTimestamp()
    });
    createModal.hide();
    loadListings();
  }catch(err){ console.error(err); alert(err.message); }
});

// ---------------------------
// Browse & render listings with filters + server-side pagination (Load more)
// ---------------------------
const browseEl = document.getElementById('browse');
const loadMoreBtn = document.getElementById('load-more-btn');
document.getElementById('filter-category').addEventListener('change', ()=>loadListings({ reset: true }));
document.getElementById('filter-hostel').addEventListener('change', ()=>loadListings({ reset: true }));
document.getElementById('sort-by').addEventListener('change', ()=>loadListings({ reset: true }));

const PAGE_SIZE = 9;
let lastVisible = null; // last document snapshot for pagination

loadMoreBtn.addEventListener('click', ()=> loadListings({ reset: false }));

async function loadListings({ reset = true } = { reset: true }){
  if(reset){
    browseEl.innerHTML = '<div class="text-center py-5">Loading...</div>';
    lastVisible = null;
    loadMoreBtn.disabled = false;
    loadMoreBtn.textContent = 'Load more';
  } else {
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = 'Loading...';
  }

  try{
    // base query ordered by createdAt desc
    let baseQuery = query(collection(db,'listings'), orderBy('createdAt','desc'));

    // apply simple server-side filters by building where clauses when possible
    const category = document.getElementById('filter-category').value;
    const hostel = document.getElementById('filter-hostel').value;
    const sortBy = document.getElementById('sort-by').value;

    // For scalability, prefer server-side filtering (requires appropriate indexes). We'll apply simple where clauses.
    const clauses = [];
    if(category) clauses.push(where('category','==', category));
    if(hostel) clauses.push(where('hostel','==', hostel));

    let q;
    if(clauses.length > 0){
      // build query with filters + ordering
      q = query(collection(db,'listings'), ...clauses, orderBy('createdAt','desc'), limit(PAGE_SIZE));
      if(lastVisible) q = query(collection(db,'listings'), ...clauses, orderBy('createdAt','desc'), startAfter(lastVisible), limit(PAGE_SIZE));
    } else {
      q = lastVisible ? query(collection(db,'listings'), orderBy('createdAt','desc'), startAfter(lastVisible), limit(PAGE_SIZE)) : query(collection(db,'listings'), orderBy('createdAt','desc'), limit(PAGE_SIZE));
    }

    const snap = await getDocs(q);
    const listings = snap.docs.map(d=>({ id:d.id, ...d.data(), _snap: d }));

    // If reset, replace; else append
    if(reset) browseEl.innerHTML = '';

    // Local sorting by price or recommended when necessary (applied client-side after server fetch)
    let toRender = listings.map(l=>{ delete l._snap; return l; });
    if(sortBy === 'price') toRender.sort((a,b)=> (a.price||0) - (b.price||0));
    else if(sortBy === 'recommended' && currentUser) toRender = await getRecommendedListings(currentUser, toRender);

    // render
    renderListings(toRender, { append: !reset });

    // update lastVisible for next page
    if(snap.docs.length > 0){
      lastVisible = snap.docs[snap.docs.length - 1];
      loadMoreBtn.disabled = false;
      loadMoreBtn.textContent = 'Load more';
    } else {
      // no more
      loadMoreBtn.disabled = true;
      loadMoreBtn.textContent = 'No more';
    }
  }catch(err){ console.error(err); browseEl.innerHTML = '<div class="text-danger">Failed to load</div>'; loadMoreBtn.disabled = false; loadMoreBtn.textContent = 'Load more'; }
}

function renderListings(listings, { append = false } = {}){
  if(!append) browseEl.innerHTML = '';
  if(listings.length === 0 && !append) { browseEl.innerHTML = '<div class="text-center">No listings</div>'; return; }

  listings.forEach(l=>{
    const col = document.createElement('div'); col.className='col';
    col.innerHTML = `
      <div class="card listing-card h-100 shadow-sm">
        <img src="${l.imageUrl||'https://via.placeholder.com/400x300?text=No+Image'}" class="card-img-top">
        <div class="card-body d-flex flex-column">
          <h5 class="card-title">${escapeHtml(l.title)}</h5>
          <p class="card-text small-muted">${escapeHtml(l.description||'')}</p>
          <div class="mt-auto d-flex justify-content-between align-items-center">
            <div>
              <div class="fw-bold">₹ ${l.price||'—'}</div>
              <div class="text-muted">${l.hostel} • ${l.type}</div>
            </div>
            <div class="text-end">
              <button class="btn btn-sm btn-outline-primary me-2" data-id="${l.id}" data-action="view">View</button>
              ${l.type === 'Rent' ? `<button class="btn btn-sm btn-success me-2" data-pay="${l.id}">Pay Rent</button>` : ''}
              <button class="btn btn-sm btn-outline-danger" data-id="${l.id}" data-action="report">Report</button>
            </div>
          </div>
        </div>
      </div>
    `;
    browseEl.appendChild(col);
  });

  // attach handlers for newly added buttons
  browseEl.querySelectorAll('button[data-action]').forEach(b=>{
    if(b._attached) return; // avoid double attaching
    b._attached = true;
    b.addEventListener('click', async (e)=>{
      const id = e.currentTarget.getAttribute('data-id');
      const action = e.currentTarget.getAttribute('data-action');
      if(action === 'view'){
        await onViewListing(id);
      } else if(action === 'report'){
        await onReportListing(id);
      }
    });
  });
  // attach pay buttons
  browseEl.querySelectorAll('button[data-pay]').forEach(b=>{
    if(b._attachedPay) return;
    b._attachedPay = true;
    b.addEventListener('click', async (e)=>{
      const id = e.currentTarget.getAttribute('data-pay');
      await payRent(id);
    });
  });
}

// Escape to prevent XSS
function escapeHtml(s){ return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;'); }

// ---------------------------
// Listing interactions: view (open chat) and report
// ---------------------------
async function onViewListing(listingId){
  // record interaction for recommendation engine
  if(currentUser) await trackInteraction(listingId);
  // open chat modal and load messages
  currentChatListing = listingId;
  chatModal.show();
  loadChat(listingId);
}

// Payment: initiate Stripe Checkout for rent payments
async function payRent(listingId){
  if(!auth.currentUser){ alert('Please login to pay'); return; }
  // Ask user to pick provider: confirm -> Stripe, Cancel -> Razorpay
  const useStripe = confirm('Pay with Stripe? OK = Stripe, Cancel = Razorpay');
  if(useStripe){
    try{
      const createSession = httpsCallable(functionsClient, 'createCheckoutSession');
      const resp = await createSession({ listingId });
      if(resp.data && resp.data.url){ window.location.href = resp.data.url; }
      else alert('Failed to create checkout session');
    }catch(err){ console.error(err); alert('Payment failed: '+(err.message||err)); }
  } else {
    await payRazorpay(listingId);
  }
}

async function payRazorpay(listingId){
  if(!auth.currentUser){ alert('Please login'); return; }
  try{
    const createOrder = httpsCallable(functionsClient, 'createRazorpayOrder');
    const resp = await createOrder({ listingId });
    if(!(resp && resp.data && resp.data.orderId && resp.data.keyId)) throw new Error('Order creation failed');
    const { orderId, keyId } = resp.data;
    const options = {
      key: keyId,
      order_id: orderId,
      handler: async function(paymentResp){
        // verify with server
        const verify = httpsCallable(functionsClient, 'verifyRazorpayPayment');
        const v = await verify({ razorpay_payment_id: paymentResp.razorpay_payment_id, razorpay_order_id: paymentResp.razorpay_order_id, razorpay_signature: paymentResp.razorpay_signature });
        if(v.data && v.data.success){
          document.getElementById('payment-status-body').textContent = 'Payment successful (Razorpay).';
          paymentModal.show();
        } else {
          document.getElementById('payment-status-body').textContent = 'Payment verification failed.';
          paymentModal.show();
        }
      },
      modal: { ondismiss: function(){ console.log('Razorpay modal closed'); } }
    };
    const rzp = new window.Razorpay(options);
    rzp.open();
  }catch(err){ console.error(err); alert('Razorpay payment initiation failed'); }
}

async function checkStripePaymentStatus(sessionId){
  const bodyEl = document.getElementById('payment-status-body');
  bodyEl.textContent = 'Checking payment status...';
  paymentModal.show();
  // poll payments collection for a matching stripeSessionId
  const paymentsRef = collection(db,'payments');
  let attempts = 0;
  while(attempts < 20){
    const snap = await getDocs(query(paymentsRef, where('stripeSessionId','==', sessionId), limit(1)));
    if(!snap.empty){
      const p = snap.docs[0].data();
      if(p.status === 'paid') { bodyEl.textContent = 'Payment confirmed. Thank you!'; return; }
      else bodyEl.textContent = 'Payment pending. Please wait...';
    } else {
      bodyEl.textContent = 'Payment record not found yet. Waiting...';
    }
    attempts++;
    await new Promise(r=>setTimeout(r,2000));
  }
  bodyEl.textContent = 'Timed out while checking payment. If money was deducted, contact support.';
}

async function onReportListing(listingId){
  if(!auth.currentUser){ alert('Login to report'); return; }
  const reason = prompt('Reason for report (brief)');
  if(!reason) return;
  await addDoc(collection(db,'reports'), { listingId, reporterId: auth.currentUser.uid, reason, createdAt: serverTimestamp() });
  alert('Report submitted');
}

// ---------------------------
// Simple chat via Firestore (polling every 3s)
// Chats stored in `chats` with listingId, senderId, message, createdAt
// ---------------------------
document.getElementById('chat-form').addEventListener('submit', async (e)=>{
  e.preventDefault();
  if(!auth.currentUser) { alert('Please login'); return; }
  const text = document.getElementById('chat-input').value.trim();
  if(!text) return;
  await addDoc(collection(db,'chats'), { listingId: currentChatListing, senderId: auth.currentUser.uid, message: text, createdAt: serverTimestamp() });
  document.getElementById('chat-input').value='';
  loadChat(currentChatListing);
});

async function loadChat(listingId){
  // clear existing interval
  if(pollIntervals.chat) clearInterval(pollIntervals.chat);
  const container = document.getElementById('chat-messages');
  async function fetchAndRender(){
    const snap = await getDocs(query(collection(db,'chats'), where('listingId','==', listingId), orderBy('createdAt','asc')));
    container.innerHTML = '';
    snap.docs.forEach(d=>{
      const m = d.data();
      const div = document.createElement('div');
      div.className = (m.senderId===auth.currentUser?.uid) ? 'text-end mb-2' : 'text-start mb-2';
      div.innerHTML = `<div class="d-inline-block p-2 rounded bg-light">${escapeHtml(m.message)}</div>`;
      container.appendChild(div);
    });
    container.scrollTop = container.scrollHeight;
  }
  await fetchAndRender();
  pollIntervals.chat = setInterval(fetchAndRender, 3000);
}

// ---------------------------
// Recommendation engine (client-side scoring)
// - Tracks clicked categories and recently viewed types in `users` doc
// - getRecommendedListings(userDoc, listings)
// Logic (lightweight):
// 1. Increase score if listing.hostel === user.hostel (local relevance)
// 2. Increase score if listing.category appears in user's clickedCategories (weighted by frequency)
// 3. Slight boost for recently viewed types
// 4. Recent listings slightly boosted
// Returns sorted array by score, then keeps top results
// ---------------------------
async function trackInteraction(listingId){
  // fetch listing to get category/type
  const docSnap = await getDoc(doc(db,'listings',listingId));
  if(!docSnap.exists()) return;
  const data = docSnap.data();
  const userRef = doc(db,'users', currentUser.id);
  // simple append and keep top 10
  const updated = { clickedCategories: currentUser.clickedCategories || [] };
  updated.clickedCategories.push(data.category);
  // shrink
  if(updated.clickedCategories.length>20) updated.clickedCategories = updated.clickedCategories.slice(-20);
  await updateDoc(userRef, { clickedCategories: updated.clickedCategories });
  currentUser.clickedCategories = updated.clickedCategories;
}

async function getRecommendedListings(userDoc, listings){
  // Build frequency map of clicked categories
  const freq = {};
  (userDoc.clickedCategories || []).forEach(c=> freq[c] = (freq[c]||0) + 1);

  // assign score
  const scored = listings.map(l=>{
    let score = 0;
    if(userDoc.hostel && l.hostel === userDoc.hostel) score += 5; // strong local preference
    if(freq[l.category]) score += Math.min(5, freq[l.category]);
    // recent boost (newer => higher)
    if(l.createdAt && l.createdAt.seconds) score += Math.max(0, 1 - ((Date.now()/1000 - l.createdAt.seconds)/60/60/24));
    // type preference from last clicked categories heuristic omitted for simplicity
    return { listing: l, score };
  });

  scored.sort((a,b)=> b.score - a.score);
  return scored.map(s=>s.listing);
}

// ---------------------------
// Reporting & Admin actions
// - Users can file reports (done above)
// - Admin can view reports, delete listings, suspend users
// ---------------------------
document.getElementById('nav-admin').addEventListener('click', async ()=>{
  await loadReports();
  adminModal.show();
});

// ---------------------------
// Profile modal: load and update user profile
// ---------------------------
const profileModal = new bootstrap.Modal(document.getElementById('profileModal'));
async function openProfileModal(){
  if(!auth.currentUser) { alert('Please login'); return; }
  // ensure latest user doc
  const usersSnap = await getDocs(query(collection(db,'users'), where('uid','==', auth.currentUser.uid), limit(1)));
  if(usersSnap.empty) { alert('User profile not found'); return; }
  const udoc = usersSnap.docs[0];
  const udata = udoc.data();
  document.getElementById('profile-email').value = udata.email || auth.currentUser.email;
  document.getElementById('profile-hostel').value = udata.hostel || '';
  document.getElementById('profile-phone').value = udata.phone || '';
  document.getElementById('profile-emailpref').checked = !!udata.emailNotifications;
  // store the doc id on the modal save button dataset
  document.getElementById('profile-save').dataset.docId = udoc.id;
  profileModal.show();
}

document.getElementById('profile-save').addEventListener('click', async (e)=>{
  e.preventDefault();
  const docId = e.currentTarget.dataset.docId;
  if(!docId) return;
  const phone = document.getElementById('profile-phone').value.trim();
  const hostel = document.getElementById('profile-hostel').value;
  const emailPref = document.getElementById('profile-emailpref').checked;
  try{
    await updateDoc(doc(db,'users', docId), { phone, hostel, emailNotifications: !!emailPref });
    alert('Profile updated');
    profileModal.hide();
    // refresh in-memory currentUser
    const d = await getDoc(doc(db,'users', docId));
    currentUser = { id: d.id, ...d.data() };
  }catch(err){ console.error(err); alert('Failed to update profile'); }
});

async function loadReports(){
  const reportsEl = document.getElementById('reports-list');
  reportsEl.innerHTML = '<div>Loading...</div>';
  const snap = await getDocs(query(collection(db,'reports'), orderBy('createdAt','desc')));
  reportsEl.innerHTML = '';
  for(const d of snap.docs){
    const r = d.data();
    const row = document.createElement('div');
    row.className = 'd-flex justify-content-between border p-2 mb-2 align-items-start';
    row.innerHTML = `
      <div>
        <div><strong>Listing:</strong> ${r.listingId}</div>
        <div><strong>Reporter:</strong> ${r.reporterId}</div>
        <div><strong>Reason:</strong> ${escapeHtml(r.reason)}</div>
      </div>
      <div class="text-end">
        <button class="btn btn-sm btn-danger me-2" data-id="${d.id}" data-action="delete-listing">Delete Listing</button>
        <button class="btn btn-sm btn-warning" data-id="${d.id}" data-action="suspend-user">Suspend User</button>
      </div>
    `;
    reportsEl.appendChild(row);
  }
  // attach handlers
  reportsEl.querySelectorAll('button[data-action]').forEach(b=>{
    b.addEventListener('click', async (e)=>{
      const action = e.currentTarget.getAttribute('data-action');
      const reportId = e.currentTarget.getAttribute('data-id');
      const reportDoc = (await getDoc(doc(db,'reports',reportId))).data();
      if(action === 'delete-listing'){
        // delete listing doc (storage cleanup not implemented here)
        await deleteDoc(doc(db,'listings', reportDoc.listingId));
        alert('Listing deleted');
        await loadReports();
      } else if(action === 'suspend-user'){
        // flag user as suspended
        const uidToSuspend = reportDoc.reporterId;
        // find user doc by uid
        const usersSnap = await getDocs(query(collection(db,'users'), where('uid','==', uidToSuspend), limit(1)));
        if(!usersSnap.empty){
          const udoc = usersSnap.docs[0];
          await updateDoc(doc(db,'users', udoc.id), { status: 'suspended' });
          alert('User suspended');
          await loadReports();
        }
      }
    });
  });
}

// ---------------------------
// Initial load
// ---------------------------
loadListings();

// End of app.js
