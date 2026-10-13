# Changelog

## v6 — "The Stage" frontend + safer voice

Backend and `shared/` are byte-for-byte unchanged (`git diff --stat v5-baseline -- backend shared` is empty). No new dependencies, fonts, CDNs, service worker or getUserMedia.

### Voice (`voice.js`, `spotify.js`, small `app.js` hooks)
- **B1** "Iris iris" is one wake word, not a request for the song "Iris" ("Iris play Iris" still plays it). A repeat is collapsed only when nothing or a clear command follows, so "Iris, Iris by Goo Goo Dolls" and "Iris, Irish Rover" keep their titles as in v5.
- **B2** Fuzzy wake on the first 1–3 words (edit distance ≤ 1 to "iris"/"irish", plus "ayris", "airis", "i wish", "eye ris"…), with a stoplist (kris, tris, idris…) and, for anything not an exact wake word, a required explicit command. Flag `fuzzyWake`.
- **B3** Every final transcript is logged (misses rate-limited); near-misses show "Almost heard: …" under the eye. Flag `nearMiss`.
- **B4** No forced `stop()` after a bare "Iris" — the pause before the command is no longer clipped. Early close only once words follow the wake word.
- **B5** If the final drops the wake word the interim had ("iris play x" → "i risk play x"), the command is recovered.
- **B6** One `audio-capture` error no longer turns the mic off for good (backoff retries, "No mic" until audio flows again); `InvalidStateError` on restart is retried; a watchdog restarts a recognizer that goes silent for 25 s; 250 ms minimum restart delay. Only a real permission denial keeps the mic off.
- **B8** Tap-to-talk: `VoiceControl.listenNow()` / `cancelListening()`, the **Start listening** button, tapping the eye, or the **L** key.
- **B9** Spotify Web API 401 → fetch a fresh token and retry once (the cached token used to go stale after ~1 h).
- A fuzzy wake that the final transcript rejects closes the listening window; a bare "Iris" still open when its window lapses is discarded; the watchdog waits for the first real session (never fights the permission prompt); during an automatic mic retry the mic button turns the mic on rather than muting it; Space returns to play/pause after the eye is clicked. (Found by an independent review pass; each has a test.)
- Also fixed: "play iris" said as the follow-up after a bare "Iris" was swallowed as a new wake; a bare wake that never finalized re-opened listening after the window had closed.

### The Stage UI (`stage.css`, `stage.js`, `flags.js`, `index.html`)
- Full-viewport stage: the eye sized to the screen, wordmark and mic pill on top, glass dock at the bottom with art, title, transport, volume and progress (calls the same `SpotifyController` functions as voice and keyboard).
- Phase atmosphere (CSS only), progress ring around the eye (`arc`), album-art tint (`tint`), "Did you mean" cards (`didYouMean`), first-run chips (`firstRun`), ambient mode with wake lock (`ambient`), diagnostics drawer (`diagnostics`).
- Every state designed: signed out, server waking, connecting, idle, listening, thinking, speaking, resolving, playing, paused, choose, not found, search failed, muted, blocked, no mic, autoplay blocked, Premium required.
- Contrast: `--dim` 3.4:1 → 5.4:1; minimum text 13 px; visible focus; reduced motion respected.

### Extras
- **B7** Music ducks to 25% while Iris listens and is restored after (never over a volume command). `duck.js`, flag `duck`.
- **B10** Eye draws at ~30 fps when idle/off and not at all while the tab is hidden (verified in headless Chromium). Flag `eyeThrottle`.
- **B11** `/auth/status` retried with backoff and "Waking the server…" instead of a dead screen. Flag `coldStart`.

### Tests
- `test/contract.test.js` (DOM ids, script order, events, APIs, routes), `test/voice.test.js` (real `voice.js` with a fake recognizer and clock), `test/duck.test.js`; all in `npm test`.
- `npm run smoke`: headless Chromium against the real frontend with fake speech, SDK and backend (135 checks). `SCREENS=1 npm run smoke` refreshes `docs/screens/`.

## v4 — Search moved server-side; confidence gate; intent parser

**Causes of wrong songs (v3):** `searchTrack()` in `frontend/spotify.js` always returned `ranked[0]` (no confidence floor, karaoke kept as a last resort); `FILLER_WORDS` deleted real title words anywhere in the phrase ("tu", "tune", "kya", "of", "the", "akon"); the fallback loop shrank queries down to a single word; no `market` param; speech recognition ran as `en-US`; commands required exact strings ("pause the music", "next song" failed; "play next" searched for a song called "next"); a single-URI queue left "next" nowhere to go.

- New `backend/music/`: `text.js` (Hinglish phonetic keys), `query.js` (edge-only carrier stripping, multiple readings, structured queries), `rank.js` (hard junk filter, 0–1 scores, dedup, confidence gate), `spotifySearch.js` (`market=from_token`, cache, 429 retry), `llm.js` (optional), `resolver.js`.
- `POST /api/resolve` returns `play` / `choose` / `not_found`; the browser still plays via the SDK.
- `shared/intent.js`: one intent parser for browser + tests (English + Hinglish, option selection, "wrong song").
- Voice: `en-IN`, 4 alternatives sent as extra readings, wake-word near-misses, first-occurrence split.
- Playback in album context; volume changes are relative to the SDK's real volume; stale searches can't start playback after a newer command.
- Tests rewritten: 29 resolver cases + 41 intent cases against a mock catalog (not live Spotify).

## v3.1 — Search: wrong-version fix ("stronger by kanye west" played the karaoke cut)

**Cause:** the transcript kept the word "by", and karaoke titles like `Stronger (Made Famous By Kanye West)` contain every query word, so they scored 0.88 vs 0.76 for the real track.

