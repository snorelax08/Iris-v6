// Run with: npm test   (plain node: no browser, no microphone, no network)
//
// Loads the REAL frontend/voice.js (unmodified) into a `vm` sandbox with a scripted
// fake SpeechRecognition and a fake clock, then replays transcripts the way Chrome
// delivers them (interim results, then a final with alternatives). A pass proves the
// wake/command logic; it does NOT prove how a real recognizer hears a real voice —
// that is what docs/MANUAL_CHECKS.md is for.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const VOICE_SRC = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'voice.js'), 'utf8');
const INTENT_SRC = fs.readFileSync(path.join(__dirname, '..', 'shared', 'intent.js'), 'utf8');

function makeEnv(opts = {}) {
  // ---- fake clock
  let now = 1_000_000;
  let timerSeq = 0;
  const timers = new Map();
  const setTimeout_ = (fn, ms) => { const id = ++timerSeq; timers.set(id, { at: now + Math.max(0, ms || 0), fn }); return id; };
  const clearTimeout_ = (id) => { timers.delete(id); };
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next.t.at || (t.at === next.t.at && id < next.id))) next = { id, t };
      if (!next) break;
      timers.delete(next.id);
      now = next.t.at;
      next.t.fn();
    }
    now = end;
  }

  // ---- fake recognizer
  const recs = [];
  const stats = { start: 0, stop: 0, abort: 0, throwNext: null };
  class FakeRecognition {
    constructor() { this.running = false; this.results = []; recs.push(this); }
    start() {
      stats.start++;
      if (stats.throwNext) { const name = stats.throwNext; stats.throwNext = null; const e = new Error(name); e.name = name; throw e; }
      if (this.running) { const e = new Error('already started'); e.name = 'InvalidStateError'; throw e; }
      this.running = true;
      this.results = [];
      setTimeout_(() => { this.onstart && this.onstart(); this.onaudiostart && this.onaudiostart(); }, 0);
    }
    stop() {
      stats.stop++;
      if (!this.running) return;
      // stop() finalizes the open (interim) result, then ends the session.
      const open = this.results.findIndex((r) => !r.isFinal);
      if (open !== -1) this._emit(open, [this.results[open][0].transcript], true);
      this._end();
    }
    abort() { stats.abort++; if (this.running) this._end(); }
    _end() { this.running = false; setTimeout_(() => this.onend && this.onend(), 0); }
    _emit(idx, alts, isFinal) {
      const r = alts.map((t) => ({ transcript: t }));
      r.isFinal = isFinal;
      this.results[idx] = r;
      this.onresult && this.onresult({ resultIndex: idx, results: this.results });
    }
  }

  // ---- sandbox
  const events = [];
  const logs = [];
  const commands = [];
  const ctx = {
    console: { log() {}, warn() {}, info() {}, error() {} },
    setTimeout: setTimeout_, clearTimeout: clearTimeout_,
    setInterval: () => 0, clearInterval: () => {},
    Promise,
    Date: class extends Date { static now() { return now; } },
    alert: () => {},
    CustomEvent: class { constructor(name, init) { this.type = name; this.detail = init && init.detail; } },
    dispatchEvent: (e) => { events.push({ name: e.type, detail: e.detail, at: now }); return true; },
    addEventListener: () => {}, removeEventListener: () => {},
    document: { hidden: false, addEventListener: () => {} },
    AkonDebug: { log: (m, l) => logs.push(`${l || 'info'}: ${m}`) },
    IRIS_FLAGS: opts.flags || undefined
  };
  if (!opts.noRecognition) ctx.webkitSpeechRecognition = FakeRecognition;
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(INTENT_SRC, ctx, { filename: 'intent.js' });
  vm.runInContext(VOICE_SRC, ctx, { filename: 'voice.js' });
  const VC = vm.runInContext('VoiceControl', ctx);

  VC.init((command, transcript, alternatives) => {
    commands.push(command);
    if (!Array.isArray(alternatives)) throw new Error('alternatives must be an array');
    return Promise.resolve();
  });
  VC.start();
  advance(10);

  const rec = () => recs[recs.length - 1];
  let idx = 0;
  // Speak one utterance: progressive interims, then a final (optionally with alternates).
  function say(text, { final = text, alts = [], step = 250, noFinal = false, at } = {}) {
    const i = at !== undefined ? at : idx++;
    const words = text.split(' ');
    for (let k = 1; k <= words.length; k++) { rec()._emit(i, [words.slice(0, k).join(' ')], false); advance(step); }
    if (!noFinal) { rec()._emit(i, [final, ...alts], true); advance(step); }
    return i;
  }
  const flush = () => advance(50); // let dispatched promises settle

  return { VC, say, advance, rec, recs, stats, events, logs, commands, flush,
    wakes: () => events.filter((e) => e.name === 'akon:wake').length,
    phases: () => events.filter((e) => e.name === 'akon:phase').map((e) => e.detail.phase),
    lastPhase: () => { const p = events.filter((e) => e.name === 'akon:phase'); return p.length ? p[p.length - 1].detail : null; },
    nextIdx: () => idx, setIdx: (n) => { idx = n; } };
}

