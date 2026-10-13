// Browser smoke test (optional; needs Chromium + Playwright, not part of `npm test`).
//   npm run smoke            -> runs the contract behaviours headlessly
//   SCREENS=1 npm run smoke  -> also writes docs/screens/*.png at 390x844 and 1440x900
//
// The REAL frontend is served from disk through Playwright request interception; the
// microphone (SpeechRecognition), the Spotify SDK, the Spotify Web API and the backend
// (/auth/*, /api/resolve) are scripted fakes. A pass proves the UI + wiring, not real
// speech recognition or real Spotify playback (see docs/MANUAL_CHECKS.md for those).

const fs = require('fs');
const path = require('path');

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  try {
    ({ chromium } = require('/opt/npm-tools/node_modules/playwright'));
  } catch (e2) {
    console.log('SKIP  smoke: Playwright is not installed (no new dependency is added for it).');
    process.exit(0);
  }
}

const ROOT = path.join(__dirname, '..', '..');
const ORIGIN = 'http://iris.local';
const SCREENS = process.env.SCREENS === '1';
const SHOT_DIR = path.join(ROOT, 'docs', 'screens');
const FAKES = fs.readFileSync(path.join(__dirname, 'fakes.js'), 'utf8');

const ART = { believer: ['#2b5d8a', '#e3b04b'], iris: ['#5b2a3c', '#d9c2a3'], pastel: ['#3a4a6b', '#c7a6d9'], stronger: ['#1d1d1d', '#c94f3a'] };
const artUrl = (k) => `${ORIGIN}/__art/${k}.svg`;
const track = (id, name, artists, artKey, score) => ({ uri: `spotify:track:${id}`, albumUri: `spotify:album:${id}`, name, artists, art: artKey ? artUrl(artKey) : null, score });
const T = {
  believer: track('believer', 'Believer', ['Imagine Dragons'], 'believer', 0.94),
  believerLive: track('believerlive', 'Believer - Live', ['Imagine Dragons'], 'believer', 0.61),
  iris: track('iris', 'Iris', ['The Goo Goo Dolls'], 'iris', 0.82),
  irisPastel: track('irispastel', 'Iris', ['Pastel Ghost'], 'pastel', 0.71),
  strongerK: track('strongerk', 'Stronger', ['Kanye West'], 'stronger', 0.66),
  strongerC: track('strongerc', "Stronger (What Doesn't Kill You)", ['Kelly Clarkson'], 'stronger', 0.62),
  strongerB: track('strongerb', 'Stronger', ['Britney Spears'], 'stronger', 0.6)
};
const who = (t) => `${t.name} by ${t.artists.join(', ')}`;
function resolve(query) {
  const q = query.toLowerCase();
  if (q.includes('fail')) return { status: 500, body: { error: 'boom' } };
  if (q.includes('believer')) return { body: { action: 'play', track: T.believer, alternatives: [T.believerLive], confidence: 0.94, source: 'fake', message: `Playing ${who(T.believer)}. Not it? Say "option two" for ${who(T.believerLive)}.`, debug: { ms: 3, top: [] } } };
  if (q === 'iris' || q.includes('iris')) return { body: { action: 'play', track: T.iris, alternatives: [T.irisPastel], confidence: 0.82, source: 'fake', message: `Playing ${who(T.iris)}. Not it? Say "option two" for ${who(T.irisPastel)}.`, debug: { ms: 3, top: [] } } };
  if (q.includes('stronger')) {
    const options = [T.strongerK, T.strongerC, T.strongerB];
    return { body: { action: 'choose', options, confidence: 0.66, source: 'fake', message: 'Did you mean: ' + options.map((o, i) => `${i + 1}) ${who(o)}`).join(', ') + '? Say "option one", "two" or "three".', debug: { ms: 3, top: [] } } };
  }
  return { body: { action: 'not_found', options: [], confidence: 0, source: 'fake', message: "I couldn't find that song. Try saying the title and the artist.", debug: { ms: 3, top: [] } } };
}

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