- Added junk detection (karaoke, tribute, "made famous by", cover, "originally performed", …): junk sinks below any real result but stays as a last resort; skipped if you ask for it ("stronger karaoke").
- Added "title by artist" parsing (last "by"), matched against artist names; the un-split reading is kept so "stand by me" still works.
- Structured Spotify query (`track:"…" artist:"…"`) is tried first; the old fallbacks remain.
- Popularity is a tie-breaker only and optional (Spotify Development Mode may not return it).
- Debug log now tags junk and popularity per candidate.
- `test/matching.test.js` now loads the real code from `spotify.js` (previously a copy that could drift); 13 cases incl. regressions.

## v3 — Polish pass (cosmetic / UX only)

No change to search/matching, SDK init, device activation, auth/refresh, or command parsing.

### Added
- **Album art** (largest image from `player_state_changed`), placeholder + `onerror` fallback. (`polish.js`, `index.html`, `polish.css`)
- **Icons** on Connect / mic / debug buttons via CSS masks — text labels kept, survive `textContent` updates.
- **Toasts** driven by existing `AkonDebug.log` lines ("Song not found", "Volume 85%", errors). Status fields untouched.
- **Listening pulse** (CSS-only, no mic/audio access) and **wake-word flash** (`akon:wake` event from `voice.js`).
- **Optional wake chime** (OscillatorNode, ~130 ms, try/catch) — shipped **OFF** (`CONFIG.chime`).
- **Command history strip** (last 5), `#lastCommand` unchanged.
- **Low-confidence hint** ("Best guess: X — say 'Akon next' if that's wrong") from the already-computed score (`akon:match`, threshold 0.5, UI only).
- **Searching skeleton card** shown when a "play X" command is heard; swapped for real art on resolve (10 s safety timeout).
- **Equalizer bars**, **fade-in of the app view**, distinct **idle / listening / playing** visual states.
- **Mobile layout pass**, **PWA manifest + icons** (no service worker), `aria-live="polite"` on the status card.
- **Keyboard fallback**: Space = pause/resume, ←/→ = previous/next, calling the same `SpotifyController` functions as voice.

### Hooks added to existing files (each 1 guarded line, try/catch, no logic change)
- `voice.js`: fires `akon:wake` (wake word confirmed) and `akon:heard` (parsed command).
- `app.js`: fires `akon:state` inside the existing state callback.
- `spotify.js`: fires `akon:match` with the already-computed top score after the existing log.

### Fixed during this pass
- New `.btn`/`.skeleton`/`.art img` display rules out-specified `.hidden`, which would have kept the login button visible after login; `.hidden { display:none !important }` added in `polish.css`.
- Mouse/touch clicks on the mic button now release focus so Space/arrow shortcuts work (keyboard-triggered clicks keep focus).

## v2 — Post-audit fixes (this patch)

### Fixed
- **Device not showing / race condition**: `window.onSpotifyWebPlaybackSDKReady` is now defined
  immediately at script-load time instead of inside `init()`, so it's never missed regardless of
  when the SDK finishes loading relative to app startup. (`frontend/spotify.js`)
- **"Akon next" reliability**: `nextTrack()` (and `previousTrack()`, `pause()`, `resume()`,
  `setVolume()`) now call the SDK player's own methods directly, which act on this exact browser
  device without depending on Spotify Connect's "active device" state. Web API calls remain as a
  fallback only. (`frontend/spotify.js`)
- **Wrong song selected on noisy/transliterated input**: search now strips filler words (English
  and common Hinglish transliteration tokens), tries progressively shorter query fallbacks, and
  scores every candidate with token-overlap + Levenshtein similarity plus an artist-name boost,
  instead of blindly taking Spotify's raw top-1 result. (`frontend/spotify.js`)
- **Device-not-active errors**: added `transferPlaybackHere()` (explicit `PUT /v1/me/player`
  transfer with exponential backoff, max 3 tries) called automatically on `ready`, and
  `ensureActiveDevice()` called before every playback action. (`frontend/spotify.js`)

### Added
- `GET /auth/debug` — auth/device diagnostics (token expiry, last refresh time, last known device
  id, configured redirect URI). Never exposes tokens or secrets. (`backend/auth.js`)
- `POST /auth/device` — frontend reports its current SDK device id for the debug panel.
  (`backend/auth.js`)
- Hidden, toggleable debug panel in the UI showing the above plus a rolling client-side log of
  commands, search matches/scores, and playback errors. (`frontend/index.html`, `frontend/app.js`,
  `frontend/spotify.js`, `frontend/style.css`)
- `test/matching.test.js` — credential-free unit tests for the search-matching pipeline.
- Server startup now logs the configured redirect URI (not secrets) to make Render/local
  misconfiguration obvious immediately. (`backend/server.js`)

### Changed
- `apiRequest()` now checks `res.ok`, logs failures with status + body, and retries once on
  `429`/`5xx`. (`frontend/spotify.js`)
- `voice.js` strips trailing punctuation from recognized commands before matching.
- `README.md` and `.env.example` updated with a full QA checklist and Render deployment steps.

### Unchanged (by design)
- No UI redesign — the existing layout, styling, and folder structure are preserved; the debug
  panel is additive and hidden by default.
- Still uses the Web Playback SDK exclusively for in-browser playback; the Web API is used only for
  search, transfer, and playback control as before.
- Token storage remains in-memory / single-user, matching the original project's scope.

## v1 — Initial build

- Initial Akon project: Express backend with Spotify OAuth, Web Playback SDK frontend, Web Speech
  API wake-word ("Akon") listener, basic play/pause/next/previous/volume commands.
