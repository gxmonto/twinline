# TwinLine Softphone — Security Audit

**Dual-line SIP client for Windows and Linux · version 1.4.2**

| | |
|---|---|
| **Date of review** | 23 September 2026 |
| **Build examined** | 1.4.2 (git `2282f1a`, branch `main`) |
| **Reviewer** | Application security review |
| **Classification** | Confidential — for the project maintainer |

> This document describes weaknesses found by reading the source of an application its owner controls, so they can be fixed before release. It is a defensive review and contains no working exploit code.

---

## Executive summary

TwinLine is a well-built application. Its authors have already done the security work that most Electron and VoIP projects skip: every window runs sandboxed with context isolation and no Node access, the page runs under a strict Content-Security-Policy that forbids inline scripts and styles, SIP and RTP both reject traffic that does not come from the registered server, SIP passwords are encrypted at rest, downloaded models are checksum-pinned, and spreadsheet-formula injection in CSV export is defused. The test suite (127 tests) passes and includes dedicated hardening tests.

The review found no way for a remote party on a call, or a SIP scanner on the internet, to run code or read files through the application as shipped. The issues that remain fall into two groups: the release toolchain carries known-vulnerable packages, one of which reaches the Linux artefact users actually run; and a small number of gaps between what the app promises and what it delivers on certain Linux configurations, plus the already-known absence of code signing.

### Findings at a glance

| Severity | Count | Theme |
|---|:---:|---|
| **Critical** | 0 | No critical, directly-exploitable defect in the shipped app. |
| **High** | 2 | Vulnerable build/release dependencies; one reaches the Linux AppImage. |
| **Medium** | 3 | Credential-at-rest gap on some Linux setups; unsigned builds; update redirect downgrade. |
| **Low** | 6 | Defense-in-depth: IPC sender checks, trace-log contents, version currency, plaintext RTP. |

### Launch recommendation

**Cleared to launch on Windows once H1 and H2 are addressed** by upgrading the build toolchain and re-running the dependency audit; both are a single dependency bump and are low-risk.

For the **Linux** packages, resolve H1 before publishing the AppImage, and treat M1 (password storage on machines with no system keyring) as a launch blocker for Linux or, at minimum, an honest in-app warning. Code signing (M2) is already tracked and accepted as a known gap; it is worth closing before wide distribution because the current SmartScreen flow trains users to run unsigned binaries.

---

## Scope and method

The review covered the entire application source under `src/`, the build and release configuration (`package.json`, the GitHub Actions workflows, `tools/`), and the dependency tree. Work was done by static reading of the code, running the existing automated tests, and running `npm audit` against both the production and full dependency trees. Published advisories for the flagged packages were consulted directly. No live SIP provider (JetWave or Vital) was contacted; findings that depend on provider behaviour are marked as needing confirmation on a real call.

### Attack surface considered

- **Network, unauthenticated.** SIP messages over UDP/TCP/TLS and RTP media from a call peer, a proxy, or an internet scanner — the parser, transaction layer, dialog logic, SDP, and RTP packet handling.
- **Network, update path.** The auto-updater feed, manifest parsing, redirect handling, and the on-device speech-model downloads from Hugging Face and GitHub.
- **Local, cross-boundary.** The renderer-to-main IPC bridge (preload), the Content-Security-Policy, window hardening, and how untrusted strings (caller names, transcripts, contacts) reach the DOM.
- **Data at rest.** SIP password storage, settings and contact files, saved transcripts, and log contents.
- **Supply chain.** Runtime and build-time dependencies, the release workflow, and the integrity of what the updater ships to installed copies.

### What was verified as sound

- ✓ All `BrowserWindow`s use `sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false`; `harden()` blocks navigation away from local files, webview attachment, and `window.open`. The CSP forbids inline scripts and inline style attributes.
- ✓ The SIP serialiser folds CR/LF out of header values, so a crafted display name or dialled string cannot inject extra SIP headers; a dialled `tel:` string is reduced to digits and `+ * #` before use. Both are covered by tests.
- ✓ RTP enforces a per-line strict-source check and symmetric-latch protection, so a party who guesses the media port cannot inject audio or steal the stream. SIP has the equivalent "accept from the registrar only" filter. Both are on by default and tested.
- ✓ Digest authentication negotiates the strongest offered algorithm (SHA-512-256 / SHA-256 / MD5) and only ever answers the configured server.
- ✓ The settings merge refuses `__proto__`, `constructor` and `prototype` keys (prototype-pollution guard, tested); downloaded models are size- and SHA-256-pinned and discarded on mismatch (tested).
- ✓ Renderer code escapes interpolated caller names, numbers, transcript text and contact fields before insertion into `innerHTML`; progress-bar widths are passed as data attributes to satisfy the CSP rather than inline styles.
- ✓ Transcript file reads and deletes reduce the caller-supplied name with `path.basename` and confirm the resolved path stays inside the transcripts directory (path-traversal guard).

