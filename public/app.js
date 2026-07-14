// ─────────────────────────────────────────────────────────────────────────
//  Кинозал на двоих — клиент
//  - грузит каталог из movies.json
//  - соединяется с сервером по WebSocket («комната» по коду)
//  - синхронизирует плеер: play / pause / перемотка
//  - текстовый чат с пузырьками
// ─────────────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const loginEl   = $('login');
const appEl     = $('app');
const nameInput = $('nameInput');
const codeInput = $('codeInput');
const createBtn = $('createBtn');
const joinBtn   = $('joinBtn');
const loginHint = $('loginHint');

const roomCodeEl  = $('roomCode');
const statusEl    = $('status');
const statusText  = $('statusText');
const chatStatus  = $('chatStatus');
const leaveBtn    = $('leaveBtn');

const catalogEl   = $('catalog');
const playerWrap  = $('playerWrap');
const backBtn     = $('backBtn');
const nowTitle    = $('nowTitle');
const video       = $('video');
const playerHint  = $('playerHint');

const messagesEl  = $('messages');
const chatForm    = $('chatForm');
const chatInput   = $('chatInput');

// ── Состояние ──
let ws = null;
let myName = 'Гость';
let roomCode = '';
let movies = [];
let currentMovieId = null;

// Флаг: применяем команду партнёра → свои события плеера не отправляем (чтобы не было «эха»)
let applyingRemote = false;
let suppressTimer = null;

// ── Каталог ──
async function loadMovies() {
  try {
    const res = await fetch('movies.json', { cache: 'no-store' });
    movies = await res.json();
  } catch {
    movies = [];
  }
}

function renderCatalog() {
  catalogEl.innerHTML = '';
  if (!movies.length) {
    catalogEl.innerHTML = '<div class="catalog-empty">Каталог пуст. Добавь фильмы в файл <b>movies.json</b>.</div>';
    return;
  }
  movies.forEach((m, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.animationDelay = (i * 60) + 'ms';
    card.innerHTML = `
      <div class="poster">
        <span class="ph">🎬</span>
        ${m.poster ? `<img alt="" />` : ''}
        ${m.type ? `<span class="card-badge">${escapeHtml(m.type)}</span>` : ''}
        <div class="play-overlay"><div class="play-btn"></div></div>
        <div class="card-body">
          <div class="card-title">${escapeHtml(m.title || 'Без названия')}</div>
        </div>
      </div>`;
    if (m.poster) {
      const img = card.querySelector('img');
      img.src = m.poster;
      img.onerror = () => img.remove();
    }
    card.addEventListener('click', () => selectMovie(m.id, true));
    catalogEl.appendChild(card);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ── Выбор фильма ──
function selectMovie(id, broadcast) {
  const m = movies.find((x) => x.id === id);
  if (!m) return;
  currentMovieId = id;

  if (!m.videoUrl || m.videoUrl.startsWith('ВСТАВЬ')) {
    playerHint.textContent = '⚠ У этого фильма ещё не указана ссылка на видео (videoUrl в movies.json).';
  } else {
    playerHint.textContent = '';
  }

  nowTitle.textContent = m.title || '';
  video.src = m.videoUrl || '';
  setSubtitles(m.videoUrl ? m.subtitleUrl : '');
  catalogEl.classList.add('hidden');
  playerWrap.classList.remove('hidden');

  if (broadcast) send({ type: 'select', movieId: id });
}

// ── Субтитры ──
// Подключаем русскую VTT-дорожку и ПРИНУДИТЕЛЬНО включаем её:
// одного атрибута default недостаточно — часть браузеров его игнорирует,
// поэтому ещё и выставляем textTrack.mode = 'showing'.
function setSubtitles(url) {
  // убираем дорожки от прошлого фильма
  video.querySelectorAll('track').forEach((t) => t.remove());
  if (!url) return;

  const track = document.createElement('track');
  track.kind = 'subtitles';
  track.label = 'Русские';
  track.srclang = 'ru';
  track.src = url;
  track.default = true;
  video.appendChild(track);

  const showSubs = () => {
    for (const tt of video.textTracks) {
      tt.mode = (tt.language === 'ru' || tt.label === 'Русские') ? 'showing' : 'disabled';
    }
  };
  track.addEventListener('load', showSubs);
  video.addEventListener('loadeddata', showSubs, { once: true });
}

function backToCatalog() {
  playerWrap.classList.add('hidden');
  catalogEl.classList.remove('hidden');
  video.pause();
}

// ── Синхронизация плеера ──
function applyRemote(action) {
  applyingRemote = true;
  if (suppressTimer) clearTimeout(suppressTimer);
  try { action(); } catch (e) { /* ignore */ }
  suppressTimer = setTimeout(() => { applyingRemote = false; }, 250);
}

video.addEventListener('play',   () => { if (!applyingRemote) send({ type: 'play',  time: video.currentTime }); });
video.addEventListener('pause',  () => { if (!applyingRemote) send({ type: 'pause', time: video.currentTime }); });
video.addEventListener('seeked', () => { if (!applyingRemote) send({ type: 'seek',  time: video.currentTime }); });

function tryPlay() {
  const p = video.play();
  if (p && p.catch) p.catch(() => { playerHint.textContent = 'Нажми ▶ на видео, чтобы продолжить (браузер требует клик).'; });
}

// ── WebSocket ──
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.addEventListener('open', () => send({ type: 'join', room: roomCode, name: myName }));
  ws.addEventListener('message', (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    handle(msg);
  });
  ws.addEventListener('close', () => {
    setStatus(false, 'связь потеряна, переподключаюсь…');
    setTimeout(() => { if (roomCode) connect(); }, 1500);
  });
}

function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function handle(msg) {
  switch (msg.type) {
    case 'joined':
      setStatus(msg.count > 1, msg.count > 1 ? 'друг в сети' : 'ждём друга…');
      break;
    case 'presence':
      if (msg.event === 'join' && msg.count > 1) addSystem(`${msg.name || 'Друг'} зашёл в комнату 👋`);
      if (msg.event === 'leave') addSystem(`${msg.name || 'Друг'} вышел`);
      setStatus(msg.count > 1, msg.count > 1 ? 'друг в сети' : 'ждём друга…');
      break;
    case 'select':
      selectMovie(msg.movieId, false);
      addSystem(`Включили: ${movieTitle(msg.movieId)}`);
      break;
    case 'play':
      applyRemote(() => {
        if (Math.abs(video.currentTime - msg.time) > 0.5) video.currentTime = msg.time;
        tryPlay();
      });
      break;
    case 'pause':
      applyRemote(() => {
        video.pause();
        if (Math.abs(video.currentTime - msg.time) > 0.5) video.currentTime = msg.time;
      });
      break;
    case 'seek':
      applyRemote(() => { if (Math.abs(video.currentTime - msg.time) > 0.3) video.currentTime = msg.time; });
      break;
    case 'chat':
      addMessage(msg.name || 'Друг', msg.text, false);
      break;
  }
}

function movieTitle(id) {
  const m = movies.find((x) => x.id === id);
  return m ? m.title : 'фильм';
}

// ── Статус ──
function setStatus(online, text) {
  statusEl.classList.toggle('online', !!online);
  statusText.textContent = text;
  chatStatus.classList.toggle('online', !!online);
  chatStatus.textContent = online ? 'в сети' : 'не в сети';
}

// ── Чат ──
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  addMessage(myName, text, true);
  send({ type: 'chat', text });
  chatInput.value = '';
});