async function newPage(browser, { loggedIn = true, viewport = { width: 1440, height: 900 }, statusFailures = 0, reducedMotion = 'no-preference', firstRunDone = true, init = [] } = {}) {
  const ctx = await browser.newContext({ viewport, reducedMotion, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const state = { resolves: [], statusCalls: 0, errors: [] };
  page.on('pageerror', (e) => state.errors.push(String(e)));
  // App log lines ([Iris] ...) at level error are expected in failure scenarios; real exceptions are not.
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|^\[Iris\]/.test(m.text())) state.errors.push(m.text()); });

  const catalog = {};
  Object.values(T).forEach((t) => { catalog[t.uri] = { name: t.name, artists: t.artists, art: t.art }; });
  await page.addInitScript(FAKES);
  for (const sc of init) await page.addInitScript(sc);
  await page.addInitScript(`Object.assign(window.__catalog, ${JSON.stringify(catalog)});`);
  if (firstRunDone) await page.addInitScript(`try { localStorage.setItem('iris.firstRunDone', '1'); } catch (e) {}`);

  await page.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.hostname === 'sdk.scdn.co') return route.fulfill({ contentType: 'application/javascript', body: 'window.__installFakeSdk();' });
    if (url.origin !== ORIGIN) return route.abort();
    const p = url.pathname;
    if (p.startsWith('/__art/')) {
      const [a, b] = ART[path.basename(p, '.svg')] || ['#333', '#999'];
      return route.fulfill({ contentType: 'image/svg+xml', body: `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="300" height="300" fill="url(#g)"/><circle cx="150" cy="150" r="60" fill="${b}" opacity=".5"/></svg>` });
    }
    if (p === '/auth/status') {
      state.statusCalls++;
      if (state.statusCalls <= statusFailures) return route.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad gateway</html>' });
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ logged_in: loggedIn }) });
    }
    if (p === '/auth/token') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ access_token: 'fake-token-' + Date.now() }) });
    if (p === '/auth/device') return route.fulfill({ status: 204, body: '' });
    if (p === '/auth/debug') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ logged_in: loggedIn, device_id: 'fake-device' }) });
    if (p === '/auth/login') return route.fulfill({ contentType: 'text/html', body: '<p>login</p>' });
    if (p === '/api/resolve') {
      const body = JSON.parse(req.postData() || '{}');
      state.resolves.push(body.query);
      const r = resolve(body.query || '');
      await new Promise((res) => setTimeout(res, 120));
      return route.fulfill({ status: r.status || 200, contentType: 'application/json', body: JSON.stringify(r.body) });
    }
    let file = p === '/' ? '/index.html' : p;
    const full = file.startsWith('/shared/') ? path.join(ROOT, file) : path.join(ROOT, 'frontend', file);
    if (!fs.existsSync(full)) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ contentType: MIME[path.extname(full)] || 'application/octet-stream', body: fs.readFileSync(full) });
  });
  await page.goto(ORIGIN + '/');
  return { page, ctx, state };
}

let failed = 0;
let passed = 0;
const results = [];
function check(cond, label) {
  results.push(`${cond ? 'PASS' : 'FAIL'}  smoke ${label}`);
  console.log(results[results.length - 1]);
  if (cond) passed++; else failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (page, sel) => page.$eval(sel, (el) => el.textContent.trim()).catch(() => null);
const visible = (page, sel) => page.isVisible(sel).catch(() => false);
const calls = (page) => page.evaluate(() => (window.__player ? window.__player.calls.slice() : []));
const say = (page, t, o) => page.evaluate(([t2, o2]) => window.__speech.say(t2, o2), [t, o || {}]);
const bodyHas = (page, cls) => page.evaluate((c) => document.body.classList.contains(c), cls);
async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return true; await sleep(50); }
  return false;
}
async function shot(page, name) {
  if (!SCREENS) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(SHOT_DIR, `${name}.png`) });
}

module.exports = { newPage, check, sleep, text, visible, calls, say, bodyHas, waitFor, shot, T };

async function main() {
  const browser = await chromium.launch();
  try {
    await require('./scenarios')(browser, module.exports);
  } catch (err) {
    check(false, `harness crashed: ${err.stack || err}`);
  } finally {
    await browser.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
  console.log('ALL SMOKE CHECKS PASSED');
}
if (require.main === module) main();
