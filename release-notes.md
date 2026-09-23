Security fixes from the 1.4.2 audit:

- The Linux AppImage is built with a fixed packaging toolchain (electron-builder 26). The old one could load a library from the folder the AppImage was started in (CVE-2026-54672). Linux users should download this version.
- On Linux without a running keyring (GNOME Keyring / KWallet) the app no longer claims your SIP password is encrypted: Settings now says it is kept in a file only your user can read, and how to fix that.
- Update checks and speech-model downloads refuse to follow a redirect from https to plain http.
- The main process only accepts messages from the app's own windows.
- The optional SIP trace masks digest responses and nonces, and Settings warns that the trace shows your usernames and numbers.
- A line ignores SIP from anyone until its server is resolved, instead of accepting everything for that moment.
- Every release now ships a `SHA256SUMS.txt` to check downloads by hand.

Also: the portable exe can be launched more than once at the same time.
