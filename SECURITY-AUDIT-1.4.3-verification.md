# TwinLine Softphone — Remediation Verification

**Follow-up to the 1.4.2 security audit · now at version 1.4.3**

| | |
|---|---|
| **Date of review** | 23 September 2026 |
| **Build now examined** | 1.4.3 (git `359fee0`, branch `main`) |
| **Previous audit** | 1.4.2 (git `2282f1a`), 23 September 2026 |
| **Remediation commit** | `180eb49` — "Fix the findings of the 1.4.2 security audit" |
| **Classification** | Confidential — for the project maintainer |

> Every finding from the first report was re-checked against the current source, the test suite (130 tests) and a fresh dependency audit. Status is reported honestly: what is closed, what is mitigated with a residual, and what is accepted.

---

## Verification summary

The 1.4.2 audit raised eleven findings: two high, three medium and six low. Every one has been acted on. The fixes were re-checked by reading the current source, running the full test suite, and running a fresh `npm audit`.

**Every finding that a code or configuration change can close is closed and verified.** Three items cannot be fully closed by a change alone: two are mitigated with a clearly stated residual (a code-signing certificate, and the ongoing dependency cadence), and one (unencrypted call media) remains an accepted architectural limitation.

The two high findings — the only ones with real weight — are fully resolved: the release toolchain was upgraded, which removes the AppImage search-path hijack and clears the entire dependency audit.

### Status at a glance

| Status | Count | Findings |
|---|:---:|---|
| **Resolved** | 8 | H1, H2, M1, M3, L1, L2, L3, L6 — closed in code/config and verified by test and audit. |
| **Mitigated** | 2 | M2 (checksums added; code signing still open), L4 (CI audit gates added; ownership is ongoing). |
| **Accepted** | 1 | L5 — plaintext RTP; a known, documented design limit, not a launch blocker. |

### Evidence checked

| Check | 1.4.2 (before) | 1.4.3 (now) |
|---|---|---|
| Automated tests | 127 pass | 130 pass (3 added for the fixes) |
| `npm audit` — shipped deps | 0 | 0 |
| `npm audit` — full tree | 12 (1 critical, 11 high) | **0** |
| electron-builder | 25.1.8 | 26.15.3 |
| app-builder-lib | 25.1.8 (vulnerable) | 26.15.3 (patched) |
| builder-util-runtime | 9.2.10 in the dev chain | 9.7.0 throughout |

### Launch view

The blockers named in the first report are cleared. **Windows is clear to launch.** The Linux AppImage concern (H1) is resolved at the toolchain level and the audit is clean; the one remaining step is the routine one of letting the CI packaging job build and boot the Linux artefacts once on the new toolchain, which the pipeline already does. M1 (Linux password storage) is now honest rather than misleading, so it is no longer a Linux blocker. Code signing (M2) stays a deliberate, documented gap, now softened by per-release checksums.

---

## Finding-by-finding verification

| ID | Original finding | Sev | Status | Verified by |
|---|---|:---:|:---:|---|
| H1 | AppImage library search-path hijack (CVE-2026-54672) | High | **Resolved** | toolchain upgrade; audit clean |
| H2 | Vulnerable packages in the release toolchain | High | **Resolved** | full-tree audit = 0; CI gates added |
| M1 | Password under a hardcoded key on keyring-less Linux | Med | **Resolved** | backend check; new test; honest UI |
| M2 | Builds are not code-signed | Med | **Mitigated** | SHA256SUMS added; signing still open |
| M3 | Update fetch allowed https→http downgrade | Med | **Resolved** | urlpolicy guard; end-to-end test |
| L1 | IPC receivers did not check the sender | Low | **Resolved** | `trustedSender()` on all channels |
| L2 | SIP trace stored credentials in clear | Low | **Resolved** | `redactSip()`; new test |
| L3 | Source filter open before registration | Low | **Resolved** | `acceptsSource()` closed; new test |
| L4 | Dependency / Electron currency cadence | Low | **Mitigated** | CI audit gates; ownership ongoing |
| L5 | Call media is unencrypted RTP | Low | **Accepted** | unchanged by design; documented |
| L6 | Portable exe breaks on a second launch | Low | **Resolved** | `unpackDirName`; smoke re-run |

