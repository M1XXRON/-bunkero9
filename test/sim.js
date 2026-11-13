'use strict';

/* End-to-end smoke test: bots play a full game through Socket.IO. */

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const { io } = require('socket.io-client');

const PORT = 3211;
const URL = `http://127.0.0.1:${PORT}`;
const ALL_NAMES = [
  'Алиса', 'Борис', 'Вера', 'Глеб', 'Дина', 'Егор', 'Жанна', 'Зоя',
  'Игнат', 'Кира', 'Лев', 'Мила', 'Никита', 'Оля', 'Пётр',
];
const BOT_COUNT = Math.max(5, Math.min(15, Number(process.env.BOTS) || 6));
const NAMES = ALL_NAMES.slice(0, BOT_COUNT);
const AVATARS = ['🦉', '🐺', '🦊', '🐻', '🦌', '🐍', '🐙', '🦅', '🐀', '🐇', '🦂', '🕷️', '🦇', '🐸', '🐢', '🦎'];
const EXPECTED_INFECTED = BOT_COUNT >= 13 ? 4 : BOT_COUNT >= 10 ? 3 : BOT_COUNT >= 6 ? 2 : 1;
const EXPECTED_HUMANS = BOT_COUNT - EXPECTED_INFECTED - 1;

const failures = [];
const phaseSeen = new Set();
let gameRoles = null;
let gameSetup = null;
let reconnected = false;
let reconnectChecked = false;

function fail(message) {
  failures.push(message);
  console.error(`  ✗ ${message}`);
}

function check(condition, message) {
  if (condition) console.log(`  ✓ ${message}`);
  else fail(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitFor(fn, timeout = 10000, label = 'condition') {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        if (await fn()) return resolve();
      } catch (error) {
        return reject(error);
      }
      if (Date.now() - started > timeout) return reject(new Error(`Timeout: ${label}`));
      setTimeout(tick, 35);
    };
    tick();
  });
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

class Bot {
  constructor(index, url, name) {
    this.index = index;
    this.url = url;
    this.name = name;
    this.socket = null;
    this.state = null;
    this.session = null;
    this.id = null;
    this.acted = new Set();
    this.errors = [];
    this.socketHistory = 0;
  }

  connect() {
    return new Promise((resolve) => {
      const socket = io(this.url, {
        transports: ['websocket'],
        reconnection: false,
        timeout: 5000,
      });
      this.socket = socket;
      socket.on('connect', () => resolve());
      socket.on('session', (session) => {
        this.session = session;
        this.id = session.token ? this.id : this.id;
      });
      socket.on('state', (snapshot) => this.handleState(snapshot));
      socket.on('kicked', () => this.errors.push('kicked'));
      socket.on('session-replaced', () => this.errors.push('session-replaced'));
    });
  }

  emit(event, payload = {}) {
    return new Promise((resolve) => {
      if (!this.socket?.connected) return resolve({ ok: false, error: 'offline' });
      this.socket.timeout(4000).emit(event, payload, (error, response) => {
        if (error) return resolve({ ok: false, error: 'timeout' });
        if (!response || response.ok === false) {
          this.errors.push(`${event}: ${response?.error || 'unknown'}`);
        }
        resolve(response || { ok: false });
      });
    });
  }

  async create() {
    const res = await this.emit('create', { name: this.name, avatar: AVATARS[this.index] });
    if (!res.ok) throw new Error(`create failed: ${res.error}`);
  }

  async join(code, token) {
    const res = await this.emit('join', {
      code,
      name: this.name,
      avatar: AVATARS[this.index],
      token,
    });
    if (!res.ok) throw new Error(`join failed: ${res.error}`);
  }

  handleState(snapshot) {
    this.state = snapshot;
    if (snapshot.me) this.id = snapshot.me.id;
    this.validate(snapshot);
    this.act(snapshot).catch((error) => this.errors.push(error.message));
  }

