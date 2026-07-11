// Voxelheim UI — chat: bottom-left log + input row.
//
// Pure DOM module: no three.js import. All DOM access happens inside
// initChat(), so the module is safe to import under plain node.
//
// API:
//   initChat({ onSend }) -> { open(), close(), isOpen(), addMessage(msg) }
//     addMessage({ name, text, system }) — appends a line (newest at bottom).
//       Player lines render "<name> text"; system lines render italic amber.
//     Lines fade out ~8s after arriving, but stay in a 50-line scrollback
//     that is fully visible (and scrollable) while the chat is open.
//     Input row is only visible while open. Enter sends (via onSend(text))
//     and closes; Escape closes without sending.

const FADE_MS = 8000;
const SCROLLBACK = 50;

export function initChat({ onSend } = {}) {
  let root = document.getElementById('chat');
  if (!root) {
    root = document.createElement('div');
    root.id = 'chat';
    document.body.appendChild(root);
  }
  root.classList.add('chat');
  root.textContent = '';

  const log = document.createElement('div');
  log.className = 'chat-log';
  root.appendChild(log);

  const inputRow = document.createElement('div');
  inputRow.className = 'chat-input-row';
  const prompt = document.createElement('span');
  prompt.className = 'chat-prompt';
  prompt.textContent = '>';
  const input = document.createElement('input');
  input.className = 'chat-input';
  input.type = 'text';
  input.maxLength = 256;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'Say something…';
  inputRow.append(prompt, input);
  root.appendChild(inputRow);

  let openState = false;
  const lines = []; // { el, timer }

  function scrollToBottom() {
    log.scrollTop = log.scrollHeight;
  }

  function addMessage({ name, text, system } = {}) {
    const line = document.createElement('div');
    line.className = 'chat-line';
    if (system) {
      line.classList.add('chat-line--system');
      line.textContent = String(text ?? '');
    } else {
      const nameEl = document.createElement('span');
      nameEl.className = 'chat-name';
      nameEl.textContent = `<${name ?? '???'}>`;
      line.appendChild(nameEl);
      line.appendChild(document.createTextNode(String(text ?? '')));
    }
    log.appendChild(line);

    const timer = setTimeout(() => line.classList.add('chat-line--faded'), FADE_MS);
    lines.push({ el: line, timer });
    while (lines.length > SCROLLBACK) {
      const old = lines.shift();
      clearTimeout(old.timer);
      old.el.remove();
    }
    scrollToBottom();
  }

  function open() {
    openState = true;
    root.classList.add('chat--open');
    input.value = '';
    scrollToBottom();
    input.focus();
  }

  function close() {
    openState = false;
    root.classList.remove('chat--open');
    input.value = '';
    input.blur();
    scrollToBottom();
  }

  function isOpen() {
    return openState;
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      const text = input.value.trim();
      if (text && typeof onSend === 'function') onSend(text);
      close();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // don't let Escape also trigger the pause menu
      close();
    }
  });

  return { open, close, isOpen, addMessage };
}
