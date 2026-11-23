// Front-end for ChaiCode Mentors. Talks to server.js: GET /api/personas, POST /api/chat, POST /api/reset.

const $ = (id) => document.getElementById(id);

const els = {
  picker: $('picker'),
  mentors: $('mentors'),
  chat: $('chat'),
  log: $('log'),
  name: $('chat-name'),
  monogram: $('chat-monogram'),
  form: $('composer'),
  input: $('input'),
  send: $('send'),
  back: $('back'),
  newChat: $('new-chat'),
};

const state = {
  personas: {},
  current: null, // persona object
  sessionId: crypto.randomUUID(),
  history: {}, // personaId -> [{ role, text, videos }] so switching mentors keeps each chat
  busy: false,
};

const firstName = (p) => p.name.split(' ')[0];

// ---------- Safe text rendering ----------
const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Escapes first, then adds code blocks, inline code, links and paragraphs.
function formatReply(text) {
  const blocks = [];
  let safe = escapeHtml(text).replace(/```(\w*)\n?([\s\S]*?)```/g, (_, _lang, code) => {
    blocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });

  safe = safe
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/(https?:\/\/[^\s<]+[^\s<.,!?)])/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');

  return safe
    .split(/\n{2,}/)
    .map((para) => {
      const only = para.trim().match(/^\u0000(\d+)\u0000$/);
      if (only) return blocks[only[1]];
      return `<p>${para.replace(/\n/g, '<br>')}</p>`;
    })
    .join('')
    .replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[i]);
}

// ---------- Picker ----------
function renderMentors() {
  els.mentors.innerHTML = '';
  for (const p of Object.values(state.personas)) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'mentor';
    tile.dataset.id = p.id;
    tile.innerHTML = `
      <div class="mentor-top">
        <span class="monogram" aria-hidden="true">${escapeHtml(p.initials)}</span>
        <div>
          <h2 class="mentor-name">${escapeHtml(p.name)}</h2>
          <p class="mentor-tagline">${escapeHtml(p.tagline)}</p>
        </div>
      </div>
      <p class="mentor-sample">“${escapeHtml(p.sample)}”</p>
      <span class="mentor-cta">Chat with ${escapeHtml(firstName(p))}</span>`;
    tile.addEventListener('click', () => openChat(p.id));
    els.mentors.append(tile);
  }
}

function showPicker() {
  delete document.body.dataset.persona;
  els.chat.hidden = true;
  els.picker.hidden = false;
  state.current = null;
  els.mentors.querySelector('.mentor')?.focus();
}

// ---------- Chat ----------
function openChat(personaId) {
  const p = state.personas[personaId];
  state.current = p;
  state.history[p.id] ??= [];

  document.body.dataset.persona = p.id;
  els.name.textContent = p.name;
  els.monogram.textContent = p.initials;
  els.input.placeholder = `${firstName(p)} se kuch bhi poocho…`;

  els.picker.hidden = true;
  els.chat.hidden = false;
  renderLog();
  els.input.focus();
}

function renderLog() {
  const p = state.current;
  const items = state.history[p.id];
  els.log.innerHTML = '';

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = `
      <p class="empty-hello">${escapeHtml(p.sample.split(/[.!?]/)[0])}!</p>
      <p class="empty-hint">Ask ${escapeHtml(firstName(p))} anything, or start with one of these:</p>
      <div class="starters"></div>`;
    const starters = empty.querySelector('.starters');
    for (const q of p.starters) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'starter';
      chip.textContent = q;
      chip.addEventListener('click', () => ask(q));
      starters.append(chip);
    }
    els.log.append(empty);
    return;
  }

  items.forEach((item) => els.log.append(messageEl(item)));
  scrollToEnd();
}

function messageEl({ role, text, videos = [] }) {
  const el = document.createElement('div');
  if (role === 'user') {
    el.className = 'msg msg-user';
    el.textContent = text;
    return el;
  }

  el.className = 'msg msg-mentor';
  el.innerHTML = formatReply(text);

  if (videos.length) {
    const list = document.createElement('div');
    list.className = 'videos';
    for (const v of videos) list.append(videoEl(v));
    el.append(list);
  }
  return el;
}

