# TwinLine

A dual-line SIP softphone for Windows and Linux — an alternative to MicroSIP.

Two accounts register at once, several calls can be up at the same time with
hold/swap between them, and any two or more connected calls can be bridged
into a conference. Because the conference is mixed **locally**, each party is
still an independent SIP dialog, so you can hang up on one participant and stay
on the call with the others.

---

## Why a native SIP stack, not WebRTC

Providers of the JetWave / Vital sort speak ordinary SIP over UDP, TCP or TLS
on port 5060/5061, with RTP for media. A browser-style SIP.js/WebRTC client
would need the provider to run a SIP-over-WebSocket gateway, which most do not.

TwinLine therefore talks real SIP from the Electron main process using Node's
`dgram`/`net`/`tls`, and carries audio as G.711 RTP. The renderer only owns the
microphone, the speaker and the UI.

```
┌─ renderer (Chromium) ──────────┐        ┌─ main (Node) ─────────────────────┐
│  UI                            │        │  UserAgent per account            │
│  WebAudio @ 8 kHz              │        │    registration, digest auth, NAT │
│    capture worklet  ──20 ms──► │  IPC   │  Call (dialog state machine)      │
│    playback worklet ◄──20 ms── │ ◄────► │  AudioMixer  ── mix-minus bus     │
│  ringtone / DTMF tones         │        │  RtpSession per leg ── UDP ──► PBX│
└────────────────────────────────┘        └───────────────────────────────────┘
```

The 20 ms clock lives in the main process, so RTP keeps flowing even when the
window is hidden or the renderer is busy.

## Features

- **Two SIP lines** registered simultaneously, each with its own local port,
  credentials, transport, codec order and DTMF mode.
- **Multiple concurrent calls** (default limit 4). Answering or dialling while
  a call is up puts the current call on hold automatically; one click swaps.
- **Conference** with local mixing. Each participant hears everyone except
  themselves (true mix-minus, verified by tests).
- **Drop one conference party** — hang up on a single participant while the
  rest of the conference continues.
- **Hold inside a conference** — a held member stays a member; *Resume* puts
  them straight back into the bridge. The conference as a whole behaves like
  one line: answering something else holds every member, and resuming any of
  them brings the whole conference back.
- **Incoming-call popup** — a small always-on-top window with Answer/Decline
  that remembers where you drag it (reset it from Settings → General if it
  ends up on a disconnected display). Ringtone, ringback, and short connected /
  ended / busy cues, so you hear what is happening without watching the app.
- **Contacts** with search, per-contact preferred line, caller-ID matching on
  incoming calls, and import/export as CSV, JSON or vCard (imports understand
  Outlook/Google-style headers and merge on number instead of duplicating).
- Blind and attended transfer (REFER, and REFER with Replaces).
- DTMF via RFC 4733 telephone-events, with SIP INFO fallback.
- Hold handled in both directions, including the both-sides-held case.
- NAT traversal via `rport`/`received` discovery, symmetric RTP latching and
  keep-alives; manual public-IP override if your provider needs it.
- Passwords encrypted at rest with the OS keyring (DPAPI / libsecret).
- Call history, tray icon, `sip:` and `tel:` link handling.

## Running from source

```bash
npm install
npm start
```

```bash
npm test
```

101 tests: SIP parser, digest auth (including the RFC 2617 reference vector),
SDP offer/answer, G.711 against the ITU tables, jitter buffer, conference
mix-minus, contact import/export, transcription segmentation, plus end-to-end tests that run two complete
user agents against each other over loopback and exercise call setup, hold,
DTMF, line swapping, hold-inside-a-conference and conference teardown.

```bash
npm run smoke
```

Boots the real app headlessly and asserts the UI came up. Useful in CI.

## Configuring a line

Open **Settings → Line 1**. The fields that matter for most providers:

| Field | Notes |
|---|---|
| SIP server / domain | e.g. `pbx.provider.com`. Add `:5060` only to override the port; leaving it off lets TwinLine use DNS SRV. |
| Username | Your extension or SIP user. |
| Authentication ID | Only if the provider issues one different from the username. |
| Password | Stored encrypted. |
| Outbound proxy | Set if the provider gives you an SBC address distinct from the domain. |
| Transport | UDP is the usual default; use TLS if the provider offers it. |
| DTMF | Leave on RFC 2833 unless the provider asks for SIP INFO. |

