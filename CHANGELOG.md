# Changelog

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
