/**
 * Iris feature flags (v6). Loaded FIRST, before every other app script.
 *
 * Every module reads these defensively — `(window.IRIS_FLAGS || {})` plus its own
 * default — so deleting this file, or a key in it, falls back to safe behaviour.
 * Flip a value to false to roll that one feature back without touching code.
 * You can also override per browser from the console before reload, e.g.
 *   localStorage.setItem('iris.flags', JSON.stringify({ duck: false }))
 */
(function () {
  var defaults = {
    // Voice (voice.js / app.js)
    fuzzyWake: true,    // B2: accept close mishearings of "Iris" on the first 1-3 words
    nearMiss: true,     // B3: show a dim "Almost heard: ..." line under the eye
    duck: true,         // B7: lower music to 25% while Iris listens, then restore
    coldStart: true,    // B11: retry /auth/status and say "Waking the server..."

    // The Stage UI (stage.js / stage.css)
    arc: true,          // progress ring around the eye
    tint: true,         // album-art colour blended into the glow and the ring
    didYouMean: true,   // tappable "Did you mean" cards
    firstRun: true,     // 1-2-3 setup chips on first visit
    ambient: true,      // ambient mode (eye only, screen kept awake)
    diagnostics: true,  // debug panel lives in a drawer behind the gear icon

    // The eye (iris.js frame loop only)
    eyeThrottle: true   // B10: ~30 fps when idle/off, no drawing while the tab is hidden
  };
  var overrides = {};
  try {
    overrides = JSON.parse(window.localStorage.getItem('iris.flags') || '{}') || {};
  } catch (e) {
    overrides = {};
  }
  var flags = {};
  var k;
  for (k in defaults) flags[k] = defaults[k];
  for (k in overrides) if (Object.prototype.hasOwnProperty.call(defaults, k)) flags[k] = !!overrides[k];
  window.IRIS_FLAGS = flags;
})();
