# TwinLine — notes for Claude Code

Dual-line SIP softphone (Electron, plain JavaScript, no framework, no build
step). Owner: Mike (GitHub `gxmonto`, git author "mikebord", mike@sightwatch.com).
Users are real: JetWave and Vital SIP accounts, Windows day to day, Linux
packages too. Ship carefully; every release reaches installed copies through
the built-in updater within hours.

## Commands

```bash
npm test                      # unit + loopback end-to-end tests; must pass
npm run smoke                 # boots the real app headlessly: UI, tray icon, a popped-out panel
npx electron . --smoke --smoke-wav=<16k mono wav>   # also runs speech through the recognition worker
npm run dist:win              # dist/<version>/ — needs Windows Developer Mode (or dist:win:noedit)
npm run dist:linux:docker     # .deb/.rpm/AppImage via Docker (cannot build on Windows natively)
npm run release -- patch|minor|major|x.y.z          # THE way to ship (see below)
node tools/transcribe-file.js speech.wav --telephone  # check a speech model on a recording
node tools/serve-updates.js dist/<v> 8123             # rehearse an update against a local feed
```

Packaged binaries can be checked too: `dist/<v>/win-unpacked/TwinLine.exe --smoke`
and `--update-check=<feed url>` (download-only rehearsal of the updater).

## Shipping

1. Write what changed *for users* in `release-notes.md` (empty notes are refused).
2. Commit everything (a dirty tree is refused).
3. `npm run release -- patch` → bumps version, updates CHANGELOG.md, tags, pushes,
   resets `release-notes.md` to its template in a follow-up commit.
4. GitHub Actions (`.github/workflows/release.yml`) builds Windows + Linux,
   uploads to a draft release, and publishes it — with a "Downloads" table
   prepended to the notes — only when both platforms are done. Watch with
   `gh run list` / `gh run watch <id>`. `ci.yml` (`build.yml`) runs tests, the
   smoke check and a no-publish packaging run on every push.
5. Installed copies find the release via electron-updater (GitHub provider is
   baked in by `build.publish` + `repository` in package.json).

Rules:
- Never publish installers by hand; never hand-edit `version` for a shipped build.
- Windows artefacts are `TwinLine-Installer-<v>.exe` / `TwinLine-Portable-<v>.exe`
  (set via `nsis.artifactName` / `portable.artifactName`). The `.blockmap` and
  `.yml` assets are required by the updater — keep them; Mike asked and accepted.
- `--update-check` once silently installed a throwaway build before the
  install-on-quit guard existed (`updater.disableInstallOnQuit()` in
  `runUpdateCheck`). Keep the guard. Never build a throwaway higher version
  and point a real installed copy at it.
