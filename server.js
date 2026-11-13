'use strict';

const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const engine = require('./src/engine');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const app = express();
app.disable('x-powered-by');

function lanAddresses() {
  const result = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) result.push(entry.address);
    }
  }
  return result;
}

// Один канонический адрес: www -> apex. Иначе ссылки-приглашения из QR
// половину времени указывают на www, а половину — на bunker9.lol.
app.use((req, res, next) => {
  const host = String(req.headers.host || '').toLowerCase();
  if (host.startsWith('www.')) {
    res.redirect(301, `https://${host.slice(4)}${req.originalUrl}`);
    return;
  }
  next();
});

app.get('/api/info', (_req, res) => {
  const addresses = HOST === '127.0.0.1' || HOST === 'localhost' ? [] : lanAddresses();
  res.set('Cache-Control', 'no-store');
  res.json({
    lanUrl: addresses.length ? `http://${addresses[0]}:${PORT}` : null,
    lanAddresses: addresses,
    port: PORT,
  });
});
// QR для приглашения: генерируется на сервере, поэтому клиенту не нужен
// ни лишний JS, ни внешний сервис — работает и в локальной сети без интернета.
const qrCache = new Map();
app.get('/qr.svg', async (req, res) => {
  const text = String(req.query.text || '').slice(0, 512);
  if (!text) {
    res.status(400).type('text/plain').send('text is required');
    return;
  }
  let svg = qrCache.get(text);
  if (!svg) {
    try {
      svg = await QRCode.toString(text, {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 1,
        color: { dark: '#14171cff', light: '#f3efe6ff' },
      });
    } catch (err) {
      res.status(500).type('text/plain').send('qr failed');
      return;
    }
    if (qrCache.size > 200) qrCache.clear();
    qrCache.set(text, svg);
  }
  res
    .type('image/svg+xml')
    .set('Cache-Control', 'public, max-age=3600, immutable')
    .send(svg);
});

app.use(express.static(PUBLIC_DIR, { extensions: ['html'], etag: false, maxAge: 0 }));
app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: engine.rooms.size, uptime: Math.round(process.uptime()) });
});

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 100 * 1024,
  pingTimeout: 25000,
  pingInterval: 20000,
});

function broadcastRoom(room) {
  for (const player of room.players) {
    if (!player.connected || !player.socketId) continue;
    const socket = io.sockets.sockets.get(player.socketId);
    if (socket) socket.emit('state', engine.serializeFor(room, player));
  }
}

engine.setChangeHandler(broadcastRoom);

function ackOf(ack) {
  return typeof ack === 'function' ? ack : () => {};
}

function member(socket) {
  const { roomCode, playerId } = socket.data || {};
  if (!roomCode || !playerId) return null;
  const room = engine.rooms.get(roomCode);
  if (!room) return null;
  return { room, playerId };
}

function bind(socket, room, player) {
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
  socket.join(`room:${room.code}`);
}

function detach(socket, { disconnectPlayer = true } = {}) {
  const { roomCode, playerId } = socket.data || {};
  if (roomCode && playerId && disconnectPlayer) {
    engine.disconnect(roomCode, playerId);
  }
  if (roomCode) socket.leave(`room:${roomCode}`);
  socket.data = {};
}

function notifySessionReplaced(previousSocketId, socket) {
  if (!previousSocketId || previousSocketId === socket.id) return;
  const previous = io.sockets.sockets.get(previousSocketId);
  if (!previous) return;
  previous.emit('session-replaced');
  previous.leave(`room:${previous.data?.roomCode || ''}`);
  previous.data = {};
}

