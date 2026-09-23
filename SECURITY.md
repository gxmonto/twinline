# Security

## What TwinLine protects

- **The desktop app.** Every window runs with Chromium's sandbox, context
  isolation and no Node integration; pages are local files under a strict
  Content Security Policy (no inline scripts or styles, no remote content),
  navigation away from them is blocked, and only a small named API is exposed
  through the preload bridge. `sip:`/`tel:` links from other programs fill in
  the dialler; they never dial by themselves.
- **Your accounts.** SIP passwords are encrypted at rest with the operating
  system's key store (DPAPI on Windows; GNOME Keyring or KWallet on Linux) and
  are never sent to the UI or written to the log. On a Linux machine with no
  keyring running there is no real key to encrypt with, so the password is
  kept in a file only your user account can read and Settings says so plainly
  instead of claiming encryption. Digest authentication only ever answers the
  configured server, and the optional SIP trace masks digest responses and
  nonces.
- **Unwanted calls and audio.** By default a line ignores SIP messages that do
  not come from its own server (this silences the internet's SIP scanners and
  spoofed "ghost calls") and ignores RTP audio that does not come from the
  address the server announced for the call, so nobody who guesses a port can
  inject audio or redirect where yours goes. Both can be turned off per line
  if a provider's media relay needs it. Header values are sanitised so a
  crafted display name or dialled string cannot inject SIP headers.
- **Updates and models.** Updates come from GitHub Releases over HTTPS and are
  verified against the SHA-512 in the release manifest before installing; a
  custom update server must use HTTPS unless it is on the local network, and
  a redirect that would drop to plain HTTP is refused. Every release carries a
  `SHA256SUMS.txt` for checking a download by hand. Speech models are pinned
  by size and SHA-256, downloaded with the same no-downgrade rule, and
  discarded on mismatch. Nothing installs during a call.
- **Data you export.** CSV exports defuse spreadsheet formula injection.
- **The process boundary.** The main process only acts on messages from the
  app's own pages; anything else is refused and logged.
- **Dependencies.** `npm audit` must be clean for everything that ships (CI
  fails otherwise) and the build toolchain is audited on every run; Electron
  is kept on a supported release line. The build examined in the 1.4.2 audit
  carried advisories in the packaging toolchain; 1.4.3 cleared them.

## What it does not protect

- **Call audio on the network is plain RTP.** SIP signalling can use TLS, but
  media is not encrypted (no SRTP/ZRTP). Treat calls as you would any phone
  call, not as an encrypted channel.
- **Transcripts and contacts on disk are plain files** in your profile folder,
  protected only by your operating-system account.
- **Builds are not code-signed** (yet), so Windows shows a SmartScreen warning
  on first install. Verify you downloaded from the project's GitHub Releases
  and, if you want to be sure, compare the file against `SHA256SUMS.txt` from
  the same release.

## Reporting

Open a private security advisory on the GitHub repository, or contact the
maintainer directly. Please do not file public issues for security problems.
