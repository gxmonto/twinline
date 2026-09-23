# TwinLine — notes for Claude Code

Dual-line SIP softphone (Electron, plain JavaScript, no framework, no build
step). Owner: Mike (GitHub `gxmonto`). Users are real: JetWave and Vital SIP
accounts, Windows day to day, Linux packages too. Ship carefully.

## Commands

```bash
npm test                      # 100+ unit + loopback end-to-end tests; must pass
npm run smoke                 # boots the real app headlessly; asserts UI, tray icon
npx electron . --smoke --smoke-wav=<16k mono wav>   # also runs speech through the recognition worker
npm run dist:win              # dist/<version>/ — needs Windows Developer Mode (or dist:win:noedit)
npm run dist:linux:docker     # .deb/.rpm/AppImage via Docker (cannot build on Windows natively)
npm run release -- patch|minor|major|x.y.z          # THE way to ship (see below)
node tools/transcribe-file.js speech.wav --telephone  # check a speech model on a recording
```

## Shipping

1. Write what changed for users in `release-notes.md` (empty notes are refused).
2. Commit everything (a dirty tree is refused).
3. `npm run release -- patch` → bumps version, updates CHANGELOG.md, tags, pushes.
4. GitHub Actions (`.github/workflows/release.yml`) builds Windows + Linux and
   publishes the release only when both are done. Watch with `gh run watch`.
5. Installed copies update themselves from GitHub Releases (electron-updater).

Never publish installers by hand; never edit `version` without going through
the release script for a shipped build. Windows artefacts are
`TwinLine-Installer-<v>.exe` / `TwinLine-Portable-<v>.exe`; the `.blockmap`
and `.yml` assets are required by the updater — keep them.

`TwinLine.exe --update-check=<feed>` is a *download-only* rehearsal. It once
silently installed a throwaway build before the install-on-quit guard existed;
the guard is in `runUpdateCheck`. Keep it.

## Architecture in one breath

Main process owns SIP (`src/main/sip`: hand-written parser, digest, SDP,
UDP/TCP/TLS transports, RFC 3261 transactions, dialogs), RTP + G.711
(`src/main/rtp`), the 20 ms audio clock and mix-minus conference bus
(`src/main/media`), and transcription (`src/main/transcribe`, sherpa-onnx in a
utility process). The renderer owns only the microphone/speaker (WebAudio at
8 kHz) and the UI; `preload.js` is the sole bridge. `callmanager.js` is the
source of truth for calls, hold and conference; the renderer just renders
snapshots.

## Decisions that look odd but are deliberate

- **Native SIP over UDP/TCP/TLS, not WebRTC/SIP.js** — providers have no
  WebSocket gateway.
- **Conference is mixed locally** so one party can be dropped or held while
  the others continue. Membership is explicit state (`conferenceIds`), not
  "whatever is bridged"; a held member stays a member and rejoins on Resume.
- **Hold**: we advertise `a=sendonly` and keep RTP flowing (silence) — the peer
  expects a stream and NAT bindings stay open. `a=sendonly` *from* the peer
  means they hold us (they still send MoH). `c=IN IP4 0.0.0.0` is legacy hold,
  never a destination (Vital sends it).
- **Sockets bind to 0.0.0.0**, never a specific IP: a bound IP that vanishes
  (VPN, Wi-Fi roam, sleep) fails every send with `EADDRNOTAVAIL`. Lines
  re-register on resume/unlock/online/socket error/route change.
- **Registration refresh does not show "registering"** — the old binding is
  still valid; only a real failure changes the chip.
- **Transcription channels**: microphone and each caller are separate
  streams, so *You*/*Caller* labels need no diarisation. Default model is
  Parakeet-TDT 0.6B v3 (fast, 25 languages, no language-detection step).
  Whisper is kept but was slow and mislabelled Spanish as Portuguese/Hindi.
- **Electron forbids N-API external buffers**: sherpa-onnx's `resample()` and
  `vad.front()` throw inside Electron but not in Node. Hence `Upsampler2x` in
  `core.js` and `front(false)`. Always test speech *inside* Electron
  (`--smoke-wav`), not just with `tools/transcribe-file.js`.
- **asarUnpack** covers `sherpa-onnx-*` and `src/main/transcribe/**`; the
  worker and DLLs must be real files. `unpacked()` in `main.js` maps paths.
- **Frameless window** with its own title bar; the incoming-call popup
  remembers its position and can be reset from Settings.
- **Portable exe** breaks if launched twice (electron-builder unpacks to one
  temp folder per build); the installer is what users should run.

## Testing expectations

- Loopback tests (`test/integration.test.js`) run two real user agents against
  each other with real RTP — extend them for any SIP/media change.
- Provider behaviour cannot be simulated; when a fix targets JetWave/Vital,
  say so and ask Mike to verify on a real call. The log
  (`Settings → General → Open log folder`, optional SIP trace) is the evidence
  to ask for.
- Keep `README.md` short and user-facing; put engineering detail here or in
  code comments.

## Conventions

- Comments explain *why*, not what. Match the existing plain-JS style.
- Commit messages end with `Co-Authored-By: Claude <model> <noreply@anthropic.com>`.
- Settings live in `%APPDATA%\TwinLine` (Linux `~/.config/TwinLine`): settings.json,
  contacts.json, logs/, models/, transcripts/. Passwords are encrypted via
  safeStorage. Nothing user-specific is in the repo.
