# Manual checks — real microphone + real Spotify Premium (v6)

The automated tests use a scripted fake recognizer and a fake Spotify SDK. These ten
checks cover what only a real voice, a real mic and a real Premium account can prove.
Use desktop Chrome, music speakers on, normal room noise. Open the Diagnostics drawer
(sliders icon, top right) and press "Show Debug Info" to watch the log while you test.

| # | Do this | Pass when |
|---|---|---|
| 1 | With nothing playing, say "Iris". Wait 2 seconds, then say "play Believer". | The eye blooms amber on "Iris", stays listening through the pause (no "Closing the utterance" line in the log before you speak), then Believer plays. |
| 2 | Say "Iris iris". | Listening opens and **no song plays**; the log shows `listening for a command`, not a search for "iris". Then say "play Iris" — The Goo Goo Dolls' Iris plays. |
| 3 | While music plays at a normal level, say "Iris, pause". | The music dips to about a quarter as soon as you say "Iris", then playback pauses; the log shows "Lowered music" then "Restored music". Say "Iris, resume". |
| 4 | Say "Iris, next", then "Iris, volume up". | The track skips; the volume goes up from the level you had before the dip (not from 25%). |
| 5 | Press "Start listening" (or tap the eye, or press L). Say "play Kesariya" with no wake word. | It plays. The button reads "Listening… (tap to cancel)" while open; tapping again cancels. |
| 6 | Press "Mute microphone", say "Iris, pause", then press "Turn on microphone" and say it again. | Nothing happens while muted (pill "Muted"); after unmuting the pause works. |
| 7 | Hide the tab (switch tabs) for a full minute while music plays, come back, say "Iris, next". | Music kept playing at full volume while hidden; the command works on return without a reload. |
| 8 | Say "Iris, play Stronger" (an ambiguous title). | "Did you mean" cards appear under the controls (all three options if Iris asks, or the runners-up if it picked one). Tapping a card plays that song; saying "Iris, option two" does the same. |
| 9 | Click the moon icon (ambient mode). Leave the mouse still for 3 s, then press Esc. | Only the wordmark, the eye and the ring remain, the cursor hides, the screen does not sleep; Esc (or any tap) brings everything back. |
| 10 | Leave the page open for over an hour, then say "Iris, play Believer". | It plays; if the token had expired the log shows "Access token refreshed after 401 — retrying". |

Also worth a glance: unplug or switch the microphone while idle. The pill should show
"No mic" and then "Ready" again within ~30 s of plugging it back in, without a reload.
Deny the microphone in the address bar: the pill shows "Blocked" with Retry, and nothing
retries in a loop.