---

## Findings register

| ID | Finding | Severity | Fix effort |
|---|---|:---:|:---:|
| H1 | AppImage library search-path hijack via `app-builder-lib` < 26.15.0 (CVE-2026-54672) | **High** | Low |
| H2 | Release toolchain ships 1 critical + 11 high npm advisories (tar, node-gyp chain, builder-util-runtime) | **High** | Low |
| M1 | SIP password stored under a hardcoded key on Linux with no keyring, while the app reports it as encrypted | **Medium** | Medium |
| M2 | Windows and Linux builds are not code-signed | **Medium** | Medium |
| M3 | Update-manifest fetch follows redirects into plain HTTP (protocol downgrade) | **Medium** | Low |
| L1 | IPC receivers do not validate the sending frame/window | **Low** | Low |
| L2 | SIP trace log records `Authorization` headers and full messages in clear | **Low** | Low |
| L3 | SIP source filter accepts everything before the first registration completes | **Low** | Low |
| L4 | Electron / dependency currency needs an owner and a cadence | **Low** | Low |
| L5 | Call media is unencrypted RTP (no SRTP/ZRTP) | **Low** | n/a |
| L6 | Portable executable breaks and self-deletes if launched twice | **Low** | Low |

Severity reflects impact on the application as shipped to a real user, not raw CVSS. A build-time-only advisory is rated by what it could do to the release, not to an end user's machine.

---

## Findings in detail

### H1 — AppImage library search-path hijack (CVE-2026-54672) · HIGH

- **Location:** `package.json` build toolchain — electron-builder 25.1.8 / app-builder-lib 25.1.8
- **Affects:** the Linux `.AppImage` artefact that users run; not Windows, not `.deb`/`.rpm`
- **Reference:** GHSA-7g7r-gx96-252g, CVSS 7.8 (High); patched in app-builder-lib 26.15.0

**What it is.** The AppImage runtime that electron-builder embeds builds the dynamic-linker search path in a way that leaves an empty entry when the relevant environment variable starts out unset. An empty entry is read by the loader as the current working directory. A user who launches the AppImage from a folder that also contains an attacker-placed shared library can therefore have that library loaded into the application at start-up.

**Impact.** Code execution as the user, at launch, on Linux. The realistic path is a downloads folder or a shared directory that already holds a file the attacker controls. Because TwinLine's own release notes tell Linux users to download and run the AppImage directly, this is the artefact most exposed to it.

**Recommendation.** Upgrade the build toolchain to `electron-builder@26.15.3` (which brings `app-builder-lib >= 26.15.0`) and rebuild the Linux packages. Re-run the CI packaging job and confirm the AppImage still boots via the existing smoke test. This is the same upgrade that clears most of H2, so do them together.

### H2 — Vulnerable packages in the release toolchain · HIGH

- **Location:** dev dependency tree under electron-builder 25.1.8
- **Runtime deps:** clean — `npm audit --omit=dev` reports 0 vulnerabilities
- **Full tree:** 12 advisories: 1 critical, 11 high (`tar`, `node-gyp` / `make-fetch-happen` / `cacache`, `builder-util-runtime`)

**What it is.** The application's runtime dependencies are clean. The build chain is not: the full audit reports one critical and eleven high advisories, all reached only through `electron-builder`. The critical one is in `tar` (arbitrary file write / path traversal during extraction). There is also a high advisory in `builder-util-runtime < 9.7.0` for leaking credentials on a cross-origin redirect — note that the *runtime* updater (`electron-updater 6.8.9`) already pulls the fixed 9.7.0; the vulnerable 9.2.10 is only present under the build tool.

**Impact.** These packages run on the build/release host, not on end-user machines, so they do not directly expose a user. They matter because the build host is part of the release trust chain: it produces the (future-signed) binaries and the update manifest that every installed copy trusts. A compromise there is a supply-chain compromise. The project's own rule that `npm audit --omit=dev` stays clean is met; the rule should be extended to watch the build chain too.

