<!-- Describe what changed in the next release. Shown to users in the update banner. -->
- `callto:` links now open TwinLine and fill in the number, like `sip:` and `tel:` links (Windows and Linux). The number is prefilled; press Call to dial.
- Audio no longer goes silent when the other side resumes a hold or the PBX reconnects the call to a conference. The incoming audio stream restarted with new sequence numbers and TwinLine dropped every packet as "late" until the numbers caught up — minutes of silence that only a transfer fixed.
