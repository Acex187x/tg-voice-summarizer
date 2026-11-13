'use strict';
// Loads data only on page open and on user actions. No timers, no polling.
const $ = id => document.getElementById(id);
const fmt = n => new Intl.NumberFormat('ru').format(n || 0);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const bytes = n => n < 1024 ? n + ' Б' : n < 1048576 ? (n / 1024).toFixed(1) + ' КБ' : (n / 1048576).toFixed(2) + ' МБ';
const kinds = {text: 'Текст', voice: 'Голосовое', video_note: 'Кружок', photo: 'Фото', video: 'Видео', audio: 'Аудио', document: 'Документ', sticker: 'Стикер', other: 'Другое'};
const statuses = {done: 'Готово', error: 'Ошибка', pending: 'В очереди', ignored: 'Пропущено', transcribing: 'Расшифровка', routing: 'Маршрутизация', summarizing: 'Сводка', filtering: 'Отбор'};
const state = {mode: 'all', chat: '', cursor: null, items: [], request: 0, chats: [], read: 0, calls: 0};

const when = sec => sec ? new Date(sec * 1000).toLocaleString('ru', {dateStyle: 'medium', timeStyle: 'short'}) : '—';
const author = d => d.fromName || [d.fromFirstName, d.fromLastName].filter(Boolean).join(' ') || d.fromUsername || (d.fromId ? String(d.fromId) : 'Неизвестный автор');
const chatName = id => state.chats.find(c => String(c.chatId) === String(id))?.title || ('Чат ' + id);
function telegram(d) {
  const id = String(d.chatId || '');
  return id.startsWith('-100') && d.messageId > 0 && !d.importedFromDump ? 'https://t.me/c/' + id.slice(4) + '/' + d.messageId : null;
}

async function api(path, params = {}) {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v !== null && v !== undefined));
  const r = await fetch(path + (query.size ? '?' + query : ''));
  const d = await r.json();
  if (!r.ok) throw Error(d.error || 'Ошибка загрузки');
  state.read += d.readBytes || 0; state.calls++;
  $('statRead').textContent = bytes(state.read);
  $('statCalls').textContent = fmt(state.calls) + ' запр. за эту вкладку';
  return d;
}
function notice(text) { $('notice').hidden = !text; $('notice').textContent = text || ''; }

function renderChats() {
  const q = $('chatSearch').value.toLowerCase();
  $('chats').innerHTML = state.chats.filter(c => (chatName(c.chatId) + ' ' + c.chatId).toLowerCase().includes(q)).map(c => {
    const title = chatName(c.chatId);
    return `<button class="chat ${state.chat === String(c.chatId) ? 'active' : ''}" data-chat="${esc(c.chatId)}"><span class="avatar">${esc(title.replace('Чат ', '').slice(0, 2).toUpperCase())}</span><span class="chat-label"><strong>${esc(title)}</strong><small>${fmt(c.messageTotal)} сообщений</small></span></button>`;
  }).join('');
}

async function loadChats() {
  const d = await api('/api/chats');
  state.chats = d.chats;
  $('chatCount').textContent = d.chats.length;
  $('statChats').textContent = fmt(d.chats.length);
  $('statMessages').textContent = fmt(d.chats.reduce((s, c) => s + (c.messageTotal || 0), 0));
  renderChats();
}

function dayStart(value, plusDays = 0) {
  if (!value) return '';
  const d = new Date(value + 'T00:00:00');
  d.setDate(d.getDate() + plusDays);
  return Math.floor(d.getTime() / 1000);
}

function request() {
  const chat = state.chat;
  if (state.mode === 'voices') return ['/api/voices', {chat}];
  if (state.mode === 'summaries') return ['/api/summaries', {chat}];
  return ['/api/messages', {chat, q: $('search').value.trim(), order: $('order').value, from: chat ? dayStart($('from').value) : '', to: chat ? dayStart($('to').value, 1) : ''}];
}

