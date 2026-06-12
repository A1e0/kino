// ─────────────────────────────────────────────────────────────────────────
//  Кинотеатр на двоих — сервер
//  Что он делает:
//   1) Раздаёт сайт (папка public)
//   2) Держит WebSocket-«комнаты»: пересылает между друзьями команды плеера
//      (play / pause / перемотка / выбор фильма) и сообщения чата.
//  Видео он НЕ хранит и НЕ раздаёт — браузеры тянут видео напрямую из R2.
// ─────────────────────────────────────────────────────────────────────────

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();

// Раздаём статические файлы сайта
app.use(express.static(path.join(__dirname, 'public')));

// ТОЛЬКО ДЛЯ ЛОКАЛЬНОГО ТЕСТА: отдаёт видео, лежащее рядом с папкой cinema/
// (например ../Avatar.mp4 -> http://localhost:3000/local/Avatar.mp4).
// express.static поддерживает Range-запросы, поэтому перемотка работает.
// В интернете (на Render) этого файла не будет — там видео берётся из R2.
app.use('/local', express.static(path.join(__dirname, '..')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Комнаты: код комнаты -> набор подключённых сокетов
const rooms = new Map();

function roomSet(code) {
  if (!rooms.has(code)) rooms.set(code, new Set());
  return rooms.get(code);
}

// Отправить всем в комнате (кроме отправителя, если он указан)
function broadcast(code, data, except) {
  const set = rooms.get(code);
  if (!set) return;
  const msg = JSON.stringify(data);
  for (const client of set) {
    if (client !== except && client.readyState === 1 /* OPEN */) {
      client.send(msg);
    }
  }
}

// Сообщения, которые сервер просто пересылает партнёру в комнате
const RELAY_TYPES = new Set(['play', 'pause', 'seek', 'select', 'chat']);

wss.on('connection', (ws) => {
  ws.room = null;
  ws.name = 'Гость';

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return; // мусор игнорируем
    }

    // Вход в комнату
    if (data.type === 'join') {
      const code = String(data.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      if (!code) return;
      ws.room = code;
      ws.name = String(data.name || 'Гость').slice(0, 24);

      const set = roomSet(code);
      set.add(ws);

      // Сообщаем всем в комнате, сколько нас и кто пришёл
      broadcast(code, { type: 'presence', count: set.size, name: ws.name, event: 'join' });
      // Самому вошедшему — подтверждение
      ws.send(JSON.stringify({ type: 'joined', room: code, count: set.size }));
      return;
    }

    // Дальше — только для тех, кто уже в комнате
    if (!ws.room) return;

    if (RELAY_TYPES.has(data.type)) {
      // Прокидываем партнёру, подставляя имя отправителя
      broadcast(ws.room, { ...data, name: ws.name }, ws);
    }
  });

  ws.on('close', () => {
    const code = ws.room;
    if (!code || !rooms.has(code)) return;
    const set = rooms.get(code);
    set.delete(ws);
    if (set.size === 0) {
      rooms.delete(code); // пустую комнату убираем
    } else {
      broadcast(code, { type: 'presence', count: set.size, name: ws.name, event: 'leave' });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎬 Кинотеатр запущен на порту ${PORT}`);
  console.log(`   Локально открой: http://localhost:${PORT}`);
});
