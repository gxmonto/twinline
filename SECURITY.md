# Security

## What TwinLine protects

- **The desktop app.** Every window runs with Chromium's sandbox, context
  isolation and no Node integration; pages are local files under a strict
  Content Security Policy (no inline scripts or styles, no remote content),
  navigation away from them is blocked, and only a small named API is exposed
  through the preload bridge. `sip:`/`tel:` links from other programs fill in
  the dialler; they never dial by themselves.
- **Your accounts.** SIP passwords are encrypted at rest with the operating
  system's key store (DPAPI on Windows, libsecret on Linux) and are never sent
  to the UI or written to the log. Digest authentication only ever answers the
  configured server.
- **Unwanted calls and audio.** By default a line ignores SIP messages that do
  not come from its own server (this silences the internet's SIP scanners and
  spoofed "ghost calls") and ignores RTP audio that does not come from the
  address the server announced for the call, so nobody who guesses a port can
  inject audio or redirect where yours goes. Both can be turned off per line
  if a provider's media relay needs it. Header values are sanitised so a
  crafted display name or dialled string cannot inject SIP headers.
- **Updates and models.** Updates come from GitHub Releases over HTTPS and are
  verified against the SHA-512 in the release manifest before installing; a
  custom update server must use HTTPS unless it is on the local network.
  Speech models are pinned by size and SHA-256 and discarded on mismatch.
  Nothing installs during a call.
- **Data you export.** CSV exports defuse spreadsheet formula injection.
- **Dependencies.** `npm audit` is clean for everything that ships; Electron
  is kept on a supported release line.

## What it does not protect

- **Call audio on the network is plain RTP.** SIP signalling can use TLS, but
  media is not encrypted (no SRTP/ZRTP). Treat calls as you would any phone
  call, not as an encrypted channel.
- **Transcripts and contacts on disk are plain files** in your profile folder,
  protected only by your operating-system account.
- **Builds are not code-signed** (yet), so Windows shows a SmartScreen warning
  on first install. Verify you downloaded from the project's GitHub Releases.

## Reporting

Open a private security advisory on the GitHub repository, or contact the
maintainer directly. Please do not file public issues for security problems.