function videoEl(v) {
  const a = document.createElement('a');
  a.className = 'video';
  a.href = v.url;
  a.target = '_blank';
  a.rel = 'noopener';
  const play = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="rgba(0,0,0,.55)"/><path d="M10 8l6 4-6 4z" fill="#fff"/></svg>`;
  a.innerHTML = `
    <span class="video-thumb">${v.thumbnail ? `<img src="${escapeHtml(v.thumbnail)}" alt="" loading="lazy">` : ''}${play}</span>
    <span>
      <p class="video-title">${escapeHtml(v.title)}</p>
      <p class="video-meta">${escapeHtml(v.channel || 'YouTube')}${v.thumbnail ? '' : ' channel'}</p>
    </span>`;
  return a;
}

function typingEl() {
  const el = document.createElement('div');
  el.className = 'typing';
  el.innerHTML = `<span class="dots" aria-hidden="true"><span></span><span></span><span></span></span>
    <span>${escapeHtml(firstName(state.current))} likh rahe hain…</span>`;
  return el;
}

function errorEl(message, retryText) {
  const el = document.createElement('div');
  el.className = 'msg-error';
  el.innerHTML = `<span>${escapeHtml(message)}</span>`;
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'ghost-btn';
  retry.textContent = 'Try again';
  retry.addEventListener('click', () => {
    el.remove();
    ask(retryText, { retry: true });
  });
  el.append(retry);
  return el;
}

function scrollToEnd() {
  els.log.scrollTop = els.log.scrollHeight;
}

function setBusy(busy) {
  state.busy = busy;
  els.send.disabled = busy || !els.input.value.trim();
}

async function ask(text, { retry = false } = {}) {
  const p = state.current;
  const message = text.trim();
  if (!message || state.busy) return;

  const items = state.history[p.id];
  if (!retry) {
    if (!items.length) els.log.innerHTML = ''; // clear the empty state
    items.push({ role: 'user', text: message });
    els.log.append(messageEl({ role: 'user', text: message }));
  }

  els.input.value = '';
  autoGrow();
  setBusy(true);
  const typing = typingEl();
  els.log.append(typing);
  scrollToEnd();

  // The live bubble that fills up as text streams in.
  let bubble = null;
  let streamed = '';
  let frame = 0;
  const isHere = () => state.current?.id === p.id;

  const paint = () => {
    frame = 0;
    if (!isHere()) return;
    const nearBottom = els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 80;
    if (!bubble) {
      typing.remove();
      bubble = document.createElement('div');
      bubble.className = 'msg msg-mentor streaming';
      els.log.append(bubble);
    }
    bubble.innerHTML = formatReply(streamed);
    if (nearBottom) scrollToEnd();
  };

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId, personaId: p.id, message }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Server error ${res.status}`);
    }

    // Read NDJSON lines as they arrive.
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    let final = null;

    while (!final) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;

      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;

        const event = JSON.parse(line);
        if (event.type === 'delta') {
          streamed += event.text;
          frame ||= requestAnimationFrame(paint); // repaint at most once per frame
        } else if (event.type === 'done') {
          final = event;
        } else if (event.type === 'error') {
          throw new Error(event.error);
        }
      }
    }
    if (!final) throw new Error('The reply stopped halfway. Try again.');

    cancelAnimationFrame(frame);
    const reply = { role: 'mentor', text: final.text, videos: final.videos || [] };
    items.push(reply);
    if (isHere()) {
      // Swap the streamed draft for the final, cleaned reply plus its video cards.
      const finished = messageEl(reply);
      finished.style.animation = 'none';
      if (bubble) bubble.replaceWith(finished);
      else {
        typing.remove();
        els.log.append(finished);
      }
    }
  } catch (error) {
    cancelAnimationFrame(frame);
    typing.remove();
    bubble?.remove();
    const msg = error instanceof TypeError ? "Couldn't reach the server. Check that it's running." : error.message;
    if (isHere()) els.log.append(errorEl(msg, message));
  } finally {
    setBusy(false);
    scrollToEnd();
    els.input.focus();
  }
}

async function newChat() {
  const p = state.current;
  if (state.busy) return;
  state.history[p.id] = [];
  await fetch('/api/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: state.sessionId, personaId: p.id }),
  }).catch(() => {});
  renderLog();
  els.input.focus();
}

// ---------- Composer ----------
function autoGrow() {
  els.input.style.height = 'auto';
  els.input.style.height = `${Math.min(els.input.scrollHeight, 180)}px`;
}

els.input.addEventListener('input', () => {
  autoGrow();
  els.send.disabled = state.busy || !els.input.value.trim();
});

els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    ask(els.input.value);
  }
});

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  ask(els.input.value);
});

els.back.addEventListener('click', showPicker);
els.newChat.addEventListener('click', newChat);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.chat.hidden && !state.busy) showPicker();
});

// ---------- Start ----------
async function init() {
  try {
    const res = await fetch('/api/personas');
    const data = await res.json();
    for (const p of data.personas) state.personas[p.id] = p;
    renderMentors();
    setBusy(false);
  } catch {
    els.mentors.innerHTML = `<p class="msg-error">Couldn't load mentors. Start the server with <code>npm run web</code> and refresh.</p>`;
  }
}

init();
