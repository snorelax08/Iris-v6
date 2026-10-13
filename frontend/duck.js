/**
 * IrisDuck (v6, B7) — lower the music while Iris is listening, then put it back.
 *
 * Why: music playing at full volume is the main reason the recognizer mishears the
 * command after "Iris". Ducking to 25% for the few seconds of the command helps it.
 *
 * Rules (each one is a test in test/duck.test.js):
 *  - Duck only when a track is playing and the volume is above 25% (never when muted).
 *  - Restore when the command starts (phase -> thinking), when listening ends without a
 *    command (idle/off, which includes the mic being muted), when the tab is hidden, and
 *    after 12 s at most.
 *  - Never restore over a volume command: "volume 40" / "unmute" / the dock slider set
 *    their own level, so the saved level is dropped instead of restored.
 *  - "volume up/down" are relative, so the level is restored FIRST and the command then
 *    reads the real level (the SDK handles setVolume/getVolume in order).
 * Only listens to existing akon:* events; touches nothing else. Flag: duck.
 */
const IrisDuck = (() => {
  const LEVEL = 25;
  const MAX_MS = 12000;
  const NO_RESTORE = new Set(['volume_set', 'unmute']);

  let active = false;
  let prev = null;
  let gen = 0;
  let timer = null;
  let playing = false;

  const flag = () => {
    const f = window.IRIS_FLAGS || {};
    return Object.prototype.hasOwnProperty.call(f, 'duck') ? !!f.duck : true;
  };
  const dlog = (m, l) => { try { window.AkonDebug && window.AkonDebug.log(m, l); } catch (e) { /* ignore */ } };
  const ctl = () => (typeof SpotifyController !== 'undefined' ? SpotifyController : null);

  async function duck() {
    const c = ctl();
    if (!flag() || active || !playing || !c) return;
    const g = ++gen;
    let v = null;
    try { v = await c.getVolume(); } catch (e) { return; }
    // Released while we were reading, muted, or already quiet: leave the volume alone.
    if (g !== gen || v === null || v <= LEVEL) return;
    active = true;
    prev = v;
    clearTimeout(timer);
    timer = setTimeout(() => release('timeout'), MAX_MS);
    try {
      await c.setVolume(LEVEL, { quiet: true });
      dlog(`Lowered music ${v}% -> ${LEVEL}% while listening`);
    } catch (e) {
      active = false;
      prev = null;
    }
  }

  // restore=false: forget the saved level (a volume command chose its own).
  function release(reason, restore = true) {
    gen++;
    clearTimeout(timer);
    if (!active) return Promise.resolve(null);
    active = false;
    const p = prev;
    prev = null;
    const c = ctl();
    if (!restore || p === null || !c) {
      dlog(`Dropped the saved music level (${reason})`);
      return Promise.resolve(null);
    }
    dlog(`Restored music to ${p}% (${reason})`);
    return Promise.resolve(c.setVolume(p, { quiet: true })).catch(() => {}).then(() => p);
  }

  const on = (name, fn) => {
    try {
      window.addEventListener(name, (e) => { try { fn((e && e.detail) || {}); } catch (err) { /* never break voice */ } });
    } catch (e) { /* ignore */ }
  };

  on('akon:state', (st) => {
    const track = st.track_window && st.track_window.current_track;
    playing = !!track && !st.paused;
  });
  on('akon:wake', () => { duck(); });
  on('akon:phase', ({ phase, command }) => {
    if (phase === 'thinking') {
      let type = null;
      try { type = window.AkonIntent ? window.AkonIntent.extractIntent(command || '').type : null; } catch (e) { /* ignore */ }
      release(`command "${command || ''}"`, !NO_RESTORE.has(type));
    } else if (phase === 'idle' || phase === 'off') {
      release(phase === 'off' ? 'microphone off' : 'stopped listening');
    }
  });
  try {
    document.addEventListener('visibilitychange', () => { if (document.hidden) release('tab hidden'); });
  } catch (e) { /* ignore */ }

  return {
    duck,
    release,
    cancel: (reason) => release(reason || 'volume changed by hand', false),
    isActive: () => active
  };
})();
window.IrisDuck = IrisDuck;
