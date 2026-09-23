Conference transcription now hears everyone: every participant is recognised and labelled by contact name or number, not just the first two.

Also in this release:
- A finished transcript counts down five seconds and puts itself away (a popped-out transcript window closes with it); press "Keep open" to stop it.
- A second incoming call while you are talking now plays a soft call-waiting beep in the earpiece instead of the full ringtone over the conversation, and tones use the same audio session as the call so Windows has nothing to turn down.
- Security review: every window is sandboxed; lines ignore SIP and RTP from anywhere but their own server (per-line switches under Settings → Line); SIP header injection is impossible; sip:/tel: links fill the dialler instead of dialling; update servers must use HTTPS; speech model downloads are verified against pinned checksums; CSV exports are safe to open in Excel; the app runs on the current Electron release. Details in SECURITY.md.
