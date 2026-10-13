// Smoke scenarios: the contract Behaviors from the v6 brief, driven through the real UI.
module.exports = async function scenarios(browser, h) {
  const { newPage, check, sleep, text, visible, calls, say, bodyHas, waitFor, shot } = h;
  const has = async (page, sel) => !!(await page.$(sel));

  // ---------------------------------------------------------------- signed out
  {
    const { page, ctx, state } = await newPage(browser, { loggedIn: false });
    await sleep(400);
    check(await visible(page, '#loginBtn'), 'signed-out: Connect Spotify visible');
    check(!(await visible(page, '#app')), 'signed-out: #app hidden');
    check((await text(page, '#phaseCaption')) === 'Connect Spotify to begin', 'signed-out: caption');
    await shot(page, 'desktop-signed-out');
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(300);
    await shot(page, 'mobile-signed-out');
    const noScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    check(noScroll, 'signed-out mobile: no horizontal scroll');
    check(state.errors.length === 0, `signed-out: no page errors ${state.errors.join(' | ')}`);
    await ctx.close();
  }

  // ---------------------------------------------------------------- server waking (B11)
  {
    const { page, ctx, state } = await newPage(browser, { loggedIn: true, statusFailures: 2 });
    if (await has(page, '#serverNote')) {
      const shown = await waitFor(() => visible(page, '#serverNote'), 2500);
      check(shown, 'cold start: "Waking the server" note shows while /auth/status fails');
      await shot(page, 'desktop-server-waking');
      const up = await waitFor(() => visible(page, '#app'), 12000);
      check(up, 'cold start: app appears once /auth/status recovers');
      check(!(await visible(page, '#serverNote')), 'cold start: note hidden after recovery');
    }
    check(state.errors.length === 0, `cold start: no page errors ${state.errors.join(' | ')}`);
    await ctx.close();
  }

  // ---------------------------------------------------------------- main flows (desktop)
  for (const vp of [{ width: 1440, height: 900, tag: 'desktop' }, { width: 390, height: 844, tag: 'mobile' }]) {
    const { page, ctx, state } = await newPage(browser, { viewport: vp });
    const T = vp.tag;
    check(await waitFor(() => visible(page, '#app')), `${T}: app visible when logged in`);
    check(await waitFor(async () => (await text(page, '#listeningStatus')) === 'Player ready'), `${T}: player ready`);
    check(await waitFor(() => bodyHas(page, 'phase-idle')), `${T}: idle phase after mic start`);
    await sleep(1600); // let the iris texture finish revealing before the screenshot
    await shot(page, `${T}-idle`);

    // first gesture unlocks audio
    await page.mouse.click(5, vp.height - 5);
    check((await calls(page)).includes('activateElement'), `${T}: first gesture calls activateElement`);

    // "Iris iris" must not search for a song
    await say(page, 'iris iris');
    await sleep(300);
    check(state.resolves.length === 0, `${T}: "iris iris" does not search (resolves=${JSON.stringify(state.resolves)})`);
    check(await bodyHas(page, 'phase-listening'), `${T}: "iris iris" -> listening`);
    await shot(page, `${T}-listening`);
    await say(page, 'play believer');
    check(await waitFor(() => state.resolves.includes('believer')), `${T}: follow-up "play believer" resolves`);
    check(await waitFor(async () => /Believer/.test(await text(page, '#nowPlaying'))), `${T}: now playing Believer`);
    if (await has(page, '#dock')) {
      check(await waitFor(() => bodyHas(page, 'has-track')), `${T}: dock shows once a track exists`);
      check(await waitFor(async () => (await text(page, '#dockTitle')) === 'Believer'), `${T}: dock title`);
    }
    if (await has(page, '#choices')) {
      check(await waitFor(() => visible(page, '#choices')), `${T}: "Did you mean" cards for runners-up`);
    }
    await sleep(500);
    await shot(page, `${T}-playing`);

    // option two (voice)
    await say(page, 'iris option two');
    check(await waitFor(async () => /Believer - Live/.test(await text(page, '#nowPlaying'))), `${T}: "option two" plays the runner-up`);

    // pause / resume / next / previous / volume
    await say(page, 'iris pause');
    check(await waitFor(async () => (await calls(page)).includes('pause')), `${T}: "Iris pause" pauses`);
    check(await waitFor(async () => (await text(page, '#playbackStatus')) === 'Paused'), `${T}: playback status Paused`);
    await sleep(300);
    await shot(page, `${T}-paused`);
    await say(page, 'iris resume');
    check(await waitFor(async () => (await calls(page)).includes('resume')), `${T}: "Iris resume" resumes`);
    await say(page, 'iris next');
    check(await waitFor(async () => (await calls(page)).includes('nextTrack')), `${T}: "Iris next"`);
    await say(page, 'iris previous');
    check(await waitFor(async () => (await calls(page)).includes('previousTrack')), `${T}: "Iris previous"`);
    await say(page, 'iris volume up');
    check(await waitFor(async () => (await calls(page)).some((c) => c.startsWith('setVolume:'))), `${T}: "Iris volume up" sets volume`);
    check(await waitFor(() => page.$$eval('.toast', (t) => t.some((x) => /Volume/.test(x.textContent)))), `${T}: volume toast`);

    // choose (did you mean) + tap a card
    await say(page, 'iris play stronger');
    check(await waitFor(() => state.resolves.includes('stronger')), `${T}: "play stronger" resolves`);
    check(await waitFor(async () => /Did you mean/.test((await text(page, '#matchHint')) || '')), `${T}: choose hint shown`);
    if (await has(page, '#choices')) {
      check(await waitFor(async () => (await page.$$('#choices .choice')).length === 3), `${T}: three choice cards`);
      await sleep(300);
      await shot(page, `${T}-choose`);
      await page.click('#choices .choice:nth-child(2)');
      check(await waitFor(async () => /Kelly Clarkson/.test(await text(page, '#nowPlaying'))), `${T}: tapping card 2 plays option two`);
    }

    // not found / search failed
    await say(page, 'iris play qwxzz');
    check(await waitFor(async () => /couldn/i.test(await text(page, '#phaseCaption'))), `${T}: not-found caption`);
    await sleep(200);
    await shot(page, `${T}-not-found`);
    await say(page, 'iris play fail now');
    check(await waitFor(async () => /Search failed/i.test(await text(page, '#phaseCaption'))), `${T}: search-failed caption`);

    // keyboard: Space toggles, arrows skip (focus on body)
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    const before = (await calls(page)).length;
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    const after = (await calls(page)).slice(before);
    check(after.some((c) => c === 'pause' || c === 'resume') && after.includes('nextTrack') && after.includes('previousTrack'), `${T}: keyboard Space/arrows (${after.join(',')})`);

    // Start listening (button, L key, eye tap)
    if (await has(page, '#listenBtn')) {
      await page.click('#listenBtn');
      check(await waitFor(() => bodyHas(page, 'phase-listening')), `${T}: Start listening -> listening`);
      check(/Listening/.test(await text(page, '#listenBtn')), `${T}: listen button flips label`);
      const n = state.resolves.length;
      await say(page, 'play iris');
      check(await waitFor(() => state.resolves.length > n && state.resolves[state.resolves.length - 1] === 'iris'), `${T}: tap-to-talk "play iris" -> song Iris`);
      await waitFor(() => bodyHas(page, 'phase-idle'), 4000);
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await page.keyboard.press('l');
      check(await waitFor(() => bodyHas(page, 'phase-listening')), `${T}: "L" key starts listening`);
      await page.keyboard.press('l');
      check(await waitFor(() => bodyHas(page, 'phase-idle')), `${T}: "L" again cancels`);
      await page.click('#stage');
      check(await waitFor(() => bodyHas(page, 'phase-listening')), `${T}: tapping the eye starts listening`);
      await page.click('#stage');
      await waitFor(() => bodyHas(page, 'phase-idle'));
    }

    // dock transport calls the same SpotifyController functions
    if (await has(page, '#dockPlay') && (await visible(page, '#dockPlay'))) {
      const b2 = (await calls(page)).length;
      await page.click('#dockPlay');
      await page.click('#dockNext');
      await page.click('#dockPrev');
      const c2 = (await calls(page)).slice(b2);
      check(c2.some((c) => c === 'pause' || c === 'resume') && c2.includes('nextTrack') && c2.includes('previousTrack'), `${T}: dock transport (${c2.join(',')})`);
    }

    // mute toggle
    await page.click('#micBtn');
    check(await waitFor(async () => (await text(page, '#micBtn')) === 'Turn on microphone'), `${T}: mute -> "Turn on microphone"`);
    check((await text(page, '#phaseCaption')) === 'Microphone off', `${T}: muted caption`);
    if (await has(page, '#micPill')) check(/Muted/.test(await text(page, '#micPill')), `${T}: mic pill says Muted`);
    await shot(page, `${T}-muted`);
    await page.click('#micBtn');
    check(await waitFor(async () => (await text(page, '#micBtn')) === 'Mute microphone'), `${T}: unmute`);

    // autoplay blocked toast
    await page.evaluate(() => window.__player._fire('autoplay_failed'));
    check(await waitFor(() => page.$$eval('.toast', (t) => t.some((x) => /blocked sound/.test(x.textContent)))), `${T}: autoplay-blocked toast`);
    await sleep(200);
    await shot(page, `${T}-autoplay-blocked`);

    // debug panel
    if (await has(page, '#diagBtn')) await page.click('#diagBtn');
    await page.click('#debugToggle');
    check(await waitFor(() => visible(page, '#debugLog')), `${T}: debug panel opens`);
    check(await waitFor(async () => /Server auth\/device state/.test(await text(page, '#debugLog'))), `${T}: debug panel content`);
    await shot(page, `${T}-diagnostics`);
    await page.click('#debugToggle');
    check(await waitFor(async () => !(await visible(page, '#debugLog'))), `${T}: debug panel closes`);
    if (await has(page, '#diagClose')) {
      await page.keyboard.press('Escape');
      check(await waitFor(() => page.$eval('#diag', (d) => !d.classList.contains('open'))), `${T}: Esc closes the diagnostics drawer`);
    }

    // mic blocked / no mic
    await page.evaluate(() => window.__speech.error('not-allowed'));
    check(await waitFor(async () => /blocked/i.test(await text(page, '#phaseCaption'))), `${T}: mic blocked caption`);
    if (await has(page, '#micPill')) check(/Blocked/.test(await text(page, '#micPill')), `${T}: mic pill Blocked`);
    await sleep(200);
    await shot(page, `${T}-mic-blocked`);
    if (await has(page, '#micRetry')) {
      await page.click('#micRetry');
      check(await waitFor(() => bodyHas(page, 'phase-idle')), `${T}: Retry restarts the mic`);
    } else {
      await page.click('#micBtn');
    }
    await waitFor(() => bodyHas(page, 'phase-idle'));
    await page.evaluate(() => window.__speech.error('audio-capture'));
    check(await waitFor(async () => /No microphone/i.test(await text(page, '#phaseCaption'))), `${T}: no-mic caption`);
    await shot(page, `${T}-no-mic`);
    const recovered = await waitFor(() => bodyHas(page, 'phase-idle'), 4000);
    const why = recovered ? '' : JSON.stringify(await page.evaluate(() => ({ cls: document.body.className, sp: window.__speech.log.slice(-8), dbg: window.AkonDebug.logs.slice(-6) })));
    check(recovered, `${T}: audio-capture recovers on its own ${why}`);

    // ambient mode
    if (await has(page, '#ambientBtn')) {
      await page.click('#ambientBtn');
      check(await bodyHas(page, 'ambient'), `${T}: ambient mode on`);
      check(await waitFor(async () => !(await visible(page, '#dock')), 1500), `${T}: ambient hides the dock`);
      await sleep(400);
      await shot(page, `${T}-ambient`);
      await page.keyboard.press('Escape');
      check(!(await bodyHas(page, 'ambient')), `${T}: Esc exits ambient`);
    }

    // layout sanity
    const layout = await page.evaluate(() => {
      const c = document.getElementById('irisCanvas').getBoundingClientRect();
      return { w: c.width, h: c.height, hscroll: document.documentElement.scrollWidth > window.innerWidth };
    });
    check(layout.w > 150 && Math.abs(layout.w - layout.h) < 1, `${T}: eye canvas square and sized (${Math.round(layout.w)}x${Math.round(layout.h)})`);
    check(!layout.hscroll, `${T}: no horizontal scroll`);
    if (T === 'desktop') check(layout.w >= 500, `${T}: eye fills the stage (>= 500px, got ${Math.round(layout.w)})`);

    const minFont = await page.evaluate(() => {
      let min = 99;
      let where = '';
      for (const el of document.querySelectorAll('body *')) {
        if (!el.offsetParent || !el.childNodes.length) continue;
        const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!hasText) continue;
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (fs < min) { min = fs; where = el.id || el.className; }
      }
      return { min, where };
    });
    if (await has(page, '#dock')) check(minFont.min >= 13, `${T}: minimum visible text 13px (got ${minFont.min} on ${minFont.where})`);

    check(state.errors.length === 0, `${T}: no page errors ${state.errors.join(' | ')}`);
    await ctx.close();
  }

  // ---------------------------------------------------------------- 401 refresh (B9)
  {
    const { page, ctx, state } = await newPage(browser, {});
    await waitFor(async () => (await text(page, '#listeningStatus')) === 'Player ready');
    await waitFor(() => bodyHas(page, 'phase-idle'));
    await page.evaluate(() => { window.__api401Once = true; });
    await say(page, 'iris play believer');
    check(await waitFor(async () => /Believer/.test(await text(page, '#nowPlaying'))), '401: play still succeeds after one expired-token response');
    const api = await page.evaluate(() => window.__api.filter((a) => a.includes('/me/player/play')).length);
    check(api >= 2, `401: play retried after token refresh (${api} calls)`);
    check(state.errors.length === 0, `401: no page errors ${state.errors.join(' | ')}`);
    await ctx.close();
  }

  // ---------------------------------------------------------------- first run + duck
  {
    const { page, ctx, state } = await newPage(browser, { firstRunDone: false });
    await waitFor(async () => (await text(page, '#listeningStatus')) === 'Player ready');
    await waitFor(() => bodyHas(page, 'phase-idle'));
    if (await has(page, '#firstRun')) {
      check(await visible(page, '#firstRun'), 'first run: chips visible on first visit');
      await shot(page, 'desktop-first-run');
      await say(page, 'iris play believer');
      await waitFor(async () => /Believer/.test(await text(page, '#nowPlaying')));
      check(await waitFor(async () => !(await visible(page, '#firstRun')), 4000), 'first run: chips disappear after the first successful command');
    }
    // duck (B7): music playing at 70 -> wake ducks to 25 -> command restores.
    await waitFor(async () => /Believer/.test(await text(page, '#nowPlaying')) || (await say(page, 'iris play believer')) && false, 3000);
    await page.evaluate(() => { window.__player.vol = 0.7; window.__player.calls.length = 0; });
    await say(page, 'iris', {});
    const ducked = await waitFor(async () => (await calls(page)).includes('setVolume:25'), 2000);
    const duckOn = await page.evaluate(() => (window.IRIS_FLAGS || {}).duck !== false && !!window.IrisDuck);
    if (duckOn) {
      check(ducked, 'duck: wake word ducks music to 25%');
      await say(page, 'pause');
      check(await waitFor(async () => (await calls(page)).includes('setVolume:70'), 3000), 'duck: volume restored to 70% after the command');
      await page.evaluate(() => { window.__player.vol = 0.7; window.__player.calls.length = 0; });
      await page.evaluate(() => window.__player.resume());
      await say(page, 'iris');
      await waitFor(async () => (await calls(page)).includes('setVolume:25'), 2000);
      await say(page, 'volume 40');
      await sleep(600);
      const cs = await calls(page);
      check(cs.includes('setVolume:40') && cs.lastIndexOf('setVolume:70') < cs.lastIndexOf('setVolume:40') && cs[cs.length - 1] !== 'setVolume:70', `duck: never restores over a volume command (${cs.join(',')})`);
      await page.evaluate(() => { window.__player.vol = 0.2; window.__player.calls.length = 0; });
      await say(page, 'iris');
      await sleep(500);
      check(!(await calls(page)).some((c) => c.startsWith('setVolume')), 'duck: no duck when volume already <= 25%');
      await page.click('#micBtn');
      await page.click('#micBtn');
    }
    check(state.errors.length === 0, `first run/duck: no page errors ${state.errors.join(' | ')}`);
    await ctx.close();
  }

  // ---------------------------------------------------------------- Premium required / connecting / near-miss notes
  {
    const { page, ctx, state } = await newPage(browser, {});
    await waitFor(() => visible(page, '#app'));
    if (await has(page, '#stageNote')) {
      const early = await text(page, '#stageNote');
      check(/Connecting/.test(early) || (await text(page, '#listeningStatus')) === 'Player ready', `notes: connecting-player note before ready ("${early}")`);
      await waitFor(async () => (await text(page, '#listeningStatus')) === 'Player ready');
      check(await waitFor(async () => !/Connecting/.test(await text(page, '#stageNote'))), 'notes: connecting note clears when ready');
      await waitFor(() => bodyHas(page, 'phase-idle'));
      await say(page, 'eris plays something');
      check(await waitFor(async () => /Almost heard/.test(await text(page, '#stageNote'))), 'notes: near-miss shows "Almost heard"');
      await page.evaluate(() => window.__player._fire('account_error', { message: 'premium' }));
      check(await waitFor(async () => /Premium/.test(await text(page, '#stageNote'))), 'notes: Spotify Premium required');
      await shot(page, 'desktop-premium-required');
    }
    check(state.errors.length === 0, `notes: no page errors ${state.errors.join(' | ')}`);
    await ctx.close();
  }

  // ---------------------------------------------------------------- reduced motion + eye render
  {
    const { page, ctx, state } = await newPage(browser, { reducedMotion: 'reduce' });
    await waitFor(() => bodyHas(page, 'phase-idle'));
    await sleep(1500);
    const lit = await page.evaluate(() => {
      const c = document.getElementById('irisCanvas');
      const d = c.getContext('2d').getImageData(c.width / 2 - 100, c.height / 2 - 100, 200, 200).data;
      let s = 0;
      for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
      return s / (d.length / 4);
    });
    check(lit > 5, `eye: canvas draws the iris (mean ${lit.toFixed(1)})`);
    check(state.errors.length === 0, `reduced motion: no page errors ${state.errors.join(' | ')}`);
    await ctx.close();
  }
};
