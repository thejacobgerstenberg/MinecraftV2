// Loomfall UI — death ("unpicked") screen.
//
// Pure DOM module: no three.js import. Shown when the player's health
// reaches 0: darkened red-black overlay, a canon death message templated
// from content/deathmessages.json (the caller passes the final text), and a
// Respawn button that hands control back to the caller.
//
// API:
//   initDeathScreen({ onRespawn }) -> { show(message), hide(), isShowing() }

export function initDeathScreen({ onRespawn } = {}) {
  const root = document.createElement('div');
  root.className = 'overlay death-overlay';
  document.body.appendChild(root);

  const panel = document.createElement('div');
  panel.className = 'death-panel';
  root.appendChild(panel);

  const title = document.createElement('h2');
  title.className = 'death-title';
  title.textContent = 'You were unpicked.';
  panel.appendChild(title);

  const messageEl = document.createElement('p');
  messageEl.className = 'death-message';
  panel.appendChild(messageEl);

  const buttons = document.createElement('div');
  buttons.className = 'menu-buttons';
  panel.appendChild(buttons);

  const respawnBtn = document.createElement('button');
  respawnBtn.type = 'button';
  respawnBtn.className = 'vx-btn vx-btn--primary vx-btn--big';
  respawnBtn.textContent = 'Re-stitch at your knot';
  buttons.appendChild(respawnBtn);

  let showing = false;

  respawnBtn.addEventListener('click', () => {
    if (!showing) return;
    hide();
    if (typeof onRespawn === 'function') onRespawn();
  });

  function show(message) {
    messageEl.textContent = String(message || 'You came loose from the pattern.');
    showing = true;
    root.classList.add('visible');
    respawnBtn.focus?.();
  }

  function hide() {
    showing = false;
    root.classList.remove('visible');
  }

  return { show, hide, isShowing: () => showing };
}