Enable **Line 2** the same way for the second account. The chips in the title
bar show registration state; hover one for the failure reason.

If registration succeeds but audio is one-way, the cause is almost always NAT.
TwinLine learns its public address from the registrar's `Via` and re-registers
with it; if your provider does not echo `rport`, set **Public IP override**.

### Network changes

SIP and RTP sockets bind to the wildcard address, so a changing IP (DHCP
renewal, Wi-Fi roam, VPN or virtual adapter up/down, sleep/resume) does not
kill them. Every line re-resolves its server and re-registers when:

- the machine resumes from sleep or the screen is unlocked,
- Chromium reports connectivity coming back,
- the local route to the server changes (checked every 30 s),
- a socket error occurs,
- you press **Settings → General → Re-register lines now**.

### Logs

`%APPDATA%\TwinLine\logs\twinline.log` (Linux: `~/.config/TwinLine/logs/`)
records registration changes, call state, network refreshes and errors, and
rotates at 2 MB. **Settings → General → Open log folder** takes you there.
For a provider interop problem, tick **Record every SIP message in the log**,
reproduce, untick it, and send the log — it then contains the full SIP
exchange (digest responses are hashes, not passwords, but the log does show
your account names and the numbers you called).

## Using two lines, hold and conference

- **Dial** — pick the line in the dropdown, type a number, press Enter.
- **Second call** — just dial or answer again; the first call is held for you.
- **Swap** — press *Resume* on the held call; the other one is held.
- **Conference** — with two calls connected, press *Conference* on either. Both
  come off hold and join the bridge. *Join conf* adds a third.
- **Drop one party** — in the Conference panel, press *Drop* next to a name.
  Only that call gets a BYE; the rest of the conference carries on. If one
  party is left, it becomes an ordinary two-party call.
- **Hold one party** — *Hold* in the Conference panel mutes that party out of
  the bridge but keeps them in the conference; *Resume* brings them back. The
  others keep talking meanwhile.
- **Split** ends the bridge but keeps everyone connected (one active, rest
  held). **End all** hangs up on every participant.
- **Contacts** (the ♟ button): search, *Call* dials on the contact's preferred
  line, *Import…* accepts `.csv`, `.json` or `.vcf`, and the footer exports in
  any of the three.

Keyboard: digits and `*` `#` type into the dial field, or send DTMF during a
call; Enter dials or answers; Escape closes dialogs.

## Building installers

Artefacts land in `dist/<version>/` (the version from `package.json`), so
successive releases sit side by side — bump the version before building a
release you intend to hand out.

### Windows

```bash
npm run dist:win
```

Produces `TwinLine Setup <version>.exe` (NSIS installer) and `TwinLine <version>.exe`
(portable). Running the installer over an existing installation upgrades it in
place; settings and contacts live in `%APPDATA%\TwinLine` and are kept.

> **Use the installer for day-to-day use.** The portable exe unpacks itself
> into a temp folder each launch — the *same* folder for a given build — and
> deletes it on exit. If you launch it a second time while the first copy is
> still running (say, minimised to the tray), the second copy defers to the
> first and its launcher then deletes the shared folder, and the running app
> fails the next time it loads a library (`ffmpeg.dll was not found`). The
> portable is fine for trying TwinLine out; it is not a good fit for a tray
> app you relaunch.

> **If the build fails** with `Cannot create symbolic link ... libcrypto.dylib`,
> that is electron-builder unpacking its code-signing bundle, which contains
> macOS symlinks Windows will not create without the privilege. Either enable
> **Settings → System → For developers → Developer Mode**, run the build from
> an elevated shell, or use:
>
> ```bash
> npm run dist:win:noedit
> ```
>
> which skips signing and exe-resource editing. The app and installer are
> identical apart from the icon and version metadata embedded in the `.exe`.

### Linux (.deb, .rpm, AppImage)

