/**
 * Iris "The Stage" (v6) — UI layer only.
 *
 * Rules (same as polish.js):
 *  - Only LISTENS to akon:* events, AkonDebug lines and existing DOM text. It talks back to
 *    the app through two new events — `iris:listen` (start/cancel tap-to-talk) and
 *    `iris:select` {index} (a tapped "Did you mean" card) — handled by tiny listeners in
 *    app.js that call EXISTING logic. Dock buttons call the same SpotifyController
 *    functions as voice and the keyboard.
 *  - Every feature is isolated, wrapped in try/catch and checks its flag in flags.js.
 *  - No microphone access, no network calls (the art tint reads an already-allowed
 *    Spotify image), no timers that poll anything.
 */
(() => {
  const body = document.body;
  const $ = (id) => document.getElementById(id);
  const F = () => window.IRIS_FLAGS || {};
  const flag = (k, d = true) => (Object.prototype.hasOwnProperty.call(F(), k) ? !!F()[k] : d);
  const warn = (where, err) => { try { console.warn('[Iris stage]', where, err); } catch (e) { /* ignore */ } };
  const on = (name, fn) => window.addEventListener(name, (e) => { try { fn((e && e.detail) || {}); } catch (err) { warn(name, err); } });
  const emit = (name, detail) => { try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (e) { /* ignore */ } };
  const ctl = () => (typeof SpotifyController !== 'undefined' ? SpotifyController : null);
  const call = (fn, ...args) => {
    const c = ctl();
    if (!c || typeof c[fn] !== 'function') return;
    Promise.resolve().then(() => c[fn](...args)).catch((err) => warn(fn, err));
  };
  const feature = (name, fn) => { try { fn(); } catch (err) { warn(name, err); } };
  const fmt = (ms) => {
    const s = Math.max(0, Math.floor((ms || 0) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const reduceMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const S = { phase: 'off', reason: 'login', signedIn: false, hasTrack: false, playing: false };

  // ------------------------------------------------------------ flags -> body classes
  feature('flags', () => {
    body.classList.toggle('arc-on', flag('arc'));
    body.classList.toggle('tint', flag('tint'));
    body.classList.toggle('ambient-on', flag('ambient'));
    body.classList.toggle('no-drawer', !flag('diagnostics'));
  });

  // ------------------------------------------------------------ notes under the eye
  // One quiet line; the most important message wins (premium > auth > autoplay > mic > ...).
  const notes = {};
  function renderNote() {
    const el = $('stageNote');
    if (!el) return;
    let best = null;
    Object.keys(notes).forEach((k) => { if (!best || notes[k].prio > best.prio) best = notes[k]; });
    el.textContent = best ? best.text : '';
    el.dataset.kind = best ? best.kind || '' : '';
  }
  function setNote(key, text, kind, prio, ms) {
    if (!text) delete notes[key];
    else {
      notes[key] = { text, kind, prio: prio || 0 };
      if (ms) setTimeout(() => { if (notes[key] && notes[key].text === text) { delete notes[key]; renderNote(); } }, ms);
    }
    renderNote();
  }

  // ------------------------------------------------------------ signed in / out
  feature('signedIn', () => {
    const app = $('app');
    if (!app) return;
    const sync = () => {
      S.signedIn = !app.classList.contains('hidden');
      body.classList.toggle('signed-in', S.signedIn);
      firstRunTick();
      connectingNote();
    };
    new MutationObserver(sync).observe(app, { attributes: true, attributeFilter: ['class'] });
    sync();
  });

  // "Connecting player..." until app.js reports the SDK device ready.
  function connectingNote() {
    const st = $('listeningStatus');
    const ready = st && /ready/i.test(st.textContent);
    setNote('player', S.signedIn && !ready ? 'Connecting the Spotify player…' : '', '', 1);
  }
  feature('connecting', () => {
    const st = $('listeningStatus');
    if (st) new MutationObserver(connectingNote).observe(st, { childList: true, characterData: true, subtree: true });
  });

  // ------------------------------------------------------------ caption cross-fade (iris.js owns the text)
  feature('caption', () => {
    const cap = $('phaseCaption');
    if (!cap) return;
    let last = cap.textContent;
    new MutationObserver(() => {
      if (cap.textContent === last) return;
      last = cap.textContent;
      if (reduceMotion()) return;
      cap.classList.remove('swap');
      void cap.offsetWidth; // restart the animation
      cap.classList.add('swap');
    }).observe(cap, { childList: true, characterData: true, subtree: true });
  });

  // ------------------------------------------------------------ mic pill
  const PILL = {
    ready: 'Ready', listening: 'Listening', muted: 'Muted', blocked: 'Blocked', 'no-mic': 'No mic', starting: 'Starting'
  };
  function pillState() {
    if (S.phase === 'listening') return 'listening';
    if (S.phase === 'off') {
      if (S.reason === 'muted') return 'muted';
      if (S.reason === 'blocked') return 'blocked';
      if (S.reason === 'no-mic') return 'no-mic';
      return 'starting';
    }
    return 'ready';
  }
  function renderPill() {
    const pill = $('micPill');
    if (!pill) return;
    const st = pillState();
    pill.dataset.state = st;
    const label = $('micPillLabel');
    if (label) label.textContent = PILL[st];
    const retry = $('micRetry');
    if (retry) retry.classList.toggle('hidden', !(st === 'blocked' || st === 'no-mic'));
    // Blocked: iris.js's caption already says how to fix it; the pill offers Retry.
    if (st === 'no-mic') setNote('mic', 'No microphone found. Plug one in or choose it in your system settings. Iris keeps checking.', 'warn', 6);
    else setNote('mic', '');
  }
  feature('micRetry', () => {
    const retry = $('micRetry');
    if (!retry) return;
    retry.addEventListener('click', () => {
      try { if (typeof VoiceControl !== 'undefined') VoiceControl.start(); } catch (err) { warn('retry', err); }
    });
  });

  on('akon:phase', (d) => {
    S.phase = d.phase || 'idle';
    if (S.phase === 'off' && d.reason) S.reason = d.reason;
    renderPill();
    if (S.phase !== 'off') firstRunMark('mic');
    if (S.phase === 'listening') setNote('near', '');
  });

  // ------------------------------------------------------------ tap the eye = talk
  feature('eyeTap', () => {
    const eye = $('stage');
    if (!eye) return;
    const talk = () => { if (S.signedIn) emit('iris:listen', { source: 'eye' }); };
    eye.addEventListener('click', (e) => {
      talk();
      if (e.detail > 0) eye.blur(); // after a mouse/touch tap, Space goes back to play/pause
    });
    eye.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.code !== 'Space') return;
      e.preventDefault();
      e.stopPropagation(); // Space here means "talk", not polish.js's play/pause
      talk();
    });
    const label = () => eye.setAttribute('aria-label', S.phase === 'listening' ? 'Stop listening' : 'Talk to Iris');
    on('akon:phase', label);
  });

  // ------------------------------------------------------------ near-miss line (B3)
  on('iris:near-miss', ({ text }) => {
    if (!flag('nearMiss') || !text || S.phase === 'off') return;
    const t = String(text).slice(0, 48);
    setNote('near', `Almost heard: “${t}”. Start with “Iris”.`, 'near', 2, 4000);
  });

  // ------------------------------------------------------------ server waking (B11, app.js)
  on('iris:server', ({ state }) => {
    const n = $('serverNote');
    if (!n) return;
    if (state === 'down') n.textContent = 'Could not reach the server. Reload the page to try again.';
    n.classList.toggle('hidden', state !== 'waking' && state !== 'down');
  });

  // ------------------------------------------------------------ AkonDebug tap (read-only)
  // Premium / auth errors and the volume level only exist as log lines today.
  let volFromLog = null;
  feature('logTap', () => {
    const D = window.AkonDebug;
    if (!D || D.__staged) return;
    const orig = D.log;
    D.log = function (msg) {
      const r = orig.apply(this, arguments);
      try {
        const m = String(msg);
        let v;
        if (/SDK account error/.test(m)) setNote('premium', 'Spotify Premium is required to play music here.', 'error', 9);
        else if (/SDK auth error/.test(m)) setNote('auth', 'Spotify sign-in expired. Reload the page to reconnect.', 'error', 8);
        else if ((v = m.match(/^Volume set to (\d+)%/))) { volFromLog = Number(v[1]); syncVol(); }
      } catch (e) { /* ignore */ }
      return r;
    };
    D.__staged = true;
  });

  // ------------------------------------------------------------ autoplay blocked
  on('akon:autoplay-blocked', () => {
    setNote('autoplay', 'Tap anywhere to allow sound.', 'warn', 7);
    const clear = () => {
      setNote('autoplay', '');
      window.removeEventListener('pointerdown', clear, true);
      window.removeEventListener('keydown', clear, true);
    };
    window.addEventListener('pointerdown', clear, true);
    window.addEventListener('keydown', clear, true);
  });

  // ------------------------------------------------------------ dock: track, transport, volume, progress
  const prog = { pos: 0, dur: 0, at: 0 };
  let raf = 0;
  let lastArt = null;

  function largestImage(images) {
    if (!images || !images.length) return null;
    return images.slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0].url;
  }

  function renderProgress() {
    const now = performance.now();
    const pos = S.playing ? Math.min(prog.dur, prog.pos + (now - prog.at)) : prog.pos;
    const frac = prog.dur > 0 ? Math.max(0, Math.min(1, pos / prog.dur)) : 0;
    const bar = $('dockBar');
    if (bar) bar.style.transform = `scaleX(${frac})`;
    const el = $('dockElapsed');
    if (el) el.textContent = fmt(pos);
    const tot = $('dockTotal');
    if (tot) tot.textContent = fmt(prog.dur);
    if (flag('arc')) {
      const arc = $('arcFill');
      if (arc) arc.style.strokeDashoffset = String(1000 * (1 - frac));
    }
  }
  // Local interpolation ONLY while playing and visible; snaps to truth on every state event.
  function loop() {
    raf = 0;
    renderProgress();
    if (S.playing && !document.hidden) raf = requestAnimationFrame(loop);
  }
  function kick() {
    if (!raf && S.playing && !document.hidden) raf = requestAnimationFrame(loop);
    else renderProgress();
  }
  document.addEventListener('visibilitychange', () => { try { kick(); } catch (e) { /* ignore */ } });

  on('akon:state', (st) => {
    const track = st.track_window && st.track_window.current_track;
    S.hasTrack = !!track;
    S.playing = !!track && !st.paused;
    body.classList.toggle('has-track', S.hasTrack);
    if (track) body.classList.remove('is-resolving');
    const title = $('dockTitle');
    const artist = $('dockArtist');
    if (title) title.textContent = track ? track.name : 'Nothing playing';
    if (artist) artist.textContent = track ? (track.artists || []).map((a) => a.name).join(', ') : '';
    const play = $('dockPlay');
    if (play) {
      play.classList.toggle('is-playing', S.playing);
      play.setAttribute('aria-label', S.playing ? 'Pause' : 'Play');
    }
    prog.pos = Number(st.position) || 0;
    prog.dur = Number(st.duration) || 0;
    prog.at = performance.now();
    kick();
    if (track) setArtTint(largestImage(track.album && track.album.images));
    if (track && !volInit) initVol();
  });

  feature('transport', () => {
    const bind = (id, fn) => {
      const b = $(id);
      if (!b) return;
      b.addEventListener('click', (e) => {
        fn();
        if (e.detail > 0) b.blur(); // keep Space/arrow shortcuts working after a mouse click
      });
    };
    bind('dockPlay', () => call(S.playing ? 'pause' : 'resume'));
    bind('dockNext', () => call('nextTrack'));
    bind('dockPrev', () => call('previousTrack'));
    const meta = $('dockMeta');
    const dock = $('dock');
    if (meta && dock) {
      meta.addEventListener('click', () => {
        const open = !dock.classList.contains('expanded');
        dock.classList.toggle('expanded', open);
        meta.setAttribute('aria-expanded', String(open));
      });
    }
    // Keep --dock-h in sync so cards and toasts sit just above the dock.
    if (dock && window.ResizeObserver) {
      new ResizeObserver(() => {
        document.documentElement.style.setProperty('--dock-h', `${Math.round(dock.getBoundingClientRect().height)}px`);
      }).observe(dock);
    }
  });

  // Volume slider: reads the real level once, follows "Volume set to N%" log lines, and
  // writes through SpotifyController.setVolume (the same call as "Iris, volume 40").
  let volInit = false;
  let volDragging = false;
  let volTimer = null;
  function syncVol() {
    const input = $('dockVol');
    if (input && !volDragging && volFromLog !== null) input.value = String(volFromLog);
  }
  function initVol() {
    const c = ctl();
    if (!c || typeof c.getVolume !== 'function') return;
    volInit = true;
    Promise.resolve(c.getVolume()).then((v) => {
      if (typeof v === 'number' && volFromLog === null) { volFromLog = v; syncVol(); }
    }).catch(() => {});
  }
  feature('volume', () => {
    const input = $('dockVol');
    if (!input) return;
    input.addEventListener('pointerdown', () => { volDragging = true; });
    window.addEventListener('pointerup', () => { volDragging = false; });
    input.addEventListener('input', () => {
      clearTimeout(volTimer);
      volTimer = setTimeout(() => {
        try { if (window.IrisDuck) window.IrisDuck.cancel('volume slider'); } catch (e) { /* ignore */ }
        call('setVolume', Number(input.value));
      }, 150);
    });
  });

  // Searching: show the dock (with its skeleton) while a song request resolves.
  let resolvingTimer = null;
  const stopResolving = () => { clearTimeout(resolvingTimer); body.classList.remove('is-resolving'); };
  on('akon:heard', ({ command }) => {
    hideChoices();
    let intent = null;
    try { intent = window.AkonIntent ? window.AkonIntent.extractIntent(command || '') : null; } catch (e) { /* ignore */ }
    if (intent && intent.type === 'play_song') {
      body.classList.add('is-resolving');
      clearTimeout(resolvingTimer);
      resolvingTimer = setTimeout(stopResolving, 12000);
    }
  });
  on('akon:match', (m) => { stopResolving(); markCurrent(m); if (m.art) setArtTint(m.art); });
  on('akon:resolved', () => stopResolving());

  // ------------------------------------------------------------ art-tinted atmosphere (flag: tint)
  function setArtTint(url) {
    if (!flag('tint') || !url || url === lastArt) return;
    lastArt = url;
    try {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = c.height = 16;
          const g = c.getContext('2d');
          g.drawImage(img, 0, 0, 16, 16);
          const d = g.getImageData(0, 0, 16, 16).data; // throws if the image is not CORS-clean
          let r = 0;
          let gg = 0;
          let b = 0;
          let w = 0;
          for (let i = 0; i < d.length; i += 4) {
            const mx = Math.max(d[i], d[i + 1], d[i + 2]);
            const mn = Math.min(d[i], d[i + 1], d[i + 2]);
            const wt = 0.15 + (mx - mn) / 255 + mx / 512; // prefer colourful, bright pixels
            r += d[i] * wt; gg += d[i + 1] * wt; b += d[i + 2] * wt; w += wt;
          }
          r /= w; gg /= w; b /= w;
          // Lift dark covers toward bone so the ring stays visible on black.
          const lum = (0.2126 * r + 0.7152 * gg + 0.0722 * b) / 255;
          const k = lum < 0.45 ? Math.min(0.6, 0.45 - lum + 0.2) : 0;
          const sr = Math.round(r + (236 - r) * k);
          const sg = Math.round(gg + (231 - gg) * k);
          const sb = Math.round(b + (223 - b) * k);
          const root = document.documentElement.style;
          root.setProperty('--art', `rgb(${Math.round(r)}, ${Math.round(gg)}, ${Math.round(b)})`);
          root.setProperty('--art-glow', `rgba(${sr}, ${sg}, ${sb}, 0.2)`);
          root.setProperty('--art-strong', `rgb(${sr}, ${sg}, ${sb})`);
          body.classList.add('has-art');
        } catch (err) {
          body.classList.remove('has-art'); // pixel reads blocked: stay amber/slate
        }
      };
      img.onerror = () => body.classList.remove('has-art');
      img.src = url;
    } catch (err) {
      body.classList.remove('has-art');
    }
  }

  // ------------------------------------------------------------ did you mean (flag: didYouMean)
  const WORDS = ['one', 'two', 'three'];
  let choiceTimer = null;
  let shown = [];
  function hideChoices() {
    const box = $('choices');
    clearTimeout(choiceTimer);
    shown = [];
    if (box) { box.classList.add('hidden'); box.textContent = ''; }
    body.classList.remove('has-choices');
  }
  function markCurrent(m) {
    const box = $('choices');
    if (!box || !m) return;
    [...box.children].forEach((el) => {
      const opt = shown[Number(el.dataset.index)] || {};
      el.setAttribute('aria-current', String(opt.name === m.name && (opt.artists || []).join(', ') === m.artist));
    });
  }
  on('akon:resolved', ({ action, options }) => {
    if (!flag('didYouMean')) return;
    const box = $('choices');
    if (!box) return;
    const list = Array.isArray(options) ? options : [];
    let items = [];
    if (action === 'choose') items = list.map((o, i) => ({ o, i }));
    else if (action === 'play') items = list.slice(1).map((o, i) => ({ o, i: i + 1 }));
    items = items.filter((x) => x.o && x.i < WORDS.length);
    if (!items.length) { hideChoices(); return; }
    shown = list;
    box.textContent = '';
    items.forEach(({ o, i }) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'choice';
      b.dataset.index = String(i);
      b.setAttribute('aria-current', String(action === 'play' && i === 0));
      b.setAttribute('aria-label', `Play ${o.name} by ${(o.artists || []).join(', ')} (option ${WORDS[i]})`);
      const img = document.createElement('img');
      img.className = 'choice-art';
      img.alt = '';
      if (o.art) img.src = o.art;
      img.addEventListener('error', () => { img.removeAttribute('src'); });
      const t = document.createElement('span');
      t.className = 'choice-title';
      t.textContent = o.name || '';
      const a = document.createElement('span');
      a.className = 'choice-artist';
      a.textContent = (o.artists || []).join(', ');
      const s = document.createElement('span');
      s.className = 'choice-say';
      s.textContent = `Say “option ${WORDS[i]}”`;
      b.append(img, t, a, s);
      b.addEventListener('click', () => {
        [...box.children].forEach((el) => el.setAttribute('aria-current', String(el === b)));
        emit('iris:select', { index: i });
        if (S.phase !== 'off') firstRunDone();
      });
      box.appendChild(b);
    });
    box.classList.remove('hidden');
    body.classList.add('has-choices');
    clearTimeout(choiceTimer);
    choiceTimer = setTimeout(hideChoices, 60000); // app.js forgets the options after 60 s too
  });

  // ------------------------------------------------------------ first run (flag: firstRun)
  const FR_KEY = 'iris.firstRunDone';
  let frActive = false;
  const frDone = () => { try { return window.localStorage.getItem(FR_KEY) === '1'; } catch (e) { return false; } };
  feature('firstRun', () => {
    if (!flag('firstRun') || frDone()) return;
    const el = $('firstRun');
    if (!el) return;
    frActive = true;
    el.classList.remove('hidden');
    firstRunTick();
  });
  function firstRunMark(step) {
    if (!frActive) return;
    const li = document.querySelector(`#firstRun [data-step="${step}"]`);
    if (li) li.classList.add('done');
  }
  function firstRunTick() { if (S.signedIn) firstRunMark('connect'); }
  function firstRunDone() {
    if (!frActive) return;
    frActive = false;
    ['connect', 'mic', 'wake'].forEach((s) => { const li = document.querySelector(`#firstRun [data-step="${s}"]`); if (li) li.classList.add('done'); });
    try { window.localStorage.setItem(FR_KEY, '1'); } catch (e) { /* ignore */ }
    const el = $('firstRun');
    if (!el) return;
    setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => el.classList.add('hidden'), reduceMotion() ? 0 : 650);
    }, 900);
  }
  on('akon:wake', () => firstRunMark('wake'));
  on('akon:match', () => firstRunDone());
  let heardSinceWake = false;
  on('akon:heard', () => { heardSinceWake = true; });
  on('akon:phase', ({ phase }) => { if (phase === 'speaking' && heardSinceWake) { heardSinceWake = false; firstRunDone(); } });

  // ------------------------------------------------------------ ambient mode (flag: ambient)
  let wakeLock = null;
  let cursorTimer = null;
  async function lockScreen() {
    try {
      if (navigator.wakeLock && typeof navigator.wakeLock.request === 'function' && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      }
    } catch (e) { wakeLock = null; }
  }
  function unlockScreen() {
    try { if (wakeLock) wakeLock.release(); } catch (e) { /* ignore */ }
    wakeLock = null;
  }
  function cursorWake() {
    body.classList.remove('cursor-idle');
    clearTimeout(cursorTimer);
    if (body.classList.contains('ambient')) cursorTimer = setTimeout(() => body.classList.add('cursor-idle'), 3000);
  }
  function setAmbient(onOff) {
    body.classList.toggle('ambient', onOff);
    const btn = $('ambientBtn');
    if (btn) btn.setAttribute('aria-pressed', String(onOff));
    if (onOff) { lockScreen(); cursorWake(); } else { unlockScreen(); clearTimeout(cursorTimer); body.classList.remove('cursor-idle'); }
  }
  feature('ambient', () => {
    if (!flag('ambient')) return;
    const btn = $('ambientBtn');
    if (!btn) return;
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', (e) => { e.stopPropagation(); setAmbient(true); });
    // Any tap exits (and does nothing else); Esc exits.
    document.addEventListener('click', (e) => {
      if (!body.classList.contains('ambient')) return;
      e.preventDefault();
      e.stopPropagation();
      setAmbient(false);
    }, true);
    document.addEventListener('mousemove', () => { if (body.classList.contains('ambient')) cursorWake(); }, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) unlockScreen();
      else if (body.classList.contains('ambient')) lockScreen();
    });
  });

  // ------------------------------------------------------------ diagnostics drawer (flag: diagnostics)
  function setDrawer(open) {
    const d = $('diag');
    const btn = $('diagBtn');
    if (!d || body.classList.contains('no-drawer')) return;
    d.classList.toggle('open', open);
    if (btn) btn.setAttribute('aria-expanded', String(open));
    try {
      if (open) { const c = $('diagClose'); if (c) c.focus({ preventScroll: true }); } else if (btn && d.contains(document.activeElement)) btn.focus({ preventScroll: true });
    } catch (e) { /* ignore */ }
  }
  feature('drawer', () => {
    if (!flag('diagnostics')) return;
    const btn = $('diagBtn');
    const close = $('diagClose');
    if (btn) btn.addEventListener('click', () => setDrawer(!$('diag').classList.contains('open')));
    if (close) close.addEventListener('click', () => setDrawer(false));
  });

  document.addEventListener('keydown', (e) => {
    try {
      if (e.key !== 'Escape') return;
      if (body.classList.contains('ambient')) setAmbient(false);
      else if ($('diag') && $('diag').classList.contains('open')) setDrawer(false);
    } catch (err) { warn('esc', err); }
  });

  renderPill();
  renderNote();
})();
