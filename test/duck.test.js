// Run with: npm test  — the REAL frontend/duck.js against a fake SpotifyController (SDK
// semantics: setVolume/getVolume resolve in call order). Proves the duck/restore rules,
// not real Spotify audio levels.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'duck.js'), 'utf8');
const INTENT = fs.readFileSync(path.join(__dirname, '..', 'shared', 'intent.js'), 'utf8');

function env(opts = {}) {
  const listeners = {};
  const docListeners = {};
  const timers = [];
  const calls = [];
  let vol = opts.vol === undefined ? 70 : opts.vol;
  const ctx = {
    console,
    Promise,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    addEventListener: (n, f) => { (listeners[n] = listeners[n] || []).push(f); },
    document: { hidden: false, addEventListener: (n, f) => { (docListeners[n] = docListeners[n] || []).push(f); } },
    AkonDebug: { log() {} },
    IRIS_FLAGS: opts.flags,
    SpotifyController: {
      getVolume: async () => vol,
      setVolume: async (v, o) => { calls.push(`${v}${o && o.quiet ? 'q' : ''}`); vol = v; return true; }
    }
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(INTENT, ctx);
  vm.runInContext(SRC, ctx);
  const fire = (n, detail) => (listeners[n] || []).forEach((f) => f({ detail }));
  const settle = () => new Promise((r) => setImmediate(r));
  const playing = (p = true) => fire('akon:state', { paused: !p, track_window: { current_track: { name: 'x' } } });
  return { ctx, fire, settle, playing, calls, vol: () => vol, timers, docFire: (n) => (docListeners[n] || []).forEach((f) => f()) };
}

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`PASS  duck ${name}`); } catch (e) { failed++; console.log(`FAIL  duck ${name}\n      ${e.message}`); }
}
const eq = (a, b, w) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${w}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

(async () => {
  await test('wake while playing at 70% ducks to 25% quietly, command restores 70%', async () => {
    const e = env(); e.playing();
    e.fire('akon:wake'); await e.settle();
    eq(e.calls, ['25q'], 'after wake');
    e.fire('akon:phase', { phase: 'thinking', command: 'pause' }); await e.settle();
    eq(e.calls, ['25q', '70q'], 'after command');
  });
  await test('no duck when paused', async () => {
    const e = env(); e.playing(false);
    e.fire('akon:wake'); await e.settle();
    eq(e.calls, [], 'calls');
  });
  await test('no duck when volume already <= 25% or muted', async () => {
    for (const v of [25, 10, 0]) {
      const e = env({ vol: v }); e.playing();
      e.fire('akon:wake'); await e.settle();
      eq(e.calls, [], `calls at ${v}%`);
    }
  });
  await test('listening ends without a command -> restore', async () => {
    const e = env(); e.playing();
    e.fire('akon:wake'); await e.settle();
    e.fire('akon:phase', { phase: 'idle' }); await e.settle();
    eq(e.calls, ['25q', '70q'], 'calls');
  });
  await test('mic muted while ducked -> restore', async () => {
    const e = env(); e.playing();
    e.fire('akon:wake'); await e.settle();
    e.fire('akon:phase', { phase: 'off', reason: 'muted' }); await e.settle();
    eq(e.vol(), 70, 'volume');
  });
  await test('tab hidden while ducked -> restore', async () => {
    const e = env(); e.playing();
    e.fire('akon:wake'); await e.settle();
    e.ctx.document.hidden = true; e.docFire('visibilitychange'); await e.settle();
    eq(e.vol(), 70, 'volume');
  });
  await test('12 s safety restore', async () => {
    const e = env(); e.playing();
    e.fire('akon:wake'); await e.settle();
    const t = e.timers.find((x) => x.fn && x.ms === 12000);
    if (!t) throw new Error('no 12 s timer');
    t.fn(); await e.settle();
    eq(e.vol(), 70, 'volume');
  });
  await test('"volume 40" while ducked -> never restored over', async () => {
    const e = env(); e.playing();
    e.fire('akon:wake'); await e.settle();
    e.fire('akon:phase', { phase: 'thinking', command: 'volume 40' }); await e.settle();
    await e.ctx.SpotifyController.setVolume(40);
    e.fire('akon:phase', { phase: 'speaking' }); e.fire('akon:phase', { phase: 'idle' }); await e.settle();
    eq(e.calls, ['25q', '40'], 'calls');
  });
  await test('"volume up" while ducked -> restores first, so the step is from 70%', async () => {
    const e = env(); e.playing();
    e.fire('akon:wake'); await e.settle();
    e.fire('akon:phase', { phase: 'thinking', command: 'volume up' });
    const v = await e.ctx.SpotifyController.getVolume();
    eq(v, 70, 'level the command reads');
  });
  await test('dock slider (cancel) while ducked -> no restore', async () => {
    const e = env(); e.playing();
    e.fire('akon:wake'); await e.settle();
    e.ctx.IrisDuck.cancel(); await e.ctx.SpotifyController.setVolume(55);
    e.fire('akon:phase', { phase: 'idle' }); await e.settle();
    eq(e.vol(), 55, 'volume');
  });
  await test('command arrives before the duck finished reading the volume -> no duck', async () => {
    const e = env(); e.playing();
    e.fire('akon:wake');
    e.fire('akon:phase', { phase: 'thinking', command: 'next' }); await e.settle();
    eq(e.calls, [], 'calls');
  });
  await test('flag duck=false -> never ducks', async () => {
    const e = env({ flags: { duck: false } }); e.playing();
    e.fire('akon:wake'); await e.settle();
    eq(e.calls, [], 'calls');
  });

  if (failed) { console.log(`\n${failed} DUCK TEST(S) FAILED`); process.exit(1); }
  console.log('\nALL DUCK TESTS PASSED');
})();
