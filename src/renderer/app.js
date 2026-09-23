'use strict';
/**
 * TwinLine UI.
 *
 * Holds no call state of its own: the main process is the source of truth and
 * pushes a full snapshot on every change. This keeps the two-line / hold /
 * conference logic in one place instead of being duplicated here.
 */

import { RendererAudio } from './audio-engine.js';

const api = window.twinline;
const audio = new RendererAudio();

let settings = null;
let appInfo = null;
let state = { calls: [], conference: [], muted: false, accounts: [] };
let devices = { inputs: [], outputs: [] };
let transferContext = null;
let keypadVisible = true;

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

// ---- boot -------------------------------------------------------------------

async function boot() {
  appInfo = await api.info();
  settings = await api.settings.get();
  state = await api.state.get();

  wireEvents();
  renderAll();

  // Audio needs a user gesture in some configurations; try now and retry on
  // the first interaction so an incoming call is never silent.
  startAudio();
  document.addEventListener('pointerdown', startAudio, { once: true });
  document.addEventListener('keydown', startAudio, { once: true });

  setInterval(tickDurations, 500);
}

let audioStarting = false;
async function startAudio() {
  if (audio.started || audioStarting) return;
  audioStarting = true;
  audio.applySettings(settings.audio);
  try {
    await audio.start();
    audio.onFrame = (frame) => api.audio.sendMicFrame(frame);
    devices = await RendererAudio.devices();
    if (audio.lastError) {
      toast(`Microphone unavailable: ${audio.lastError.message}. You can still hear callers.`, 'warn');
    }
    renderSettingsAudio();
  } catch (err) {
    toast(`Audio failed to start: ${err.message}`, 'error');
  } finally {
    audioStarting = false;
  }
}

// ---- main-process events ----------------------------------------------------

function wireEvents() {
  api.on.state((snapshot) => {
    playTransitionCues(state.calls, snapshot.calls);
    state = snapshot;
    renderAll();
    updateRingtone();
  });
  api.on.accounts((accounts) => { state.accounts = accounts; renderLines(); renderAccountSelect(); });
  api.on.speaker((buffer) => audio.play(buffer));
  api.on.levels(renderLevels);
  api.on.incoming(() => updateRingtone());
  api.on.callEnded((info) => {
    updateRingtone();
    // A call that never connected and was refused gets the busy signal;
    // everything else gets the short "ended" cue.
    if (['busy', 'declined', 'notfound', 'rejected'].includes(info.reason)) audio.playCue('busy');
    else if (info.reason !== 'rejected-local' && info.reason !== 'cancelled') audio.playCue('ended');
    if (info.reason && !['local', 'remote'].includes(info.reason)) {
      toast(`Call ended: ${info.text || info.reason}`, info.status >= 400 ? 'warn' : '');
    }
  });
  api.on.warning(({ message }) => toast(message, 'warn'));
  api.on.error(({ message }) => toast(message, 'error'));
  api.on.accountError(({ id, message }) => toast(`${id}: ${message}`, 'error'));
  api.on.dtmf(({ digit }) => toast(`Received DTMF: ${digit}`));
  api.on.message(({ from, body }) => toast(`Message from ${from}: ${body}`.slice(0, 160)));

  // Title bar (the window is frameless; this bar is the only one)
  $('btnMinimise').onclick = () => api.window.minimise();
  $('btnMaximise').onclick = () => api.window.maximise();
  $('btnClose').onclick = () => api.window.close();
  document.querySelector('.titlebar').addEventListener('dblclick', (e) => {
    if (!e.target.closest('button, select, input')) api.window.maximise();
  });
  api.on.windowState(({ maximized }) => {
    $('btnMaximise').innerHTML = maximized ? '&#10697;' : '&#9633;';
    $('btnMaximise').title = maximized ? 'Restore' : 'Maximise';
  });
  $('btnSettings').onclick = openSettings;
  $('btnHistory').onclick = openHistory;
  $('btnContacts').onclick = openContacts;
  $('btnContactsClose').onclick = () => $('contactsOverlay').classList.add('hidden');
  $('btnContactNew').onclick = () => editContact(null);
  $('btnContactCancel').onclick = hideContactForm;
  $('contactForm').addEventListener('submit', saveContact);
  $('contactSearch').addEventListener('input', renderContacts);
  $('btnContactsImport').onclick = importContacts;
  for (const button of document.querySelectorAll('button[data-export]')) {
    button.onclick = () => exportContacts(button.dataset.export);
  }
  $('btnResetPopup').onclick = async () => {
    await guard(api.popup.resetPosition());
    toast('Popup position reset');
  };
  $('btnOpenLogs').onclick = () => guard(api.log.openFolder());
  $('btnReregister').onclick = async () => {
    await guard(api.network.refresh('requested from settings'));
    toast('Re-registering all lines');
  };

  // Chromium knows when connectivity comes back; the SIP stack does not.
  window.addEventListener('online', () => guard(api.network.refresh('browser online event')));

  // Transcription
  api.on.transcriptStarted(onTranscriptStarted);
  api.on.transcriptLine(onTranscriptLine);
  api.on.transcriptSpeaking(onTranscriptSpeaking);
  api.on.transcriptFinished(onTranscriptFinished);
  api.on.transcriptStatus(() => { if (!$('settingsOverlay').classList.contains('hidden')) renderSettingsTranscription(); });
  api.on.modelsProgress(onModelProgress);
  api.on.modelsStatus(() => renderSettingsTranscription());
  $('btnTranscriptClose').onclick = () => { shownTranscript = null; renderTranscript(); };
  $('btnTranscriptCopy').onclick = () => copyTranscript(shownTranscript && transcripts.get(shownTranscript));
  $('btnTranscriptViewClose').onclick = () => $('transcriptOverlay').classList.add('hidden');
  $('btnTranscriptViewCopy').onclick = () => viewedTranscript && copyText(viewedTranscript.text);
  $('btnTranscriptViewFolder').onclick = () => guard(api.transcribe.openFolder());
  $('btnTranscriptViewDelete').onclick = deleteViewedTranscript;
  $('btnTranscriptsFolder').onclick = () => guard(api.transcribe.openFolder());

  // Updates (the Check button is wired inside renderUpdate, which re-renders it)
  api.on.update(renderUpdate);
  api.updates.status().then(renderUpdate).catch(() => {});
  $('btnSettingsClose').onclick = closeSettings;
  $('btnSettingsCancel').onclick = closeSettings;
  $('btnSettingsSave').onclick = saveSettings;
  $('btnHistoryClose').onclick = () => $('historyOverlay').classList.add('hidden');

  // Dialer
  $('btnDial').onclick = dial;
  $('dialInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') dial();
  });
  $('btnMute').onclick = toggleMute;
  $('btnKeypad').onclick = toggleKeypad;
  $('keypad').addEventListener('click', (e) => {
    const button = e.target.closest('button[data-digit]');
    if (button) pressDigit(button.dataset.digit);
  });

  // Conference
  $('btnConfSplit').onclick = () => guard(api.conference.split(null));
  $('btnConfEnd').onclick = () => guard(api.conference.end());

  // Transfer
  $('btnTransferClose').onclick = closeTransfer;
  $('btnTransferCancel').onclick = closeTransfer;
  $('btnTransferGo').onclick = doTransfer;

  // Settings tabs
  $('settingsTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t === tab);
    for (const p of document.querySelectorAll('.tab-panel')) {
      p.classList.toggle('active', p.dataset.panel === tab.dataset.tab);
    }
  });

  document.addEventListener('keydown', onGlobalKey);
}