io.on('connection', (socket) => {
  socket.data.chatStamps = [];

  socket.on('create', (payload = {}, ack) => {
    const reply = ackOf(ack);
    try {
      if (member(socket)) detach(socket);
      const result = engine.createRoom({
        name: payload?.name,
        avatar: payload?.avatar,
        socketId: socket.id,
      });
      if (!result.ok) {
        reply(result);
        return;
      }
      bind(socket, result.room, result.player);
      socket.emit('session', {
        code: result.room.code,
        token: result.token,
        name: result.player.name,
        avatar: result.player.avatar,
      });
      broadcastRoom(result.room);
      reply({ ok: true, code: result.room.code });
    } catch (error) {
      console.error('[socket:create]', error);
      reply({ ok: false, error: 'Не удалось создать бункер. Попробуйте ещё раз.' });
    }
  });

  socket.on('join', (payload = {}, ack) => {
    const reply = ackOf(ack);
    try {
      const code = String(payload?.code || '').toUpperCase().trim();
      if (socket.data.roomCode && socket.data.roomCode !== code) {
        detach(socket);
      }
      const previousPlayerId = socket.data.playerId;
      const result = engine.joinRoom({
        code,
        name: payload?.name,
        avatar: payload?.avatar,
        token: payload?.token,
        socketId: socket.id,
      });
      if (!result.ok) {
        reply(result);
        return;
      }
      if (previousPlayerId && previousPlayerId !== result.player.id) {
        engine.disconnect(code, previousPlayerId);
      }
      notifySessionReplaced(result.previousSocketId, socket);
      bind(socket, result.room, result.player);
      socket.emit('session', {
        code: result.room.code,
        token: result.token,
        name: result.player.name,
        avatar: result.player.avatar,
      });
      broadcastRoom(result.room);
      reply({ ok: true, code: result.room.code, reconnected: Boolean(result.reconnected) });
    } catch (error) {
      console.error('[socket:join]', error);
      reply({ ok: false, error: 'Не удалось войти в бункер. Попробуйте ещё раз.' });
    }
  });

  socket.on('leave', (_payload, ack) => {
    const reply = ackOf(ack);
    try {
      const context = member(socket);
      if (context) {
        engine.leaveRoom(context.room.code, context.playerId);
      }
      if (socket.data?.roomCode) socket.leave(`room:${socket.data.roomCode}`);
      socket.data = { chatStamps: [] };
      socket.emit('left');
      reply({ ok: true });
    } catch (error) {
      console.error('[socket:leave]', error);
      reply({ ok: false, error: 'Не удалось выйти.' });
    }
  });

  socket.on('start', (_payload, ack) => {
    const reply = ackOf(ack);
    const context = member(socket);
    if (!context) {
      reply({ ok: false, error: 'Вы не в бункере.' });
      return;
    }
    try {
      reply(engine.startGame(context.room, context.playerId));
    } catch (error) {
      console.error('[socket:start]', error);
      reply({ ok: false, error: 'Не удалось начать игру.' });
    }
  });

  socket.on('skip', (_payload, ack) => {
    const reply = ackOf(ack);
    const context = member(socket);
    if (!context) {
      reply({ ok: false, error: 'Вы не в бункере.' });
      return;
    }
    try {
      reply(engine.skipPhase(context.room.code, context.playerId));
    } catch (error) {
      console.error('[socket:skip]', error);
      reply({ ok: false, error: 'Не удалось пропустить фазу.' });
    }
  });

  socket.on('reveal', (payload = {}, ack) => {
    const reply = ackOf(ack);
    const context = member(socket);
    if (!context) {
      reply({ ok: false, error: 'Вы не в бункере.' });
      return;
    }
    try {
      reply(engine.revealTrait(context.room.code, context.playerId, payload?.index));
    } catch (error) {
      console.error('[socket:reveal]', error);
      reply({ ok: false, error: 'Не удалось раскрыть карту.' });
    }
  });

  socket.on('vote', (payload = {}, ack) => {
    const reply = ackOf(ack);
    const context = member(socket);
    if (!context) {
      reply({ ok: false, error: 'Вы не в бункере.' });
      return;
    }
    try {
      reply(engine.castVote(context.room.code, context.playerId, payload?.targetId));
    } catch (error) {
      console.error('[socket:vote]', error);
      reply({ ok: false, error: 'Не удалось проголосовать.' });
    }
  });

  socket.on('night', (payload = {}, ack) => {
    const reply = ackOf(ack);
    const context = member(socket);
    if (!context) {
      reply({ ok: false, error: 'Вы не в бункере.' });
      return;
    }
    try {
      reply(engine.nightAction(context.room.code, context.playerId, payload?.targetId));
    } catch (error) {
      console.error('[socket:night]', error);
      reply({ ok: false, error: 'Не удалось выполнить действие.' });
    }
  });

  socket.on('night-skip', (_payload, ack) => {
    const reply = ackOf(ack);
    const context = member(socket);
    if (!context) {
      reply({ ok: false, error: 'Вы не в бункере.' });
      return;
    }
    try {
      reply(engine.doctorSkip(context.room.code, context.playerId));
    } catch (error) {
      console.error('[socket:night-skip]', error);
      reply({ ok: false, error: 'Не удалось выполнить действие.' });
    }
  });

  socket.on('chat', (payload = {}, ack) => {
    const reply = ackOf(ack);
    const context = member(socket);
    if (!context) {
      reply({ ok: false, error: 'Вы не в бункере.' });
      return;
    }
    try {
      const now = Date.now();
      const stamps = (socket.data.chatStamps || []).filter((stamp) => now - stamp < 4000);
      if (stamps.length >= 6) {
        reply({ ok: false, error: 'Слишком много сообщений. Подождите пару секунд.' });
        return;
      }
      stamps.push(now);
      socket.data.chatStamps = stamps;
      reply(engine.sendChat(context.room.code, context.playerId, payload?.channel, payload?.text));
    } catch (error) {
      console.error('[socket:chat]', error);
      reply({ ok: false, error: 'Сообщение не отправлено.' });
    }
  });

  socket.on('rematch', (_payload, ack) => {
    const reply = ackOf(ack);
    const context = member(socket);
    if (!context) {
      reply({ ok: false, error: 'Вы не в бункере.' });
      return;
    }
    try {
      reply(engine.rematch(context.room.code, context.playerId));
    } catch (error) {
      console.error('[socket:rematch]', error);
      reply({ ok: false, error: 'Не удалось вернуться в лобби.' });
    }
  });

  socket.on('pace', (payload = {}, ack) => {
    const reply = ackOf(ack);
    const context = member(socket);
    if (!context) {
      reply({ ok: false, error: 'Вы не в бункере.' });
      return;
    }
    try {
      reply(engine.setPace(context.room.code, context.playerId, payload?.pace));
    } catch (error) {
      console.error('[socket:pace]', error);
      reply({ ok: false, error: 'Не удалось изменить темп.' });
    }
  });

  socket.on('kick', (payload = {}, ack) => {
    const reply = ackOf(ack);
    const context = member(socket);
    if (!context) {
      reply({ ok: false, error: 'Вы не в бункере.' });
      return;
    }
    try {
      const result = engine.kickPlayer(context.room.code, context.playerId, payload?.targetId);
      if (result.ok && result.targetSocketId) {
        const target = io.sockets.sockets.get(result.targetSocketId);
        if (target) {
          target.emit('kicked');
          target.leave(`room:${context.room.code}`);
          target.data = { chatStamps: [] };
        }
      }
      reply({ ok: result.ok, error: result.error });
    } catch (error) {
      console.error('[socket:kick]', error);
      reply({ ok: false, error: 'Не удалось исключить игрока.' });
    }
  });

  socket.on('disconnect', () => {
    const context = member(socket);
    if (context) {
      engine.disconnect(context.room.code, context.playerId);
    }
  });
});

setInterval(() => engine.cleanupRooms(), 30000).unref();

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  БУНКЕР·9  ·  СИГНАЛ ТИШИНЫ');
  console.log(`  http://localhost:${PORT}`);
  for (const address of lanAddresses()) {
    console.log(`  http://${address}:${PORT}  (локальная сеть)`);
  }
  console.log('');
});

function shutdown() {
  console.log('\n  Закрываем бункер...');
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