function messageRow(x, i) {
  const a = author(x), link = telegram(x);
  return `<article class="message" tabindex="0" role="button" aria-label="Открыть запись" data-index="${i}"><span class="avatar">${esc(a.slice(0, 2).toUpperCase())}</span><div class="message-content"><div class="message-meta"><strong>${esc(a)}</strong>${x.fromUsername ? `<span class="chat-name">@${esc(x.fromUsername)}</span>` : ''}<span class="chat-name">${esc(chatName(x.chatId))}</span><span class="pill">${esc(kinds[x.mediaKind] || 'Сообщение')}</span><time>${esc(when(x.ts))}</time></div><div class="message-text">${esc(x.text || '[' + (kinds[x.mediaKind] || 'Сообщение без текста') + ']')}</div><div class="message-bottom"><span>#${esc(x.messageId)}</span>${x.importedFromDump ? '<span>Импорт</span>' : ''}${x.replyToMessageId ? '<span>↳ Ответ на #' + esc(x.replyToMessageId) + '</span>' : ''}${link ? '<a href="' + link + '" target="_blank" rel="noreferrer">В Telegram ↗</a>' : ''}<span>Подробнее →</span></div></div></article>`;
}
function voiceRow(x, i) {
  const a = author(x);
  return `<article class="message" tabindex="0" role="button" aria-label="Открыть голосовое" data-index="${i}"><span class="avatar">${esc(a.slice(0, 2).toUpperCase())}</span><div class="message-content"><div class="message-meta"><strong>${esc(a)}</strong><span class="chat-name">${esc(x.chatTitle || chatName(x.chatId))}</span><span class="pill">${esc(kinds[x.mediaKind] || 'Голосовое')}</span><span class="pill">${esc(statuses[x.status] || x.status)}</span><time>${esc(when(x._creationTime / 1000))}</time></div><div class="message-text">${esc(x.transcript || x.error || '[нет расшифровки]')}</div><div class="message-bottom"><span>#${esc(x.messageId)}</span>${x.durationSec ? '<span>' + esc(x.durationSec) + ' сек.</span>' : ''}${x.transcriptLength > 600 ? '<span>' + fmt(x.transcriptLength) + ' символов</span>' : ''}<span>Подробнее →</span></div></div></article>`;
}
function summaryRow(x, i) {
  const title = chatName(x.chatId);
  return `<article class="message" tabindex="0" role="button" aria-label="Открыть сводку" data-index="${i}"><span class="avatar">${esc(title.replace('Чат ', '').slice(0, 2).toUpperCase())}</span><div class="message-content"><div class="message-meta"><strong>${esc(title)}</strong><span class="pill">${esc(statuses[x.status] || x.status)}</span><time>${esc(when(x._creationTime / 1000))}</time></div><div class="message-text">${esc(x.filterDescription || 'Сводка')} · ${fmt(x.messageCount)} сообщений · ${esc(when(x.startTs))} — ${esc(when(x.endTs))}${x.error ? '\n' + esc(x.error) : ''}</div><div class="message-bottom">${x.fromUsername ? '<span>@' + esc(x.fromUsername) + '</span>' : ''}${x.displayedMode ? '<span>' + esc(x.displayedMode) + ' / ' + esc(x.displayedContext || '') + '</span>' : ''}<span>Подробнее →</span></div></div></article>`;
}

async function load(append = false) {
  if (!append) { state.cursor = null; state.items = []; $('results').innerHTML = ''; }
  const ticket = ++state.request;
  const [path, params] = request();
  $('resultCount').textContent = 'Загрузка…'; $('more').disabled = true;
  try {
    const d = await api(path, {...params, cursor: state.cursor});
    if (ticket !== state.request) return;
    const start = state.items.length;
    state.items.push(...d.items);
    state.cursor = d.cursor;
    const row = state.mode === 'voices' ? voiceRow : state.mode === 'summaries' ? summaryRow : messageRow;
    if (!append) $('results').innerHTML = '';
    $('results').insertAdjacentHTML('beforeend', d.items.map((x, i) => row(x, start + i)).join(''));
    if (!state.items.length) $('results').innerHTML = '<div class="empty"><strong>Здесь пока ничего нет</strong>Попробуйте другой запрос или сбросьте фильтры.</div>';
    $('resultCount').textContent = 'Показано ' + fmt(state.items.length) + (state.cursor ? ', есть ещё' : ', это всё') + ($('search').value.trim() && state.mode === 'all' ? ' · по релевантности' : '');
    $('pageInfo').textContent = 'Последняя страница: ' + bytes(d.readBytes || 0) + ' из Convex';
    $('more').hidden = !state.cursor; $('more').disabled = false;
    $('statLoaded').textContent = new Date().toLocaleTimeString('ru', {hour: '2-digit', minute: '2-digit', second: '2-digit'});
    notice('');
  } catch (e) {
    if (ticket !== state.request) return;
    notice(e.message); $('resultCount').textContent = 'Не удалось загрузить'; $('more').disabled = false;
  }
}