// цвет аватарки по имени (стабильный)
function avatarColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, hsl(${h} 70% 55%), hsl(${(h + 40) % 360} 70% 50%))`;
}

function nowTime() {
  return new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function addMessage(who, text, isMe) {
  const el = document.createElement('div');
  el.className = 'msg' + (isMe ? ' me' : '');
  const initial = escapeHtml((who || '?').trim().charAt(0).toUpperCase() || '?');
  const avStyle = isMe ? '' : ` style="background:${avatarColor(who || '?')}"`;
  el.innerHTML = `
    <div class="avatar"${avStyle}>${initial}</div>
    <div class="msg-content">
      <div class="who">${escapeHtml(who)} · <span class="time">${nowTime()}</span></div>
      <div class="bubble">${escapeHtml(text)}</div>
    </div>`;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addSystem(text) {
  const el = document.createElement('div');
  el.className = 'msg-system';
  el.innerHTML = `<span>${escapeHtml(text)}</span>`;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ── Вход / комнаты ──
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function enterRoom(code) {
  myName = (nameInput.value.trim() || 'Гость').slice(0, 24);
  roomCode = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (!roomCode) { loginHint.textContent = 'Введи код комнаты.'; return; }

  roomCodeEl.textContent = roomCode;
  loginEl.classList.add('hidden');
  appEl.classList.remove('hidden');
  setStatus(false, 'подключение…');
  connect();
}

createBtn.addEventListener('click', () => enterRoom(genCode()));
joinBtn.addEventListener('click', () => {
  const code = codeInput.value.trim();
  if (!code) { loginHint.textContent = 'Введи код, который прислал друг.'; return; }
  enterRoom(code);
});
codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') createBtn.click(); });

roomCodeEl.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(roomCode);
    const old = roomCodeEl.textContent;
    roomCodeEl.textContent = '✓ скопировано';
    setTimeout(() => { roomCodeEl.textContent = old; }, 1100);
  } catch { /* ignore */ }
});

backBtn.addEventListener('click', backToCatalog);
leaveBtn.addEventListener('click', () => location.reload());

// ── Старт ──
(async function init() {
  await loadMovies();
  renderCatalog();
})();