let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`PASS  voice ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL  voice ${name}\n      ${err.message}`);
  }
}
const eq = (a, b, what) => {
  const A = JSON.stringify(a);
  const B = JSON.stringify(b);
  if (A !== B) throw new Error(`${what || 'value'}: expected ${B}, got ${A}`);
};
const ok = (cond, what) => { if (!cond) throw new Error(what); };
const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  // ---------------- B1: repeated wake words
  await test('"iris iris" -> wake only, no song', async () => {
    const e = makeEnv();
    e.say('iris iris'); await tick(); e.flush();
    eq(e.commands, [], 'commands');
    ok(e.wakes() >= 1, 'should have woken');
    eq(e.lastPhase().phase, 'listening', 'phase');
  });
  await test('"iris iris play x" -> ["play x"]', async () => {
    const e = makeEnv();
    e.say('iris iris play x'); await tick();
    eq(e.commands, ['play x'], 'commands');
  });
  await test('"iris play iris" -> ["play iris"] (the song)', async () => {
    const e = makeEnv();
    e.say('iris play iris'); await tick();
    eq(e.commands, ['play iris'], 'commands');
  });
  await test('"iris play believer" -> ["play believer"]', async () => {
    const e = makeEnv();
    e.say('iris play believer'); await tick();
    eq(e.commands, ['play believer'], 'commands');
  });
  await test('"iris play believer" keeps the recognizer alternatives as an array', async () => {
    const e = makeEnv();
    e.say('iris play believer', { alts: ['iris play beliver'] }); await tick();
    eq(e.commands, ['play believer'], 'commands');
  });

  // ---------------- B4: no forced stop after a bare wake
  await test('"iris", 1.5 s pause, "play believer" -> ["play believer"], no forced stop()', async () => {
    const e = makeEnv();
    e.say('iris');               // Chrome finalizes the bare wake word
    e.advance(1500);
    e.say('play believer'); await tick();
    eq(e.commands, ['play believer'], 'commands');
    eq(e.stats.stop, 0, 'recognition.stop() calls');
  });
  await test('"iris" held open by music (no final), 1.5 s pause, then words -> ["play believer"], no stop() before the words', async () => {
    const e = makeEnv();
    const i = e.say('iris', { noFinal: true });
    e.advance(1500);
    eq(e.stats.stop, 0, 'stop() during the pause');
    e.rec()._emit(i, ['iris play'], false); e.advance(200);
    e.rec()._emit(i, ['iris play believer'], false); e.advance(200);
    e.rec()._emit(i, ['iris play believer'], true); e.advance(100); await tick();
    eq(e.commands, ['play believer'], 'commands');
  });
  await test('a bare wake that never finalizes is not replayed after the window lapses', async () => {
    const e = makeEnv();
    e.say('iris', { noFinal: true });
    e.advance(9000);                              // window (8 s) lapses -> idle
    eq(e.lastPhase().phase, 'idle', 'phase after lapse');
    e.rec().abort(); e.advance(400);              // session ends with the stale interim
    eq(e.lastPhase().phase, 'idle', 'phase after session end');
    eq(e.commands, [], 'commands');
  });

  // ---------------- review regressions (v6 code review)
  await test('"iris iris by goo goo dolls" keeps the title (v5: "iris by goo goo dolls")', async () => {
    const e = makeEnv();
    e.say('iris iris by goo goo dolls'); await tick();
    eq(e.commands, ['iris by goo goo dolls'], 'commands');
  });
  await test('"iris irish rover" keeps the title (v5: "irish rover")', async () => {
    const e = makeEnv();
    e.say('iris irish rover'); await tick();
    eq(e.commands, ['irish rover'], 'commands');
  });
  await test('fuzzy "eris" turned down by its final closes the window (next sentence is not a command)', async () => {
    const e = makeEnv();
    e.say('eris is a goddess'); await tick();
    e.say('you were here yesterday'); await tick();
    eq(e.commands, [], 'commands');
    eq(e.lastPhase().phase, 'idle', 'phase');
  });
  await test('bare "iris" held open past the window is discarded, not re-woken by later words', async () => {
    const e = makeEnv();
    const i = e.say('iris', { noFinal: true });
    const aborts = e.stats.abort;
    e.advance(9000);
    ok(e.stats.abort > aborts, 'stale utterance not discarded');
    e.advance(500);
    eq(e.lastPhase().phase, 'idle', 'phase');
    ok(e.rec().running, 'recognizer restarted');
    eq(e.commands, [], 'commands');
  });
  await test('watchdog does not fire before the first session starts (permission prompt open)', async () => {
    const e = makeEnv();
    e.VC.stop();
    // start() whose session never reports onstart (Chrome waiting on the permission prompt)
    e.rec().start = function () { e.stats.start++; };
    e.VC.start();
    const aborts = e.stats.abort;
    e.advance(60000);
    eq(e.stats.abort, aborts, 'abort() calls while the prompt is open');
  });
  await test('during an automatic mic retry the mic button turns the mic ON, not off', async () => {
    const e = makeEnv();
    e.rec().start = function () { e.stats.start++; }; // retry attempt never reports audio
    e.rec().onerror({ error: 'audio-capture' });
    e.advance(1500);                 // recovery attempt in flight
    eq(e.VC.isEnabled(), false, 'isEnabled during recovery');
  });

  // ---------------- B5: wake word dropped in the final
  await test('interim "iris play x" then final "i risk play x" -> still runs "play x"', async () => {
    const e = makeEnv();
    e.say('iris play x', { final: 'i risk play x' }); await tick();
    eq(e.commands, ['play x'], 'commands');
  });
  await test('interim "iris play x" then final "play x" (wake dropped entirely) -> "play x"', async () => {
    const e = makeEnv();
    e.say('iris play x', { final: 'play x' }); await tick();
    eq(e.commands, ['play x'], 'commands');
  });

  // ---------------- B2: fuzzy wake positives
  for (const [text, want] of [
    ['irish play x', ['play x']],
    ['i wish play x', ['play x']],
    ['eye ris play x', ['play x']],
    ['hey iris play x', ['play x']],
    ['eris play x', ['play x']],
    ['airis play x', ['play x']]
  ]) {
    await test(`positive "${text}" -> ${JSON.stringify(want)}`, async () => {
      const e = makeEnv();
      e.say(text); await tick();
      eq(e.commands, want, 'commands');
    });
  }
  for (const text of ['eris', 'ayris', 'airis']) {
    await test(`positive bare "${text}" wakes`, async () => {
      const e = makeEnv();
      e.say(text); await tick();
      ok(e.wakes() >= 1, 'no wake');
      eq(e.commands, [], 'commands');
      e.say('play believer'); await tick();
      eq(e.commands, ['play believer'], 'follow-up command');
    });
  }

  // ---------------- B2: negatives must NOT wake (interim or final)
  for (const text of ['this is a song', 'it is', 'it was', 'i miss you', 'i risk it all', 'a risk', 'kris kross', 'hi there',
    'i wish you were here', 'tris play x', 'idris play x']) {
    await test(`negative "${text}" does not wake`, async () => {
      const e = makeEnv();
      e.say(text); await tick();
      eq(e.wakes(), 0, 'wake events');
      eq(e.commands, [], 'commands');
      ok(!e.phases().includes('listening'), 'entered listening');
    });
  }
  await test('fuzzy bare wake does not turn the rest of the same sentence into a command ("eris is a goddess")', async () => {
    const e = makeEnv();
    e.say('eris is a goddess'); await tick();
    eq(e.commands, [], 'commands');
  });
  await test('fuzzyWake flag off -> "eris play x" does not wake, "iris play x" still does', async () => {
    const e = makeEnv({ flags: { fuzzyWake: false } });
    e.say('eris play x'); await tick();
    eq(e.commands, [], 'fuzzy off');
    e.say('iris play x'); await tick();
    eq(e.commands, ['play x'], 'exact still works');
  });

  // ---------------- follow-up containing the song "Iris"
  await test('"iris", then follow-up "play iris" -> ["play iris"]', async () => {
    const e = makeEnv();
    e.say('iris');
    e.say('play iris'); await tick();
    eq(e.commands, ['play iris'], 'commands');
  });
  await test('follow-up window still expires: "iris", 9 s, "play believer" -> nothing', async () => {
    const e = makeEnv();
    e.say('iris');
    e.advance(9000);
    e.say('play believer'); await tick();
    eq(e.commands, [], 'commands');
  });

  // ---------------- B3: misses are logged; near-misses surface
  await test('misses are logged to AkonDebug, near-misses emit iris:near-miss', async () => {
    const e = makeEnv();
    e.say('hello there');
    ok(e.logs.some((l) => /hello there/.test(l)), 'miss not logged');
    e.advance(3000);
    e.say('eris plays x');
    ok(e.events.some((ev) => ev.name === 'iris:near-miss'), 'no near-miss event');
  });

  // ---------------- B6: mic resilience
  await test('one audio-capture error -> recovers via backoff', async () => {
    const e = makeEnv();
    const before = e.stats.start;
    e.rec().onerror({ error: 'audio-capture' });
    e.rec().abort();
    e.advance(20000);
    ok(e.stats.start > before, 'did not retry start()');
    ok(e.VC.isEnabled(), 'mic disabled after one audio-capture error');
    ok(e.rec().running, 'recognizer not running again');
    e.say('iris play believer'); await tick();
    eq(e.commands, ['play believer'], 'commands after recovery');
  });
  await test('audio-capture followed by a late audiostart from the dead session still recovers', async () => {
    const e = makeEnv();
    e.rec().onerror({ error: 'audio-capture' });
    e.rec().onaudiostart();          // stale event from the session that just failed
    e.rec().abort();
    e.advance(20000);
    ok(e.VC.isEnabled(), 'mic stayed off');
    ok(e.rec().running, 'recognizer not running again');
    eq(e.lastPhase().phase, 'idle', 'phase');
  });
  await test('not-allowed -> stays off, reason "blocked", no restart loop', async () => {
    const e = makeEnv();
    e.rec().onerror({ error: 'not-allowed' });
    e.rec().abort();
    const before = e.stats.start;
    e.advance(60000);
    eq(e.stats.start, before, 'start() calls after not-allowed');
    ok(!e.VC.isEnabled(), 'should be disabled');
    ok(e.VC.isBlocked(), 'should be blocked');
    eq(e.lastPhase(), { phase: 'off', reason: 'blocked' }, 'phase');
  });
  await test('start() throws InvalidStateError while not running -> retried', async () => {
    const e = makeEnv();
    e.stats.throwNext = 'InvalidStateError';
    e.rec().abort();                 // session ends -> restart attempt throws
    e.advance(15000);
    ok(e.rec().running, 'recognizer not running after InvalidStateError');
  });
  await test('2 min silent stall -> watchdog restarts the recognizer', async () => {
    const e = makeEnv();
    const before = e.stats.start;
    e.rec().running = true;          // looks alive, but delivers no events at all
    e.advance(120000); e.advance(1000);
    ok(e.stats.abort > 0 || e.stats.start > before, 'watchdog never kicked the recognizer');
    ok(e.rec().running, 'recognizer not running after watchdog');
    e.say('iris play believer'); await tick();
    eq(e.commands, ['play believer'], 'commands after watchdog');
  });
  await test('manual mute stops everything (no watchdog restarts while muted)', async () => {
    const e = makeEnv();
    e.VC.stop();
    const before = e.stats.start;
    e.advance(180000);
    eq(e.stats.start, before, 'start() while muted');
    eq(e.lastPhase(), { phase: 'off', reason: 'muted' }, 'phase');
  });

  // ---------------- B8: listenNow / cancelListening
  await test('listenNow() takes the next sentence as the command, no wake word', async () => {
    const e = makeEnv();
    ok(typeof e.VC.listenNow === 'function', 'listenNow missing');
    e.VC.listenNow();
    eq(e.lastPhase().phase, 'listening', 'phase');
    e.say('play believer'); await tick();
    eq(e.commands, ['play believer'], 'commands');
  });
  await test('listenNow() while muted turns the mic on', async () => {
    const e = makeEnv();
    e.VC.stop();
    e.VC.listenNow();
    e.advance(10);
    ok(e.VC.isEnabled(), 'not enabled');
    e.say('pause'); await tick();
    eq(e.commands, ['pause'], 'commands');
  });
  await test('cancelListening() closes the window', async () => {
    const e = makeEnv();
    e.VC.listenNow();
    e.VC.cancelListening();
    eq(e.lastPhase().phase, 'idle', 'phase');
    e.say('play believer'); await tick();
    eq(e.commands, [], 'commands');
  });
  await test('listenNow() window lapses after 8 s', async () => {
    const e = makeEnv();
    e.VC.listenNow();
    e.advance(8500);
    eq(e.lastPhase().phase, 'idle', 'phase');
  });

  if (failed) {
    console.log(`\n${failed} VOICE TEST(S) FAILED`);
    process.exit(1);
  }
  console.log('\nALL VOICE TESTS PASSED');
})();