const subtitles = {all: 'Последние сохранённые сообщения во всех чатах.', voices: 'Голосовые с расшифровками, сначала новые.', summaries: 'Запросы /summary, сначала новые.'};
function choose(mode, chat = '') {
  state.mode = mode; state.chat = chat;
  $('title').textContent = chat ? chatName(chat) + (mode === 'all' ? '' : ' · ' + {voices: 'голосовые', summaries: 'сводки'}[mode]) : {all: 'Последние сообщения', voices: 'Голосовые', summaries: 'Сводки чатов'}[mode];
  $('subtitle').textContent = chat && mode === 'all' ? 'История чата. Можно выбрать даты и порядок.' : subtitles[mode];
  $('scope').innerHTML = chat ? esc(chatName(chat)) + ' · <a href="#" data-mode="voices">голосовые</a> · <a href="#" data-mode="summaries">сводки</a> · <a href="#" data-mode="all">сообщения</a>' : 'Все чаты';
  for (const id of ['all', 'voices', 'summaries']) $(id).classList.toggle('active', id === mode && !chat);
  const messages = mode === 'all';
  $('searchForm').hidden = !messages; $('filters').hidden = !messages;
  for (const id of ['from', 'to', 'order']) $(id).disabled = !chat;
  $('filterHint').hidden = !!chat;
  $('search').value = '';
  if (!chat) { $('from').value = ''; $('to').value = ''; $('order').value = 'desc'; }
  renderChats(); load();
}

function section(title, text, extra = '') {
  return `<h3>${esc(title)}</h3>${extra}${text ? '<div class="detail-text">' + esc(text) + '</div>' : ''}`;
}
async function showDetail(i) {
  const x = state.items[i];
  $('detailBody').textContent = 'Загрузка…'; $('detail').showModal();
  try {
    let html = '', read = 0;
    if (state.mode === 'summaries') {
      const d = await api('/api/summary', {id: x._id}); read = d.readBytes || 0;
      html = `<p>${esc(chatName(x.chatId))} · ${esc(when(x._creationTime / 1000))} · ${fmt(x.messageCount)} сообщений</p>` + (d.texts.length ? d.texts.map(t => section(`${t.mode} / ${t.context} · детальность ${t.detail}`, t.text)).join('') : '<p>Текстов сводки нет.</p>');
    } else {
      const d = state.mode === 'voices' ? await api('/api/voice', {id: x._id}) : await api('/api/message', {chat: x.chatId, id: x.messageId});
      read = d.readBytes || 0;
      const m = d.message || x, link = telegram(m);
      html = `<p>${esc(author(m))} · ${esc(chatName(m.chatId))} · ${esc(when(m.ts || (m._creationTime || 0) / 1000))}</p>${link ? '<p><a target="_blank" rel="noreferrer" href="' + link + '">Открыть в Telegram ↗</a></p>' : ''}`;
      if (d.message?.text) html += section('Сообщение', d.message.text);
      if (d.replyTo) html += section('Ответ на сообщение · ' + author(d.replyTo), d.replyTo.text || '[' + (kinds[d.replyTo.mediaKind] || 'без текста') + ']');
      if (d.voice) html += section('Расшифровка', d.voice.transcript || d.voice.error || '[нет расшифровки]', `<p>${esc(statuses[d.voice.status] || d.voice.status)}${d.voice.durationSec ? ' · ' + esc(d.voice.durationSec) + ' сек.' : ''}</p>`);
      html += d.summaries.map(s => section(`Сводка · ${s.mode} / ${s.context} · детальность ${s.detail}`, s.text)).join('');
    }
    $('detailBody').innerHTML = html + `<p class="read-note">Карточка: один запрос, ${esc(bytes(read))} из Convex.</p>`;
  } catch (e) { $('detailBody').textContent = e.message; }
}

for (const id of ['all', 'voices', 'summaries']) $(id).onclick = () => choose(id);
$('chats').onclick = e => { const b = e.target.closest('[data-chat]'); if (b) choose('all', b.dataset.chat); };
$('scope').onclick = e => { const a = e.target.closest('[data-mode]'); if (a) { e.preventDefault(); choose(a.dataset.mode, state.chat); } };
$('chatSearch').oninput = renderChats;
$('searchForm').onsubmit = e => { e.preventDefault(); load(); };
$('search').onsearch = () => { if (!$('search').value) load(); };
for (const id of ['from', 'to', 'order']) $(id).onchange = () => load();
$('reset').onclick = () => { $('search').value = ''; $('from').value = ''; $('to').value = ''; $('order').value = 'desc'; load(); };
$('more').onclick = () => load(true);
$('results').onclick = e => { if (e.target.closest('a')) return; const row = e.target.closest('[data-index]'); if (row) showDetail(+row.dataset.index); };
$('results').onkeydown = e => { if (e.target.closest('a')) return; if (e.key === 'Enter' || e.key === ' ') { const row = e.target.closest('[data-index]'); if (row) { e.preventDefault(); showDetail(+row.dataset.index); } } };
$('close').onclick = () => $('detail').close();
$('detail').onclick = e => { if (e.target === $('detail')) $('detail').close(); };
$('refresh').onclick = async () => { try { await loadChats(); } catch (e) { notice(e.message); } choose(state.mode, state.chat); };

(async () => { try { await loadChats(); } catch (e) { notice(e.message); } choose('all'); })();
