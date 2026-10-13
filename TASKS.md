# TASKS.md — Akon Post-Audit Work

## v6 — "The Stage" + safe voice upgrades

### Done
- [x] P0 safety net: `v5-baseline` git tag, `test/contract.test.js`, headless smoke harness (`npm run smoke`)
- [x] P1 voice: B1 repeated wake, B2 fuzzy wake (flag), B3 miss logging + near-miss line, B4 no forced stop after bare wake, B5 dropped-wake recovery, B6 mic resilience + watchdog, B8 tap-to-talk (button / eye / L), B9 401 refresh
- [x] P2 Stage UI: full-viewport layout, tokens + contrast, eye tap, live transcript, mic pill with Retry, glass dock with transport/volume/progress, signed-out state, all states, responsive 390 → 1440+
- [x] P3 delight: progress ring, art tint, "Did you mean" cards, first-run chips, ambient mode + wake lock, diagnostics drawer, cold-start state
- [x] P4: B7 duck, B10 eye throttle (browser-verified), B11 server wake-up retry
- [x] Docs: `DESIGN.md`, `docs/MANUAL_CHECKS.md`, `docs/screens/`, CHANGELOG, README

### Follow-ups
- [ ] Walk `docs/MANUAL_CHECKS.md` with a real mic and Spotify Premium account (not possible here)
- [ ] Tune the fuzzy wake lists from real "Almost heard" lines in the debug log after a week of use
- [ ] Measure whether ducking measurably improves recognition with loud music; drop it (`duck: false`) if not
- [ ] Seek by tapping the progress bar (needs a new `SpotifyController.seek`; left out to keep the API unchanged)
- [ ] Out of scope, recommended: OAuth `state` check and session security, removing "akon" from `query.js`, artist-only playback, renaming `AKON_*` env vars, a third-party wake-word engine, text-to-speech replies. No service worker.

### Risk Notes
- **Fuzzy wake** can still wake on a rare real word near "iris"; anything that is not an exact wake word must be followed by an explicit command ("play …", "pause"), so chatter like "I wish you were here" does nothing. Off switch: `fuzzyWake`.
- **Watchdog** restarts a recognizer after 25 s with no events at all. Chrome normally emits `no-speech`/`end` events during silence, so a healthy session should never trip it; if one does, the cost is a ~250 ms listening gap.
- **Minimum 250 ms restart delay** (v5 restarted immediately after a clean end): a quarter-second gap per session end.
- **Ducking** depends on the SDK handling `setVolume`/`getVolume` in call order (true for the fake; expected for the real SDK, unverified). Worst case is a missed restore, capped by the 12 s safety restore. Off switch: `duck`.
- **Ducking via the Web API fallback**: if the SDK's `setVolume` ever throws, the volume goes through the Web API, whose ordering against the restore is not guaranteed; the 12 s safety restore still applies.
- **"No mic"** now keeps retrying (1 s → 30 s backoff) instead of staying off; the pill and caption still say "No microphone found" while it does.
- **Canvas `mix-blend-mode: screen`** lets the glow show through the eye's black; drawing code is untouched. If a GPU has trouble compositing it, remove that one line in `stage.css`.
- **`duck.js`** is an extra script between `voice.js` and `app.js`; the contract's required order is unchanged.
- **Layout shift**: "Did you mean" cards appear below the controls (replacing history and hint) so nothing above them moves; the match hint above the controls can still add a line.
- **Not verified**: real speech recognition, real Spotify playback, real wake lock, real CORS on Spotify art for the tint (falls back to amber/slate silently if blocked).

## v3 Polish Pass

### Done
- [x] Tier 1: album art, icons, toasts
- [x] Tier 2: listening pulse (CSS), wake flash, optional chime (off), command history, low-confidence hint
- [x] Tier 3: fade-in transition, equalizer bars, searching skeleton
- [x] Tier 4: mobile layout, PWA manifest (no service worker), idle/listening/playing states
- [x] Tier 5: `aria-live` status card, keyboard controls

### Follow-ups
- [ ] Verify the structured `track:"…" artist:"…"` query and junk filtering against the live Spotify API (only tested with mocked results)
- [ ] Tier 6 stretch (not started, per brief): push-to-talk toggle, queue/playlist view
- [ ] Optional progress bar (not a numbered item in the brief): interpolate from `position`/`duration` in `akon:state`, no polling
- [ ] Verify against a real Spotify Premium account + mic (see README → Polish QA); could not be done without credentials
- [ ] If you want the chime, set `CONFIG.chime = true` in `polish.js` and test that it doesn't affect recognition