**Recommendation.** Run `npm audit fix --force` to move to `electron-builder@26.15.3`, then rebuild and run the full test and packaging suite (this is a major bump of a dev tool, so verify the artefacts). Add a full-tree `npm audit` to CI as a warning, keeping the shipped-only gate as the hard failure. Pin the toolchain and refresh it on a schedule.

### M1 — Password stored under a hardcoded key on keyring-less Linux · MEDIUM

- **Location:** `src/main/config.js` (`encryptionAvailable` / `_encrypt` / `_decrypt`); reported to the UI in `app:info`
- **Affects:** Linux systems with no GNOME keyring or KWallet (headless, minimal, or some server desktops)
- **Contradicts:** `SECURITY.md`: "SIP passwords are encrypted at rest with the operating system's key store"

**What it is.** The app treats `safeStorage.isEncryptionAvailable()` as a yes/no answer. On Linux, when no secret store is present, Electron still returns `true` but falls back to a backend (`basic_text`) that encrypts with a hardcoded, publicly known password. The value on disk looks encrypted and the Settings screen reports "encrypted at rest using your operating system keyring", but on such a machine the SIP password is effectively recoverable by anyone who reads the file.

**Impact.** A copied or backed-up `settings.json` from an affected Linux machine yields the SIP password, which is a reusable account credential at the provider. The security promise the app makes is not kept on that configuration, and the user is told the opposite.

**Recommendation.** Call `safeStorage.getSelectedStorageBackend()` and treat `basic_text` as "no real encryption": either refuse to store the password encrypted and fall back to the existing `0600`-file path with the honest warning the code already shows, or keep storing it but change the Settings text to say the OS keyring is unavailable. The Windows DPAPI path is unaffected and correct.

### M2 — Builds are not code-signed · MEDIUM

- **Location:** `release.yml` (`WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` wired but unset); no Linux signing
- **Status:** known and documented in `SECURITY.md` and `CLAUDE.md`; certificate "may be bought later"
- **Interacts with:** the auto-updater, which installs new versions on restart

**What it is.** Neither the Windows installer/portable exe nor the Linux packages are signed. Windows SmartScreen warns on first install and the README tells users to click through it. Integrity of an update currently rests on HTTPS transport plus the SHA-512 that electron-updater checks against the (unsigned) `latest.yml` manifest.

**Impact.** Training users to bypass the SmartScreen warning erodes the one signal that would flag a tampered installer. Without signing, the strongest guarantee for updates is that whoever controls the release GitHub repo (and its HTTPS) controls what installs. That is acceptable for a small project but is worth closing before wide distribution; on Windows an Authenticode signature also removes the warning entirely.

**Recommendation.** Obtain an Authenticode certificate and set the two secrets already referenced in `release.yml`; electron-builder signs both exes automatically. For Linux, publish and document GPG signatures / checksums for the artefacts. This is already accepted as a gap; the recommendation is to schedule it rather than leave it open-ended.

### M3 — Update-manifest fetch allows an HTTPS-to-HTTP downgrade on redirect · MEDIUM

- **Location:** `src/main/updater.js` — `fetchText()` and the Linux `_checkManual()` path
- **Scope:** the deb/rpm manual-check path and any generic (non-GitHub) feed
- **Guardrail present:** `feedFromUrl()` already forbids a plain-http feed unless it is loopback/RFC-1918

**What it is.** The initial feed URL is correctly restricted to HTTPS (or a local address). But `fetchText()` follows HTTP redirects by choosing the transport from each new `Location` value, so a manifest served over HTTPS can redirect the client to a plain `http://` URL, which it will then fetch. The manifest that drives the Linux "here is a newer version" prompt can therefore be delivered over an unauthenticated channel.

**Impact.** Limited but real: an attacker positioned on the network for the downgraded hop could alter the manifest the user sees. The eventual installer download for deb/rpm is only ever handed to the browser and is gated to `http(s)`, and the AppImage/Windows path still verifies the electron-updater checksum, so this is manifest-tampering rather than direct code delivery. Still, an update channel should not silently drop to cleartext.

**Recommendation.** In the redirect follower, reject a redirect that moves from `https:` to `http:` unless the destination is loopback/RFC-1918 (reuse `isLocalNetwork`). Apply the same rule to the model downloader in `models.js`, which follows redirects the same way.

---

