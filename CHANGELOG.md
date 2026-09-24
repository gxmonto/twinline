# Changelog

## 1.4.5 — 2026-09-24

- Call history is kept across restarts (it used to vanish when the app was closed).
- The incoming-call popup first appears centred over the TwinLine window, and is always placed fully on screen, so it can no longer get stuck half off the edge.
- Narrow window: the Contacts, History and Settings buttons no longer slide under the Windows caption buttons; the line chips shrink instead.
- Contacts: the add/edit form is hidden until you press Add or edit a contact.

## 1.4.4 — 2026-09-24

- Linux: after switching from the AppImage to the .deb or .rpm, the menu could still open the deleted AppImage. The installed app now removes the launcher the AppImage left behind and points `sip:`/`tel:` links at itself.

## 1.4.3 — 2026-09-23

Security fixes from the 1.4.2 audit:

- The Linux AppImage is built with a fixed packaging toolchain (electron-builder 26). The old one could load a library from the folder the AppImage was started in (CVE-2026-54672). Linux users should download this version.
- On Linux without a running keyring (GNOME Keyring / KWallet) the app no longer claims your SIP password is encrypted: Settings now says it is kept in a file only your user can read, and how to fix that.
- Update checks and speech-model downloads refuse to follow a redirect from https to plain http.
- The main process only accepts messages from the app's own windows.
- The optional SIP trace masks digest responses and nonces, and Settings warns that the trace shows your usernames and numbers.
- A line ignores SIP from anyone until its server is resolved, instead of accepting everything for that moment.
- Every release now ships a `SHA256SUMS.txt` to check downloads by hand.

Also: the portable exe can be launched more than once at the same time.

## 1.4.2 — 2026-09-23

- When the other side pulls you into a conference, TwinLine now says so: a "Conference (their side)" tag appears on the call when the PBX identifies itself as a conference bridge or renames the call ("Conference 8000"). TwinLine cannot list who is in a conference hosted elsewhere — the PBX does not tell a phone — but the transcript now tries to tell voices apart: when it is confident several people are speaking through one line, lines are labelled Caller 1, Caller 2, … by voice. Treat those labels as approximate; phone audio makes voices hard to separate. A small voice model (29 MB) is fetched automatically.
- Redirect a ringing call without answering: the ↪ button on an incoming call sends it to another number.
- Dialogs no longer run under the window's corner buttons.

## 1.4.1 — 2026-09-23

Small fixes: the transcript countdown now shows in the panel header ("Closing in 5 s", with Keep open next to it); minimise, maximise and close are drawn by Windows itself so they always respond; the incoming-call popup drags smoothly from its top bar with no dead spots and has a ✕ to hide it while the call keeps ringing in the main window; the Settings version line says "Windows 64-bit" instead of win32.

## 1.4.0 — 2026-09-23

Conference transcription now hears everyone: every participant is recognised and labelled by contact name or number, not just the first two.

Also in this release:
- A finished transcript counts down five seconds and puts itself away (a popped-out transcript window closes with it); press "Keep open" to stop it.
- A second incoming call while you are talking now plays a soft call-waiting beep in the earpiece instead of the full ringtone over the conversation, and tones use the same audio session as the call so Windows has nothing to turn down.
- Security review: every window is sandboxed; lines ignore SIP and RTP from anywhere but their own server (per-line switches under Settings → Line); SIP header injection is impossible; sip:/tel: links fill the dialler instead of dialling; update servers must use HTTPS; speech model downloads are verified against pinned checksums; CSV exports are safe to open in Excel; the app runs on the current Electron release. Details in SECURITY.md.

## 1.3.0 — 2026-09-23

Every dialog can now live in its own window. Press the ⧉ button on Settings, Contacts, History, a transcript or the Transfer dialog and it pops out as a separate window you can move anywhere on screen — for example the live transcript next to your notes during a call. Changes made in a popped-out window apply everywhere.

## 1.2.1 — 2026-09-23

Clearer downloads: the Windows files are now named TwinLine-Installer and TwinLine-Portable, and each release page starts with a table saying which file to pick. The .yml and .blockmap files stay — the built-in updater reads them to download only what changed.

## 1.2.0 — 2026-09-23

Transcription is much faster and more accurate. The new default engine, Parakeet, recognises an utterance in a fraction of a second, handles English and Spanish (and 23 other languages) without guessing the language first, and adds punctuation. Download it once in Settings → Transcription (~670 MB); anyone on a Whisper model is moved to it automatically. The start-of-transcription tone is gone.

Also: the update dialog now has Download and Restart buttons right in Settings, the duplicate Windows title bar is gone (drag the TwinLine bar, double-click to maximise), and the log records how much audio from each side reached the transcription engine.

## 1.1.0 — 2026-09-22

Call transcription, fully offline. Press Transcribe on a connected call (or turn on automatic transcription in Settings) and lines appear live, labelled You / Caller, in English and Spanish. Transcripts are saved with the call and reachable from History.

Speech recognition runs on your own computer — audio never leaves it. Download a model once in Settings → Transcription (whisper-small, ~375 MB, is recommended). A short tone tells both parties when transcription starts; you can turn it off in Settings, but check your local consent laws first.

## 1.0.4 — 2026-09-22

In-app updates: TwinLine now checks for new versions and offers them, so installers no longer need to be passed around by hand.

Also in this release: re-registration on network changes (sleep, VPN, Wi-Fi), a log file with optional SIP trace, and the tray icon fix.

## 1.0.3 — 2026-09-22

Sockets bind to the wildcard address and every line re-registers on network changes (resume, VPN, Wi-Fi roam, socket errors). Log file with optional SIP trace. Repeated errors collapse into one toast.

## 1.0.2 — 2026-09-22

Tray icon ships inside the app (multi-resolution .ico on Windows).

## 1.0.1 — 2026-09-21

`c=IN IP4 0.0.0.0` (legacy hold) from the PBX is treated as hold, not as a destination. Versioned `dist/<version>/` output.

## 1.0.0 — 2026-09-21

Initial release: two SIP lines, multiple calls with hold/swap, locally mixed conference with per-party hold and drop, incoming-call popup, contacts with CSV/JSON/vCard import and export, transfer, DTMF.
