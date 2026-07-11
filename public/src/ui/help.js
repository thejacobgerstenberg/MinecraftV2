// Loomfall UI — "How to Play" panel (renders content/GAME_GUIDE.md).
//
// Pure DOM module: no three.js import. Fetches the guide markdown once and
// renders it with a deliberately small, sanitized markdown-to-HTML pass:
// headings (#/##/###), bold (**text**), unordered/ordered lists, plus
// fenced code blocks and tables rendered as monospace <pre> so recipes stay
// readable. All source text is escaped BEFORE any tags are generated, so no
// markup from the file (or a tampered file) can reach the DOM as HTML.
//
// API:
//   initHelp() -> { open(), close(), isOpen() }

const GUIDE_URL = '/content/GAME_GUIDE.md';

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Inline pass over an ALREADY-ESCAPED line: **bold** and `code`. */
function inline(md) {
  return md
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/**
 * Tiny markdown renderer (headings/bold/lists + pre for code/tables).
 * Input is raw markdown; output is safe HTML (everything escaped first).
 */
export function renderMarkdown(md) {
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol' | null
  let para = [];
  let fence = null; // array of code lines when inside ``` fence
  let table = null; // array of table lines

  function closeList() {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  }
  function closePara() {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  }
  function closeTable() {
    if (table) {
      out.push(`<pre class="help-table">${table.join('\n')}</pre>`);
      table = null;
    }
  }

  for (const rawLine of lines) {
    const line = escapeHtml(rawLine);

    if (fence) {
      if (/^```/.test(rawLine)) {
        out.push(`<pre class="help-code">${fence.join('\n')}</pre>`);
        fence = null;
      } else {
        fence.push(line);
      }
      continue;
    }
    if (/^```/.test(rawLine)) {
      closePara();
      closeList();
      closeTable();
      fence = [];
      continue;
    }

    if (/^\s*\|/.test(rawLine)) {
      closePara();
      closeList();
      if (!table) table = [];
      if (!/^\s*\|[\s\-|:]+\|\s*$/.test(rawLine)) table.push(line); // skip |---| rows
      continue;
    }
    closeTable();

    const h = /^(#{1,3})\s+(.*)$/.exec(rawLine);
    if (h) {
      closePara();
      closeList();
      out.push(`<h${h[1].length + 1}>${inline(escapeHtml(h[2]))}</h${h[1].length + 1}>`);
      continue;
    }

    const ul = /^\s*[-*]\s+(.*)$/.exec(rawLine);
    const ol = /^\s*\d+\.\s+(.*)$/.exec(rawLine);
    if (ul || ol) {
      closePara();
      const want = ul ? 'ul' : 'ol';
      if (list !== want) {
        closeList();
        out.push(`<${want}>`);
        list = want;
      }
      out.push(`<li>${inline(escapeHtml((ul || ol)[1]))}</li>`);
      continue;
    }

    if (/^\s*$/.test(rawLine)) {
      closePara();
      closeList();
      continue;
    }

    closeList();
    para.push(line);
  }
  closePara();
  closeList();
  closeTable();
  if (fence) out.push(`<pre class="help-code">${fence.join('\n')}</pre>`);
  return out.join('\n');
}

export function initHelp() {
  const root = document.createElement('div');
  root.className = 'overlay help-overlay';
  document.body.appendChild(root);

  const panel = document.createElement('div');
  panel.className = 'vx-panel help-panel';
  root.appendChild(panel);

  const head = document.createElement('div');
  head.className = 'help-head';
  panel.appendChild(head);
  const title = document.createElement('h2');
  title.className = 'menu-h2';
  title.textContent = 'How to Play';
  head.appendChild(title);

  const body = document.createElement('div');
  body.className = 'help-body';
  body.textContent = 'Loading the guide…';
  panel.appendChild(body);

  const nav = document.createElement('div');
  nav.className = 'menu-buttons menu-buttons--row';
  panel.appendChild(nav);
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'vx-btn vx-btn--primary';
  back.textContent = 'Back';
  nav.appendChild(back);

  let openState = false;
  let onCloseCb = null;
  let loaded = false;

  async function ensureGuide() {
    if (loaded) return;
    try {
      const res = await fetch(GUIDE_URL);
      if (!res.ok) throw new Error(`GET ${GUIDE_URL} -> ${res.status}`);
      const md = await res.text();
      body.innerHTML = renderMarkdown(md); // safe: fully escaped upstream
      loaded = true;
    } catch (err) {
      body.textContent = 'The guide could not be loaded.';
      console.warn('[loomfall] GAME_GUIDE.md unavailable:', err && err.message);
    }
  }

  function open(onClose) {
    onCloseCb = typeof onClose === 'function' ? onClose : null;
    openState = true;
    root.classList.add('visible');
    ensureGuide();
    body.scrollTop = 0;
  }

  function close() {
    openState = false;
    root.classList.remove('visible');
    const cb = onCloseCb;
    onCloseCb = null;
    if (cb) cb();
  }

  back.addEventListener('click', close);

  return { open, close, isOpen: () => openState };
}
