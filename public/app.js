// Fleet Analyst chat. Each browser tab keeps its own conversation in sessionStorage;
// `context` is what the server needs to understand follow-up questions.

const STORE_KEY = 'analyst-chat-v3';
const MAX_MESSAGES = 60;

const messagesEl = document.getElementById('messages');
const welcomeEl = document.getElementById('welcome');
const form = document.getElementById('chat-form');
const input = document.getElementById('prompt');
const sendBtn = document.getElementById('send');

let chat = loadChat();
let pending = null; // AbortController of the question being answered

function loadChat() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORE_KEY));
    if (saved && Array.isArray(saved.messages)) return saved;
  } catch { /* missing or corrupted */ }
  return { messages: [], context: null };
}

function saveChat() {
  chat.messages = chat.messages.slice(-MAX_MESSAGES);
  try { sessionStorage.setItem(STORE_KEY, JSON.stringify(chat)); } catch { /* storage full */ }
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The small subset of markdown the answers use: bold, italics, code, lists, headings, tables. */
function renderMarkdown(text) {
  const inline = s => escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])_(\S(?:.*?\S)?)_(?=[\s).,!?]|$)/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');

  let html = '';
  let list = false;
  let table = null; // rows of cells

  const flushTable = () => {
    if (!table) return;
    const [head, ...body] = table;
    html += '<div class="table-wrap"><table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'
      + body.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table></div>';
    table = null;
  };
  const closeList = () => { if (list) { html += '</ul>'; list = false; } };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('|') && line.endsWith('|')) {
      closeList();
      if (/^\|(\s*:?-+:?\s*\|)+$/.test(line)) continue; // separator row
      (table ??= []).push(line.slice(1, -1).split('|').map(c => c.trim()));
      continue;
    }
    flushTable();
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (heading) { closeList(); html += `<h4>${inline(heading[1])}</h4>`; }
    else if (/^[-*+]\s/.test(line)) { if (!list) { html += '<ul>'; list = true; } html += `<li>${inline(line.slice(2))}</li>`; }
    else { closeList(); if (line) html += `<p>${inline(line)}</p>`; }
  }
  flushTable();
  closeList();
  return html;
}

function addMessage(role, text, fixable) {
  welcomeEl.hidden = true;
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  if (role === 'user') el.textContent = text;
  else el.innerHTML = renderMarkdown(text);
  messagesEl.appendChild(el);
  if (fixable) addFixLink(el, fixable);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

// "Not right?" under an answer: say what you meant, the model tries again, Save teaches it.
function addFixLink(el, msg) {
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'fix-link';
  link.textContent = 'Not right?';
  el.appendChild(link);

  link.addEventListener('click', () => {
    link.remove();
    const box = document.createElement('form');
    box.className = 'fix-box';
    box.innerHTML = '<input type="text" maxlength="500" placeholder="What did you mean? e.g. all shipments of this device, not just in transit"><button type="submit">Try again</button>';
    el.appendChild(box);
    const field = box.querySelector('input');
    field.focus();

    box.addEventListener('submit', async e => {
      e.preventDefault();
      const note = field.value.trim();
      if (!note) return;
      box.querySelector('button').disabled = true;
      box.querySelector('button').textContent = 'Thinking…';
      try {
        const res = await fetch('/api/chat/fix', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: msg.question, context: msg.before || undefined, note })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        showRetry(el, box, msg, note, data);
      } catch (err) {
        box.querySelector('button').disabled = false;
        box.querySelector('button').textContent = 'Try again';
        field.placeholder = err.message || 'Could not reach the server.';
        field.value = '';
      }
    });
  });
}

function showRetry(el, box, msg, note, data) {
  box.remove();
  const retry = document.createElement('div');
  retry.className = 'retry';
  retry.innerHTML = `<div class="retry-answer">${renderMarkdown(data.answer)}</div>
    <div class="retry-actions"><button type="button" class="save">Save — this is right</button><button type="button" class="discard">Discard</button></div>`;
  el.appendChild(retry);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  retry.querySelector('.discard').addEventListener('click', () => { retry.remove(); addFixLink(el, msg); });
  retry.querySelector('.save').addEventListener('click', async () => {
    await fetch('/api/chat/fix/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: msg.question, previousQuestion: msg.before?.lastPrompt, note, plan: data.plan })
    });
    // The corrected answer replaces the wrong one
    msg.text = data.answer;
    if (chat.messages[chat.messages.length - 1] === msg) chat.context = data.context || chat.context;
    saveChat();
    el.innerHTML = renderMarkdown(data.answer);
    const done = document.createElement('div');
    done.className = 'fix-saved';
    done.textContent = "Saved. I'll answer this correctly from now on.";
    el.appendChild(done);
  });
}

function addTyping() {
  const el = addMessage('assistant', '');
  el.classList.add('typing');
  el.innerHTML = '<span></span><span></span><span></span>';
  return el;
}

async function ask(prompt) {
  prompt = prompt.trim();
  if (!prompt || pending) return;

  addMessage('user', prompt);
  chat.messages.push({ role: 'user', text: prompt });
  saveChat();
  input.value = '';
  autosize();

  const before = chat.context;
  const typing = addTyping();
  pending = new AbortController();
  sendBtn.disabled = true;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, context: chat.context || undefined }),
      signal: pending.signal
    });
    const data = await res.json();
    typing.remove();
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
    const msg = { role: 'assistant', text: data.answer, question: prompt, before };
    chat.messages.push(msg);
    addMessage('assistant', data.answer, msg);
    chat.context = data.context || chat.context;
    saveChat();
  } catch (err) {
    typing.remove();
    if (err.name !== 'AbortError') addMessage('assistant', err.message || 'Could not reach the server.').classList.add('error');
  } finally {
    pending = null;
    sendBtn.disabled = false;
    input.focus();
  }
}

function newChat() {
  pending?.abort();
  chat = { messages: [], context: null };
  saveChat();
  messagesEl.querySelectorAll('.msg').forEach(el => el.remove());
  welcomeEl.hidden = false;
  input.focus();
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
}

form.addEventListener('submit', e => { e.preventDefault(); ask(input.value); });
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input.value); }
});
input.addEventListener('input', autosize);
document.getElementById('new-chat').addEventListener('click', newChat);
welcomeEl.querySelectorAll('.suggestions button').forEach(b => b.addEventListener('click', () => ask(b.textContent)));

for (const m of chat.messages) addMessage(m.role, m.text, m.role === 'assistant' && m.question ? m : null);
