/**
 * VoiceControl
 * Wraps the browser's Web Speech API (browser-native; no cloud/paid SDK added).
 *
 * Hands-free flow for Iris:
 *  - The mic opens when start() is called (app.js calls it on load) and stays open.
 *    Whenever the browser ends a recognition session it is restarted automatically.
 *  - Saying "Iris" enters the listening phase the moment the word appears in an
 *    INTERIM transcript, so the eye reacts while the user is still talking.
 *  - "Iris play Believer" in one breath works exactly as before. "Iris" + a pause
 *    opens a short window in which the next utterance is taken as the command.
 *  - Background music can keep the recognizer from ever closing an utterance. Once
 *    words FOLLOW the wake word, the utterance is closed for the user after a short
 *    settle (stop() makes the recognizer return a final result), then recognition
 *    restarts by itself. A bare "Iris" is never force-closed (v6, see B4 below).
 *  - Phases are broadcast as `akon:phase` { phase: off|idle|listening|thinking|speaking }.
 *    They are UI-only; command handling is unchanged (callback(command, transcript, alts)).
 *
 * v6 (voice reliability):
 *  - B1 "iris iris" collapses to one wake word (it used to play the song "Iris").
 *  - B2 fuzzy wake on the first 1-3 words only (flag fuzzyWake), guarded by a stoplist
 *       and, for anything that is not an exact wake word, by an explicit command intent.
 *  - B3 every final transcript is logged (misses rate-limited); near-misses emit
 *       `iris:near-miss` so the UI can show "Almost heard: ...".
 *  - B4 no forced stop() after a bare wake word.
 *  - B5 the final dropping the wake word that the interim had no longer loses the command.
 *  - B6 audio-capture / InvalidStateError retries with backoff, a stall watchdog, and a
 *       250 ms minimum restart delay. Only a real permission denial keeps the mic off.
 *  - B8 listenNow() / cancelListening(): tap-to-talk with no wake word.
 *
 * Works best in Chrome/Edge (desktop). Safari/Firefox support is limited.
 */