`.deb` and `.rpm` need `fpm` and `rpmbuild`, which are Linux-only — they cannot
be produced on Windows. On a Linux machine:

```bash
npm run dist:linux
```

From Windows or macOS, build them in a container (requires Docker):

```bash
npm run dist:linux:docker
```

That copies the sources into `electronuserland/builder:20`, installs Linux
dependencies there and copies `twinline_1.0.0_amd64.deb`,
`twinline-<version>.x86_64.rpm` and `TwinLine-<version>.AppImage` back into
`dist/<version>/`.

The `.deb` depends on `libasound2 | libasound2t64` so it installs on both
Ubuntu 22.04 and 24.04.

Before distributing, change `homepage` in `package.json` — Debian and RPM both
require a Homepage field and it is currently a placeholder.

## Transcription

TwinLine can transcribe calls **entirely on the local machine** — audio never
leaves it and there is no per-minute cost. Lines appear live as each speaker
pauses, labelled *You* / *Caller*, and the finished transcript is saved with
the call.

**Before you use it:** transcribing a call is legally the same as recording
it. Many jurisdictions (including several US states) require *every* party's
consent. TwinLine shows a red *Transcribing* tag and, by default, plays a short
tone to both parties when transcription starts. How it is used is your
responsibility.

### Setup

Settings → Transcription → pick a model and press *Download*:

| Model | Download | Notes |
|---|---|---|
| whisper-base | ~160 MB | fastest; noticeably worse on phone audio |
| **whisper-small** | ~375 MB | recommended; ~1–2 s per utterance on a modern laptop CPU |
| whisper-medium | ~950 MB | best accuracy; several seconds per utterance |

The models are int8 Whisper exports for [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx),
fetched from Hugging Face into `%APPDATA%\TwinLine\models`. Whisper is
multilingual and detects the language per utterance, so English/Spanish calls
need no configuration (*Language* can pin one if detection misfires).

### Using it

Press **Transcribe** on a connected call, or turn on *Transcribe every call
automatically*. The panel under the call list fills in as people speak.
Transcripts are saved as `.txt` and `.json` in `%APPDATA%\TwinLine\transcripts`
and are reachable from History (*Transcript* on the call, or the *Saved
transcripts* list).

### How it works

Recognition runs in a separate utility process so Whisper's CPU work can never
disturb the 20 ms audio clock. The mixer hands it your microphone and each
caller's stream as **separate channels**, which is why speaker labels are
exact rather than guessed. Each channel goes through a Silero voice-activity
detector; when a speaker pauses (0.5 s), that utterance is decoded. Bursts
under 0.4 s and Whisper's known silence hallucinations ("Thank you.") are
discarded.

To check a model against a recording, or debug a transcript complaint:

```bash
node tools/transcribe-file.js recording.wav --telephone
```

`--telephone` first squeezes the audio through the 8 kHz µ-law path a real
call takes, so the result is representative.

## Updates

TwinLine checks for new versions itself, so installers do not have to be
passed around. It looks for the manifest electron-builder writes
(`latest.yml`, `latest-linux.yml`) on an update server, shows a banner when
something newer exists, downloads on request (or automatically — Settings →
General → Updates), and installs on restart. It never installs during a call.

### One-time setup

1. **Pick where the files will live.** Either:
   - **GitHub Releases** — a repository whose *releases* are public (the code
     can stay private only if you use a token, which is not recommended in a
     desktop app). Set `build.publish` in `package.json` to
     `{ "provider": "github", "owner": "gxmonto", "repo": "twinline" }`.
   - **Any HTTPS folder** — a directory on your own web server, S3 bucket,
     etc. Keep the default `{ "provider": "generic", "url": "https://…/twinline" }`
     and put your URL in. Plain HTTP works too but only use it for LAN tests.
2. **Fix `homepage`** in `package.json` while you are there (deb/rpm need it).
3. Optional but recommended: a **code-signing certificate** (`WIN_CSC_LINK` /
   `WIN_CSC_KEY_PASSWORD` environment variables). Unsigned updates do install
   — SmartScreen only inspects files the browser downloaded, not ones the app
   fetched itself — but the first install of a fresh machine still gets the
   warning, and some corporate antivirus is stricter.
