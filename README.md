# TwinLine

A two-line SIP softphone for Windows and Linux, in the spirit of MicroSIP.

- Two SIP accounts registered at once, several calls at a time, hold and swap.
- Conference calls mixed on your own machine, so you can hold or hang up on
  one participant while the others carry on.
- Incoming-call popup, ringtone and status tones, contacts with CSV/JSON/vCard
  import and export, blind and attended transfer, call history.
- Optional call transcription that runs entirely on your computer.
- Checks for updates itself and installs them on restart.

## Install

Download the latest release from
[github.com/gxmonto/twinline/releases](https://github.com/gxmonto/twinline/releases):

- Windows: `TwinLine-Installer-<version>.exe` (`TwinLine-Portable-<version>.exe` is for a quick
  try — the installer gets automatic updates).
- Debian/Ubuntu: `.deb`; Fedora/RHEL: `.rpm`; anything else: `.AppImage`.

Windows shows a SmartScreen warning on the first install because the build is
not code-signed; choose *More info → Run anyway*. Every release includes a
`SHA256SUMS.txt` if you want to check a download first. After that, updates arrive
through the app.

## Set up a line

Settings → Line 1: server (e.g. `pbx.provider.com`), username, password. Add
an authentication ID or outbound proxy only if your provider gave you one.
UDP is the usual transport. Line 2 works the same way.

The chips in the title bar show registration; hover one for details. One-way
audio after a successful registration is almost always NAT — set **Public IP
override** if your provider does not echo `rport`.

## Calls

- **Dial**: pick the line, type a number, press Enter. Digits and `*` `#`
  also type into the field, or send DTMF during a call.
- **Second call**: dial or answer again; the first call goes on hold. *Resume*
  swaps back. A call arriving while you are talking plays a soft call-waiting
  beep, not the full ringtone.
- **Conference**: with two calls connected, press *Conference*. *Join conf*
  adds a third. In the conference panel, *Hold* parks one party (they rejoin
  on *Resume*) and *Drop* hangs up on that party only. *Split* keeps everyone
  on the line but stops bridging; *End all* hangs up on everyone.
- **Transfer**: blind to a number, or attended to another call in progress.
  A *ringing* call can be redirected elsewhere without answering (the ↪
  button).
- **Conferences hosted by the other side**: when a PBX pulls you into its own
  bridge, the call shows *Conference (their side)* if the PBX announces it.
  TwinLine cannot list who is in it — the PBX does not tell a phone — but the
  transcript tells the voices apart (*Caller 1*, *Caller 2*, …).
- **Hold music** is whatever your PBX or provider plays; TwinLine itself sends
  silence to a held party.
- **Pop out**: the ⧉ button on Settings, Contacts, History, a transcript or
  the Transfer dialog opens it as its own window you can move anywhere —
  handy for keeping the live transcript beside another app during a call.

## Codecs

TwinLine speaks **G.711**, the codec every SIP provider and PBX supports:

- **PCMU (µ-law)** and **PCMA (A-law)** are the two flavours; µ-law is the
  norm in North America and Japan, A-law elsewhere. Both are 8 kHz, 64 kbit/s
  — ordinary landline quality. A provider usually accepts either; the *Codec
  preference* per line decides which TwinLine offers first.
- **DTMF** (keypad tones during a call) is sent as RFC 4733 events inside the
  audio stream, which is what nearly every provider expects. Switch a line to
  *SIP INFO* only if your provider asks for it.
- There is no wideband codec (G.722, Opus): phone networks downmix to 8 kHz
  anyway, and G.711 needs no licence and no negotiation surprises. It also
  means the transcription engine only ever sees telephone-band audio, which
  the Parakeet model handles well.

## Transcription

Press **Transcribe** on a connected call, or turn on automatic transcription
in Settings → Transcription. Lines appear as each speaker pauses, labelled
*You* / *Caller* — or by contact name or number for each participant of a
conference — and the transcript is saved with the call (History →
*Transcript*, or the *Saved transcripts* list). When the call ends the panel
counts down five seconds and closes; *Keep open* stops it.

Everything runs on your own machine — audio never leaves it. Download a model
once in Settings → Transcription. **Parakeet** (~670 MB) is the one to use:
fast (well under a second per utterance on a recent laptop), accurate on phone
audio, and it handles English, Spanish and 23 other languages in one pass
without a separate language-detection step. The Whisper models remain
available but are slower and their language detection is unreliable on short
phone utterances.

Transcribing a call is legally the same as recording it; many places require
every party's consent. A red *Transcribing* tag shows while it runs.

## Updates

TwinLine checks GitHub Releases on start and every six hours. Settings →
General → Updates lets you check now, download, and restart to install, or
switch to automatic downloads. It never installs while a call is up.

## Security

Every window runs sandboxed; a line ignores SIP and call audio that do not
come from its own server (per-line switches under Settings → Line — turn off
only if a provider relays media from another address); updates and speech
models are checksum-verified; call audio on the network is plain RTP. Details
and what is *not* covered are in [SECURITY.md](SECURITY.md).

## Troubleshooting

- **Logs**: Settings → General → *Open log folder*. *Record every SIP message*
  adds a full SIP trace for provider problems (turn it off afterwards; it
  shows your usernames and numbers, though digest responses are masked).
- **Lines drop after sleep, VPN or Wi-Fi changes**: TwinLine re-registers on
  its own; *Re-register lines now* forces it.
- **Popup stuck on a missing display**: Settings → General → *Reset to default
  corner*.
- **Transcript missing a side**: the log's `transcription finished` line shows
  how many frames of microphone and caller audio reached the engine.
- **Check a speech model against a recording**:
  `node tools/transcribe-file.js recording.wav --telephone`

## Development

```bash
npm install
npm start          # run from source
npm test           # unit and loopback end-to-end tests
npm run smoke      # boot the real app headlessly
npm run dist:win   # Windows installer + portable → dist/<version>/
npm run dist:linux:docker   # .deb / .rpm / AppImage via Docker
```

Releases are cut with `npm run release -- patch|minor|major` after writing
`release-notes.md`; GitHub Actions builds both platforms and publishes.

```
src/main/sip        SIP: parser, digest auth, SDP, transports, transactions, dialogs
src/main/rtp        G.711, RTP, jitter buffer
src/main/media      mixer (conference bus) and the 20 ms audio clock
src/main/transcribe speech recognition (sherpa-onnx in a utility process)
src/main            call manager, contacts, settings, updater, logging, Electron main
src/renderer        UI, WebAudio worklets, incoming-call popup
test/               tests; tools/ build and diagnostic scripts
```

Codecs are G.711 µ-law/A-law only; media is plain RTP (signalling can use
TLS); no ICE/STUN. MIT licence.
