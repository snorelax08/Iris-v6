// Run with: npm test   (plain node, no browser, no network)
//
// Guards the frontend CONTRACT that existing JS depends on: DOM ids, script order,
// event names and public API names. If a redesign renames or drops any of these,
// this test fails before a user ever sees a broken page.

const fs = require('fs');
const path = require('path');

const FE = path.join(__dirname, '..', 'frontend');
const html = fs.readFileSync(path.join(FE, 'index.html'), 'utf8');
const read = (f) => fs.readFileSync(path.join(FE, f), 'utf8');

let failed = 0;
function check(ok, label) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  contract ${label}`);
  if (!ok) failed++;
}

// ---- 1. DOM ids existing JS reads or writes
const IDS = [
  'irisCanvas', 'stage', 'phaseCaption', 'heardText', 'loginBtn', 'app', 'matchHint', 'artBox', 'artImg',
  'artPh', 'skeleton', 'skeletonText', 'eq', 'listeningStatus', 'lastCommand', 'nowPlaying',
  'playbackStatus', 'history', 'micBtn', 'debugToggle', 'debugLog', 'toasts'
];
for (const id of IDS) {
  const n = (html.match(new RegExp(`id="${id}"`, 'g')) || []).length;
  check(n === 1, `#${id} present exactly once (found ${n})`);
}

// #app and #debugLog start hidden; .hidden must stay load-bearing.
check(/id="app"[^>]*class="[^"]*\bhidden\b/.test(html) || /class="[^"]*\bhidden\b[^"]*"[^>]*id="app"/.test(html), '#app starts hidden');
check(/id="debugLog"[^>]*class="[^"]*\bhidden\b/.test(html) || /class="[^"]*\bhidden\b[^"]*"[^>]*id="debugLog"/.test(html), '#debugLog starts hidden');
const allCss = fs.readdirSync(FE).filter((f) => f.endsWith('.css')).map(read).join('\n');
check(/\.hidden\s*\{\s*display:\s*none\s*!important/.test(allCss), '.hidden { display:none !important } still defined');

// ---- 2. Script order
const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1].replace(/^\//, ''));
const REQUIRED = ['shared/intent.js', 'spotify.js', 'voice.js', 'app.js', 'polish.js', 'iris.js'];
const pos = REQUIRED.map((s) => scripts.indexOf(s));
check(pos.every((p) => p >= 0), `required scripts present (${scripts.join(', ')})`);
check(pos.every((p, i) => i === 0 || p > pos[i - 1]), 'required scripts in order intent, spotify, voice, app, polish, iris');
if (scripts.includes('flags.js')) {
  const local = scripts.filter((s) => !/^https?:/.test(s));
  check(local[0] === 'flags.js', 'flags.js is the first app script');
}
if (scripts.includes('stage.js')) check(scripts.indexOf('stage.js') > scripts.indexOf('polish.js'), 'stage.js loads after polish.js');
check(scripts.includes('https://sdk.scdn.co/spotify-player.js'), 'Spotify SDK script still loaded');

// ---- 3. Event names: still dispatched AND still listened to somewhere
const sources = fs.readdirSync(FE).filter((f) => f.endsWith('.js')).map(read).join('\n');
const EVENTS = ['akon:phase', 'akon:wake', 'akon:hearing', 'akon:heard', 'akon:state', 'akon:match', 'akon:resolved', 'akon:autoplay-blocked'];
for (const ev of EVENTS) {
  const esc = ev.replace(/[-:]/g, '\\$&');
  const emitted = new RegExp(`(emit\\(|CustomEvent\\()\\s*'${esc}'`).test(sources);
  const heard = new RegExp(`(on\\(|addEventListener\\()\\s*'${esc}'`).test(sources);
  check(emitted, `event ${ev} is dispatched`);
  check(heard, `event ${ev} is listened to`);
}
// Phase names are still the five the UI understands.
const voice = read('voice.js');
for (const p of ['off', 'idle', 'listening', 'thinking', 'speaking']) {
  check(new RegExp(`setPhase\\('${p}'`).test(voice), `voice.js still emits phase "${p}"`);
}

// ---- 4. Public APIs
const spotify = read('spotify.js');
for (const fn of ['init', 'playTrack', 'pause', 'resume', 'nextTrack', 'previousTrack', 'setVolume', 'getVolume', 'getDeviceId', 'activate']) {
  check(new RegExp(`return \\{[\\s\\S]*\\b${fn}\\b[\\s\\S]*\\};\\s*\\}\\)\\(\\);\\s*$`).test(spotify), `SpotifyController.${fn} exported`);
}
for (const fn of ['init', 'start', 'stop', 'isEnabled', 'isBlocked']) {
  check(new RegExp(`return \\{[\\s\\S]*\\b${fn}\\b[\\s\\S]*\\};\\s*\\}\\)\\(\\);\\s*$`).test(voice), `VoiceControl.${fn} exported`);
}
check(/onCommandCallback\(command, transcript, alternatives\)/.test(voice), 'command callback is (command, transcript, alternatives)');
check(/window\.showToast\s*=/.test(sources), 'window.showToast defined');
check(/window\.AkonDebug\s*=/.test(sources), 'window.AkonDebug defined');

// ---- 5. HTTP routes the frontend relies on
const auth = fs.readFileSync(path.join(__dirname, '..', 'backend', 'auth.js'), 'utf8');
for (const r of ['login', 'callback', 'token', 'status', 'device', 'debug']) {
  check(new RegExp(`router\\.(get|post)\\('/${r}'`).test(auth), `/auth/${r} route exists`);
}
const resolveRoute = fs.readFileSync(path.join(__dirname, '..', 'backend', 'routes', 'resolve.js'), 'utf8');
check(/router\.post\('\/resolve'/.test(resolveRoute) && /router\.get\('\/intent'/.test(resolveRoute), '/api/resolve and /api/intent exist');

if (failed) {
  console.log(`\n${failed} CONTRACT CHECK(S) FAILED`);
  process.exit(1);
}
console.log('\nALL CONTRACT CHECKS PASSED');