- Versioning (Mike's rule, 2026-09-23): the third number for everything —
  fixes, small features, visual tweaks — and the second number only for a big
  change. Versions are three numbers (semver, the updater orders them); the
  fourth digit Windows shows is padding and cannot be used. History: 1.0.0 first build →
  1.0.1 legacy-hold fix → 1.0.2 tray icon → 1.0.3 network re-registration +
  logging → 1.0.4 in-app updates → 1.1.0 transcription (Whisper) → 1.2.0
  Parakeet engine, frameless window → 1.2.1 artefact names → 1.3.0 pop-out panels →
  1.4.0 security review, Electron 44, conference-wide transcription, call-waiting
  tone, transcript auto-close → 1.4.1 native caption buttons, popup manual drag →
  1.4.2 hosted-conference detection, voice separation, 302 redirect.

## Architecture in one breath

Main process owns SIP (`src/main/sip`: hand-written parser, digest, SDP,
UDP/TCP/TLS transports, RFC 3261 transactions, dialogs), RTP + G.711
(`src/main/rtp`), the 20 ms audio clock and mix-minus conference bus
(`src/main/media`), transcription (`src/main/transcribe`, sherpa-onnx in a
utility process), updates (`updater.js`), contacts, settings, logging.
The renderer owns only the microphone/speaker (WebAudio at 8 kHz) and the UI;
`preload.js` is the sole bridge. `callmanager.js` is the source of truth for
calls, hold and conference; every window just renders snapshots it is sent.

Windows: main window (frameless, own title bar), incoming-call popup
(`popup.html`, remembers position), and popped-out panels — the same
`index.html` loaded with `?panel=settings|contacts|history|transcript|transcriptView|transfer`,
which shows only that dialog (`panel-mode` CSS), makes no sound, and closes
the window when the dialog hides (MutationObserver). `send()` in main.js
broadcasts to all windows; only the speaker stream goes to the main window.

## Decisions that look odd but are deliberate

- **Native SIP over UDP/TCP/TLS, not WebRTC/SIP.js** — providers have no
  WebSocket gateway. Do not put this debate in the README; Mike found it noise.
- **Conference is mixed locally** so one party can be dropped or held while
  the others continue. Membership is explicit state (`conferenceIds`), not
  "whatever is bridged"; a held member stays a member and rejoins on Resume;
  answering another call holds the whole conference as one unit.
- **Hold**: we advertise `a=sendonly` and keep RTP flowing (silence) — the peer
  expects a stream and NAT bindings stay open. `a=sendonly` *from* the peer
  means they hold us (they may still send MoH; we keep receiving). Their
  `a=recvonly` answer to our hold is compliance, not a hold. `c=IN IP4 0.0.0.0`
  is legacy hold, never a destination (Vital sends it; caused `EADDRNOTAVAIL 0.0.0.0`).
- **Sockets bind to 0.0.0.0**, never a specific IP: a bound IP that vanishes
  (VPN, Wi-Fi roam, sleep, Docker's vEthernet) fails every send with
  `EADDRNOTAVAIL <valid public ip>` — that was the "people stopped getting
  calls" bug. Lines re-register on resume/unlock/online/socket error/route
  change (`refreshNetwork`).
- **Registration refresh does not show "registering"** — the old binding is
  still valid; only a real failure changes the chip (it flickered amber before).
- **Errors**: RTP send errors are reported once per code per 30 s; toasts
  collapse repeats into "×N", max four. Never let a per-frame error toast.
- **Transcription channels**: microphone and each *party* are separate streams
  (`participants(callId)` from the CallManager lists every conference member,
  labelled by contact/name/number), so *You*/*Caller*/per-party labels need
  no diarisation. One conference = one transcript (`mergeConference` keeps the
  earliest). A finished transcript auto-closes after 5 s unless "Keep open".
- **Hosted conferences** (the PBX bridges, we have one leg): detected from
  `;isfocus` on the remote Contact (RFC 4579) or an identity change to
  "Conference…" (P-Asserted-Identity / Remote-Party-ID / From on a re-INVITE)
  → `call.hostedConference`. Participants cannot be listed — the PBX does not
  tell a phone — so voices are told apart instead: `core.js` computes a
  speaker embedding (wespeaker CAM++, `models/speaker`) per remote utterance,
  `voices.js` clusters online (cosine ≥ 0.6 joins; ≥ 1.2 s needed to found a
  new voice), lines get `voice` and labels "Caller 1/2". Imperfect by nature;
  say so. The mic channel is never clustered.
- **Redirect while ringing**: `Call.deflect(target)` answers the INVITE with
  302 + Contact; the PBX places the call. UI: ↪ icon on incoming cards opens
  the Transfer dialog in "Redirect" mode.
- **Window Controls Overlay** (1.4.1): `TITLE_BAR` in main.js; the page hides
  its own min/max/close when `appInfo.windowControls === 'native'`; overlays
  start at 42 px so OS buttons never cover a dialog header. The incoming popup
  is the exception: frameless, dragged by mouse deltas (`popup:move`), ✕
  dismisses (`popup:dismiss`) while the main window keeps ringing.
- **Call waiting**: an incoming call during a live call plays a soft beep
  (`waiting` pattern), not the ringtone; tones share the call's AudioContext
  when the ringtone device is the speaker device, so Windows communications
  ducking has nothing to lower (Mike reported audio dropping on a second call). Default model is Parakeet-TDT
  0.6B v3 int8 (`nemo_transducer`, featureDim 128; ~130–260 ms per utterance
  on a Ryzen 7 5800U). Whisper stays selectable but was 5–10 s per utterance
  on Mike's i7 laptop and mislabelled Spanish as Portuguese/Hindi/Thai (its
  encoder always processes 30 s; its language ID is unreliable on short 8 kHz
  snippets). Saved Whisper picks migrate once (`config.js migrate()`).
- **Electron forbids N-API external buffers**: sherpa-onnx's `resample()` and
  `vad.front()` throw `External buffers are not allowed` inside Electron but
  not in Node — the worker caught it per frame and simply "heard nothing".
  Hence `Upsampler2x` in `core.js` and `front(false)`. Always test speech
  *inside* Electron (`--smoke-wav`), not only with `tools/transcribe-file.js`.
- **asarUnpack** covers `sherpa-onnx-*` and `src/main/transcribe/**`; the
  worker and DLLs must be real files. `unpacked()` in `main.js` maps paths.
  The worker gets PATH / LD_LIBRARY_PATH for the platform library dir.
- **No consent tone** at transcription start — it existed in 1.1.0; Mike had it
  removed. The README carries the legal note instead.
- **Frameless main window** (Mike disliked the doubled title bar), own
  minimise/maximise/close; double-click the bar to maximise.
- **Portable exe** breaks if launched twice (electron-builder unpacks every
  launch of one build to the same temp folder and deletes it on exit →
  `ffmpeg.dll not found`). The installer is what users should run.
- **Models** live in `<userData>/models/{parakeet-tdt-0.6b-v3,whisper-*,vad}`,
  fetched file-by-file from Hugging Face (`csukuangfj/...`) so nothing needs
  bzip2/tar. Never bundle them in the installer.
- Passwords are encrypted with `safeStorage` (DPAPI on Windows), so a copied
  `settings.json` does not carry them to another machine.

## Security posture (1.4.0 review — keep it this way)

- All BrowserWindows: `sandbox: true`, `contextIsolation`, no Node integration;
  `harden(win)` blocks non-file navigation, webviews and window.open. The CSP
  in index.html forbids inline scripts *and* inline style attributes — set
  widths via `data-width` + `applyWidths()` or CSS classes, never `style=""`
  inside innerHTML.
- `sip:`/`tel:` links only prefill the dialler (`dial:prefill`); never auto-dial.
- SIP: `parser.stringify` folds CR/LF in header values (header injection);
  per-line `acceptFromServerOnly` (default on, only meaningful with register)
  drops requests from other hosts silently; TLS targets carry `serverName`
  for SNI and hostname verification.
- RTP: per-line `mediaStrictSource` (default on) — packets must come from the
  SDP address (port may change); after latching, a different address is
  rejected even with strict off. `unexpectedSource` is logged once per 30 s.
  If a provider relays media from an address other than its SDP `c=`, users
  turn the switch off — that is the diagnosis for sudden one-way audio.
- Updater: a custom feed must be https unless loopback/RFC 1918
  (`feedFromUrl`); `openExternal` only for http(s). Models: size + SHA-256
  pinned in `models.js` CATALOG and verified on download — refresh the pins if
  upstream files change (`huggingface.co/api/models/<repo>?blobs=true` →
  `lfs.sha256`).
- Settings merge skips `__proto__`/`constructor`/`prototype`. CSV export
  defuses formulas (`=`, `@`, and `+`/`-` not followed by a number); phone
  numbers must keep their `+`.
- Electron 44 (from 33 in 1.4.0). `npm audit --omit=dev` must stay clean;
  dev-chain findings are build-time only.
- Not covered, by design: RTP is unencrypted (no SRTP); no code signing yet.
  `SECURITY.md` is the user-facing statement — keep it truthful.

## Open items and known gaps

- One report (1.1.0, Whisper) of the user's own voice not appearing in a
  transcript while the far end heard them; unreproduced. 1.2.0 logs per-channel
  frame counters on `transcription finished` — ask for that log line first.
- Spanish recognition is verified only by Parakeet's documentation; no Spanish
  TTS voice exists on Mike's PC to synthesise a test. English is verified
  end-to-end (Windows TTS sample through the 8 kHz µ-law path).
- Code signing: `release.yml` already reads `WIN_CSC_LINK` /
  `WIN_CSC_KEY_PASSWORD` secrets; Mike may buy a certificate later.
- Linux packages are built and inspected (deb/rpm metadata, desktop entry with
  sip:/tel: handlers) but have never been run by a user.
- Codecs are G.711 only; media is plain RTP; no ICE/STUN. Known and accepted.

## Mike's preferences (learned)

- Short, user-facing README; engineering detail goes here or in code comments.
- Wants to *test on a real call* after each change; tell him exactly what to
  try. He tests from a remote-desktop session and on a second laptop.
- Prefers being told the honest state ("verified on loopback, not on Vital")
  over reassurance. Reports bugs with screenshots; give root causes.
- Likes things automated: releases, updates, CI. Asked for update-download
  buttons inside Settings, popup position reset, pop-out dialogs.

## Machine notes (Mike's Windows PC, 2026-09)

- Electron cannot start from Claude's scratch workspace (UWP LocalCache path →
  V8 snapshot error); work in `C:\Users\Support\Downloads\twinline`.
