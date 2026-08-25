// ============================================================
// PARTY VOICE CHAT — talk to the room instead of calling each other.
//
// The multiplayer transport is already WebRTC (PeerJS), and WebRTC carries
// audio natively, so voice needs no server, no account and no third party: the
// same peer connection that ships the game state opens a second, media call
// alongside it. peerjs.min.js is already on the page.
//
// TOPOLOGY. The game's DATA path is a star — in 2v2 every guest talks to the
// host and the host relays. Audio does NOT follow that: relaying it would mean
// decoding and re-encoding four streams on one player's laptop. Voice is a
// MESH instead, every peer dialling every other peer directly, which is what
// four-person voice chat normally is and costs the host nothing extra.
//
// The catch is that guests only know the HOST's peer id — they have never been
// told each other's. So the host publishes a roster ({seat: peerId}) over the
// existing data channel and everyone dials from that. To stop two peers
// ringing each other at the same moment (WebRTC "glare"), exactly one side
// initiates: the one whose peer id sorts lower.
//
// FAILURE IS ALWAYS SOFT. No microphone, a denied permission, an insecure
// origin, a browser without getUserMedia — every one of them leaves the game
// running untouched and puts a readable reason on the panel. Voice is opt-in:
// nothing asks for the microphone until the player presses Join.
// ============================================================
const Voice = {
  // ---- state ----
  _stream: null,          // our microphone
  _calls: {},             // peerId -> MediaConnection
  _audio: {},             // peerId -> HTMLAudioElement
  _meters: {},            // peerId ('me' for us) -> { ctx, analyser, data }
  _roster: {},            // seat -> peerId  (who is in the room)
  _names: {},             // peerId -> display name
  _muted: false,          // our mic muted (still connected, still listening)
  _peerMuted: {},         // peerId -> bool, per-person mute
  _active: false,         // have we joined voice
  _error: null,
  _joining: false,
  _speaking: {},          // peerId -> bool
  _rafId: null,
  _guardId: null,         // audibility guard (see _startAudibilityGuard)

  // ---- capability ----
  supported() {
    return !!(typeof navigator !== 'undefined'
      && navigator.mediaDevices && navigator.mediaDevices.getUserMedia
      && typeof window !== 'undefined' && window.RTCPeerConnection);
  },
  // getUserMedia is refused outright on an insecure origin. Worth naming
  // separately because the fix is "open the https:// page", not "buy a mic".
  secureOk() {
    if (typeof window === 'undefined') return false;
    if (window.isSecureContext) return true;
    const h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1';
  },

  // ---- the live PeerJS object, whichever mode we are in ----
  _peer() {
    try {
      const t4 = (typeof Multiplayer4 !== 'undefined') && Multiplayer4._transport;
      if (t4 && t4._peer) return t4._peer;
      const t1 = (typeof Multiplayer !== 'undefined') && Multiplayer._transport;
      if (t1 && t1._peer) return t1._peer;
    } catch (e) {}
    return null;
  },
  _isHost() {
    try {
      const tt = (typeof Game !== 'undefined') && Game.state && Game.state.twoVTwo;
      if (tt && tt.online) return tt.you === 'p1';
      return !!(typeof Game !== 'undefined' && Game.mp && Game.mp.role === 'host');
    } catch (e) { return false; }
  },
  _inOnlineMatch() {
    try {
      const tt = (typeof Game !== 'undefined') && Game.state && Game.state.twoVTwo;
      if (tt && tt.online) return true;
      return !!(typeof Game !== 'undefined' && Game.isMultiplayer && Game.isMultiplayer());
    } catch (e) { return false; }
  },
  _mySeat() {
    try {
      const tt = Game.state && Game.state.twoVTwo;
      if (tt && tt.online) return tt.you || null;
      if (Game.mp && Game.mp.role) return Game.mp.role === 'host' ? 'host' : 'guest';
    } catch (e) {}
    return null;
  },

  // ---- joining ----
  async join() {
    if (this._active || this._joining) return;
    this._error = null;
    if (!this.supported()) { this._fail('This browser has no microphone support.'); return; }
    if (!this.secureOk())  { this._fail('Voice needs an https:// page (or localhost).'); return; }
    const peer = this._peer();
    if (!peer || !peer.id) { this._fail('Not connected to a room yet.'); return; }
    this._joining = true; this._paint();
    try {
      // Browser-side cleanup on the captured audio — without these three, four
      // laptops in one room feed back into each other immediately.
      this._stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (e) {
      const n = (e && e.name) || '';
      this._joining = false;
      this._fail(
        n === 'NotAllowedError' ? 'Microphone blocked — allow it in the browser and try again.'
        : n === 'NotFoundError' ? 'No microphone found.'
        : 'Could not open the microphone.'
      );
      return;
    }
    this._joining = false;
    this._active = true;
    this._muted = false;
    this._meter('me', this._stream);
    this._listen(peer);
    this._announce();
    this._dialAll();
    this._startLevels();
    this._paint();
  },

  leave() {
    Object.keys(this._calls).forEach(id => { try { this._calls[id].close(); } catch (e) {} });
    this._calls = {};
    Object.keys(this._audio).forEach(id => { try { this._audio[id].remove(); } catch (e) {} });
    this._audio = {};
    Object.keys(this._meters).forEach(k => { try { this._meters[k].ctx.close(); } catch (e) {} });
    this._meters = {};
    if (this._stream) { try { this._stream.getTracks().forEach(t => t.stop()); } catch (e) {} }
    this._stream = null;
    this._active = false; this._speaking = {};
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
    if (this._guardId) { clearInterval(this._guardId); this._guardId = null; }
    this._paint();
  },

  toggleMute() {
    if (!this._active || !this._stream) return;
    this._muted = !this._muted;
    // Disabling the TRACK keeps the call up and the connection warm — the
    // other side simply receives silence, which is what mute should mean.
    try { this._stream.getAudioTracks().forEach(t => (t.enabled = !this._muted)); } catch (e) {}
    this._paint();
  },
  togglePeerMute(peerId) {
    this._peerMuted[peerId] = !this._peerMuted[peerId];
    const a = this._audio[peerId];
    if (a) a.muted = !!this._peerMuted[peerId];
    this._paint();
  },

  _fail(msg) { this._error = msg; this._paint(); },

  // ---- signalling over the game's own data channel ----
  // Every client announces its peer id; the host collects them and publishes
  // the whole roster back, which is how guests learn about each other.
  _announce() {
    const peer = this._peer();
    if (!peer || !peer.id) return;
    const seat = this._mySeat();
    const name = this._myName();
    this._roster[seat || 'me'] = peer.id;
    this._names[peer.id] = name;
    this._send({ t: 'voice', kind: 'hello', seat, peerId: peer.id, name });
    if (this._isHost()) this._publishRoster();
  },
  _publishRoster() {
    if (!this._isHost()) return;
    this._send({ t: 'voice', kind: 'roster', roster: this._roster, names: this._names });
  },
  _send(msg) {
    try {
      if (typeof Multiplayer4 !== 'undefined' && Multiplayer4._transport) { Multiplayer4.send(msg); return; }
      if (typeof Multiplayer !== 'undefined' && Multiplayer.send) { Multiplayer.send(msg); }
    } catch (e) {}
  },
  // Called by the transports when a {t:'voice'} message arrives.
  onMessage(msg) {
    if (!msg || msg.t !== 'voice') return;
    if (msg.kind === 'hello') {
      if (msg.seat && msg.peerId) this._roster[msg.seat] = msg.peerId;
      if (msg.peerId && msg.name) this._names[msg.peerId] = msg.name;
      // The host is the only one that can see everybody, so it answers a hello
      // with the full picture. A guest that joins voice later is picked up the
      // same way, with no reconnect.
      if (this._isHost()) this._publishRoster();
      if (this._active) this._dialAll();
      this._paint();
      return;
    }
    if (msg.kind === 'roster') {
      this._roster = Object.assign({}, this._roster, msg.roster || {});
      this._names = Object.assign({}, this._names, msg.names || {});
      if (this._active) this._dialAll();
      this._paint();
      return;
    }
    if (msg.kind === 'bye') {
      const id = msg.peerId;
      if (id) this._drop(id);
      this._paint();
    }
  },

  _myName() {
    try {
      const tt = Game.state && Game.state.twoVTwo;
      if (tt && tt.online && tt.you && tt.players[tt.you]) return tt.players[tt.you].name || tt.you;
      if (Game.state && Game.state._mpNames) {
        const side = (Game.mp && Game.mp.you) || 'player';
        return Game.state._mpNames[side] || 'Player';
      }
    } catch (e) {}
    return 'Player';
  },

  // ---- the mesh ----
  _remoteIds() {
    const mine = (this._peer() || {}).id;
    return Object.keys(this._roster)
      .map(seat => this._roster[seat])
      .filter(id => id && id !== mine)
      .filter((id, i, a) => a.indexOf(id) === i);
  },
  _dialAll() {
    const peer = this._peer();
    if (!peer || !this._stream) return;
    this._remoteIds().forEach(id => {
      if (this._calls[id]) return;                 // already connected
      // GLARE GUARD — only the lower id dials, the higher id answers. Without
      // it both sides call simultaneously and each ends up with two half-open
      // calls, which sounds like an echo of yourself.
      if (String(peer.id) > String(id)) return;
      try {
        const call = peer.call(id, this._stream, { metadata: { name: this._myName() } });
        this._bindCall(id, call);
      } catch (e) {}
    });
  },
  _listen(peer) {
    if (this._peerBound === peer) return;
    this._peerBound = peer;
    try {
      peer.on('call', (call) => {
        // Answer with our mic. If we have not joined voice we do not answer at
        // all — a one-way call would make us audible without consent.
        if (!this._active || !this._stream) { try { call.close(); } catch (e) {} return; }
        try { call.answer(this._stream); } catch (e) { return; }
        const nm = call.metadata && call.metadata.name;
        if (nm) this._names[call.peer] = nm;
        this._bindCall(call.peer, call);
      });
    } catch (e) {}
  },
  _bindCall(id, call) {
    if (!call) return;
    this._calls[id] = call;
    call.on('stream', (remote) => {
      let a = this._audio[id];
      if (!a) {
        a = document.createElement('audio');
        a.autoplay = true;
        a.dataset.voicePeer = id;
        // OUTSIDE THE GAME MIXER, ON PURPOSE. Voices must stay audible when
        // the music slider is at zero, when SFX are off and when hand-audio
        // privacy is on — those settings are for the game's own sounds, and a
        // player who turns the soundtrack down has not asked to stop hearing
        // their friends. (User: "make sure you can still hear people if your
        // music is down and your hand volume is off.")
        // Nothing in the game touches these today: its audio lives in its own
        // Audio() pools and there is no global sweep over <audio> elements.
        // The marker + the re-assert in _startLevels make that a rule rather
        // than a coincidence, so a future "mute everything" cannot take the
        // room's voices with it.
        a.dataset.voiceAudio = '1';
        a.volume = 1;
        a.style.display = 'none';
        document.body.appendChild(a);
        this._audio[id] = a;
      }
      a.srcObject = remote;
      a.muted = !!this._peerMuted[id];
      // Autoplay can still be refused; the join button was a user gesture, so
      // this almost always resolves, and if it does not the panel says so.
      const p = a.play();
      if (p && p.catch) p.catch(() => { this._error = 'Tap anywhere to enable audio.'; this._paint(); });
      this._meter(id, remote);
      this._paint();
    });
    call.on('close', () => { this._drop(id); this._paint(); });
    call.on('error', () => { this._drop(id); this._paint(); });
  },
  _drop(id) {
    if (this._calls[id]) { try { this._calls[id].close(); } catch (e) {} delete this._calls[id]; }
    if (this._audio[id]) { try { this._audio[id].remove(); } catch (e) {} delete this._audio[id]; }
    if (this._meters[id]) { try { this._meters[id].ctx.close(); } catch (e) {} delete this._meters[id]; }
    delete this._speaking[id];
  },

  // ---- who is talking ----
  // A cheap RMS off an AnalyserNode. It drives the dot next to each name so
  // you can tell who is speaking without anyone having to say "it's me".
  _meter(key, stream) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      this._meters[key] = { ctx, analyser, data: new Uint8Array(analyser.frequencyBinCount) };
    } catch (e) {}
  },
  _startLevels() {
    if (this._rafId) return;
    const tick = () => {
      let changed = false;
      Object.keys(this._meters).forEach(key => {
        const m = this._meters[key];
        if (!m) return;
        m.analyser.getByteTimeDomainData(m.data);
        let sum = 0;
        for (let i = 0; i < m.data.length; i++) { const v = (m.data[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / m.data.length);
        const on = rms > 0.045 && !(key === 'me' && this._muted);
        if (!!this._speaking[key] !== on) { this._speaking[key] = on; changed = true; }
      });
      if (changed) this._paintDots();
      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
    this._startAudibilityGuard();
  },

  // KEEPING THE VOICES AUDIBLE, ON A TIMER RATHER THAN A FRAME.
  // Only a deliberate per-person mute may silence someone; anything else that
  // turned them down (a global "mute everything" added later, a stray volume
  // sweep) is undone here. Deliberately NOT part of the animation loop:
  // requestAnimationFrame stops dead while the tab is hidden, which is exactly
  // when a player has alt-tabbed and is relying on hearing the room. An
  // interval keeps running, so the guarantee holds whether or not anyone is
  // looking at the page.
  _startAudibilityGuard() {
    if (this._guardId) return;
    this._guardId = setInterval(() => {
      if (!this._active) return;
      Object.keys(this._audio).forEach(id => {
        const a = this._audio[id];
        if (!a) return;
        const want = !!this._peerMuted[id];
        if (a.muted !== want) a.muted = want;
        if (a.volume !== 1) a.volume = 1;
        // A paused element is silent too — an autoplay policy or a stray
        // pause() would otherwise take the room away with no way back.
        if (a.paused && a.srcObject) { const p = a.play(); if (p && p.catch) p.catch(() => {}); }
      });
    }, 500);
  },

  // ---- UI ----
  // The panel is built once and updated in place, so it survives the game's
  // full re-renders (which rebuild the board every frame) without flicker.
  mount() {
    if (!this._inOnlineMatch()) { this.unmount(); return; }
    let el = document.getElementById('voice-panel');
    if (!el) {
      el = document.createElement('div');
      el.id = 'voice-panel';
      el.className = 'voice-panel collapsed';
      document.body.appendChild(el);
    }
    this._paint();
  },
  unmount() {
    const el = document.getElementById('voice-panel');
    if (el) el.remove();
    if (this._active) this.leave();
  },
  toggleOpen() {
    const el = document.getElementById('voice-panel');
    if (el) el.classList.toggle('collapsed');
  },

  _participants() {
    const mine = (this._peer() || {}).id;
    const rows = [];
    Object.keys(this._roster).forEach(seat => {
      const id = this._roster[seat];
      if (!id) return;
      const isMe = id === mine;
      rows.push({
        id, seat, isMe,
        name: this._names[id] || (isMe ? this._myName() : seat),
        connected: isMe ? this._active : !!this._audio[id],
        muted: isMe ? this._muted : !!this._peerMuted[id],
        speaking: !!this._speaking[isMe ? 'me' : id],
      });
    });
    return rows;
  },

  _paint() {
    const el = document.getElementById('voice-panel');
    if (!el) return;
    const rows = this._participants();
    const others = rows.filter(r => !r.isMe && r.connected).length;
    const head = this._active
      ? `<span class="vp-live">● LIVE</span><span class="vp-count">${others + 1}</span>`
      : `<span class="vp-off">VOICE</span>`;
    const body = this._active
      ? rows.map(r => `
          <div class="vp-row${r.speaking ? ' vp-speaking' : ''}" data-peer="${r.id}">
            <i class="vp-dot"></i>
            <span class="vp-name">${String(r.name).replace(/</g, '&lt;')}${r.isMe ? ' <em>(you)</em>' : ''}</span>
            <button type="button" class="vp-mute${r.muted ? ' is-muted' : ''}"
              data-act="${r.isMe ? 'mute-self' : 'mute-peer'}" data-peer="${r.id}"
              title="${r.isMe ? (r.muted ? 'Unmute your microphone' : 'Mute your microphone')
                              : (r.muted ? 'Unmute this player' : 'Mute this player')}">
              ${r.muted ? '&#128263;' : '&#128266;'}
            </button>
          </div>`).join('')
        + `<button type="button" class="vp-btn vp-leave" data-act="leave">Leave voice</button>`
      : `<div class="vp-blurb">Talk to the room instead of calling each other.</div>
         <button type="button" class="vp-btn vp-join" data-act="join"${this._joining ? ' disabled' : ''}>
           ${this._joining ? 'Connecting…' : 'Join voice'}
         </button>`;
    el.innerHTML =
      `<button type="button" class="vp-head" data-act="toggle">${head}</button>
       <div class="vp-body">
         ${this._error ? `<div class="vp-err">${String(this._error).replace(/</g, '&lt;')}</div>` : ''}
         ${body}
       </div>`;
    el.querySelectorAll('[data-act]').forEach(b => {
      b.onclick = (ev) => {
        ev.stopPropagation();
        const act = b.getAttribute('data-act');
        if (act === 'toggle') this.toggleOpen();
        else if (act === 'join') this.join();
        else if (act === 'leave') this.leave();
        else if (act === 'mute-self') this.toggleMute();
        else if (act === 'mute-peer') this.togglePeerMute(b.getAttribute('data-peer'));
      };
    });
  },
  // Speaking dots change many times a second — repaint only those, never the
  // whole panel, so the buttons underneath never lose focus or flicker.
  _paintDots() {
    const el = document.getElementById('voice-panel');
    if (!el) return;
    const mine = (this._peer() || {}).id;
    el.querySelectorAll('.vp-row').forEach(row => {
      const id = row.getAttribute('data-peer');
      const on = !!this._speaking[id === mine ? 'me' : id];
      row.classList.toggle('vp-speaking', on);
    });
    const head = el.querySelector('.vp-live');
    if (head) head.classList.toggle('vp-live-hot', !!this._speaking.me);
  },
};

if (typeof window !== 'undefined') window.Voice = Voice;
