(async function() {

function _loadScript(src) {
  return new Promise(function(resolve, reject) {
    if (document.querySelector('script[src="' + src + '"]')) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload  = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

await _loadScript('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
await _loadScript('https://www.gstatic.com/firebasejs/9.23.0/firebase-database-compat.js');

const _app = firebase.initializeApp({
  apiKey:            'AIzaSyAhMfNtfS6nA89ihB2-CLN5wtsp8TnBalY',
  authDomain:        'quizzo-a7d72.firebaseapp.com',
  databaseURL:       'https://quizzo-a7d72-default-rtdb.firebaseio.com',
  projectId:         'quizzo-a7d72',
  storageBucket:     'quizzo-a7d72.firebasestorage.app',
  messagingSenderId: '56228054846',
  appId:             '1:56228054846:web:2332ea0c59e501e8e18e6f',
});
const _db  = firebase.database(_app);

const _ref  = path => _db.ref(path);
const _get  = path => _ref(path).once('value').then(s => s.val());
const _set  = (path, val) => _ref(path).set(val);
const _push = (path, val) => _ref(path).push(val);
const _del  = path => _ref(path).remove();

const _roomCache = {};
let _msgHandler  = null;
let _msgTs       = 0;
const _listeners = {};

function _off(key) {
  if (_listeners[key]) { _listeners[key](); delete _listeners[key]; }
}

window.writeRoom = function(data) {
  if (!ROOM_CODE || !data) return;
  data.ts = Date.now();
  _roomCache[ROOM_CODE] = data;
  try { localStorage.setItem('quizzo_room_' + ROOM_CODE, JSON.stringify(data)); } catch(e) {}
  _set('rooms/' + ROOM_CODE, data);
};

window.readRoom = function(code) {
  return _roomCache[code] || (function() {
    try { const s = localStorage.getItem('quizzo_room_' + code); return s ? JSON.parse(s) : null; }
    catch(e) { return null; }
  })();
};

window.clearRoom = function(code) {
  delete _roomCache[code];
  try { localStorage.removeItem('quizzo_room_' + code); } catch(e) {}
  _del('rooms/' + code);
  _del('answers/' + code);
  ['room:' + code, 'msg:' + code].forEach(_off);
};

window.sendMsg = function(type, data) {
  if (!ROOM_CODE) return;
  const msg = Object.assign({ type, ts: Date.now() }, data || {});
  _push('messages/' + ROOM_CODE, msg).then(function(r) {
    if (r && r.key) {
      setTimeout(function() { _del('messages/' + ROOM_CODE + '/' + r.key); }, 8000);
    }
  });
};

window.onMsg = function(handler) { _msgHandler = handler; };

const _origStartHost = window.startHost;
window.startHost = function() {
  _origStartHost.apply(this, arguments);
  if (!ROOM_CODE) return;

  _msgTs = Date.now();
  _off('msg:' + ROOM_CODE);
  const msgRef = _ref('messages/' + ROOM_CODE);
  const _onMsg = msgRef.on('child_added', function(snap) {
    const msg = snap.val();
    if (!msg || msg.ts <= _msgTs) return;

    if (msg.type === 'powerup' && msg.code === ROOM_CODE) {
      const { team, key, qIdx, round } = msg;
      if (qIdx === G.currentQ && round === G.currentRound) {
        if (typeof activePowerups !== 'undefined') {
          activePowerups[team] = activePowerups[team] || {};
          activePowerups[team][key] = true;
        }
      }
    }

    if (_msgHandler) { try { _msgHandler(msg); } catch(e) {} }
    if (Date.now() - msg.ts > 8000) snap.ref.remove();
  });
  _listeners['msg:' + ROOM_CODE] = function() { msgRef.off('child_added', _onMsg); };
};

const _origStartLobbyPoll = window.startLobbyPoll;
window.startLobbyPoll = function() {
  if (ROOM_CODE) {
    _off('room:' + ROOM_CODE);
    const roomRef = _ref('rooms/' + ROOM_CODE);
    const _onRoom = roomRef.on('value', function(snap) {
      const data = snap.val();
      if (data) _roomCache[ROOM_CODE] = data;
    });
    _listeners['room:' + ROOM_CODE] = function() { roomRef.off('value', _onRoom); };
  }
  _origStartLobbyPoll.apply(this, arguments);
};

window.joinRoom = function() { _doJoin(); };

document.addEventListener('DOMContentLoaded', function() {
  const btn = document.getElementById('btn-join');
  if (btn) {
    btn.addEventListener('touchend', function(e) {
      if (btn.disabled) return;
      e.preventDefault();
      _doJoin();
    });
  }
});

async function _doJoin() {
  const err    = document.getElementById('join-error');
  const nameEl = document.getElementById('inp-join-name');

  const digits = [0,1,2,3].map(i => {
    const el = document.getElementById('cd-' + i);
    return el ? el.value.trim() : '';
  });
  let code = digits.join('').toUpperCase();
  if (code.length !== 4) {
    const codeEl = document.getElementById('code-input');
    code = (codeEl ? codeEl.value : '').trim().toUpperCase();
  }

  const rawName = nameEl ? nameEl.value.trim().toUpperCase() : '';

  if (!rawName) {
    err.textContent = 'Please enter your name before joining.';
    err.classList.add('show');
    if (nameEl) { nameEl.focus(); nameEl.style.borderColor = 'var(--red)'; }
    return;
  }
  if (nameEl) nameEl.style.borderColor = '';
  if (code.length !== 4) {
    err.textContent = 'Enter the 4-digit room code.';
    err.classList.add('show');
    return;
  }
  err.classList.remove('show');

  MY_NAME = rawName;
  MY_TEAM = (typeof joinTeamChoice !== 'undefined' ? joinTeamChoice : null) || 'blue';
  ROLE    = 'client';

  const pid = BROWSER_PID;
  const AV_ = (typeof AV !== 'undefined' ? AV : null) || { skin:0, hair:0, eyes:0, accessory:0 };
  const playerEntry = {
    id: pid, name: MY_NAME, team: MY_TEAM,
    score: 0, streak: 0, mult: 1, correct: 0, answered: 0, lastAns: null,
    avatar: Object.assign({}, AV_)
  };

  showOverlay(true);
  document.getElementById('co-text').textContent = 'SEARCHING FOR ROOM ' + code + '...';

  let room;
  try { room = await _get('rooms/' + code); }
  catch(e) { room = undefined; }

  if (room === undefined || room === null) {
    showOverlay(false);
    err.textContent = room === null
      ? 'Room "' + code + '" not found. Make sure the host has started.'
      : 'Cannot reach server. Check your internet and try again.';
    err.classList.add('show');
    return;
  }

  const ACTIVE = ['lineup','playing','ready','resolving','round_end','match_end'];
  if (ACTIVE.includes(room.status)) {
    showOverlay(false);
    err.textContent = 'Match already in progress.';
    err.classList.add('show');
    return;
  }

  try {
    await _ref('rooms/' + code + '/players').transaction(function(players) {
      players = players || [];
      if (!players.find(p => p.id === pid)) players.push(playerEntry);
      return players;
    });
    await _ref('rooms/' + code + '/ts').set(Date.now());
    ROOM_CODE = code;
  } catch(e) {
    showOverlay(false);
    err.textContent = 'Could not join. Please try again.';
    err.classList.add('show');
    return;
  }

  const badge = document.getElementById('role-badge');
  if (badge) {
    badge.textContent   = MY_TEAM === 'blue' ? 'PLAYER · BLUE' : 'PLAYER · RED';
    badge.className     = 'role-badge tag-' + MY_TEAM;
    badge.style.display = 'block';
  }

  showOverlay(true);
  document.getElementById('co-text').textContent = 'JOINED! Waiting for host...';

  let _launched = false;
  _off('wait:' + code);
  const waitRef = _ref('rooms/' + code);
  const _onWait = waitRef.on('value', function(snap) {
    if (_launched) return;
    const r = snap.val();
    if (!r) return;
    _roomCache[code] = r;

    const dbg = document.getElementById('co-text');
    if (r.status === 'waiting') {
      const total = (r.players||[]).length;
      const blue  = (r.players||[]).filter(p => p.team==='blue').length;
      const red   = (r.players||[]).filter(p => p.team==='red').length;
      if (dbg) dbg.textContent =
        'LOBBY · ' + blue + ' Blue · ' + red + ' Red · ' + total +
        ' player' + (total!==1?'s':'') + ' · waiting for host...';
      return;
    }

    if (['lineup','playing','ready'].includes(r.status)) {
      _launched = true;
      waitRef.off('value', _onWait);
      delete _listeners['wait:' + code];
      showOverlay(false);
      applyRoomState(r);
      if (r.status === 'lineup') {
        showLineup(() => { enterGame(); listenAsClient(); });
      } else {
        enterGame(); listenAsClient();
      }
    }
  });
  _listeners['wait:' + code] = function() { waitRef.off('value', _onWait); };
}

window.listenAsClient = function() {
  let lastTs = 0;

  _off('client:room');
  const roomRef = _ref('rooms/' + ROOM_CODE);
  const _onRoom = roomRef.on('value', function(snap) {
    const r = snap.val();
    if (!r || (r.ts||0) <= lastTs) return;
    lastTs = r.ts;
    _roomCache[ROOM_CODE] = r;
    handleClientUpdate(r);

    if (r.status === 'resolving' || r.status === 'playing') {
      const myPlayer = (r.players || []).find(function(p) {
        return p.name === MY_NAME && p.team === MY_TEAM;
      });
      if (myPlayer && typeof checkStreakPowerups === 'function') {
        checkStreakPowerups(myPlayer);
        if (typeof renderPowerupBar === 'function') renderPowerupBar();
      }
    }
  });
  _listeners['client:room'] = function() { roomRef.off('value', _onRoom); };

  _msgTs = Date.now();
  _off('client:msg');
  const msgRef = _ref('messages/' + ROOM_CODE);
  const _onMsg = msgRef.on('child_added', function(snap) {
    const msg = snap.val();
    if (!msg || msg.ts <= _msgTs || !_msgHandler) return;
    try { _msgHandler(msg); } catch(e) {}
  });
  _listeners['client:msg'] = function() { msgRef.off('child_added', _onMsg); };

  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState !== 'visible' || !ROOM_CODE) return;
    _get('rooms/' + ROOM_CODE).then(function(r) {
      if (r && (r.ts||0) > lastTs) {
        lastTs = r.ts;
        _roomCache[ROOM_CODE] = r;
        handleClientUpdate(r);
      }
    });
  });
}

window.submitAnswer = function(idx) {
  if (ROLE === 'host' || G.locked) return;
  const myAnswers = MY_TEAM === 'blue' ? G.blueAnswers : G.redAnswers;
  const myPlayer  = G.players.find(p => p.name === MY_NAME && p.team === MY_TEAM);
  const pid = myPlayer ? myPlayer.id : (MY_TEAM + '_' + BROWSER_PID);
  if (myAnswers[pid] !== undefined) return;

  const elapsed = (Date.now() - G.qStartTime) / 1000;
  const ans = { idx, elapsed };
  if (MY_TEAM === 'blue') G.blueAnswers[pid] = ans;
  else                    G.redAnswers[pid]  = ans;

  document.querySelectorAll('.opt').forEach((b, i) => {
    if (i === idx) b.classList.add('selected-' + MY_TEAM);
    b.disabled = true;
  });
  if (typeof SFX !== 'undefined' && SFX.submit) SFX.submit();
  if (typeof updateAnswerStatus === 'function') updateAnswerStatus();

  _set('answers/' + ROOM_CODE + '/' + pid, {
    team: MY_TEAM, pid, ans, qIdx: G.currentQ, round: G.currentRound
  });
};

window.watchClientAnswers = function() {
  clearInterval(answerPoll);
  if (ROLE !== 'host') return;

  _off('host:answers');
  const ansRef = _ref('answers/' + ROOM_CODE);
  const _onAns = ansRef.on('child_added', function(snap) {
    if (G.locked) return;
    const p = snap.val();
    if (!p || p.qIdx !== G.currentQ || p.round !== G.currentRound) return;

    const bucket = p.team === 'blue' ? G.blueAnswers : G.redAnswers;
    if (bucket[p.pid] !== undefined) return;
    bucket[p.pid] = p.ans;

    if (typeof updateAnswerStatus === 'function') updateAnswerStatus();

    const bluePlayers = G.players.filter(pl => pl.team === 'blue');
    const redPlayers  = G.players.filter(pl => pl.team === 'red');
    const q = G.questions[G.currentQ];
    if (!q) return;

    if (G.gameMode === 'speed') {
      const blueOk = bluePlayers.some(pl => G.blueAnswers[pl.id] && G.blueAnswers[pl.id].idx === q.a);
      const redOk  = redPlayers.some(pl  => G.redAnswers[pl.id]  && G.redAnswers[pl.id].idx  === q.a);
      if ((blueOk || redOk) && !G.locked) {
        ansRef.off('child_added', _onAns);
        delete _listeners['host:answers'];
        _del('answers/' + ROOM_CODE);
        sendMsg('speed_correct', { code: ROOM_CODE, team: blueOk?'blue':'red', qIdx: G.currentQ, round: G.currentRound });
        setTimeout(resolveQ, 250);
      }
    } else {
      const allDone = Object.keys(G.blueAnswers).length >= bluePlayers.length &&
                      Object.keys(G.redAnswers).length  >= redPlayers.length;
      if (allDone && !G.locked) {
        ansRef.off('child_added', _onAns);
        delete _listeners['host:answers'];
        _del('answers/' + ROOM_CODE);
        resolveQ();
      }
    }
  });
  _listeners['host:answers'] = function() { ansRef.off('child_added', _onAns); };

  answerPoll = setInterval(function() {
    if (G.locked) { clearInterval(answerPoll); return; }
  }, 500);
};

var checkSpeedResolve = function() {};

const _origAdvanceGame = window.advanceGame;
window.advanceGame = function() {
  if (ROOM_CODE) {
    _del('messages/' + ROOM_CODE);
    _del('answers/' + ROOM_CODE);
    _off('host:answers');
  }
  _origAdvanceGame.apply(this, arguments);
};

(function() {
  const ua = navigator.userAgent || '';
  if (!/FBAN|FBAV|Instagram|FB_IAB|FB4A|FBIOS|MicroMessenger|TikTok/i.test(ua)) return;
  function _warn() {
    if (!document.body) { setTimeout(_warn, 50); return; }
    const d   = document.createElement('div');
    const btn = document.createElement('button');
    d.style.cssText = 'position:fixed;inset:0;z-index:999999;background:#46178f;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px;text-align:center;font-family:sans-serif;';
    btn.textContent = 'OPEN IN BROWSER';
    btn.style.cssText = 'background:#ffa602;color:#1a1a2e;font-size:16px;font-weight:900;padding:16px 32px;border-radius:12px;border:none;cursor:pointer;margin-top:24px;';
    btn.onclick = () => window.open(location.href, '_blank');
    d.innerHTML = '<div style="font-size:48px">&#127760;</div><div style="color:#ffa602;font-size:20px;font-weight:900;margin-top:12px">Open in Chrome or Safari</div><div style="color:#fff;font-size:14px;line-height:1.6;margin-top:12px">This app cannot run inside Messenger.<br>Please open it in your browser.</div>';
    d.appendChild(btn);
    document.body.appendChild(d);
  }
  _warn();
})();

})();