function onGlobalKey(e) {
  if (e.target.matches('input, select, textarea')) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  if (e.key === 'Escape') {
    for (const id of ['settingsOverlay', 'historyOverlay', 'transferOverlay', 'contactsOverlay', 'transcriptOverlay']) {
      $(id).classList.add('hidden');
    }
    return;
  }
  if (/^[0-9*#]$/.test(e.key)) { pressDigit(e.key); return; }
  if (e.key === 'Enter') {
    const incoming = state.calls.find((c) => c.state === 'incoming');
    if (incoming) guard(api.call.answer(incoming.id));
    else dial();
  }
}

// ---- rendering --------------------------------------------------------------

function renderAll() {
  renderLines();
  renderAccountSelect();
  renderCalls();
  renderConference();
  $('btnMute').classList.toggle('active', !!state.muted);
  $('btnMute').textContent = state.muted ? 'Unmute' : 'Mute';
}

function renderLines() {
  const container = $('lineStatus');
  if (!state.accounts.length) {
    container.innerHTML = '<span class="line-chip"><span class="dot"></span><span class="label">No lines</span></span>';
    return;
  }
  container.innerHTML = state.accounts.map((a) => {
    const reg = a.registration.state;
    const title = reg === 'failed' && a.registration.reason
      ? `${a.label}: ${a.registration.reason}`
      : `${a.label}: ${reg}`;
    return `<span class="line-chip ${esc(reg)}" title="${esc(title)}">
      <span class="dot"></span><span class="label">${esc(a.label)}</span>
    </span>`;
  }).join('');
}

function renderAccountSelect() {
  const select = $('dialAccount');
  const previous = select.value;
  select.innerHTML = state.accounts.map((a) =>
    `<option value="${esc(a.id)}">${esc(a.label)}</option>`).join('');
  if (previous && state.accounts.some((a) => a.id === previous)) select.value = previous;
}

function renderCalls() {
  const area = $('callArea');
  const calls = state.calls.filter((c) => c.state !== 'terminated');

  if (!calls.length) {
    area.innerHTML = '<div class="empty"><p class="empty-title">No active calls</p>'
      + '<p class="empty-sub">Dial a number below, or wait for a call.</p></div>';
    return;
  }

  const connectedCount = calls.filter((c) => c.state === 'connected').length;
  const conferenceRunning = !!state.conferenceRunning;

  area.innerHTML = calls.map((call) => {
    const account = state.accounts.find((a) => a.id === call.accountId);
    const cls = call.state === 'incoming' ? 'incoming'
      : call.inConference && !call.localHold ? 'conference'
      : call.localHold ? 'held'
      : call.state === 'connected' ? 'active' : '';
    // A contact name beats whatever the PBX sent as display name.
    const name = call.contactName || call.remoteName;

    return `<article class="call-card ${cls}" data-call="${esc(call.id)}">
      <div class="call-head">
        <span class="call-number">${esc(name || call.remoteNumber || 'Unknown')}</span>
        ${name ? `<span class="call-name">${esc(call.remoteNumber)}</span>` : ''}
      </div>
      <div class="call-meta">
        ${statusTag(call)}
        ${call.transcribing ? '<span class="tag red rec">Transcribing</span>' : ''}
        <span>${esc(account ? account.label : call.accountId)}</span>
        <span data-duration="${esc(call.id)}">${formatDuration(call)}</span>
        ${call.codec ? `<span>${esc(call.codec)}</span>` : ''}
      </div>
      <div class="call-actions">${callButtons(call, connectedCount, conferenceRunning)}</div>
    </article>`;
  }).join('');

  for (const button of area.querySelectorAll('button[data-action]')) {
    button.onclick = () => onCallAction(button.dataset.action, button.dataset.call);
  }
}

function statusTag(call) {
  if (call.state === 'incoming') return '<span class="tag blue">Incoming</span>';
  if (call.state === 'calling') return '<span class="tag">Calling</span>';
  if (call.state === 'ringing') return '<span class="tag">Ringing</span>';
  if (call.inConference && call.localHold) return '<span class="tag amber">Conference · on hold</span>';
  if (call.inConference) return '<span class="tag purple">In conference</span>';
  if (call.localHold && call.remoteHold) return '<span class="tag amber">Both on hold</span>';
  if (call.localHold) return '<span class="tag amber">On hold</span>';
  if (call.remoteHold) return '<span class="tag amber">Held by peer</span>';
  if (call.state === 'connected') return '<span class="tag green">Connected</span>';
  return `<span class="tag">${esc(call.state)}</span>`;
}

function callButtons(call, connectedCount, conferenceRunning) {
  const id = esc(call.id);
  const b = (action, label, cls = 'btn small') =>
    `<button class="${cls}" data-action="${action}" data-call="${id}">${label}</button>`;

  if (call.state === 'incoming') {
    return b('answer', 'Answer', 'btn call small') + b('reject', 'Decline', 'btn danger small');
  }
  if (call.state === 'calling' || call.state === 'ringing') {
    return b('hangup', 'Cancel', 'btn danger small');
  }
  if (call.state !== 'connected') return b('hangup', 'End', 'btn danger small');

  const parts = [];
  if (call.inConference) {
    // Holding a member keeps them in the conference; Resume puts them back.
    parts.push(call.localHold
      ? b('confResume', 'Resume', 'btn small active')
      : b('confHold', 'Hold', 'btn ghost small'));
    parts.push(b('hangup', 'Drop', 'btn danger small'));
    return parts.join('');
  }

  parts.push(call.localHold ? b('unhold', 'Resume', 'btn small active') : b('hold', 'Hold', 'btn small'));

  if (conferenceRunning) parts.push(b('confAdd', 'Join conf', 'btn small'));
  else if (connectedCount >= 2) parts.push(b('conference', 'Conference', 'btn small'));

  parts.push(b('transfer', 'Transfer', 'btn ghost small'));
  parts.push(transcribeButton(call));
  parts.push(b('hangup', 'End', 'btn danger small'));
  return parts.join('');
}

function transcribeButton(call) {
  const id = esc(call.id);
  if (call.transcribing) {
    return `<button class="btn small active" data-action="transcribeStop" data-call="${id}" title="Stop transcribing; the transcript so far is saved">Stop transcript</button>`;
  }
  const available = state.transcription && state.transcription.available;
  const title = available ? 'Transcribe this call on this computer' : 'Download a speech model in Settings → Transcription first';
  return `<button class="btn ghost small" data-action="transcribe" data-call="${id}" ${available ? '' : 'disabled'} title="${title}">Transcribe</button>`;
}

function renderConference() {
  const panel = $('conferencePanel');
  const members = state.conference.filter((id) => state.calls.some((c) => c.id === id));

  if (members.length < 2) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  $('confCount').textContent = `${members.length + 1} parties`;

  $('confMembers').innerHTML = members.map((id) => {
    const call = state.calls.find((c) => c.id === id);
    const held = call.localHold;
    return `<li data-call="${esc(id)}">
      <span class="member-name">${esc(call.contactName || call.remoteName || call.remoteNumber || 'Unknown')}
        ${held ? '<span class="tag amber">on hold</span>' : ''}</span>
      <span class="level-bar"><span data-level="${esc(id)}"></span></span>
      ${held
        ? `<button class="btn small active" data-conf="resume" data-call="${esc(id)}"
                   title="Bring this party back into the conference">Resume</button>`
        : `<button class="btn ghost small" data-conf="hold" data-call="${esc(id)}"
                   title="Hold this party; they stay in the conference and rejoin on Resume">Hold</button>`}
      <button class="btn danger small" data-conf="drop" data-call="${esc(id)}"
              title="Hang up on this party only">Drop</button>
    </li>`;
  }).join('');

  for (const button of $('confMembers').querySelectorAll('button[data-conf]')) {
    button.onclick = () => {
      const callId = button.dataset.call;
      if (button.dataset.conf === 'hold') guard(api.conference.holdParty(callId));
      else if (button.dataset.conf === 'resume') guard(api.conference.resumeParty(callId));
      else guard(api.conference.hangupParty(callId));
    };
  }
}

/** Audible cues for state changes the user might not be looking at. */
function playTransitionCues(before, after) {
  const previous = new Map(before.map((c) => [c.id, c.state]));
  for (const call of after) {
    const was = previous.get(call.id);
    if (call.state === 'connected' && was && was !== 'connected') audio.playCue('connected');
  }
}

function renderLevels(levels) {
  const mic = $('micMeter');
  if (mic) mic.style.width = `${Math.round((levels.mic || 0) * 100)}%`;
  for (const [id, value] of Object.entries(levels.legs || {})) {
    const bar = document.querySelector(`[data-level="${CSS.escape(id)}"]`);
    if (bar) bar.style.width = `${Math.round(value * 100)}%`;
  }
}

function tickDurations() {
  for (const call of state.calls) {
    const el = document.querySelector(`[data-duration="${CSS.escape(call.id)}"]`);
    if (el) el.textContent = formatDuration(call);
  }
}

function formatDuration(call) {
  const since = call.answeredAt || call.createdAt;
  const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000));
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

// ---- actions ----------------------------------------------------------------

async function guard(promise) {
  try {
    return await promise;
  } catch (err) {
    toast(err.message, 'error');
    return null;
  }
}

function onCallAction(action, callId) {
  switch (action) {
    case 'answer': return guard(api.call.answer(callId));
    case 'reject': return guard(api.call.reject(callId, 486));
    case 'hangup': return guard(api.call.hangup(callId));
    case 'hold': return guard(api.call.hold(callId));
    case 'unhold': return guard(api.call.unhold(callId));
    case 'conference': return guard(api.conference.start(null));
    case 'confAdd': return guard(api.conference.add(callId));
    case 'confHold': return guard(api.conference.holdParty(callId));
    case 'confResume': return guard(api.conference.resumeParty(callId));
    case 'transfer': return openTransfer(callId);
    case 'transcribe': return guard(api.transcribe.start(callId));
    case 'transcribeStop': return guard(api.transcribe.stop(callId));
    default: return null;
  }
}

async function dial() {
  const input = $('dialInput');
  const target = input.value.trim();
  if (!target) return;
  await startAudio();
  const accountId = $('dialAccount').value || undefined;
  const result = await guard(api.call.dial(target, accountId));
  if (result) input.value = '';
}

function pressDigit(digit) {
  // During a call the keypad sends DTMF; otherwise it types a number.
  const target = state.calls.find((c) => c.state === 'connected' && !c.localHold);
  if (target) {
    audio.playDtmfFeedback(digit);
    guard(api.call.dtmf(target.id, digit));
    return;
  }
  const input = $('dialInput');
  input.value += digit;
  input.focus();
}

async function toggleMute() {
  const result = await guard(api.audio.mute(!state.muted));
  if (result) {
    state.muted = result.muted;
    audio.setMicrophoneEnabled(!result.muted);
    renderAll();
  }
}

function toggleKeypad() {
  keypadVisible = !keypadVisible;
  $('keypad').classList.toggle('hidden', !keypadVisible);
  $('btnKeypad').textContent = keypadVisible ? 'Hide keypad' : 'Show keypad';
}

function updateRingtone() {
  const incoming = state.calls.some((c) => c.state === 'incoming');
  const outgoingRinging = state.calls.some((c) => c.state === 'ringing');
  if (incoming) audio.startRinging('ring');
  else if (outgoingRinging) audio.startRinging('ringback');
  else audio.stopRinging();
}

// ---- transfer ---------------------------------------------------------------

function openTransfer(callId) {
  const call = state.calls.find((c) => c.id === callId);
  if (!call) return;
  transferContext = callId;

  $('transferSubject').textContent = `Transferring ${call.remoteNumber || 'this call'}.`;
  $('transferTarget').value = '';

  // Offer an attended transfer to any other connected call.
  const others = state.calls.filter((c) => c.id !== callId && c.state === 'connected');
  $('attendedOptions').innerHTML = others.length
    ? `<p class="hint">Or hand it to a call already in progress:</p>`
      + others.map((c) => `<button class="btn small" data-attended="${esc(c.id)}">`
        + `${esc(c.remoteNumber || 'Unknown')}</button>`).join(' ')
    : '';

  for (const button of $('attendedOptions').querySelectorAll('button[data-attended]')) {
    button.onclick = async () => {
      await guard(api.call.transferAttended(callId, button.dataset.attended));
      closeTransfer();
    };
  }

  $('transferOverlay').classList.remove('hidden');
  $('transferTarget').focus();
}

function closeTransfer() {
  transferContext = null;
  $('transferOverlay').classList.add('hidden');
}

async function doTransfer() {
  const target = $('transferTarget').value.trim();
  if (!target || !transferContext) return;
  await guard(api.call.transferBlind(transferContext, target));
  closeTransfer();
}

// ---- history ----------------------------------------------------------------

async function openHistory() {
  const history = await api.state.history();
  $('historyList').innerHTML = history.length
    ? history.map((h) => {
        const cls = h.missed ? 'missed' : h.direction === 'out' ? 'out' : 'in';
        const arrow = h.missed ? '&#10007;' : h.direction === 'out' ? '&#8599;' : '&#8600;';
        const duration = h.durationMs ? ` · ${Math.round(h.durationMs / 1000)}s` : '';
        return `<li>
          <span class="dir ${cls}">${arrow}</span>
          <span class="who">${esc(h.contactName || h.remoteName || h.remoteNumber || 'Unknown')}</span>
          <span class="when">${new Date(h.startedAt).toLocaleString()}${duration}</span>
          ${h.transcript ? `<button class="btn ghost small" data-tfile="${esc(h.transcript)}" title="${h.transcriptLines} lines">Transcript</button>` : ''}
          <button class="btn ghost small redial" data-redial="${esc(h.remoteNumber)}">Call</button>
        </li>`;
      }).join('')
    : '<li><span class="who">No calls yet.</span></li>';

  for (const button of $('historyList').querySelectorAll('button[data-redial]')) {
    button.onclick = () => {
      $('dialInput').value = button.dataset.redial;
      $('historyOverlay').classList.add('hidden');
      dial();
    };
  }
  for (const button of $('historyList').querySelectorAll('button[data-tfile]')) {
    button.onclick = () => openTranscriptFile(button.dataset.tfile);
  }
  renderSavedTranscripts();
  $('historyOverlay').classList.remove('hidden');
}

// ---- settings ---------------------------------------------------------------

function openSettings() {
  renderSettingsAccounts();
  renderSettingsAudio();
  renderSettingsGeneral();
  renderSettingsTranscription();
  $('settingsOverlay').classList.remove('hidden');
}

function closeSettings() {
  $('settingsOverlay').classList.add('hidden');
}

function renderSettingsAccounts() {
  settings.accounts.forEach((account, index) => {
    const panel = document.querySelector(`[data-panel="line${index + 1}"]`);
    if (!panel) return;
    const p = `a${index}`;
    panel.innerHTML = `
      <label class="check"><input type="checkbox" id="${p}_enabled"> Enable this line</label>
      <label class="field"><span>Label</span><input type="text" id="${p}_label"></label>
      <label class="field"><span>SIP server / domain</span>
        <input type="text" id="${p}_domain" placeholder="pbx.provider.com"></label>
      <label class="field"><span>Username (extension)</span><input type="text" id="${p}_username"></label>
      <label class="field"><span>Authentication ID <em>(if different)</em></span>
        <input type="text" id="${p}_authUsername"></label>
      <label class="field"><span>Password</span><input type="password" id="${p}_password"></label>
      <label class="field"><span>Display name</span><input type="text" id="${p}_displayName"></label>
      <label class="field"><span>Outbound proxy <em>(optional)</em></span>
        <input type="text" id="${p}_outboundProxy" placeholder="sbc.provider.com:5060"></label>
      <label class="field"><span>Transport</span>
        <select id="${p}_transport">
          <option value="UDP">UDP</option><option value="TCP">TCP</option><option value="TLS">TLS</option>
        </select></label>
      <label class="check"><input type="checkbox" id="${p}_register"> Register with the server</label>
      <label class="field"><span>Registration expiry (seconds)</span>
        <input type="number" id="${p}_registerExpires" min="30" max="7200"></label>
      <label class="field"><span>NAT keep-alive (seconds, 0 to disable)</span>
        <input type="number" id="${p}_keepAliveSeconds" min="0" max="600"></label>
      <label class="field"><span>DTMF</span>
        <select id="${p}_dtmfMode">
          <option value="rfc2833">RFC 2833 / 4733 (in-band RTP events)</option>
          <option value="info">SIP INFO</option>
        </select></label>
      <label class="field"><span>Codec preference</span>
        <select id="${p}_codecs">
          <option value="PCMU,PCMA">G.711 µ-law, then A-law</option>
          <option value="PCMA,PCMU">G.711 A-law, then µ-law</option>
          <option value="PCMU">G.711 µ-law only</option>
          <option value="PCMA">G.711 A-law only</option>
        </select></label>
      <label class="field"><span>Hold signalling</span>
        <select id="${p}_holdDirection">
          <option value="sendonly">a=sendonly (standard)</option>
          <option value="inactive">a=inactive</option>
        </select></label>
      <label class="field"><span>Local SIP port <em>(0 = automatic)</em></span>
        <input type="number" id="${p}_localPort" min="0" max="65535"></label>
      <label class="field"><span>Public IP override <em>(only if NAT detection fails)</em></span>
        <input type="text" id="${p}_publicAddress"></label>
      <p class="hint" data-status="${index}"></p>`;

    const set = (field, value) => { const el = $(`${p}_${field}`); if (el) el.value = value ?? ''; };
    const check = (field, value) => { const el = $(`${p}_${field}`); if (el) el.checked = !!value; };

    check('enabled', account.enabled);
    check('register', account.register);
    for (const field of ['label', 'domain', 'username', 'authUsername', 'displayName',
      'outboundProxy', 'transport', 'registerExpires', 'keepAliveSeconds', 'dtmfMode',
      'holdDirection', 'localPort', 'publicAddress']) {
      set(field, account[field]);
    }
    set('password', account.hasPassword ? '••••••••' : '');
    set('codecs', (account.codecs || ['PCMU', 'PCMA']).join(','));

    const live = state.accounts.find((a) => a.id === account.id);
    const status = panel.querySelector(`[data-status="${index}"]`);
    if (live && status) {
      const r = live.registration;
      status.textContent = r.state === 'registered'
        ? `Registered${r.expires ? ` (renews every ${r.expires}s)` : ''}`
          + `${live.publicAddress ? ` · public address ${live.publicAddress}` : ''}`
        : r.state === 'failed' ? `Registration failed: ${r.reason || 'unknown error'}`
        : r.state;
      status.classList.toggle('warn', r.state === 'failed');
    }
  });
}

function renderSettingsAudio() {
  const fill = (selectId, list, current) => {
    const select = $(selectId);
    const options = [{ id: 'default', label: 'System default' },
      ...list.filter((d) => d.id !== 'default')];
    select.innerHTML = options.map((d) =>
      `<option value="${esc(d.id)}">${esc(d.label)}</option>`).join('');
    select.value = options.some((d) => d.id === current) ? current : 'default';
  };
  fill('audioInput', devices.inputs, settings.audio.inputDeviceId);
  fill('audioOutput', devices.outputs, settings.audio.outputDeviceId);
  fill('audioRing', devices.outputs, settings.audio.ringtoneDeviceId);

  const range = (id, value, label) => {
    $(id).value = value;
    $(label).textContent = `${Math.round(value * 100)}%`;
    $(id).oninput = () => { $(label).textContent = `${Math.round($(id).value * 100)}%`; };
  };
  range('micGain', settings.audio.micGain, 'micGainValue');
  range('speakerGain', settings.audio.speakerGain, 'speakerGainValue');
  range('ringVolume', settings.audio.ringVolume, 'ringVolumeValue');

  $('echoCancellation').checked = settings.audio.echoCancellation;
  $('noiseSuppression').checked = settings.audio.noiseSuppression;
  $('autoGainControl').checked = settings.audio.autoGainControl;
}

function renderSettingsGeneral() {
  $('maxCalls').value = settings.behaviour.maxCalls;
  $('rtpPortLow').value = settings.behaviour.mediaPortRange[0];
  $('rtpPortHigh').value = settings.behaviour.mediaPortRange[1];
  $('minimiseToTray').checked = settings.behaviour.minimiseToTray;
  $('startMinimised').checked = settings.behaviour.startMinimised;
  $('incomingPopup').checked = settings.behaviour.incomingPopup !== false;
  $('sipTrace').checked = !!settings.behaviour.sipTrace;
  $('updateMode').value = (settings.updates && settings.updates.mode) || 'ask';
  $('updateUrl').value = (settings.updates && settings.updates.url) || '';

  $('encryptionHint').textContent = appInfo.encryptionAvailable
    ? 'Passwords are encrypted at rest using your operating system keyring.'
    : 'No OS keyring is available, so passwords are stored in a file readable only by your user account.';
  $('encryptionHint').classList.toggle('warn', !appInfo.encryptionAvailable);
  $('versionHint').textContent = `TwinLine ${appInfo.version} on ${appInfo.platform}`;
}

async function saveSettings() {
  const next = JSON.parse(JSON.stringify(settings));

  next.accounts.forEach((account, index) => {
    const p = `a${index}`;
    const value = (field) => { const el = $(`${p}_${field}`); return el ? el.value : account[field]; };
    const checked = (field) => { const el = $(`${p}_${field}`); return el ? el.checked : account[field]; };

    account.enabled = checked('enabled');
    account.register = checked('register');
    account.label = value('label') || `Line ${index + 1}`;
    account.domain = value('domain').trim();
    account.username = value('username').trim();
    account.authUsername = value('authUsername').trim();
    account.displayName = value('displayName');
    account.outboundProxy = value('outboundProxy').trim();
    account.transport = value('transport');
    account.registerExpires = Number(value('registerExpires')) || 300;
    account.keepAliveSeconds = Number(value('keepAliveSeconds')) || 0;
    account.dtmfMode = value('dtmfMode');
    account.codecs = value('codecs').split(',');
    account.holdDirection = value('holdDirection');
    account.localPort = Number(value('localPort')) || 0;
    account.publicAddress = value('publicAddress').trim();
    account.password = value('password');           // placeholder is kept by main
  });

  const audioChanged =
    next.audio.inputDeviceId !== $('audioInput').value ||
    next.audio.outputDeviceId !== $('audioOutput').value ||
    next.audio.ringtoneDeviceId !== $('audioRing').value ||
    next.audio.echoCancellation !== $('echoCancellation').checked ||
    next.audio.noiseSuppression !== $('noiseSuppression').checked ||
    next.audio.autoGainControl !== $('autoGainControl').checked;

  next.audio.inputDeviceId = $('audioInput').value;
  next.audio.outputDeviceId = $('audioOutput').value;
  next.audio.ringtoneDeviceId = $('audioRing').value;
  next.audio.micGain = Number($('micGain').value);
  next.audio.speakerGain = Number($('speakerGain').value);
  next.audio.ringVolume = Number($('ringVolume').value);
  next.audio.echoCancellation = $('echoCancellation').checked;
  next.audio.noiseSuppression = $('noiseSuppression').checked;
  next.audio.autoGainControl = $('autoGainControl').checked;

  next.behaviour.maxCalls = Number($('maxCalls').value) || 4;
  next.behaviour.mediaPortRange = [Number($('rtpPortLow').value), Number($('rtpPortHigh').value)];
  next.behaviour.minimiseToTray = $('minimiseToTray').checked;
  next.behaviour.startMinimised = $('startMinimised').checked;
  next.behaviour.incomingPopup = $('incomingPopup').checked;
  next.behaviour.sipTrace = $('sipTrace').checked;
  next.updates = { mode: $('updateMode').value, url: $('updateUrl').value.trim() };
  next.transcription = {
    model: $('trModel').value || 'small',
    language: $('trLanguage').value,
    autoStart: $('trAutoStart').checked,
    threads: $('trThreads').value ? Math.max(1, Math.min(16, Number($('trThreads').value) || 0)) : 0,
    catalogVersion: (settings.transcription && settings.transcription.catalogVersion) || 0,
  };

  const saved = await guard(api.settings.save(next));
  if (!saved) return;
  settings = saved;

  audio.applySettings(settings.audio);
  if (audioChanged) {
    await audio.restart();
    audio.onFrame = (frame) => api.audio.sendMicFrame(frame);
    devices = await RendererAudio.devices();
  }

  closeSettings();
  toast('Settings saved');
}

// ---- transcription ----------------------------------------------------------

/** Live and recently finished transcripts, by call id. */
const transcripts = new Map();
let shownTranscript = null;          // call id shown in the panel
let viewedTranscript = null;         // saved transcript open in the viewer
let modelsStatus = null;

function onTranscriptStarted(record) {
  transcripts.set(record.callId, { ...record, lines: record.lines || [] });
  shownTranscript = record.callId;
  renderTranscript();
}

function onTranscriptLine({ callId, line }) {
  const record = transcripts.get(callId);
  if (!record) return;
  record.lines.push(line);
  if (shownTranscript === callId) renderTranscript();
}

function onTranscriptSpeaking({ callId, speaker, speaking }) {
  const record = transcripts.get(callId);
  if (!record) return;
  record.speaking = { ...(record.speaking || {}), [speaker]: speaking };
  if (shownTranscript === callId) renderSpeaking(record);
}

function onTranscriptFinished(record) {
  const existing = transcripts.get(record.callId) || {};
  transcripts.set(record.callId, { ...existing, ...record, finished: true });
  if (shownTranscript === record.callId) renderTranscript();
  if (record.lines && record.lines.length) toast(`Transcript saved (${record.lines.length} lines)`);
}

function renderTranscript() {
  const panel = $('transcriptPanel');
  const record = shownTranscript ? transcripts.get(shownTranscript) : null;
  if (!record) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');

  $('transcriptWho').textContent = record.remoteName || record.remoteNumber || '';
  const list = $('transcriptLines');
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;

  list.innerHTML = record.lines.length
    ? record.lines.map((l) => `<li>
        <span class="t">${stamp(l.atMs)}</span>
        <span class="s ${l.speaker}">${l.speaker === 'you' ? 'You' : 'Caller'}</span>
        <span class="x">${esc(l.text)}${l.lang && l.lang !== 'en' ? `<small>${esc(l.lang)}</small>` : ''}</span>
      </li>`).join('')
    : `<li class="empty-line">${record.finished ? 'Nothing was said.' : 'Listening… lines appear when a speaker pauses.'}</li>`;
  if (atBottom) list.scrollTop = list.scrollHeight;

  $('transcriptFoot').textContent = record.finished
    ? (record.file ? `Saved as ${record.file.replace(/\.json$/, '.txt')}` : 'Finished; nothing to save.')
    : 'Recognition runs on this computer.';
  renderSpeaking(record);
}

function renderSpeaking(record) {
  const s = record.speaking || {};
  $('speakYou').classList.toggle('on', !!s.you && !record.finished);
  $('speakCaller').classList.toggle('on', !!s.caller && !record.finished);
}

function stamp(ms) {
  const s = Math.floor((ms || 0) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function transcriptToText(record) {
  return record.lines.map((l) => `[${stamp(l.atMs)}] ${l.speaker === 'you' ? 'You' : 'Caller'}: ${l.text}`).join('\n');
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); } catch (err) { toast(`Copy failed: ${err.message}`, 'error'); }
}

function copyTranscript(record) {
  if (record) copyText(transcriptToText(record));
}

async function openTranscriptFile(file) {
  const record = await guard(api.transcribe.read(file));
  if (!record) return;
  viewedTranscript = record;
  $('transcriptViewTitle').textContent = `Transcript — ${record.remoteName || record.remoteNumber || 'unknown'}`;
  $('transcriptViewText').textContent = record.text;
  $('transcriptOverlay').classList.remove('hidden');
}

async function deleteViewedTranscript() {
  if (!viewedTranscript) return;
  if (!window.confirm('Delete this transcript? This cannot be undone.')) return;
  await guard(api.transcribe.remove(viewedTranscript.file));
  $('transcriptOverlay').classList.add('hidden');
  viewedTranscript = null;
  if (!$('historyOverlay').classList.contains('hidden')) openHistory();
}

async function renderSavedTranscripts() {
  const list = await guard(api.transcribe.list()) || [];
  $('transcriptList').innerHTML = list.length
    ? list.map((t) => `<li>
        <span class="dir">&#9998;</span>
        <span class="who">${esc(t.remoteName || t.remoteNumber || 'Unknown')} <small style="color:var(--text-dim)">· ${t.lines} lines</small></span>
        <span class="when">${new Date(t.startedAt).toLocaleString()}</span>
        <button class="btn ghost small" data-tfile="${esc(t.file)}">Open</button>
      </li>`).join('')
    : '<li><span class="who" style="color:var(--text-dim)">No transcripts yet. Press <b>Transcribe</b> on a connected call.</span></li>';
  for (const b of $('transcriptList').querySelectorAll('button[data-tfile]')) {
    b.onclick = () => openTranscriptFile(b.dataset.tfile);
  }
}

// -- settings tab

async function renderSettingsTranscription() {
  const t = settings.transcription || {};
  modelsStatus = await guard(api.models.status());
  const status = await guard(api.transcribe.status());

  const select = $('trModel');
  const current = select.value || t.model || 'small';
  select.innerHTML = (modelsStatus ? modelsStatus.models : []).map((m) =>
    `<option value="${esc(m.id)}">${esc(m.label)} — ~${m.approxMB} MB${m.installed ? ' ✓' : ''}</option>`).join('');
  select.value = current;
  $('trLanguage').value = t.language || 'auto';
  $('trAutoStart').checked = !!t.autoStart;
  $('trThreads').value = t.threads > 0 ? t.threads : '';
  renderModelRows();
  renderLanguageField();
  select.onchange = () => { renderModelRows(); renderLanguageField(); };

  if (status) {
    $('trStatus').textContent = {
      off: status.available ? 'Ready. The engine starts when a transcript is requested.' : 'Download a speech model above to enable transcription.',
      starting: 'Speech engine starting…',
      ready: `Speech engine running${status.active.length ? ` — transcribing ${status.active.length} call(s)` : ''}.`,
      error: `Speech engine error: ${status.error}`,
    }[status.state] || '';
    $('trStatus').classList.toggle('warn', status.state === 'error');
  }
}

/** Parakeet recognises 25 languages in one pass; the pin-a-language option only means something for Whisper. */
function renderLanguageField() {
  if (!modelsStatus) return;
  const chosen = modelsStatus.models.find((m) => m.id === $('trModel').value);
  const whisper = chosen && chosen.type === 'whisper';
  $('trLanguage').disabled = !whisper;
  $('trLanguageHint').textContent = whisper ? '' : '(handled automatically by this model)';
}

function renderModelRows() {
  if (!modelsStatus) return;
  const chosen = $('trModel').value;
  const rows = modelsStatus.models.filter((m) => m.id === chosen || m.installed || m.downloading);
  $('trModelRows').innerHTML = rows.map((m) => {
    const p = m.progress;
    const action = m.downloading
      ? `<span class="bar"><span style="width:${p ? p.percent : 0}%"></span></span>
         <span style="color:var(--text-dim)">${p && p.total ? `${Math.round(p.received / 1e6)} / ${Math.round(p.total / 1e6)} MB` : '…'}</span>
         <button class="btn ghost small" data-mcancel="${esc(m.id)}">Cancel</button>`
      : m.installed
        ? `<span class="tag green">Installed · ${m.sizeOnDiskMB} MB</span>
           <button class="btn ghost small" data-mremove="${esc(m.id)}" title="Delete the model files">Remove</button>`
        : `<button class="btn primary small" data-mdownload="${esc(m.id)}">Download ~${m.approxMB} MB</button>`;
    return `<div class="model-row" data-model="${esc(m.id)}">
      <span class="name">whisper-${esc(m.id)}<small>${esc(m.label)}</small></span>${action}
    </div>`;
  }).join('') + (modelsStatus.vadInstalled || modelsStatus.vadDownloading ? '' :
    '<p class="hint">The 1 MB voice-activity detector is fetched together with the model.</p>');

  const root = $('trModelRows');
  for (const b of root.querySelectorAll('[data-mdownload]')) b.onclick = () => { guard(api.models.download(b.dataset.mdownload)); renderSettingsTranscription(); };
  for (const b of root.querySelectorAll('[data-mcancel]')) b.onclick = () => guard(api.models.cancel(b.dataset.mcancel)).then(renderSettingsTranscription);
  for (const b of root.querySelectorAll('[data-mremove]')) b.onclick = () => {
    if (window.confirm(`Remove the whisper-${b.dataset.mremove} model files?`)) guard(api.models.remove(b.dataset.mremove)).then(renderSettingsTranscription);
  };
}

function onModelProgress(p) {
  if ($('settingsOverlay').classList.contains('hidden')) return;
  if (p.done) { renderSettingsTranscription(); return; }
  const row = document.querySelector(`.model-row[data-model="${CSS.escape(p.id)}"]`);
  if (!row) { renderSettingsTranscription(); return; }
  const bar = row.querySelector('.bar span');
  const label = row.querySelector('.bar + span');
  if (bar) bar.style.width = `${p.percent || 0}%`;
  if (label && p.total) label.textContent = `${Math.round(p.received / 1e6)} / ${Math.round(p.total / 1e6)} MB`;
}

// ---- updates ----------------------------------------------------------------

let updateStatus = null;

function renderUpdate(status) {
  updateStatus = status;
  const banner = $('updateBanner');
  const settingsLine = $('updateStatus');
  const v = esc(status.version || '');
  const current = esc(status.current || '');

  const button = (action, label, cls = 'btn small') =>
    `<button class="${cls}" data-update="${action}">${label}</button>`;
  let html = null;
  let cls = '';

  switch (status.state) {
    case 'available':
      html = `<span class="text">TwinLine <b>${v}</b> is available (you have ${current}).</span>`
        + (status.notes ? button('notes', "What's new", 'btn ghost small') : '')
        + button('download', status.manualDownloadUrl ? 'Download page' : 'Download', 'btn primary small')
        + button('dismiss', 'Later', 'btn ghost small');
      break;
    case 'downloading': {
      const pct = Math.round((status.progress && status.progress.percent) || 0);
      html = `<span class="text">Downloading TwinLine <b>${v}</b>… ${pct}%</span>`
        + `<span class="bar"><span style="width:${pct}%"></span></span>`;
      break;
    }
    case 'downloaded':
      html = `<span class="text">TwinLine <b>${v}</b> is ready to install.</span>`
        + button('install', 'Restart and update', 'btn primary small')
        + button('dismiss', 'On next quit', 'btn ghost small');
      break;
    case 'error':
      cls = 'error';
      html = `<span class="text">Update check failed: ${esc(status.error || 'unknown error')}</span>`
        + button('dismiss', 'Dismiss', 'btn ghost small');
      break;
    default:
      html = null;
  }

  banner.className = `update-banner ${cls} ${html ? '' : 'hidden'}`.trim();
  banner.innerHTML = html || '';
  for (const b of banner.querySelectorAll('button[data-update]')) b.onclick = () => onUpdateAction(b.dataset.update);

  // The same actions inside Settings, so "check → download → restart" never
  // requires closing the dialog to reach the banner.
  const actions = $('updateActions');
  if (actions) {
    let extra = '';
    if (status.state === 'available') extra = button('download', status.manualDownloadUrl ? 'Download page' : `Download ${v}`, 'btn primary small');
    else if (status.state === 'downloaded') extra = button('install', `Restart and install ${v}`, 'btn primary small');
    else if (status.state === 'downloading') extra = `<span class="bar" style="width:120px;height:6px;border-radius:3px;background:var(--bg-input);overflow:hidden;display:inline-block;vertical-align:middle"><span style="display:block;height:100%;width:${Math.round((status.progress && status.progress.percent) || 0)}%;background:var(--accent)"></span></span>`;
    actions.innerHTML = `<button type="button" class="btn small" id="btnCheckUpdates" ${status.state === 'checking' ? 'disabled' : ''}>Check for updates now</button>${extra}`;
    $('btnCheckUpdates').onclick = async () => {
      $('updateStatus').textContent = 'Checking…';
      const s = await guard(api.updates.check());
      if (s) renderUpdate(s);
    };
    for (const b of actions.querySelectorAll('button[data-update]')) b.onclick = () => onUpdateAction(b.dataset.update);
  }

  if (settingsLine) {
    const when = status.lastCheck ? ` Last checked ${new Date(status.lastCheck).toLocaleTimeString()}.` : '';
    settingsLine.textContent = {
      idle: `Version ${current}.${when}`,
      checking: 'Checking…',
      available: `Version ${v} is available.`,
      downloading: `Downloading ${v}…`,
      downloaded: `Version ${v} downloaded; restart to install.`,
      'up-to-date': `Version ${current} is the latest.${when}`,
      error: `Version ${current}. ${status.error || ''}`,
      disabled: status.error || 'Updates are disabled.',
      unsupported: 'Automatic updates are not available for this package.',
    }[status.state] || `Version ${current}.`;
  }
}

async function onUpdateAction(action) {
  switch (action) {
    case 'download': return guard(api.updates.download());
    case 'install': {
      const result = await guard(api.updates.install());
      if (result && !result.ok) toast(result.reason, 'warn');
      return result;
    }
    case 'dismiss': return guard(api.updates.dismiss());
    case 'notes':
      toast(`What's new in ${updateStatus.version}:\n${updateStatus.notes}`.slice(0, 600));
      return null;
    default: return null;
  }
}

// ---- contacts ---------------------------------------------------------------

let contacts = [];
let editingContactId = null;

async function openContacts() {
  contacts = await guard(api.contacts.list()) || [];
  hideContactForm();
  renderContacts();
  $('contactsOverlay').classList.remove('hidden');
  $('contactSearch').focus();
}

function renderContacts() {
  const query = $('contactSearch').value.trim().toLowerCase();
  const digits = query.replace(/\D/g, '');
  const list = contacts.filter((c) => !query
    || c.name.toLowerCase().includes(query)
    || (c.company || '').toLowerCase().includes(query)
    || (digits && c.number.replace(/\D/g, '').includes(digits)));

  $('contactCount').textContent = String(contacts.length);
  $('contactList').innerHTML = list.length
    ? list.map((c) => {
        const line = state.accounts.find((a) => a.id === c.accountId);
        return `<li data-id="${esc(c.id)}">
          <span class="avatar">${esc(initials(c.name))}</span>
          <span class="who">
            <span class="n">${esc(c.name)}</span>
            <span class="d">${esc(c.number)}${c.company ? ` · ${esc(c.company)}` : ''}${line ? ` · ${esc(line.label)}` : ''}</span>
          </span>
          <span class="row-actions">
            <button class="btn ghost small" data-cedit="${esc(c.id)}" title="Edit">Edit</button>
            <button class="btn ghost small" data-cdel="${esc(c.id)}" title="Delete">&#10005;</button>
          </span>
          <button class="btn call small" data-cdial="${esc(c.id)}" ${c.number ? '' : 'disabled'}>Call</button>
        </li>`;
      }).join('')
    : `<li><span class="who"><span class="d">${contacts.length ? 'No matches.' : 'No contacts yet. Add one, or import a CSV, JSON or vCard file.'}</span></span></li>`;

  const root = $('contactList');
  for (const b of root.querySelectorAll('[data-cdial]')) b.onclick = () => dialContact(b.dataset.cdial);
  for (const b of root.querySelectorAll('[data-cedit]')) b.onclick = () => editContact(b.dataset.cedit);
  for (const b of root.querySelectorAll('[data-cdel]')) b.onclick = () => deleteContact(b.dataset.cdel);
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

async function dialContact(id) {
  const contact = contacts.find((c) => c.id === id);
  if (!contact || !contact.number) return;
  $('contactsOverlay').classList.add('hidden');
  await startAudio();
  // The contact's preferred line wins over the dropdown when it is available.
  const accountId = contact.accountId && state.accounts.some((a) => a.id === contact.accountId)
    ? contact.accountId
    : ($('dialAccount').value || undefined);
  await guard(api.call.dial(contact.number, accountId));
}

function editContact(id) {
  const contact = id ? contacts.find((c) => c.id === id) : null;
  editingContactId = contact ? contact.id : null;

  const select = $('cfAccount');
  select.innerHTML = '<option value="">Any line</option>'
    + state.accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.label)}</option>`).join('');

  $('cfName').value = contact ? contact.name : '';
  $('cfNumber').value = contact ? contact.number : $('dialInput').value.trim();
  $('cfCompany').value = contact ? contact.company : '';
  $('cfEmail').value = contact ? contact.email : '';
  $('cfNotes').value = contact ? contact.notes : '';
  select.value = contact && contact.accountId ? contact.accountId : '';

  $('contactForm').classList.remove('hidden');
  $('cfName').focus();
}

function hideContactForm() {
  editingContactId = null;
  $('contactForm').classList.add('hidden');
}

async function saveContact(event) {
  event.preventDefault();
  const payload = {
    name: $('cfName').value,
    number: $('cfNumber').value,
    company: $('cfCompany').value,
    email: $('cfEmail').value,
    notes: $('cfNotes').value,
    accountId: $('cfAccount').value,
  };
  const saved = await guard(editingContactId
    ? api.contacts.update(editingContactId, payload)
    : api.contacts.add(payload));
  if (!saved) return;
  contacts = await api.contacts.list();
  hideContactForm();
  renderContacts();
  refreshState();
}

async function deleteContact(id) {
  const contact = contacts.find((c) => c.id === id);
  if (!contact) return;
  if (!window.confirm(`Delete ${contact.name}?`)) return;
  await guard(api.contacts.remove(id));
  contacts = await api.contacts.list();
  renderContacts();
  refreshState();
}

async function importContacts() {
  const result = await guard(api.contacts.import());
  if (!result || result.canceled) return;
  contacts = await api.contacts.list();
  renderContacts();
  refreshState();
  toast(`Imported ${result.added} new, updated ${result.updated}${result.skipped ? `, skipped ${result.skipped}` : ''}`);
}

async function exportContacts(format) {
  const result = await guard(api.contacts.export(format));
  if (!result || result.canceled) return;
  toast(`Exported ${result.count} contacts`);
}

/** Pull a fresh snapshot so contact names on live calls update. */
async function refreshState() {
  const snapshot = await guard(api.state.get());
  if (snapshot) { state = snapshot; renderAll(); }
}

// ---- toasts -----------------------------------------------------------------

const MAX_TOASTS = 4;

/**
 * Show a message. A repeat of a message that is still on screen bumps a
 * counter on it instead of stacking — an error that fires every second
 * should read "×37", not bury the dialler.
 */
function toast(message, kind = '') {
  const stack = $('toasts');
  const existing = [...stack.children].find((el) => el.dataset.message === message);
  const ttl = kind === 'error' ? 7000 : 4000;

  if (existing) {
    const count = (Number(existing.dataset.count) || 1) + 1;
    existing.dataset.count = String(count);
    existing.textContent = `${message}  ×${count}`;
    clearTimeout(Number(existing.dataset.timer));
    existing.dataset.timer = String(setTimeout(() => existing.remove(), ttl));
    return;
  }

  while (stack.children.length >= MAX_TOASTS) stack.firstElementChild.remove();

  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.dataset.message = message;
  el.dataset.count = '1';
  el.textContent = message;
  el.onclick = () => el.remove();
  stack.append(el);
  el.dataset.timer = String(setTimeout(() => el.remove(), ttl));
}

boot().catch((err) => {
  document.body.innerHTML = `<pre style="padding:16px;color:#e5484d">Failed to start: ${esc(err.stack || err.message)}</pre>`;
});