  validate(snapshot) {
    if (!snapshot.me) return fail(`${this.name}: state without me`);
    if (snapshot.state !== 'end') {
      for (const player of snapshot.players) {
        if (player.id === snapshot.me.id) continue;
        if (!player.roleRevealed && player.role !== null) {
          fail(`${this.name}: увидел роль ${player.name} (${player.role}) до раскрытия`);
        }
      }
    } else {
      for (const player of snapshot.players) {
        if (!player.role) fail(`${this.name}: роль ${player.name} скрыта после игры`);
        if ((player.traits || []).length !== 5) fail(`${this.name}: у ${player.name} не раскрыты все карты после игры`);
      }
    }
    if (snapshot.me.role !== 'infected') {
      for (const player of snapshot.players) {
        if (player.teammate) fail(`${this.name}: не-заражённый видит союзника ${player.name}`);
      }
    }
    for (const message of snapshot.messages || []) {
      if (message.channel === 'mafia') {
        if (snapshot.state !== 'end' && (!snapshot.me.alive || snapshot.me.role !== 'infected')) {
          fail(`${this.name}: утёк канал мафии`);
        }
      }
      if (message.channel === 'dead' && snapshot.state !== 'end' && snapshot.me.alive) {
        fail(`${this.name}: живой видит чат мёртвых`);
      }
    }
    if (JSON.stringify(snapshot).includes('"token"')) {
      fail(`${this.name}: token попал в state`);
    }
    if (snapshot.state !== 'lobby' && snapshot.state !== 'end') phaseSeen.add(snapshot.state);
    if (snapshot.state === 'intro' && !gameRoles) {
      gameRoles = { role: snapshot.me.role, setup: snapshot.setup };
      gameSetup = snapshot.setup;
      const infected = snapshot.players.filter((player) => player.role).length;
      check(infected === 0, `${this.name}: роли скрыты при старте`);
      check(Boolean(snapshot.setup?.infected), `${this.name}: состав бункера известен`);
      if (snapshot.me.role === 'infected') {
        check(
          snapshot.me.teammates.length === snapshot.setup.infected - 1,
          `${this.name}: заражённый видит союзников`,
        );
      }
    }
  }

  async act(snapshot) {
    if (!snapshot.me?.alive || snapshot.state === 'end' || snapshot.state === 'lobby') return;
    if (snapshot.state === 'reveal') {
      const key = `reveal:${snapshot.gameId}:${snapshot.day}`;
      if (this.acted.has(key) || !snapshot.me.canReveal) return;
      const index = snapshot.me.traits.findIndex((trait) => !trait.revealed);
      if (index < 0) return;
      this.acted.add(key);
      const res = await this.emit('reveal', { index });
      if (!res.ok) this.acted.delete(key);
      return;
    }
    if (snapshot.state === 'vote') {
      const key = `vote:${snapshot.gameId}:${snapshot.day}`;
      if (this.acted.has(key) || snapshot.me.votedFor) return;
      const alive = snapshot.players.filter((player) => player.alive && player.id !== snapshot.me.id);
      if (!alive.length) return;
      const target = alive[(this.index + snapshot.day) % alive.length];
      this.acted.add(key);
      const res = await this.emit('vote', { targetId: target.id });
      if (!res.ok) this.acted.delete(key);
      return;
    }
    if (snapshot.state === 'night') {
      const key = `night:${snapshot.gameId}:${snapshot.day}`;
      if (this.acted.has(key)) return;
      if (snapshot.me.role === 'infected') {
        const mateIds = new Set([snapshot.me.id, ...(snapshot.me.teammates || [])]);
        const targets = snapshot.players.filter((player) => player.alive && !mateIds.has(player.id));
        if (!targets.length) return;
        const target = targets[(this.index + snapshot.day) % targets.length];
        this.acted.add(key);
        const res = await this.emit('night', { targetId: target.id });
        if (!res.ok) this.acted.delete(key);
      } else if (snapshot.me.role === 'doctor') {
        const targets = snapshot.players.filter(
          (player) => player.alive && player.id !== snapshot.me.lastHealTarget,
        );
        if (!targets.length) return;
        const target = targets[(this.index + snapshot.day) % targets.length];
        this.acted.add(key);
        const res = await this.emit('night', { targetId: target.id });
        if (!res.ok) this.acted.delete(key);
      }
    }
  }