### Risk Notes (intentionally simplified or skipped)
- **Mic pulse is CSS-only**, not audio-reactive: no second `getUserMedia`, so speech recognition can't be disturbed (Known Risk #1).
- **Chime shipped OFF**: output-only, but untested against a live mic; a tone could in theory be picked up by recognition.
- **No progress bar**: not in the numbered list; if added it must interpolate from `akon:state` only (Known Risk #2).
- **No service worker**: manifest only, avoiding stale-JS risk (Known Risk #3).
- **`hidden` logic untouched**: transitions are CSS animations that run when `hidden` is removed; plus a `.hidden { display:none !important }` guard.
- **Debug panel untouched**: `AkonDebug`, `#debugLog`, `#debugToggle` unchanged; `AkonDebug.log` is wrapped (same behavior, plus a read-only tap for toasts).
- **Hooks in protected files** are single guarded `dispatchEvent` lines after existing logic; they never alter return values or timing.
- **Polish is removable**: deleting `polish.js`/`polish.css` (and their two tags) returns the app to v2 behavior; each feature also has a `CONFIG` switch.

## Done

- [x] Fixed `window.onSpotifyWebPlaybackSDKReady` race condition (device not showing)
- [x] Added explicit playback transfer to the browser device on `ready`, with retry/backoff
- [x] Added `ensureActiveDevice()` guard before every playback call
- [x] Rewrote `nextTrack()` / `previousTrack()` / `pause()` / `resume()` / `setVolume()` to prefer
      the SDK player's own methods, with Web API as fallback only
- [x] Rewrote search: query normalization, filler-word stripping (English + Hinglish),
      progressive fallback queries, Levenshtein + token-overlap scoring, artist boost
- [x] Hardened `apiRequest()`: checks `res.ok`, retries once on 429/5xx, logs failures
- [x] Added `GET /auth/debug` (auth/device diagnostics, no secrets) and `POST /auth/device`
- [x] Added last-refreshed timestamp tracking in `auth.js`
- [x] Added a hidden, toggleable debug panel in the UI (server state + client log)
- [x] Added `test/matching.test.js` — credential-free unit tests for the matching pipeline
- [x] Hardened `voice.js` command parsing (strips trailing punctuation)
- [x] Updated `.env.example` and `README.md` with local + Render env values and a full QA checklist
- [x] Added `app.use(express.json())` and `trust proxy` to `server.js` for Render + the new device-report endpoint

## Follow-ups (not done — suggestions only)

- [ ] Move token storage from in-memory to a real session/DB store if more than one person will use a deployed instance concurrently (current store is single-user by design, per the original spec).
- [ ] Add a small in-UI toast/message when a search match is low-confidence, instead of only logging it to the debug panel — nice-to-have for non-technical users.
- [ ] Consider a real phonetic-matching library (e.g. Soundex/Metaphone or a proper transliteration library) instead of the hand-rolled Hinglish filler list, if regional-language accuracy needs to go further.
- [ ] Add automated integration tests against a mocked Spotify Web API (the current test suite only covers the pure matching/scoring logic, not the network calls, since that needs real credentials).

## Unit Test Examples (`test/matching.test.js`)

Run with `npm test` — no network access or Spotify credentials required (uses mock search-result pools).

| Input query | Mock candidates available | Expected top match | Why |
|---|---|---|---|
| `"play believer"` | Believer / Believer (Remix) / Whatever It Takes (all Imagine Dragons) / Sahiba (Jasleen Royal) | **Believer — Imagine Dragons** | Highest token-overlap + string similarity even with leftover "play" token |
| `"believer"` | same as above | **Believer — Imagine Dragons** (score 1.00) | Exact match |
| `"ye sahiba tune kya kiya"` | Sahiba (Jasleen Royal) / Tera Ban Jaunga / Kesariya | **Sahiba — Jasleen Royal** | Filler words (`ye`, `tune`, `kya`, `kiya`) stripped, leaving `sahiba`, an exact title hit — this is the literal wrong-match scenario from the bug report, now fixed |
| `"ye tune kya kiya"` (no real title at all — the literal spec example) | same as above | *(best-effort pick, low confidence)* | Every token is a filler word; the "never reduce to nothing" fallback kicks in so search doesn't run on an empty string — test only asserts it returns a ranked list without crashing, since there's genuinely no song title in this phrase |

All four assertions pass as of this fix (`npm test` → `ALL TESTS PASSED`).