4. **Install this version once by hand** on each machine. Everything after
   that arrives through the app.

Users can point their copy at a different server from Settings → General →
Update server (a GitHub repo URL or a folder URL), so moving hosts later needs
no rebuild.

### Shipping a release

1. Bump `version` in `package.json` and write what changed in
   `release-notes.md` (shown in the banner's *What's new*).
2. Build: `npm run dist:win`, and `npm run dist:linux:docker` (or
   `npm run dist:linux` on Linux).
3. Upload **all** of these from `dist/<version>/` to the server folder or the
   GitHub release, keeping the file names exactly:
   - `latest.yml`, `TwinLine Setup <v>.exe`, `TwinLine Setup <v>.exe.blockmap`
   - `latest-linux.yml`, `TwinLine-<v>.AppImage`
   - the `.deb`/`.rpm` too if you have Linux users (they get a download link
     rather than an in-place update — those package formats cannot replace
     themselves from inside the app).

   With GitHub as the provider, `npm run release:win` / `release:linux` uploads
   for you when `GH_TOKEN` is set.
4. Installed copies see the new version within six hours, or immediately via
   *Check for updates now*.

Leave the **previous** version's `TwinLine Setup <v>.exe.blockmap` on the
server alongside the new files: with both blockmaps present the updater
transfers only the bytes that changed (typically a few MB) instead of the whole
78 MB installer.

### Rehearsing an update locally

```bash
node tools/serve-updates.js dist/<new-version> 8123
```

Then in an installed **older** copy: Settings → General → Update server →
`http://<this machine>:8123/` → *Check for updates now*. Or headlessly, which
downloads but does not install:

```bash
"dist/<old-version>/win-unpacked/TwinLine.exe" --update-check=http://127.0.0.1:8123/
```

## Layout

```
src/main/
  main.js              Electron main, window, tray, incoming popup, IPC
  preload.js           the only renderer↔Node bridge
  log.js               rotating file log, optional SIP trace
  updater.js           update checks and installation (electron-updater)
  config.js            settings, password encryption
  contacts.js          contact store, CSV/JSON/vCard import and export
  callmanager.js       lines, hold/swap, conference orchestration
  sip/
    parser.js          SIP message, URI, header parsing and serialisation
    digest.js          HTTP digest auth (MD5, SHA-256, qop)
    sdp.js             SDP offer/answer
    transport.js       UDP/TCP/TLS, RFC 3263 resolution
    transaction.js     RFC 3261 §17 transactions and timers
    useragent.js       one account: registration, inbound routing
    call.js            dialog state machine, hold, DTMF, transfer
  rtp/
    codecs.js          G.711 µ-law / A-law
    session.js         RTP send/receive, symmetric latching, RFC 4733
    jitterbuffer.js    reordering, loss concealment
  media/
    mixer.js           the conference bus (mix-minus)
    engine.js          20 ms clock, RTP session registry
src/assets/            icons shipped inside the app (window icon, tray .ico)
src/renderer/          UI, WebAudio worklets, incoming-call popup (popup.*)
test/                  unit and loopback end-to-end tests
tools/                 icon generator, Linux container build
```

## Limitations

Worth knowing before you deploy this:

- **Codecs are G.711 µ-law and A-law only.** Universally supported, but
  narrowband. No G.722, Opus or G.729.
- **No SRTP or ZRTP.** Signalling can use TLS; media is plain RTP. Do not treat
  calls as encrypted.
- **No ICE/STUN/TURN.** NAT traversal relies on `rport` plus symmetric RTP,
  which is what hosted SIP providers expect. A peer that requires ICE will not
  work.
- No video, no presence/BLF, no voicemail MWI indicator.
- Music on hold is silence.
- 32-bit and ARM builds are not configured; add architectures to the
  `build.win.target` / `build.linux.target` arrays if you need them.
- The end-to-end tests exercise the stack against itself. Interop with your
  specific providers still needs a live test — start with one line, check
  registration, then two-way audio, then hold and conference.

## Licence

MIT.
