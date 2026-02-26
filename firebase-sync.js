// ═══════════════════════════════════════════════════════════════
//  QUIZZO — FIREBASE SYNC LAYER
//  Drop-in replacement for localStorage + BroadcastChannel sync.
//  Replaces: sendMsg(), onMsg(), writeRoom(), readRoom(), clearRoom()
//
//  SETUP:
//  1. Go to https://console.firebase.google.com
//  2. Create a new project (free Spark plan is fine)
//  3. Add a Web app → copy your firebaseConfig below
//  4. Go to Realtime Database → Create database → Start in TEST MODE
//  5. Replace the placeholder config values below with yours
// ═══════════════════════════════════════════════════════════════

// ── YOUR FIREBASE CONFIG (replace all values) ──────────────────
const FIREBASE_CONFIG = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT.firebaseapp.com",
  databaseURL:       "https://YOUR_PROJECT-default-rtdb.firebaseio.com",
  projectId:         "YOUR_PROJECT",
  storageBucket:     "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID"
};
// ───────────────────────────────────────────────────────────────

// ── Firebase SDK (loaded via CDN in index.html) ─────────────────
// Make sure your index.html <head> includes:
//   <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
//   <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-database-compat.js"></script>
// ───────────────────────────────────────────────────────────────

let _fbApp = null;
let _fbDb  = null;
let _roomListeners = {};   // active Firebase listeners keyed by room code
let _msgHandlers   = [];   // onMsg() subscribers

// Initialise Firebase once
function initFirebase() {
  if (_fbApp) return;
  try {
    _fbApp = firebase.initializeApp(FIREBASE_CONFIG);
    _fbDb  = firebase.database();
    console.info('[Quizzo] Firebase initialised ✓');
  } catch (e) {
    console.error('[Quizzo] Firebase init failed:', e);
  }
}

// ── Room path helper ────────────────────────────────────────────
function roomRef(code) {
  if (!_fbDb) initFirebase();
  return _fbDb.ref('rooms/' + code);
}

// ── writeRoom(data)  ────────────────────────────────────────────
// Replaces: localStorage.setItem(getRoomKey(code), JSON.stringify(data))
//           + sendMsg('room_update', {code, data})
function writeRoom(data) {
  if (!data || !ROOM_CODE) return;
  try {
    roomRef(ROOM_CODE).set({
      ...data,
      _ts: firebase.database.ServerValue.TIMESTAMP   // server-side timestamp
    });
  } catch (e) {
    console.error('[Quizzo] writeRoom error:', e);
  }
}

// ── readRoom(code)  ─────────────────────────────────────────────
// Firebase is realtime, so we DON'T use readRoom() for polling anymore.
// Instead we use listenRoom() below. readRoom() is kept as a one-time fetch
// for the join flow where we need an immediate answer.
function readRoom(code) {
  // Returns a Promise — callers that used the sync version need updating.
  // See joinRoom() patch below.
  if (!_fbDb) initFirebase();
  return _fbDb.ref('rooms/' + code).get().then(snap => snap.val());
}

// ── clearRoom(code)  ────────────────────────────────────────────
function clearRoom(code) {
  if (!_fbDb) initFirebase();
  _fbDb.ref('rooms/' + code).remove().catch(() => {});
  stopListeningRoom(code);
}

// ── listenRoom(code, callback)  ─────────────────────────────────
// Real-time listener. Replaces the setInterval polling in listenAsClient().
// callback(roomData) fires every time the room changes in Firebase.
function listenRoom(code, callback) {
  stopListeningRoom(code);   // remove any existing listener first
  if (!_fbDb) initFirebase();
  const ref = _fbDb.ref('rooms/' + code);
  const handler = ref.on('value', snap => {
    const data = snap.val();
    if (data) callback(data);
  }, err => {
    console.error('[Quizzo] listenRoom error:', err);
  });
  _roomListeners[code] = { ref, handler };
}

function stopListeningRoom(code) {
  if (_roomListeners[code]) {
    _roomListeners[code].ref.off('value', _roomListeners[code].handler);
    delete _roomListeners[code];
  }
}

