'use strict';
/**
 * Incoming-call popup. Shows every ringing call; the main process closes the
 * window once nothing is ringing any more.
 */

const api = window.twinline;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function render({ calls, accounts }) {
  const root = document.getElementById('calls');
  root.innerHTML = calls.slice(0, 3).map((call) => {
    const account = accounts.find((a) => a.id === call.accountId);
    const name = call.contactName || call.remoteName;
    return `<section class="call" data-call="${esc(call.id)}">
      <div class="who">
        <div class="name">${esc(name || call.remoteNumber || 'Unknown caller')}</div>
        ${name ? `<div class="number">${esc(call.remoteNumber)}</div>` : ''}
        <div class="line">on ${esc(account ? account.label : call.accountId)}</div>
      </div>
      <div class="actions">
        <button class="answer" data-action="answer">Answer</button>
        <button class="decline" data-action="decline">Decline</button>
      </div>
    </section>`;
  }).join('');

  for (const button of root.querySelectorAll('button[data-action]')) {
    button.onclick = () => {
      const callId = button.closest('.call').dataset.call;
      button.disabled = true;
      const action = button.dataset.action === 'answer'
        ? api.call.answer(callId)
        : api.call.reject(callId, 486);
      action.catch(() => { button.disabled = false; });
    };
  }
}

api.on.popupCalls(render);

document.addEventListener('keydown', (e) => {
  const first = document.querySelector('.call');
  if (!first) return;
  if (e.key === 'Enter') first.querySelector('[data-action="answer"]').click();
  if (e.key === 'Escape') first.querySelector('[data-action="decline"]').click();
});
