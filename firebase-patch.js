const FIREBASE_URL = 'https://quizzo-a7d72-default-rtdb.firebaseio.com/';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  FIREBASE REST + SSE HELPERS  (no SDK, pure fetch/EventSource)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function _fbFetch(path, method = 'GET', body = undefined) {
  const url = `${FIREBASE_URL}/${path}.json`;
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(url, opts);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn('[Quizzo Firebase] fetch error:', e.message);
    return null;
  }
}

// SSE listener — Firebase Server-Sent Events for real-time push
let _sseSource = null;

function _fbListen(path, onData) {
  if (_sseSource) { try { _sseSource.close(); } catch(e) {} _sseSource = null; }
  const url = `${FIREBASE_URL}/${path}.json`;
  _sseSource = new EventSource(url);

  function parse(e) {
    try {
      const p = JSON.parse(e.data);
      if (p && p.data !== undefined) onData(p.data);
    } catch (err) {}
  }

  _sseSource.addEventListener('put',   parse);
  _sseSource.addEventListener('patch', parse);
  _sseSource.onerror = () => {
    // EventSource auto-reconnects; no action needed
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ROOM CACHE  (keeps last known state for sync-style reads)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const _roomCache = {};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  OVERRIDE SYNC FUNCTIONS
//  These replace the original localStorage / BroadcastChannel versions
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// writeRoom — async write to Firebase
window.writeRoom = function(data) {
  if (!window.ROOM_CODE) return;
  const path = `rooms/${window.ROOM_CODE}`;
  _fbFetch(path, 'PUT', data).then(result => {
    if (result !== null) _roomCache[window.ROOM_CODE] = data;
  });
};

// readRoom — returns cached value synchronously (populated by listener)
window.readRoom = function(code) {
  return _roomCache[code] || null;
};

// clearRoom — delete room from Firebase
window.clearRoom = function(code) {
  _fbFetch(`rooms/${code}`, 'DELETE');
  _fbFetch(`messages/${code}`, 'DELETE');
  _fbFetch(`locks/${code}`, 'DELETE');
  delete _roomCache[code];
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  MESSAGING — replaces BroadcastChannel + storage events
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let _msgHandler = null;

// sendMsg — writes a short-lived message to Firebase
window.sendMsg = function(type, data = {}) {
  if (!window.ROOM_CODE) return;
  const msg = { type, data, ts: Date.now() };
  _fbFetch(`messages/${window.ROOM_CODE}`, 'PUT', msg);
};

// onMsg — registers the message handler (called by game code)
window.onMsg = function(handler) {
  _msgHandler = handler;
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  ROOM LISTENER SETUP
//  Starts Firebase SSE listeners for both room state and messages
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let _roomListenerCleanup = null;
let _msgListenerSource = null;

function startRoomListener(code) {
  // Room state listener
  let roomSse = new EventSource(`${FIREBASE_URL}/rooms/${code}.json`);
  function handleRoomData(e) {
    try {
      const p = JSON.parse(e.data);
      if (p && p.data) {
        _roomCache[code] = p.data;
      }
    } catch(err) {}
  }
  roomSse.addEventListener('put', handleRoomData);
  roomSse.addEventListener('patch', handleRoomData);

  // Messages listener
  if (_msgListenerSource) { try { _msgListenerSource.close(); } catch(e){} }
  _msgListenerSource = new EventSource(`${FIREBASE_URL}/messages/${code}.json`);
  function handleMsgData(e) {
    try {
      const p = JSON.parse(e.data);
      if (p && p.data && _msgHandler) {
        const msg = p.data;
        if (msg.ts && msg.ts > Date.now() - 10000) { // ignore stale messages
          _msgHandler(msg);
        }
      }
    } catch(err) {}
  }
  _msgListenerSource.addEventListener('put', handleMsgData);
  _msgListenerSource.addEventListener('patch', handleMsgData);

  _roomListenerCleanup = () => {
    try { roomSse.close(); } catch(e) {}
    try { _msgListenerSource.close(); } catch(e) {}
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PATCH joinRoom() — async Firebase-aware version
//  Replaces the original which used setInterval + localStorage reads
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

window.joinRoom = async function() {
  const code = document.getElementById('code-input').value.trim().toUpperCase();
  const rawName = document.getElementById('inp-join-name').value.trim().toUpperCase();
  const nameInput = document.getElementById('inp-join-name');
  const err = document.getElementById('join-error');

  if (!rawName) {
    err.textContent = 'Please enter your name before joining.';
    err.classList.add('show');
    nameInput.focus();
    nameInput.style.borderColor = 'var(--red)';
    nameInput.style.boxShadow = '0 0 0 3px rgba(226,27,60,0.15)';
    return;
  }
  nameInput.style.borderColor = '';
  nameInput.style.boxShadow = '';
  if (code.length !== 4) { err.textContent = 'Enter a 4-digit room code.'; err.classList.add('show'); return; }
  err.classList.remove('show');

  window.MY_NAME = rawName;
  window.MY_TEAM = window.joinTeamChoice || 'blue';
  window.ROLE = 'client';

  const pid = window.BROWSER_PID;
  const playerEntry = {
    id: pid,
    name: window.MY_NAME,
    team: window.MY_TEAM,
    score: 0, streak: 0, mult: 1, correct: 0, answered: 0, lastAns: null,
    avatar: { ...(window.AV || { skin: 0, hair: 0, eyes: 0, accessory: 0 }) }
  };

  showOverlay(true);
  document.getElementById('co-text').textContent = 'SEARCHING FOR ROOM ' + code + '...';

  // Fetch room from Firebase
  const room = await _fbFetch(`rooms/${code}`, 'GET');

  if (!room) {
    showOverlay(false);
    err.textContent = 'Room "' + code + '" not found. Check the code and try again.';
    err.classList.add('show');
    return;
  }

  if (['lineup', 'playing', 'ready', 'resolving', 'round_end', 'match_end'].includes(room.status)) {
    showOverlay(false);
    err.textContent = 'Match already started. Ask the host to start a new game.';
    err.classList.add('show');
    return;
  }

  // Optimistic lock via Firebase
  const lockPath = `locks/${code}`;
  const myLock = pid + '_' + Date.now();
  await _fbFetch(lockPath, 'PUT', myLock);
  await new Promise(r => setTimeout(r, 100));
  const currentLock = await _fbFetch(lockPath, 'GET');

  if (currentLock !== myLock) {
    // Someone else locked — retry after short delay
    await new Promise(r => setTimeout(r, 200));
    const retry = await _fbFetch(lockPath, 'GET');
    if (retry !== myLock) {
      showOverlay(false);
      err.textContent = 'Room busy — please try again.';
      err.classList.add('show');
      return;
    }
  }

  // We have the lock — re-read fresh room state
  const fresh = await _fbFetch(`rooms/${code}`, 'GET');
  if (!fresh || ['lineup', 'playing', 'ready', 'resolving', 'round_end', 'match_end'].includes(fresh.status)) {
    await _fbFetch(lockPath, 'DELETE');
    showOverlay(false);
    err.textContent = 'Match already started.';
    err.classList.add('show');
    return;
  }

  // Check if this browser already joined on a different team
  const players = [...(fresh.players || [])];
  const existingPlayer = players.find(p => p.id === pid);
  if (existingPlayer && existingPlayer.team !== window.MY_TEAM) {
    await _fbFetch(lockPath, 'DELETE');
    showOverlay(false);
    err.textContent = '⚠ This browser is already on the ' + existingPlayer.team.toUpperCase() + ' team.';
    err.classList.add('show');
    return;
  }

  if (!players.find(p => p.id === pid)) players.push(playerEntry);
  fresh.players = players;
  fresh.status = 'waiting';
  fresh.ts = Date.now();

  window.ROOM_CODE = code;
  _roomCache[code] = fresh;

  // Write updated room
  await _fbFetch(`rooms/${code}`, 'PUT', fresh);

  // Release lock
  await _fbFetch(lockPath, 'DELETE');

  // Update UI
  document.getElementById('role-badge').textContent = window.MY_TEAM === 'blue' ? 'PLAYER · BLUE' : 'PLAYER · RED';
  document.getElementById('role-badge').className = `role-badge tag-${window.MY_TEAM}`;
  document.getElementById('role-badge').style.display = 'block';

  showOverlay(true);
  document.getElementById('co-text').textContent = '✓ JOINED! Waiting for host to start...';

  // Start room + message listeners
  startRoomListener(code);

  // Poll loop — watches for host to launch the game
  const waitPoll = setInterval(async () => {
    const r = _roomCache[code];
    if (!r) return;
    const total = (r.players || []).length;
    const blue = (r.players || []).filter(p => p.team === 'blue').length;
    const red = (r.players || []).filter(p => p.team === 'red').length;

    if (r.status === 'waiting' || r.status === 'joined_notify') {
      document.getElementById('co-text').textContent =
        `LOBBY · ${blue} Blue · ${red} Red · ${total} player${total !== 1 ? 's' : ''} · waiting for host...`;
      return;
    }
    if (r.status === 'lineup') {
      clearInterval(waitPoll);
      showOverlay(false);
      applyRoomState(r);
      showLineup(() => { enterGame(); listenAsClient(); });
    } else if (r.status === 'playing') {
      clearInterval(waitPoll);
      showOverlay(false);
      applyRoomState(r);
      enterGame();
      listenAsClient();
    }
  }, 300);
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PATCH listenAsClient() — use Firebase room cache instead of localStorage poll
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

window._origListenAsClient = window.listenAsClient;
window.listenAsClient = function() {
  // Ensure listeners are running
  if (window.ROOM_CODE) startRoomListener(window.ROOM_CODE);

  let clientLastTs = 0;
  // Poll the cache (which is kept fresh by the SSE listener)
  const poll = setInterval(() => {
    const r = _roomCache[window.ROOM_CODE];
    if (r && r.ts > clientLastTs) {
      clientLastTs = r.ts;
      handleClientUpdate(r);
    }
  }, 150);
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PATCH watchClientAnswers() — write answers to Firebase instead of localStorage
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const _origSubmitAnswer = window.submitAnswer;
window.submitAnswer = function(idx) {
  if (window.ROLE === 'host' || window.G.locked) return;
  const myAnswers = window.MY_TEAM === 'blue' ? window.G.blueAnswers : window.G.redAnswers;
  const myPlayer = window.G.players.find(p => p.name === window.MY_NAME && p.team === window.MY_TEAM);
  const pid = myPlayer ? myPlayer.id : window.MY_TEAM + '_default';
  if (myAnswers[pid] !== undefined) return;
  const elapsed = (Date.now() - window.G.qStartTime) / 1000;
  const ans = { idx, elapsed };

  if (window.MY_TEAM === 'blue') window.G.blueAnswers[pid] = ans;
  else window.G.redAnswers[pid] = ans;

  document.querySelectorAll('.opt').forEach((b, i) => {
    if (i === idx) b.classList.add('selected-' + window.MY_TEAM);
    b.disabled = true;
  });

  if (typeof SFX !== 'undefined') SFX.submit();
  if (typeof updateAnswerStatus === 'function') updateAnswerStatus();

  // Write answer to Firebase (host picks it up via watchClientAnswers)
  const ansPath = `answers/${window.ROOM_CODE}/${pid}`;
  _fbFetch(ansPath, 'PUT', {
    team: window.MY_TEAM,
    pid,
    ans,
    qIdx: window.G.currentQ,
    round: window.G.currentRound,
    ts: Date.now()
  });

  // Also send message for real-time buzzer (First Correct mode)
  sendMsg('answer', {
    code: window.ROOM_CODE,
    team: window.MY_TEAM,
    pid,
    ans,
    qIdx: window.G.currentQ,
    round: window.G.currentRound
  });
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PATCH watchClientAnswers() — read answers from Firebase
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let _answerPollInterval = null;

window._origWatchClientAnswers = window.watchClientAnswers;
window.watchClientAnswers = function() {
  clearInterval(_answerPollInterval);
  if (window.ROLE !== 'host') return;

  // Listen for real-time answer messages (BroadcastChannel replacement)
  const origOnMsg = window._msgHandler;
  window._msgHandler = function(msg) {
    if (origOnMsg) origOnMsg(msg);
    if (msg.type === 'answer' && msg.data.code === window.ROOM_CODE && !window.G.locked) {
      const p = msg.data;
      if (p.qIdx === window.G.currentQ && p.round === window.G.currentRound) {
        if (p.team === 'blue') window.G.blueAnswers[p.pid] = p.ans;
        else window.G.redAnswers[p.pid] = p.ans;
        if (typeof updateAnswerStatus === 'function') updateAnswerStatus();
        checkSpeedResolve(p);
      }
    }
    if (msg.type === 'speed_correct' && msg.data.code === window.ROOM_CODE && window.ROLE !== 'host') {
      if (msg.data.qIdx === window.G.currentQ && msg.data.round === window.G.currentRound) {
        document.querySelectorAll('.opt:not(.selected-blue):not(.selected-red)').forEach(b => {
          b.disabled = true; b.style.opacity = '0.45';
        });
        const aiEl = document.getElementById('ai-' + msg.data.team);
        if (aiEl) { aiEl.classList.add('answered', msg.data.team); }
      }
    }
  };

  // Also poll Firebase answers path (for reliability)
  _answerPollInterval = setInterval(async () => {
    if (window.G.locked) { clearInterval(_answerPollInterval); return; }

    const answers = await _fbFetch(`answers/${window.ROOM_CODE}`, 'GET');
    if (!answers) return;

    let newAnswer = false;
    Object.entries(answers).forEach(([pid, p]) => {
      if (!p || p.qIdx !== window.G.currentQ || p.round !== window.G.currentRound) return;
      const bucket = p.team === 'blue' ? window.G.blueAnswers : window.G.redAnswers;
      if (bucket[pid] === undefined) {
        bucket[pid] = p.ans;
        newAnswer = true;
      }
    });

    if (newAnswer && typeof updateAnswerStatus === 'function') updateAnswerStatus();

    // Check if all answered (class mode) or correct answer found (speed mode)
    const bluePlayers = window.G.players.filter(p => p.team === 'blue');
    const redPlayers = window.G.players.filter(p => p.team === 'red');
    const q = window.G.questions[window.G.currentQ];
    if (!q) return;

    if (window.G.gameMode === 'speed') {
      const blueCorrect = bluePlayers.some(p => window.G.blueAnswers[p.id]?.idx === q.a);
      const redCorrect = redPlayers.some(p => window.G.redAnswers[p.id]?.idx === q.a);
      if ((blueCorrect || redCorrect) && !window.G.locked) {
        const correctTeam = blueCorrect ? 'blue' : 'red';
        sendMsg('speed_correct', { code: window.ROOM_CODE, team: correctTeam, qIdx: window.G.currentQ, round: window.G.currentRound });
        clearInterval(_answerPollInterval);
        setTimeout(resolveQ, 250);
      }
    } else {
      const allDone = Object.keys(window.G.blueAnswers).length >= bluePlayers.length &&
                      Object.keys(window.G.redAnswers).length >= redPlayers.length;
      if (allDone && !window.G.locked) { clearInterval(_answerPollInterval); resolveQ(); }
    }
  }, 300);
};

function checkSpeedResolve(p) {
  const q = window.G.questions?.[window.G.currentQ];
  if (!q || window.G.locked) return;
  if (window.G.gameMode === 'speed' && p.ans.idx === q.a) {
    sendMsg('speed_correct', { code: window.ROOM_CODE, team: p.team, qIdx: window.G.currentQ, round: window.G.currentRound });
    clearInterval(_answerPollInterval);
    setTimeout(resolveQ, 250);
  }
}

// Clean up Firebase answers when advancing
const _origAdvanceGame = window.advanceGame;
window.advanceGame = function() {
  // Delete stale answers from Firebase
  if (window.ROOM_CODE) {
    _fbFetch(`answers/${window.ROOM_CODE}`, 'DELETE');
  }
  _origAdvanceGame.apply(this, arguments);
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PATCH startLobbyPoll() — use Firebase instead of localStorage
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

window._origStartLobbyPoll = window.startLobbyPoll;
window.startLobbyPoll = function() {
  if (window._lobbyPollInterval) clearInterval(window._lobbyPollInterval);

  // Start Firebase listener for the room
  if (window.ROOM_CODE) {
    startRoomListener(window.ROOM_CODE);
  }

  window._lobbyPollInterval = setInterval(() => {
    const room = _roomCache[window.ROOM_CODE];
    if (!room) return;
    const players = room.players || [];
    const blue = players.filter(p => p.team === 'blue').length;
    const red = players.filter(p => p.team === 'red').length;
    const total = blue + red;
    const ready = total >= 2 && blue >= 1 && red >= 1;
    const wtEl = document.getElementById('waiting-text');
    const startBtn = document.getElementById('btn-start-host');
    if (wtEl) {
      if (total === 0) wtEl.textContent = 'Share the room code — players join from any device!';
      else if (!ready) wtEl.textContent = `${total} player${total !== 1 ? 's' : ''} joined — need at least 1 on each team.`;
      else wtEl.textContent = `${total} player${total !== 1 ? 's' : ''} ready · ${blue} Blue · ${red} Red — start when ready!`;
    }
    if (startBtn) startBtn.style.display = ready ? 'block' : 'none';
  }, 400);
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  PATCH startHost() — ensure listener starts with room code
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const _origStartHost = window.startHost;
window.startHost = function() {
  _origStartHost.apply(this, arguments);
  // Start Firebase listener after ROOM_CODE is set
  setTimeout(() => {
    if (window.ROOM_CODE) startRoomListener(window.ROOM_CODE);
  }, 100);
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  STARTUP CHECK — warn if URL not configured
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

if (FIREBASE_URL === 'https://YOUR-PROJECT-default-rtdb.firebaseio.com') {
  // Show a friendly setup banner
  const banner = document.createElement('div');
  banner.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
    background: linear-gradient(90deg, #ff6b00, #ffa602);
    color: #1a1a2e; padding: 10px 16px;
    font-family: 'Nunito', sans-serif; font-size: 13px; font-weight: 800;
    text-align: center; box-shadow: 0 3px 12px rgba(0,0,0,0.3);
    display: flex; align-items: center; justify-content: center; gap: 12px;
  `;
  banner.innerHTML = `
    ⚠ Firebase not configured — cross-device play disabled.
    <a href="https://console.firebase.google.com" target="_blank"
       style="color:#1a1a2e; text-decoration:underline; cursor:pointer;">
       Set up Firebase (free, 2 min) →
    </a>
    <button onclick="this.parentElement.remove()" 
            style="background:rgba(0,0,0,0.15); border:none; border-radius:6px; 
                   padding:3px 10px; cursor:pointer; font-weight:800; color:#1a1a2e;">
      ✕
    </button>
  `;
  document.body.appendChild(banner);
  console.warn(
    '%c[Quizzo] Cross-device patch loaded but FIREBASE_URL not set!\n' +
    'Edit firebase-patch.js and paste your Firebase Realtime Database URL.',
    'color:orange; font-weight:bold; font-size:14px'
  );
} else {
  console.info('%c[Quizzo] ✓ Firebase cross-device multiplayer active', 'color:#5dd130; font-weight:bold');
}