// ── sendMsg(type, data)  ────────────────────────────────────────
// Replaces BroadcastChannel.postMessage().
// We store ephemeral messages in Firebase under /messages/{code}/{pushId}.
// They auto-delete after 10 seconds.
function sendMsg(type, data = {}) {
  if (!_fbDb || !ROOM_CODE) return;
  const msg = { type, data, ts: Date.now() };
  const msgRef = _fbDb.ref('messages/' + ROOM_CODE).push(msg);
  // Auto-cleanup after 10 seconds
  setTimeout(() => msgRef.remove().catch(() => {}), 10000);
}

// ── onMsg(handler)  ─────────────────────────────────────────────
// Replaces BroadcastChannel.onmessage + storage event listener.
// Listens to /messages/{code} and fires handler for each new message.
// Must be called AFTER ROOM_CODE is set.
function onMsg(handler) {
  _msgHandlers.push(handler);
}

// Internal: start listening for messages once ROOM_CODE is known
let _msgListenerActive = false;
function startMsgListener() {
  if (_msgListenerActive || !ROOM_CODE || !_fbDb) return;
  _msgListenerActive = true;
  const ref = _fbDb.ref('messages/' + ROOM_CODE);
  // Only listen to NEW messages (childAdded after now)
  ref.orderByChild('ts').startAt(Date.now()).on('child_added', snap => {
    const msg = snap.val();
    if (msg) _msgHandlers.forEach(h => { try { h(msg); } catch(e) {} });
  });
}

// ── Answer submission via Firebase  ─────────────────────────────
// Replaces localStorage answer keys ('quizzo_ans_...')
// Players write their answer to /answers/{roomCode}/{pid}
function submitAnswerToFirebase(pid, team, ans, qIdx, round) {
  if (!_fbDb || !ROOM_CODE) return;
  _fbDb.ref(`answers/${ROOM_CODE}/${pid}`).set({
    team, pid, ans, qIdx, round, ts: Date.now()
  });
}

// Host reads all answers for current question from Firebase
function listenForAnswers(qIdx, round, callback) {
  if (!_fbDb || !ROOM_CODE) return;
  const ref = _fbDb.ref(`answers/${ROOM_CODE}`);
  ref.on('child_added', snap => {
    const p = snap.val();
    if (p && p.qIdx === qIdx && p.round === round) {
      callback(p);
    }
  });
  ref.on('child_changed', snap => {
    const p = snap.val();
    if (p && p.qIdx === qIdx && p.round === round) {
      callback(p);
    }
  });
}

function clearAnswers() {
  if (!_fbDb || !ROOM_CODE) return;
  _fbDb.ref(`answers/${ROOM_CODE}`).remove().catch(() => {});
}

// ── Power-up submission via Firebase  ───────────────────────────
function submitPowerupToFirebase(team, key, qIdx, round) {
  if (!_fbDb || !ROOM_CODE) return;
  _fbDb.ref(`powerups/${ROOM_CODE}/${team}_${key}`).set({
    team, key, qIdx, round, ts: Date.now()
  });
}

function listenForPowerups(qIdx, round, callback) {
  if (!_fbDb || !ROOM_CODE) return;
  _fbDb.ref(`powerups/${ROOM_CODE}`).on('child_added', snap => {
    const p = snap.val();
    if (p && p.qIdx === qIdx && p.round === round) callback(p);
  });
}

function clearPowerups() {
  if (!_fbDb || !ROOM_CODE) return;
  _fbDb.ref(`powerups/${ROOM_CODE}`).remove().catch(() => {});
}

// ── Presence / connection status  ───────────────────────────────
// Shows players as online/offline in the lobby
function registerPresence(pid, name, team) {
  if (!_fbDb || !ROOM_CODE) return;
  const presRef = _fbDb.ref(`presence/${ROOM_CODE}/${pid}`);
  presRef.set({ name, team, online: true, ts: Date.now() });
  // Remove on disconnect
  presRef.onDisconnect().remove();
}

// ── Init on load  ───────────────────────────────────────────────
initFirebase();
