# Iris v6 — "The Stage"

The eye is the interface. Everything else is quiet furniture that appears when it
matters: a mic pill, one line of copy under the eye, a glass dock when something is
playing, cards only when Iris needs you to choose. Black, with amber and slate taken
from the iris itself.

## Files

| File | Role |
|---|---|
| `frontend/flags.js` | `window.IRIS_FLAGS`, loaded first. Every module reads it defensively. |
| `frontend/stage.css` | Tokens, layout, every state. Loaded after `style.css` and `polish.css`. |
| `frontend/stage.js` | UI behaviour. Listens to `akon:*`; talks back only through `iris:listen` / `iris:select`. |
| `frontend/duck.js` | B7 music ducking. Listens to `akon:wake` / `akon:phase` / `akon:state`. |
| `frontend/voice.js` | B1–B6, B8 (wake word, resilience, tap-to-talk). |
| `frontend/spotify.js` | B9 (401 → refresh token, retry once); `setVolume(p, {quiet})`. |
| `frontend/app.js` | Tiny additive listeners: `iris:listen`, `iris:select`, "L" key, `#listenBtn`, B11 retry, extra `akon:resolved` fields. |
| `frontend/iris.js` | Frame loop only (B10). Drawing code unchanged. |

Script order: `flags.js`, Spotify SDK, `intent.js`, `spotify.js`, `voice.js`, `duck.js`,
`app.js`, `polish.js`, `stage.js`, `iris.js`.

## Tokens

| Token | Value | Use |
|---|---|---|
| `--void` | `#000000` | Page |
| `--bone` | `#ece7df` | Primary text, play button (17.1:1) |
| `--ash` | `#8f9498` | Secondary text (6.9:1) |
| `--dim` | `#7d8286` | Tertiary text: hints, footer, notes (5.4:1; v5 was 3.4:1) |
| `--amber` | `#d8a24a` | Listening, progress, focus ring (9.2:1) |
| `--slate` | `#83a5b8` | Idle / thinking atmosphere, ready dot (8.0:1) |
| `--danger` | `#e2766f` | Blocked / no mic / errors (7.1:1) |
| `--glass` / `--glass-line` | bone at 5% / 10% | The dock only |
| `--art`, `--art-glow`, `--art-strong` | sampled | Album tint (flag `tint`) |

- Type: Palatino stack (`--serif`) for the wordmark, the caption and track titles; the
  system sans for UI. Scale 13 / 15 / 17 / 22 / 28 / 40 px. Nothing visible under 13 px
  (checked by the smoke test).
- Spacing on a 4/8 grid. Radii: dock 20, cards 14, pills 999.
- Motion: 160 ms micro, 280 ms state, 600 ms ambient, `cubic-bezier(.2,.8,.2,1)`.
  `prefers-reduced-motion` stops the breathing, the orbit, the caption fade and slides.
- Eye: `--eye: clamp(240px, min(58vh, 56vw), 800px)` on desktop, `min(100vw - 8px, 50vh)`
  on phones; square, never zero-sized (iris.js measures it).
- Atmosphere: `--glow` is a registered `@property` colour driven by `body.phase-*`
  (off ash, idle slate breathing, listening amber bloom, thinking slate orbit, speaking
  amber). The opaque canvas uses `mix-blend-mode: screen` so the glow shows through its
  black with no square edge.

## States

| State | What you see |
|---|---|
| Signed out | Dimmed eye, "Connect Spotify to begin", one line of copy, one Connect button, quiet footer |
| Server waking | Amber line "Waking the server…" while `/auth/status` retries (B11) |
| Connecting player | Note "Connecting the Spotify player…" until the SDK is ready |
| Idle | Pill "Ready", caption "Say “Iris”", slate breathing glow |
| Listening | Pill "Listening", amber bloom, live transcript in amber (2 lines max) |
| Thinking | Slate orbit, transcript in bone |
| Speaking / done | Caption "Playing X" etc., amber settle |
| Resolving | Dock slides in with the skeleton shimmer on the art |
| Playing / paused | Dock: art, title, artist, prev / play-pause / next, volume, time; ring fills around the eye (ash when paused) |
| Choose / runners-up | "Did you mean" cards under the controls (tap or say "option two") |
| Not found / search failed | Caption from iris.js; hint line |
| Muted | Pill "Muted", caption "Microphone off" |
| Mic blocked | Pill "Blocked" + Retry, caption explains the address-bar fix |
| No mic | Pill "No mic" + Retry, note "Iris keeps checking" (auto-retries with backoff) |
| Autoplay blocked | Toast plus note "Tap anywhere to allow sound." until the next tap |
| Premium required | Note "Spotify Premium is required to play music here." |
| Near miss | Dim italic "Almost heard: “…”. Start with “Iris”." for 4 s |
| Ambient | Only the wordmark, the eye and the ring; cursor hides after 3 s; tap or Esc exits; screen kept awake |
| First run | Chips 1 Connect · 2 Allow the microphone · 3 Say “Iris”; gone after the first successful command |

## Events

Unchanged (names and payloads; fields only added):
`akon:phase {phase, reason?, command?}` (new reasons: `manual`, `cancelled`),
`akon:wake` (new optional `{reason:'manual'}`), `akon:hearing {text}`,
`akon:heard {command, transcript}`, `akon:state`, `akon:match {name, artist, score, art}`,
`akon:resolved {action, message, options?, alternatives?}` (options/alternatives added),
`akon:autoplay-blocked`.

New:

| Event | Emitted by | Handled by | Meaning |
|---|---|---|---|
| `iris:listen` | stage.js (eye tap), app.js (button, "L") | app.js | Toggle tap-to-talk: `VoiceControl.listenNow()` / `cancelListening()` |
| `iris:select {index}` | stage.js (card tap) | app.js | Runs the existing `handleCommand("option two")` path |
| `iris:near-miss {text}` | voice.js | stage.js | Something close to "Iris" was heard but ignored |
| `iris:server {state}` | app.js | stage.js | `waking` / `up` / `down` during `/auth/status` retries |

New APIs (additive): `VoiceControl.listenNow()`, `VoiceControl.cancelListening()`,
`VoiceControl.getPhase()`, `SpotifyController.setVolume(percent, {quiet})`,
`window.IrisDuck {duck, release, cancel, isActive}`.

## Flags (`frontend/flags.js`)

| Flag | Default | Turns off |
|---|---|---|
| `fuzzyWake` | `true` | Fuzzy wake matching (exact wake words still work) |
| `nearMiss` | `true` | The "Almost heard" line (misses are still logged) |
| `duck` | `true` | Lowering music while listening |
| `coldStart` | `true` | `/auth/status` retries + "Waking the server" (back to v5's single try) |
| `arc` | `true` | Progress ring around the eye |
| `tint` | `true` | Album-art colour in the glow and ring |
| `didYouMean` | `true` | Tappable cards (voice "option two" still works) |
| `firstRun` | `true` | First-visit chips |
| `ambient` | `true` | Ambient mode button |
| `diagnostics` | `true` | Drawer; when off, the debug panel sits inline at the bottom |
| `eyeThrottle` | `true` | 30 fps idle / no drawing while hidden (verified in headless Chromium: 60→30 fps idle, 59 fps listening, 0 hidden) |

Per-browser override without editing code:
`localStorage.setItem('iris.flags', JSON.stringify({ duck: false }))`, then reload.