const VoiceControl = (() => {
  // en-IN (not en-US): Indian-English recognition transcribes Hinglish titles
  // ("kesariya", "tum hi ho") far closer to Spotify's romanized titles than en-US.
  // Override with window.AKON_SPEECH_LANG = 'en-US' if most users are not in India.
  const LANG = window.AKON_SPEECH_LANG || 'en-IN';

  // Wake word is "Iris". Recognizers sometimes hear a near-miss, so a few are accepted.
  // "akon" is deliberately NOT here any more: it is now just an artist name, so
  // "Iris play Lonely by Akon" keeps Akon inside the command.
  const WAKE_WORDS = "iris(?:['’]s)?|irish|irris|irus|ires|ira['’]?s|eyeris";
  const WAKE_RE = new RegExp(`\\b(${WAKE_WORDS})\\b`);
  // B1: repeated LEADING wake words ("iris iris ...") collapse into one wake.
  const LEADING_WAKE_RE = new RegExp(`^(?:${WAKE_WORDS})\\b[\\s,.!?]*`);

  // B2: fuzzy wake. Applies only to the first 1-3 words and only to words of 4+ letters
  // within edit distance 1 of "iris"/"irish". Names and real words that sit that close
  // are excluded, and a fuzzy match must be bare or followed by an explicit command
  // ("eris play x" wakes, "eris is a goddess" does not). Tuned against test/voice.test.js.
  const FUZZY_STOP = new Set(['kris', 'cris', 'chris', 'tris', 'pris', 'bris', 'trish', 'idris', 'isis', 'ibis', 'irks', 'iron', 'aries', 'ares']);
  const FUZZY_JOINED = new Set(['ayris', 'airis', 'ayeris', 'eyris', 'aeris']);
  const FUZZY_SPLIT = [['i', 'wish'], ['eye', 'ris'], ['i', 'ris'], ['ai', 'ris'], ['aye', 'ris']];
  const LEAD_FILLER = new Set(['hey', 'hi', 'ok', 'okay', 'oh', 'yo', 'hello', 'so', 'and']);

  const WINDOW_MS = 8000;        // after a bare "Iris": how long the next utterance counts as the command
  const SETTLE_MS = 1400;        // interim text unchanged this long after the wake word -> close the utterance
  const MAX_UTTERANCE_MS = 7000; // hard cap once awake (music can keep an utterance open indefinitely)
  const RESPOND_MS = 2200;       // how long the responding ("speaking") phase shows before idle
  const MIN_RESTART_MS = 250;    // B6: never hammer start() back-to-back
  const STALL_MS = 25000;        // B6: no recognizer events for this long -> assume it died silently
  const WATCHDOG_EVERY_MS = 5000;
  const MISS_LOG_MS = 1500;      // B3: at most one "no wake word" log line per this interval

  let recognition = null;
  let enabled = false;          // mic should be running
  let blocked = false;          // browser refused the mic (permission / no gesture / no device)
  let onCommandCallback = null;

  let phase = 'off';
  let windowUntil = 0;          // command window after the wake word
  let wakeIdx = -1;             // result index whose interim contained the wake word
  let pending = null;           // { idx, text, cmd } unfinalized interim we are waiting on
  let settleTimer = null;
  let capTimer = null;
  let phaseTimer = null;
  let restartTimer = null;
  let restartDelay = 0;
  let sessionHadError = false;
  let cmdSeq = 0;

  let running = false;          // B6: between onstart and onend
  let lastEventAt = 0;          // B6: any recognizer event (watchdog input)
  let watchdogTimer = null;
  let captureFails = 0;         // B6: consecutive audio-capture errors
  let recoverTimer = null;
  let missLogAt = 0;
  let wakeFuzzy = false;        // the wake on wakeIdx was a fuzzy match (not an exact word)
  let everStarted = false;      // B6: a session has really started since start() (watchdog gate)
  let recovering = false;       // B6: automatic audio-capture retry in flight
  let missSuppressed = 0;

  const dlog = (msg, level) => window.AkonDebug && window.AkonDebug.log(msg, level);
  const emit = (name, detail) => {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch (e) { /* UI only */ }
  };
  const flag = (key, dflt) => {
    const f = window.IRIS_FLAGS || {};
    return Object.prototype.hasOwnProperty.call(f, key) ? !!f[key] : dflt;
  };
  const touch = () => { lastEventAt = Date.now(); };

  function setPhase(next, extra) {
    phase = next;
    emit('akon:phase', Object.assign({ phase: next }, extra || {}));
  }

  function init(onCommand) {
    onCommandCallback = onCommand;

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      alert('Speech recognition is not supported in this browser. Please use Chrome or Edge.');
      return false;
    }

    recognition = new SpeechRecognition();
    recognition.continuous = true;
    // Interim results let the wake word switch the UI to "listening" immediately,
    // instead of only after the whole sentence has been finalized.
    recognition.interimResults = true;
    recognition.lang = LANG;
    recognition.maxAlternatives = 4; // alternates are fed to the resolver as extra readings

    recognition.onresult = handleResult;

    recognition.onstart = () => {
      sessionHadError = false;
      running = true;
      everStarted = true;
      touch();
    };

    // B6: audio actually flowing = the mic works again; clear a "No microphone found" state.
    recognition.onaudiostart = () => {
      touch();
      // Ignore a late audiostart from a session that already failed (seen in the smoke
      // harness: it arrived after audio-capture and cancelled the recovery).
      if (!enabled) return;
      recovering = false;
      if (captureFails) {
        captureFails = 0;
        blocked = false;
        dlog('Microphone available again');
        if (phase === 'off' && enabled) setPhase('idle');
      }
    };
    recognition.onsoundstart = touch;
    recognition.onspeechstart = touch;

    recognition.onerror = (event) => {
      touch();
      // "no-speech" and "aborted" are normal/expected in continuous mode — ignore quietly
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        // Hands-free can't override a browser mic refusal. Stay off (no restart loop)
        // until the user allows the mic or presses "Turn on microphone".
        enabled = false;
        blocked = true;
        clearTimers();
        clearTimeout(recoverTimer);
        stopWatchdog();
        dlog(`Microphone unavailable (${event.error})`, 'warn');
        setPhase('off', { reason: 'blocked' });
        return;
      }
      if (event.error === 'audio-capture') {
        // B6: one capture glitch (device switch, Bluetooth reconnect) used to turn the mic
        // off for good. Show "No microphone found", but keep retrying with backoff.
        enabled = false;
        blocked = true;
        clearTimers();
        captureFails++;
        const wait = Math.min(1000 * Math.pow(2, captureFails - 1), 30000);
        dlog(`Microphone unavailable (audio-capture) — retrying in ${Math.round(wait / 1000)}s`, 'warn');
        setPhase('off', { reason: 'no-mic' });
        clearTimeout(recoverTimer);
        recoverTimer = setTimeout(() => {
          if (enabled) return; // already running again (mute and permission denial clear this timer)
          startRecognizer(true);
        }, wait);
        return;
      }
      sessionHadError = true;
      console.warn('Speech recognition error:', event.error);
    };

    // Browsers end recognition sessions on silence, on errors and after a time limit.
    // Restart so listening is continuous; back off if sessions keep failing (e.g. offline).
    recognition.onend = () => {
      running = false;
      touch();
      // An utterance we were waiting on ended without a final result: use its last interim
      // text — but only if it carries a command. A bare wake word left over from a window
      // that already lapsed must not re-open listening (v5 replayed it).
      if (enabled && pending) {
        const p = pending;
        pending = null;
        const r = interpret(p.text, awake());
        if (r && r.command) handleFinal([p.text], p.idx);
      }
      wakeIdx = -1; // result indices restart with every session
      if (!enabled) return;
      restartDelay = sessionHadError ? Math.min(Math.max(500, restartDelay * 2), 8000) : MIN_RESTART_MS;
      scheduleRestart();
    };

    return true;
  }

  function scheduleRestart() {
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      if (!enabled || running) return;
      try {
        recognition.start();
      } catch (e) {
        // B6: InvalidStateError while we believe the recognizer is NOT running means a
        // session is half-closed; retry with backoff instead of swallowing it (v5 gave up).
        if (e && e.name === 'InvalidStateError' && running) return;
        restartDelay = Math.min(Math.max(500, restartDelay * 2), 8000);
        dlog(`Recognizer restart failed (${(e && e.name) || 'error'}) — retrying in ${restartDelay} ms`, 'warn');
        scheduleRestart();
      }
    }, Math.max(MIN_RESTART_MS, restartDelay));
  }

  // B6: a recognizer can die without ever firing onend/onerror (seen after sleep/resume and
  // device switches). If nothing at all has happened for STALL_MS, abort and restart it.
  function startWatchdog() {
    clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(function check() {
      if (!enabled) return;
      // Not before the first real session: Chrome may be showing the permission prompt.
      if (everStarted && Date.now() - lastEventAt > STALL_MS) {
        dlog('Recognizer stalled (no events) — restarting it', 'warn');
        touch();
        running = false;
        try { recognition.abort(); } catch (e) { /* ignore */ }
        restartDelay = MIN_RESTART_MS;
        scheduleRestart();
      }
      watchdogTimer = setTimeout(check, WATCHDOG_EVERY_MS);
    }, WATCHDOG_EVERY_MS);
  }
  function stopWatchdog() {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }

  function clearTimers() {
    clearTimeout(settleTimer);
    clearTimeout(capTimer);
    clearTimeout(phaseTimer);
    clearTimeout(restartTimer);
    capTimer = null;
  }

  // ---------------------------------------------------------------- wake word matching

  function lev(a, b) {
    const d = [];
    for (let j = 0; j <= b.length; j++) d[j] = j;
    for (let i = 1; i <= a.length; i++) {
      let prev = d[0];
      d[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const t = d[j];
        d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = t;
      }
    }
    return d[b.length];
  }

  function tokens(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9'’ऀ-ॿ\s]/g, ' ').split(/\s+/).filter(Boolean);
  }

  function tidy(text) {
    return String(text || '')
      .trim()
      .replace(/^[,.!?\s]+/, '')
      .replace(/[.,!?]+$/, '')
      .trim();
  }

  // Collapse ONLY when the repeat is a stutter: "iris iris" (nothing after) or
  // "iris iris play x" (a clear command after). "Iris, Iris by Goo Goo Dolls" and
  // "Iris, Irish Rover" keep the song title, exactly as v5 did.
  function collapseLeadingWake(rest) {
    const original = tidy(rest);
    let r = original;
    let m;
    while ((m = LEADING_WAKE_RE.exec(r))) r = tidy(r.slice(m[0].length));
    if (r === original) return r;
    return !r || explicitCommand(r) ? r : original;
  }

  const allFiller = (toks) => toks.every((t) => LEAD_FILLER.has(t));

  // A real command, not just words: "play x", "pause", "volume up" — but not an implicit
  // song guess like "you were here". Used to keep fuzzy wakes from firing on chatter.
  function explicitCommand(text) {
    try {
      if (!window.AkonIntent) return false;
      const i = window.AkonIntent.extractIntent(text);
      return !!i && i.type !== 'unknown' && !(i.type === 'play_song' && i.implicit);
    } catch (e) {
      return false;
    }
  }

  function fuzzyToken(t) {
    const w = t.replace(/['’]s$/, '');
    if (FUZZY_JOINED.has(w)) return true;
    if (w.length < 4 || FUZZY_STOP.has(w)) return false;
    return lev(w, 'iris') <= 1 || lev(w, 'irish') <= 1;
  }

  // -> { kind: 'exact'|'fuzzy', before, rest, split } or null (no wake candidate at all)
  function findWake(text) {
    const m = WAKE_RE.exec(text);
    if (m) {
      return { kind: 'exact', before: tidy(text.slice(0, m.index)), rest: collapseLeadingWake(text.slice(m.index + m[0].length)) };
    }
    if (!flag('fuzzyWake', true)) return null;
    const tk = tokens(text);
    for (let p = 0; p < Math.min(3, tk.length); p++) {
      if (!allFiller(tk.slice(0, p))) break;
      const pair = FUZZY_SPLIT.find(([a, b]) => tk[p] === a && tk[p + 1] === b);
      if (pair) return { kind: 'fuzzy', split: true, before: tk.slice(0, p).join(' '), rest: collapseLeadingWake(tk.slice(p + 2).join(' ')) };
      if (fuzzyToken(tk[p])) return { kind: 'fuzzy', split: false, before: tk.slice(0, p).join(' '), rest: collapseLeadingWake(tk.slice(p + 1).join(' ')) };
    }
    return null;
  }

  function acceptWake(w) {
    if (!w) return false;
    if (w.kind === 'exact') return true;
    if (!w.rest) return !w.split;      // bare "eris" yes; bare "i wish" no
    return explicitCommand(w.rest);
  }

  // -> { wake: bool, command: string, near?: bool } or null when not addressed to Iris.
  function interpret(text, awakeNow) {
    const w = findWake(text);
    if (w && acceptWake(w)) {
      // Inside a command window, "play iris" / "play iris by goo goo dolls" is a song
      // request that happens to contain the wake word, not a fresh wake.
      const wordsBefore = tokens(w.before);
      if (awakeNow && wordsBefore.length && !allFiller(wordsBefore)) return { wake: false, command: tidy(text) };
      return { wake: true, command: w.rest };
    }
    if (awakeNow) return { wake: false, command: tidy(text) };
    return w ? { wake: false, command: '', near: true } : null;
  }

  // Text after the wake word, used for the recognizer's alternative readings.
  function afterWake(text) {
    const w = findWake(text);
    return w && acceptWake(w) ? w.rest : null;
  }

  // B5: the final dropped the wake word the interim had ("iris play x" -> "i risk play x").
  // Strip a leading 1-2 word prefix that sounds like the wake word (edit distance <= 3).
  function recoverDropped(text, lastInterimCmd) {
    const tk = tokens(text);
    let best = null;
    for (let n = 1; n <= Math.min(2, tk.length - 1); n++) {
      const joined = tk.slice(0, n).join('');
      const d = Math.min(lev(joined, 'iris'), lev(joined, 'irish'));
      if (d <= 3 && (!best || d < best.d || (d === best.d && n > best.n))) best = { n, d };
    }
    const command = best ? tk.slice(best.n).join(' ') : tidy(text);
    if (!command) return null;
    // Accept a clear command, or exactly what the interim already showed after "Iris".
    if (explicitCommand(command) || (lastInterimCmd && tidy(lastInterimCmd) === command)) return command;
    return null;
  }

  // B3: every final is visible in the debug log (misses rate-limited, trimmed).
  function logMiss(text, near) {
    if (near) emit('iris:near-miss', { text });
    const now = Date.now();
    if (now - missLogAt < MISS_LOG_MS) { missSuppressed++; return; }
    const extra = missSuppressed ? ` (+${missSuppressed} more)` : '';
    missSuppressed = 0;
    missLogAt = now;
    dlog(`Heard "${String(text).slice(0, 60)}" — ${near ? 'almost the wake word' : 'no wake word'}, ignored${extra}`);
  }

  // ---------------------------------------------------------------- phases

  function awake() {
    return phase === 'listening' && Date.now() < windowUntil;
  }

  // Keep the command window open at least `ms` from now; back to idle when it lapses.
  function armWindow(ms) {
    windowUntil = Math.max(windowUntil, Date.now() + ms);
    clearTimeout(phaseTimer);
    phaseTimer = setTimeout(() => {
      if (phase === 'listening') {
        windowUntil = 0;
        // A bare wake word still open in the recognizer (music can hold an utterance open)
        // must not re-trigger later with whatever is heard next in that same utterance.
        // Nothing new was recognized for the whole window, so discarding it is safe.
        if (pending && !pending.cmd) {
          pending = null;
          wakeIdx = -1;
          if (enabled && recognition) { try { recognition.abort(); } catch (e) { /* ignore */ } }
        }
        setPhase('idle');
      }
    }, windowUntil - Date.now());
  }

  function enterListening(extra) {
    windowUntil = 0;
    armWindow(WINDOW_MS);
    if (phase !== 'listening') {
      setPhase('listening', extra);
      // UI-only side effect (wake cue). Never affects command handling.
      emit('akon:wake', extra);
    }
  }

  // Ask the recognizer to finalize what it has (stop() returns a final result for the
  // audio so far; onend then restarts recognition). Replaces the old manual Stop click.
  function closeUtterance() {
    clearTimeout(settleTimer);
    clearTimeout(capTimer);
    capTimer = null;
    if (!enabled || !pending || !pending.cmd || !recognition) return; // B4: never for a bare wake
    dlog('Closing the utterance (no pause detected)');
    try { recognition.stop(); } catch (e) { /* ignore */ }
  }

  function handleResult(event) {
    touch();
    recovering = false; // results flowing = the recognizer is truly back
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      if (res.isFinal) {
        const transcripts = [];
        for (let k = 0; k < res.length; k++) {
          transcripts.push(String(res[k].transcript || '').trim().toLowerCase());
        }
        handleFinal(transcripts, i);
      } else {
        handleInterim(String((res[0] && res[0].transcript) || '').trim().toLowerCase(), i);
      }
    }
  }

  function handleInterim(text, idx) {
    if (!text || !enabled) return;
    // Only a DIFFERENT utterance counts as the follow-up to a wake: "eris" waking the eye
    // must not turn the rest of that same sentence ("eris is a goddess") into a command.
    const followUp = awake() && idx !== wakeIdx;
    const r = interpret(text, followUp);
    if (r && r.wake) {
      if (wakeIdx !== idx) wakeFuzzy = false;
      wakeIdx = idx;
      const w = findWake(text);
      wakeFuzzy = wakeFuzzy || !!(w && w.kind === 'fuzzy');
      enterListening();
    } else if (!followUp) {
      return; // not addressed to Iris
    }
    const cmd = (r && r.command) || '';

    if (!pending || pending.idx !== idx) {
      pending = { idx, text, cmd };
      clearTimeout(capTimer);
      capTimer = null;
    } else {
      pending.text = text;
      pending.cmd = cmd;
    }
    armWindow(SETTLE_MS + 1500); // a long command must not time out while it is being spoken

    emit('akon:hearing', { text: cmd });

    // B4: close early only once words follow the wake word. A bare "Iris" + pause used to
    // be force-stopped after 1.4 s, clipping the command the user was about to say.
    clearTimeout(settleTimer);
    if (cmd) {
      if (!capTimer) capTimer = setTimeout(closeUtterance, MAX_UTTERANCE_MS);
      settleTimer = setTimeout(closeUtterance, SETTLE_MS);
    }
  }

  function handleFinal(transcripts, idx) {
    let lastInterimCmd = '';
    if (pending && pending.idx === idx) {
      lastInterimCmd = pending.cmd;
      pending = null;
      clearTimeout(settleTimer);
      clearTimeout(capTimer);
      capTimer = null;
    }
    if (!enabled) return;

    const awakeNow = awake() && idx !== wakeIdx; // see handleInterim: same utterance is not a follow-up
    let transcript;
    let command;
    let alternatives;

    // Use the most confident transcript that contains the wake word.
    let primaryIdx = -1;
    let r = null;
    for (let k = 0; k < transcripts.length; k++) {
      const rk = interpret(transcripts[k], awakeNow);
      if (rk && rk.wake) { primaryIdx = k; r = rk; break; }
    }

    if (primaryIdx !== -1) {
      transcript = transcripts[primaryIdx];
      command = r.command;
      alternatives = transcripts
        .filter((_, i) => i !== primaryIdx)
        .map((t) => afterWake(t) || t)
        .filter((t) => t && t !== command);
      if (!command) {
        // Bare "Iris": listen for the command in the next utterance.
        enterListening();
        dlog(`Heard "${transcript}" -> listening for a command`);
        return;
      }
    } else if (idx === wakeIdx) {
      // B5: the interim had the wake word but the final dropped it. Recover the command
      // when it is unambiguous; otherwise the window stays open for a retry.
      wakeIdx = -1;
      transcript = transcripts[0];
      command = recoverDropped(transcript, lastInterimCmd);
      if (!command) {
        dlog(`Heard "${transcript}" (wake word dropped in final) — ignored`, 'warn');
        emit('iris:near-miss', { text: transcript });
        // A FUZZY wake ("eris ...") that the final turned down was never really "Iris":
        // close the window so the next sentence is not taken as a command.
        if (wakeFuzzy) cancelListening();
        return;
      }
      dlog(`Heard "${transcript}" (wake word dropped in final) -> recovered "${command}"`);
      alternatives = [];
    } else if (awakeNow) {
      // Follow-up utterance after a bare "Iris" (or a tap on Start listening).
      transcript = transcripts[0];
      command = tidy(transcript);
      alternatives = transcripts.slice(1).map(tidy).filter((t) => t && t !== command);
    } else {
      const near = interpret(transcripts[0], false);
      logMiss(transcripts[0], !!(near && near.near));
      return;
    }
    if (idx === wakeIdx) wakeIdx = -1;
    if (!command) return;

    dispatchCommand(command, transcript, alternatives);
  }

  function dispatchCommand(command, transcript, alternatives) {
    windowUntil = 0;
    clearTimeout(phaseTimer);

    if (window.AkonDebug) {
      window.AkonDebug.log(`Heard "${transcript}" -> command "${command}"` + (alternatives.length ? ` (alts: ${alternatives.join(' / ')})` : ''));
    }

    // UI-only side effect (history strip / searching skeleton).
    emit('akon:heard', { command, transcript });

    const seq = ++cmdSeq;
    setPhase('thinking', { command });

    let result;
    try {
      result = onCommandCallback ? onCommandCallback(command, transcript, alternatives) : null;
    } catch (err) {
      dlog(`Command "${command}" failed: ${err.message}`, 'error');
    }

    // When the command has been carried out, show the responding phase, then go back to
    // waiting for "Iris" — the mic never stopped, so the next command needs no click.
    Promise.resolve(result)
      .catch(() => {})
      .then(() => {
        if (seq !== cmdSeq || phase !== 'thinking') return; // superseded by a newer wake/command
        setPhase('speaking');
        clearTimeout(phaseTimer);
        phaseTimer = setTimeout(() => {
          if (phase === 'speaking') setPhase('idle');
        }, RESPOND_MS);
      });
  }

  // ---------------------------------------------------------------- public

  // quiet = an automatic recovery attempt: don't claim "idle" until audio actually flows.
  function startRecognizer(quiet) {
    if (!recognition) return false;
    enabled = true;
    blocked = false;
    recovering = !!quiet;
    everStarted = false;
    restartDelay = 0;
    clearTimeout(restartTimer);
    clearTimeout(recoverTimer);
    touch();
    try {
      recognition.start();
    } catch (e) {
      // Already started is fine. Anything else (or a half-closed session): retry shortly.
      if (!(e && e.name === 'InvalidStateError' && running)) scheduleRestart();
    }
    startWatchdog();
    if (!quiet) setPhase('idle');
    return true;
  }

  function start() {
    captureFails = 0;
    return startRecognizer(false);
  }

  // Manual mute. abort() (not stop()) so half-heard speech is discarded, not executed.
  function stop() {
    enabled = false;
    recovering = false;
    clearTimers();
    clearTimeout(recoverTimer);
    stopWatchdog();
    windowUntil = 0;
    pending = null;
    wakeIdx = -1;
    if (recognition) {
      try { recognition.abort(); } catch (e) { /* ignore */ }
    }
    setPhase('off', { reason: 'muted' });
  }

  // B8: tap-to-talk. Ensures the mic is running (a tap is a valid gesture), opens the
  // command window, and takes the next sentence as the command with no wake word.
  function listenNow() {
    if (!recognition) return false;
    if (!enabled) start();
    windowUntil = 0;
    enterListening({ reason: 'manual' });
    dlog('Listening (tap) — say the command');
    return true;
  }

  function cancelListening() {
    windowUntil = 0;
    clearTimeout(phaseTimer);
    clearTimeout(settleTimer);
    clearTimeout(capTimer);
    capTimer = null;
    pending = null;
    wakeIdx = -1;
    if (phase === 'listening') setPhase('idle', { reason: 'cancelled' });
  }

  return {
    init,
    start,
    stop,
    listenNow,
    cancelListening,
    getPhase: () => phase,
    isEnabled: () => enabled && !recovering,
    isBlocked: () => blocked
  };
})();