*"Resolved" means the weakness is gone from the current source and a test or the dependency audit confirms it. "Mitigated" means the risk is reduced but a residual remains that a code change alone cannot close. "Accepted" means the project has knowingly chosen to live with it and says so.*

---

## What was done, and how it was verified

### H1 — AppImage library search-path hijack (CVE-2026-54672) · RESOLVED

**Fix applied.** The build toolchain was upgraded from `electron-builder 25.1.8` to `26.15.3`, which brings `app-builder-lib 26.15.3` — past the 26.15.0 that removed the empty `LD_LIBRARY_PATH` entry. The Linux desktop-entry keys were moved under `entry` to match the version-26 schema.

**Verification.** `app-builder-lib` resolves to 26.15.3 on disk and the full `npm audit` is clean, so the advisory is no longer present. The commit records the smoke test passing on the packaged build. Residual: none in code; as a matter of routine, let the CI Linux packaging job build and boot the AppImage once on the new toolchain (the pipeline already does this).

### H2 — Vulnerable packages in the release toolchain · RESOLVED

**Fix applied.** The same toolchain upgrade removes every flagged package: the `tar` critical, the `node-gyp` / `make-fetch-happen` / `cacache` chain, and `builder-util-runtime` (now 9.7.0 everywhere). CI in both `build.yml` and `release.yml` now runs `npm audit --omit=dev` as a hard gate and `npm audit` on the full tree as a warning.

**Verification.** `npm audit` reports 0 vulnerabilities on the full tree (was 1 critical + 11 high) and 0 on shipped dependencies. The runtime updater already used the fixed 9.7.0; that is now the only version present. Fully resolved.

### M1 — Password under a hardcoded key on keyring-less Linux · RESOLVED

**Fix applied.** `config.js` now judges availability by the actual backend: a new `encryptionBackend` getter returns null for Electron's Linux `basic_text` (and `unknown`) fallback, and `encryptionAvailable` follows it. On that configuration the password is stored in the 0600 file and the Settings screen says plainly that it is not encrypted and how to fix it. Decryption is no longer gated on availability, so a value written by any older backend still loads and nobody is locked out. `SECURITY.md` was corrected to match.

**Verification.** A new test drives a fake `basic_text` backend and confirms the value is stored plainly (not falsely wrapped), a real `gnome_libsecret` backend still encrypts, and an older encrypted value is read back and re-saved under the new policy. The false promise the first report flagged is gone.

### M2 — Builds are not code-signed · MITIGATED

**What changed.** The release publish job now generates `SHA256SUMS.txt` covering every installer and uploads it with the release; the README and `SECURITY.md` point users to it so a download can be checked by hand.

**Residual risk.** Code signing itself is still absent, so Windows SmartScreen still warns on first install and there is no cryptographic signature binding a build to the project. This is a deliberate, documented gap that needs a purchased certificate; the CI secrets are already wired for it. Checksums give tamper-evidence for a careful user but do not replace signing. **Recommendation unchanged:** obtain an Authenticode certificate before wide distribution.

### M3 — Update fetch allowed an https-to-http downgrade on redirect · RESOLVED

**Fix applied.** A new dependency-free `src/main/urlpolicy.js` exposes `followRedirect()`, which resolves each redirect and refuses one that leaves HTTPS for plain HTTP (unless the destination is loopback/RFC-1918, for the local rehearsal server) and refuses non-http(s) schemes. Both the updater's `fetchText()` and the model downloader's `downloadFile()` now route redirects through it.

**Verification.** A new test exercises the pure function for the allowed and refused cases and drives a real redirect through the updater's fetcher end to end. Same-scheme redirects still work; a downgrade is rejected before any request is sent to the http target.

