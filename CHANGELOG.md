# Changelog

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
