// Injected into the page BEFORE any app script (page.addInitScript). Replaces the
// browser's speech recognizer and the Spotify SDK with scripted fakes so the real
// frontend can be driven end-to-end in headless Chromium with no mic and no Spotify.
/* eslint-disable */
(() => {
  // ---------------- fake SpeechRecognition
  const S = (window.__speech = { recs: [], log: [] });
  class FakeSR {
    constructor() { S.recs.push(this); this.running = false; this.results = []; }
    start() {
      S.log.push('start');
      if (this.running) { const e = new Error('already started'); e.name = 'InvalidStateError'; throw e; }
      this.running = true; this.results = [];
      setTimeout(() => { this.onstart && this.onstart(); this.onaudiostart && this.onaudiostart(); }, 5);
    }
    stop() {
      S.log.push('stop');
      if (!this.running) return;
      const open = this.results.findIndex((r) => !r.isFinal);
      if (open !== -1) this._emit(open, [this.results[open][0].transcript], true);
      this._end();
    }
    abort() { S.log.push('abort'); if (this.running) this._end(); }
    _end() { this.running = false; setTimeout(() => this.onend && this.onend(), 5); }
    _emit(i, alts, fin) {
      const r = alts.map((t) => ({ transcript: t }));
      r.isFinal = fin;
      this.results[i] = r;
      this.onresult && this.onresult({ resultIndex: i, results: this.results });
    }
  }
  window.SpeechRecognition = FakeSR;
  window.webkitSpeechRecognition = FakeSR;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  S.say = async (text, opts = {}) => {
    const r = S.recs[S.recs.length - 1];
    if (!r || !r.running) { S.log.push('say-dropped:' + text); return false; }
    const i = r.results.length;
    const words = text.split(' ');
    for (let k = 1; k <= words.length; k++) { r._emit(i, [words.slice(0, k).join(' ')], false); await wait(opts.step || 60); }
    if (!opts.noFinal) r._emit(i, [opts.final || text], true);
    return true;
  };
  S.error = (code) => { const r = S.recs[S.recs.length - 1]; r.onerror && r.onerror({ error: code }); r.abort(); };

  // ---------------- fake Spotify Web Playback SDK (served in place of sdk.scdn.co)
  const CATALOG = (window.__catalog = {});
  class Player {
    constructor(opts) { this.opts = opts; this.l = {}; this.vol = opts.volume || 0.7; this.calls = []; this.state = null; window.__player = this; }
    addListener(n, f) { (this.l[n] = this.l[n] || []).push(f); return true; }
    _fire(n, d) { (this.l[n] || []).forEach((f) => f(d)); }
    connect() { this.calls.push('connect'); setTimeout(() => this._fire('ready', { device_id: 'fake-device' }), 30); return Promise.resolve(true); }
    _emit() { this._fire('player_state_changed', JSON.parse(JSON.stringify(this.state))); }
    _set(patch) { if (!this.state) return; Object.assign(this.state, patch); this._emit(); }
    pause() { this.calls.push('pause'); this._set({ paused: true }); return Promise.resolve(); }
    resume() { this.calls.push('resume'); this._set({ paused: false }); return Promise.resolve(); }
    nextTrack() { this.calls.push('nextTrack'); this._set({ position: 0 }); return Promise.resolve(); }
    previousTrack() { this.calls.push('previousTrack'); this._set({ position: 0 }); return Promise.resolve(); }
    setVolume(v) { this.calls.push('setVolume:' + Math.round(v * 100)); this.vol = v; return Promise.resolve(); }
    getVolume() { return Promise.resolve(this.vol); }
    activateElement() { this.calls.push('activateElement'); }
    _play(uri) {
      const t = CATALOG[uri] || { name: uri, artists: ['Unknown'], art: null };
      this.state = {
        paused: false, position: 0, duration: 215000, timestamp: Date.now(),
        track_window: { current_track: { uri, name: t.name, artists: t.artists.map((n) => ({ name: n })), album: { images: t.art ? [{ url: t.art, width: 300 }] : [] } } }
      };
      this._emit();
    }
  }
  window.__installFakeSdk = () => {
    window.Spotify = { Player };
    // The real SDK signals readiness asynchronously (after its iframe loads), i.e. after the app scripts.
    window.addEventListener('load', () => setTimeout(() => window.onSpotifyWebPlaybackSDKReady && window.onSpotifyWebPlaybackSDKReady(), 30));
  };

  // Spotify Web API calls (play / transfer / volume fallbacks) never leave the page.
  const realFetch = window.fetch.bind(window);
  window.__api = [];
  window.fetch = (url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.spotify.com/')) {
      window.__api.push(`${opts.method || 'GET'} ${u.replace('https://api.spotify.com/v1', '')}`);
      if (window.__api401Once && !u.includes('/me/player?') && opts.method === 'PUT' && u.includes('/play')) {
        window.__api401Once = false;
        return Promise.resolve(new Response('{"error":"expired"}', { status: 401 }));
      }
      if (u.includes('/me/player/play') && opts.body) {
        try {
          const b = JSON.parse(opts.body);
          const uri = (b.offset && b.offset.uri) || (b.uris && b.uris[0]);
          if (uri && window.__player) setTimeout(() => window.__player._play(uri), 20);
        } catch (e) { /* ignore */ }
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    return realFetch(url, opts);
  };
})();