- Windows Developer Mode is on, so plain `electron-builder --win` works; before
  that the winCodeSign bundle's macOS symlinks failed (`dist:win:noedit` avoids it).
- Docker Desktop is installed but usually needs starting
  (`Start-Process "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"`, ~20 s).
- `gh` is installed per-user at `%LOCALAPPDATA%\Programs\gh\bin` (on the user
  PATH; Bash sessions need `export PATH="$PATH:$LOCALAPPDATA/Programs/gh/bin"`),
  authenticated as `gxmonto`.
- Installing into `C:\Program Files` needs a UAC prompt Claude cannot answer;
  ask Mike to run installers. His PC once ended up with a bogus "1.0.5" from
  the updater accident; he was told to reinstall from GitHub.
- Windows TTS voices available: David, Zira (en-US) — used for speech tests via
  `System.Speech` → 16 kHz WAV.

## Testing expectations

- Loopback tests (`test/integration.test.js`) run two real user agents against
  each other with real RTP — extend them for any SIP/media change. The
  transcription pipeline has fake-sherpa tests (`test/transcribe.test.js`) and
  fake-worker plumbing tests (`test/service.test.js`).
- Provider behaviour cannot be simulated; when a fix targets JetWave/Vital,
  say so and ask Mike to verify on a real call. The log
  (`Settings → General → Open log folder`, optional SIP trace) is the evidence
  to ask for.

## Conventions

- Comments explain *why*, not what. Match the existing plain-JS style; no
  frameworks, no bundler, no TypeScript.
- Commit messages end with `Co-Authored-By: Claude <model> <noreply@anthropic.com>`.
- Settings live in `%APPDATA%\TwinLine` (Linux `~/.config/TwinLine`): settings.json,
  contacts.json, logs/, models/, transcripts/. Nothing user-specific is in the repo.
- The `homepage`/`repository` fields point at github.com/gxmonto/twinline;
  deb/rpm require a homepage.