### L1 — IPC receivers did not validate the sender · RESOLVED

**Fix applied.** A `trustedSender()` check now runs on every IPC channel — both the request/response `handle()` wrapper and a new guarded `on()` for fire-and-forget channels (`audio:mic`, the window controls, popup move/dismiss). It requires the sender to be the main frame, loading a `file:` URL under the renderer directory, and one of the app's own `BrowserWindow`s; anything else is refused and logged.

**Verification.** Read and confirmed in `main.js`. This is broader than the first report asked for — the check covers all channels, not only the high-rate ones — and the whole suite still passes, so the legitimate windows are unaffected.

### L2 — SIP trace stored credentials-in-transit in clear · RESOLVED

**Fix applied.** `log.js` gained `redactSip()`, which masks the `response`, `nonce`, `cnonce` and `rspauth` values in the authentication headers while leaving username and realm for debugging. It is applied as the trace is written. The Settings screen and README now warn what the trace contains.

**Verification.** A new test confirms the digest response and nonces are redacted (quoted and unquoted forms), the username survives, other headers are untouched, and the masking happens on the way into the file.

### L3 — Source filter was open before the first registration · RESOLVED

**Fix applied.** `acceptsSource()` in `useragent.js` now returns false, not true, while strict filtering and registration are on but the registrar has not been resolved yet — the start-up window is closed rather than open.

**Verification.** A new assertion in the security tests covers the pre-resolution case. Because the transport is only created after the server is resolved, no legitimate traffic is affected.

### L4 — Dependency and Electron currency need an owner and cadence · MITIGATED

**What changed.** CI now audits on every push and every release: `npm audit --omit=dev` is a hard failure and the full-tree audit is surfaced as a warning, so a future toolchain advisory shows up on the run. Electron is on 44.4.5, the current 44.x patch.

**Residual.** The CI gates operationalise the check, but keeping Electron on a supported line and acting on the warnings is an ongoing responsibility that needs a named owner and a cadence rather than a one-time fix. Treat this as an operational item, not a closed defect.

### L5 — Call media is unencrypted RTP · ACCEPTED

**Status.** Unchanged, by design. Audio is plain RTP with no SRTP/ZRTP; only SIP signalling can use TLS. The project documents this and accepts it, and it matches ordinary softphone behaviour.

**Residual.** Anyone able to observe the media path can record call audio. This is not a launch blocker; it is a stated limitation. SRTP would be a future enhancement. The `SECURITY.md` statement remains truthful about it.

### L6 — Portable executable broke on a second launch · RESOLVED

**Fix applied.** The portable target now sets `unpackDirName: true`, so each launch unpacks to its own directory and two concurrent launches no longer delete each other's files. The README no longer warns against it.

**Verification.** The commit records that the smoke test was run with two concurrent portable launches. This was an availability issue rather than a security one; it is resolved.

---

## Remaining items and verification caveats

**Still open by choice.** Code signing (M2) and unencrypted RTP (L5) are the two things a user-facing security statement should keep mentioning. Both are documented; M2 now has checksums as a partial measure. Dependency currency (L4) is operational and needs an owner.

**How this was verified.** Findings were re-checked by reading the current source at commit `359fee0`, running `npm test` (130 pass) and `npm audit` (0 vulnerabilities) on this Windows host. Packaging behaviour on Linux (the AppImage build and the deb/rpm desktop-entry schema change) and behaviour on a real JetWave or Vital call were not re-exercised here; the commit reports the smoke test passing on the packaged build, and CI builds both platforms. Confirm the Linux packaging job is green on the new toolchain before publishing the Linux artefacts.

---

*Bottom line: the two high findings and every medium and low that a change can close are resolved and verified; the three that remain are a purchased certificate, an ongoing dependency cadence, and an accepted media-encryption limitation, each stated plainly. No exploit code was produced or run in the course of this review.*