  disconnect() {
    this.socket?.disconnect();
  }
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), BUNKER_TEST: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  server.stdout.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });

  try {
    await waitFor(async () => {
      try {
        const health = await httpJson(`${URL}/health`);
        return health.ok;
      } catch {
        return false;
      }
    }, 8000, 'server health');
    console.log(`\n  Сервер поднят. Подключаем ${BOT_COUNT} ботов...\n`);

    const bots = [];
    for (let index = 0; index < NAMES.length; index += 1) {
      const bot = new Bot(index, URL, NAMES[index]);
      await bot.connect();
      bots.push(bot);
    }
    const host = bots[0];
    await host.create();
    const code = host.session?.code;
    if (!code) throw new Error('no room code from session');
    for (let index = 1; index < bots.length; index += 1) {
      await bots[index].join(code);
    }
    await waitFor(() => host.state?.state === 'lobby' && host.state.players.length === BOT_COUNT, 5000, 'lobby full');
    check(host.state.players.length === BOT_COUNT, `в лобби ${BOT_COUNT} игроков`);
    check(host.state.preview.infected === EXPECTED_INFECTED, `превью: ${EXPECTED_INFECTED} заражённых`);
    check(host.state.preview.doctor === 1, 'превью: 1 врач');
    check(host.state.preview.humans === EXPECTED_HUMANS, `превью: ${EXPECTED_HUMANS} обычных`);

    await host.emit('start');
    await waitFor(() => host.state?.state !== 'lobby', 5000, 'game started');
    check(host.state.state === 'intro', 'игра началась с пролога');
    const roles = bots.map((bot) => bot.state?.me?.role).filter(Boolean);
    check(roles.length === BOT_COUNT, 'все получили роли');
    check(roles.filter((role) => role === 'infected').length === EXPECTED_INFECTED, `роздано ровно ${EXPECTED_INFECTED} заражённых`);
    check(roles.filter((role) => role === 'doctor').length === 1, 'роздан ровно 1 врач');

    const startDeadline = Date.now() + 120000;
    while (Date.now() < startDeadline) {
      const live = bots.find((bot) => bot.state);
      if (live?.state?.state === 'end') break;
      const any = bots.map((bot) => bot.state).find((snapshot) => snapshot && snapshot.state !== 'lobby');
      if (any && !reconnectChecked && any.state === 'reveal') {
        reconnectChecked = true;
        await sleep(80);
        const target = bots[2];
        const oldId = target.id;
        const token = target.session?.token;
        target.disconnect();
        await sleep(220);
        const newSocket = io(URL, { transports: ['websocket'], reconnection: false, timeout: 5000 });
        target.socket = newSocket;
        await new Promise((resolve) => newSocket.on('connect', resolve));
        newSocket.on('state', (snapshot) => target.handleState(snapshot));
        newSocket.on('session', (session) => {
          target.session = session;
        });
        await target.join(code, token);
        await waitFor(() => target.state?.me?.id === oldId, 5000, 'reconnect state');
        reconnected = target.state?.me?.id === oldId;
        check(reconnected, 'переподключение сохраняет игрока');
      }
      await sleep(120);
    }

    const finalState = bots.map((bot) => bot.state).find((snapshot) => snapshot?.state === 'end');
    check(Boolean(finalState), 'игра дошла до финала');
    check(phaseSeen.has('reveal') && phaseSeen.has('vote') && phaseSeen.has('night'), 'пройдены раскрытие, голосование и ночь');
    check(reconnected || !reconnectChecked, 'проверка реконнекта выполнена');
    if (finalState) {
      check(['humans', 'infected', 'none'].includes(finalState.winner), `есть победитель: ${finalState.winner}`);
      check(finalState.players.every((player) => player.role), 'в финале раскрыты все роли');
      check(finalState.players.every((player) => player.traits.length === 5), 'в финале раскрыты все карты');
      const errors = bots.flatMap((bot) => bot.errors).filter((error) => !/offline|timeout/.test(error));
      check(errors.length === 0, `боты без ошибок действий (${errors.slice(0, 3).join('; ')})`);
      console.log('\n  Итог:', finalState.winner, '· день', finalState.day, '· выжило', finalState.aliveCount);
      console.log('  Роли:', finalState.players.map((player) => `${player.name}=${player.role}`).join(', '));

      const rematch = await host.emit('rematch');
      check(rematch.ok, 'хост вернул комнату в лобби');
      await waitFor(() => host.state?.state === 'lobby', 5000, 'rematch lobby');
      check(host.state.players.every((player) => player.role === null && player.traits.length === 0), 'после рематча роли и карты очищены');
      check(host.state.players.length === BOT_COUNT, 'после рематча все игроки на месте');
      const secondStart = await host.emit('start');
      check(secondStart.ok, 'второй запуск игры принят');
      await waitFor(() => host.state?.state === 'intro', 5000, 'second game intro');
      check(host.state.me.role, 'во второй игре снова выдана роль');
      check(host.state.setup?.infected === EXPECTED_INFECTED, 'во второй игре верный состав');
    }

    const finalErrors = bots.flatMap((bot) => bot.errors).filter((error) => !/offline|timeout/.test(error));
    check(finalErrors.length === 0, `боты без ошибок действий (${finalErrors.slice(0, 3).join('; ')})`);
    bots.forEach((bot) => bot.disconnect());
  } finally {
    server.kill('SIGTERM');
    await sleep(300);
    if (!server.killed) server.kill('SIGKILL');
    if (failures.length) {
      console.error(`\n  ПРОВАЛЕНО: ${failures.length} проверок\n`);
      console.error(serverOutput.slice(-3000));
      process.exit(1);
    }
    console.log('\n  Все проверки пройдены.\n');
    process.exit(0);
  }
}

main().catch((error) => {
  console.error('\n  FATAL:', error);
  process.exit(1);
});