## Lower-severity and defense-in-depth items

**L1 · IPC receivers do not check the sending window.** The `ipcMain.on` handlers for `audio:mic`, `popup:move` and the window controls act on whichever renderer sends them (`popup:move` does confirm it is the popup window). Every window loads a local file under the strict CSP and is hardened against navigation, so the practical risk is low today. As defense in depth, validate `event.senderFrame` against the expected local origin on the high-rate and window-moving channels, so any future renderer-side flaw cannot drive them.

**L2 · SIP trace log stores credentials-in-transit in clear.** When "Record every SIP message" is on, the log captures whole messages including `Authorization` / `Proxy-Authorization` headers (username, realm, nonce and the digest response) in the profile folder. It is opt-in and the README says to turn it off afterwards, which is reasonable. Consider masking the digest `response` and `nonce` fields in the trace, and reminding the user in-app that the trace contains sensitive data before they share it.

**L3 · SIP source filter is open until the first registration resolves.** `acceptsSource()` returns true when no server target has been resolved yet, and when a line is configured without registration. The first is a brief start-up window; the second is by design for direct trunking. Neither is a strong risk, but the start-up window could drop unsolicited requests instead of accepting them once the intended target is known.

**L4 · Assign an owner and cadence for dependency and Electron currency.** The build examined runs Electron 44.4.5, the newest 44.x patch, and the app pins a specific line. Chromium-based runtimes accrue security fixes continuously, so confirm 44 is still a supported release line and adopt a routine that applies Electron patch releases promptly and plans major upgrades before the line goes end-of-life. Fold the full-tree `npm audit` from H2 into the same routine.

**L5 · Call media is unencrypted RTP.** Audio is plain RTP with no SRTP or ZRTP; only SIP signalling can use TLS. This is documented and accepted, and it matches ordinary softphone behaviour. It is listed here only so the residual risk is explicit: anyone able to observe the media path can record the call audio. Keep the `SECURITY.md` statement truthful and consider SRTP a future enhancement, not a launch blocker.

**L6 · Portable executable self-deletes on a second launch.** The portable build unpacks to a fixed temp folder and removes it on exit, so a second concurrent launch breaks the first (`ffmpeg.dll not found`). This is an availability/robustness issue, not a security one, and is already documented. The installer is the recommended distribution; keep the warning prominent.

---

## Suggested order of work

| Step | Action | Clears | Before |
|:---:|---|---|---|
| 1 | Upgrade to `electron-builder@26.15.3`, rebuild all platforms, run tests + smoke + a packaging run. | H1, most of H2 | any release |
| 2 | Re-run full-tree `npm audit`; add it to CI as a warning gate. Confirm no shipped-dep regressions. | H2 | any release |
| 3 | Detect `basic_text` backend on Linux; make storage and the Settings message honest. | M1 | Linux launch |
| 4 | Reject `https`→`http` downgrade in the updater and model-download redirect followers. | M3 | next release |
| 5 | Obtain Authenticode cert, set the CI secrets; publish Linux checksums/signatures. | M2 | wide distribution |
| 6 | Add IPC sender checks, mask credentials in SIP trace, tighten the start-up source window. | L1–L3 | as capacity allows |

---

## Evidence and checks run

- **Automated tests.** `node --test` — 127 tests, 127 pass, 0 fail (unit, loopback SIP/RTP, transcription plumbing, and hardening tests).
- **Production audit.** `npm audit --omit=dev` — 0 vulnerabilities.
- **Full-tree audit.** `npm audit` — 12 vulnerabilities (1 critical, 11 high), all in the electron-builder dev chain.
- **Runtime updater dep.** `electron-updater 6.8.9` resolves `builder-util-runtime 9.7.0` (the patched line); the vulnerable 9.2.10 is dev-only.
- **Advisories consulted.** GHSA-7g7r-gx96-252g (CVE-2026-54672, app-builder-lib), GHSA-p2f4-r6v6-j797 (builder-util-runtime), the node-tar advisory set.
- **Build examined.** packaged 1.4.2 present under `dist/1.4.2` (installer, portable, `win-unpacked` with `app.asar` and `app-update.yml`).

---

*This review is a point-in-time reading of build 1.4.2. It does not replace testing against the live JetWave and Vital services, which behave in ways that cannot be reproduced offline; the network-facing conclusions were reached from the code and the loopback tests and should be confirmed on a real call. No exploit code was produced or run in the course of this review.*
