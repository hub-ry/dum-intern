export function createPairView({ draft = '', onDraft }) {
  const view = document.createElement('section');
  view.className = 'pair-view';
  view.setAttribute('aria-label', 'Pair programming');
  view.innerHTML = `
    <section class="pair-screen-column" aria-label="Dum's screen">
      <div class="pair-screen-caption">
        <h2 class="pair-heading">Dum's screen</h2>
        <span class="pair-connection">Offline</span>
      </div>
      <div class="pair-screen">
        <p class="pair-screen-state">Screen offline</p>
      </div>
      <div class="pair-progress">
        <img class="pair-dum" width="56" height="64" alt="Dum, a small amber pixel intern with two antennae">
        <p class="pair-progress-title">Dum is offline.</p>
        <p class="pair-progress-detail">No session connected.</p>
      </div>
    </section>
    <section class="pair-messages" aria-label="Message Dum">
      <h2 class="pair-heading">Message Dum</h2>
      <label class="pair-draft-label">
        Message draft
        <textarea class="pair-draft" rows="7" placeholder="Write a note for Dum…"></textarea>
      </label>
      <button class="pair-send" type="button" disabled>Send</button>
      <p class="pair-send-note">Sending is unavailable while Dum is offline. This draft stays here while you switch tabs.</p>
    </section>
  `;
  view.querySelector('.pair-dum').src = new URL('./dum.svg', import.meta.url).href;
  const textarea = view.querySelector('.pair-draft');
  textarea.value = draft;
  textarea.addEventListener('input', () => onDraft(textarea.value));
  return view;
}
