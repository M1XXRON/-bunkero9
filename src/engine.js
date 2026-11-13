'use strict';

const crypto = require('crypto');
const { AVATARS, TRAITS, EVENTS, ENDINGS, ROLE_META } = require('./content');

const MIN_PLAYERS = 5;
const MAX_PLAYERS = 15;
const ENERGY_DRAIN = 3;
const CHAT_LIMIT = 160;

const TEST_PACE = process.env.BUNKER_TEST === '1';
const PACE = TEST_PACE
  ? {
      normal: { intro: 700, reveal: 700, discussion: 900, vote: 700, night: 700 },
      fast: { intro: 700, reveal: 700, discussion: 900, vote: 700, night: 700 },
    }
  : {
      normal: { intro: 20000, reveal: 40000, discussion: 120000, vote: 35000, night: 40000 },
      fast: { intro: 12000, reveal: 25000, discussion: 60000, vote: 20000, night: 25000 },
    };

const rooms = new Map();
let changeHandler = () => {};

function setChangeHandler(fn) {
  changeHandler = typeof fn === 'function' ? fn : () => {};
}

function changed(room) {
  try {
    changeHandler(room);
  } catch (error) {
    console.error('[engine] change handler failed:', error);
  }
}

function randomInt(max) {
  return crypto.randomInt(0, max);
}

function pick(list) {
  return list[randomInt(list.length)];
}

function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let attempt = 0; attempt < 50; attempt += 1) {
    let code = '';
    for (let i = 0; i < 4; i += 1) code += alphabet[randomInt(alphabet.length)];
    if (!rooms.has(code)) return code;
  }
  return `${Date.now().toString(36).slice(-4).toUpperCase()}`;
}

function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001F\u007F<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
}

function cleanChat(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function normalizeCode(raw) {
  return typeof raw === 'string' ? raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) : '';
}

function infectedCount(total) {
  if (total >= 13) return 4;
  if (total >= 10) return 3;
  if (total >= 6) return 2;
  return 1;
}

function roleCounts(total) {
  const infected = infectedCount(total);
  const doctor = total >= MIN_PLAYERS ? 1 : 0;
  return { infected, doctor, humans: Math.max(0, total - infected - doctor) };
}

function roleName(role) {
  return ROLE_META[role] ? ROLE_META[role].name : 'НЕИЗВЕСТНО';
}

function alivePlayers(room) {
  return room.players.filter((player) => player.alive);
}

function connectedPlayers(room) {
  return room.players.filter((player) => player.connected);
}

function playerById(room, id) {
  return room.players.find((player) => player.id === id) || null;
}

// Длительность хода при пошаговом раскрытии: один игрок = один ход.
// Это не длительность всей фазы — она переставляется на каждом ходе.
const TURN_PACE = TEST_PACE
  ? { normal: 1200, fast: 1200 }
  : { normal: 25000, fast: 15000 };

function turnMs(room) {
  return TURN_PACE[room.settings?.pace] || TURN_PACE.normal;
}

function phaseMs(room, phase) {
  const pace = PACE[room.settings.pace] || PACE.normal;
  return pace[phase] || 30000;
}

function makePlayer({ name, avatar, socketId }) {
  const avatarIndex = Math.max(0, AVATARS.indexOf(avatar));
  return {
    id: crypto.randomUUID(),
    token: crypto.randomBytes(18).toString('hex'),
    name,
    avatar: AVATARS[avatarIndex] || pick(AVATARS),
    avatarIndex,
    socketId,
    connected: true,
    disconnectedAt: null,
    role: null,
    traits: [],
    alive: true,
    left: false,
    roleRevealed: false,
    death: null,
    revealedThisRound: false,
    lastHealTarget: null,
  };
}

function pushMessage(room, message) {
  room.msgSeq += 1;
  const full = {
    id: room.msgSeq,
    at: Date.now(),
    channel: 'system',
    kind: 'system',
    tone: 'info',
    ...message,
  };
  room.messages.push(full);
  if (room.messages.length > 500) {
    room.messages.splice(0, room.messages.length - 500);
  }
  return full;
}

function system(room, text, tone = 'info') {
  return pushMessage(room, { channel: 'system', kind: 'system', tone, text });
}

function privateMessage(room, to, text, tone = 'info') {
  return pushMessage(room, { channel: 'system', kind: 'private', to, tone, text });
}

function chat(room, player, channel, text) {
  return pushMessage(room, {
    channel,
    kind: 'chat',
    authorId: player.id,
    author: player.name,
    avatar: player.avatar,
    avatarIndex: player.avatarIndex,
    text,
    tone: 'chat',
  });
}

function armTimer(room, ms) {
  clearTimeout(room.timer);
  const token = room.phaseToken;
  room.timer = setTimeout(() => {
    if (room.phaseToken !== token) return;
    if (!connectedPlayers(room).length) {
      room.phaseEndsAt = Date.now() + 10000;
      armTimer(room, 10000);
      changed(room);
      return;
    }
    if (typeof room.timeoutFn === 'function') room.timeoutFn();
  }, Math.max(0, ms));
}

function startPhase(room, phase, duration, timeoutFn) {
  clearTimeout(room.timer);
  room.phaseToken += 1;
  room.state = phase;
  room.phaseStartedAt = Date.now();
  room.phaseEndsAt = Date.now() + duration;
  room.timeoutFn = timeoutFn;
  armTimer(room, duration);
}

function accelerate(room, ms) {
  if (!room.phaseEndsAt) return;
  const remaining = room.phaseEndsAt - Date.now();
  if (remaining <= ms) return;
  room.phaseEndsAt = Date.now() + ms;
  armTimer(room, ms);
}

// Восстановление комнаты из базы: таймер и timeoutFn не сериализуются,
// поэтому по текущей фазе заново выбираем функцию продолжения.
const PHASE_TIMEOUTS = {
  intro: (room) => beginDay(room),
  reveal: (room) => revealTimeout(room),
  discussion: (room) => startVote(room),
  vote: (room) => resolveVote(room),
  night: (room) => resolveNight(room),
};

function resumeRoom(room) {
  room.timer = null;
  room.timeoutFn = null;
  room.phaseToken = (room.phaseToken || 0) + 1;
  room.players = (room.players || []).map((player) => ({
    ...player,
    socketId: null,
    connected: false,
    disconnectedAt: player.disconnectedAt ?? Date.now(),
  }));
  if (room.state === 'lobby' || room.state === 'end') return room;
  // старая комната (до пошагового раскрытия) или сброс после рестарта
  if (room.state === 'reveal' && !room.turn) {
    room.turn = {
      order: alivePlayers(room).map((player) => player.id),
      index: 0,
      stage: 'reveal',
    };
  }
  if (room.state === 'reveal' && room.turn) {
    const current = turnPlayer(room);
    if (current && !current.revealedThisRound && room.turn.stage !== 'confirm') {
      room.turn.stage = current.traits.some((trait) => !trait.revealed) ? 'reveal' : 'confirm';
    }
  }
  const next = PHASE_TIMEOUTS[room.state];
  if (!next) return room;
  room.timeoutFn = () => next(room);
  const remaining = Math.max(1000, (room.phaseEndsAt || Date.now() + 5000) - Date.now());
  room.phaseEndsAt = Date.now() + remaining;
  room.phaseStartedAt = room.phaseStartedAt || Date.now();
  armTimer(room, remaining);
  return room;
}

function finishGame(room, winner) {
  clearTimeout(room.timer);
  room.phaseToken += 1;
  room.state = 'end';
  room.phaseEndsAt = null;
  room.phaseStartedAt = null;
  room.timeoutFn = null;
  room.winner = winner;
  room.night = null;
  room.votes = {};
  for (const player of room.players) {
    player.roleRevealed = true;
    player.traits.forEach((trait) => {
      trait.revealed = true;
    });
  }
  const ending = ENDINGS[winner] || ENDINGS.none;
  const tone = winner === 'humans' ? 'good' : winner === 'infected' ? 'bad' : 'warn';
  system(room, ending.title, tone);
  system(room, ending.text, 'info');
  changed(room);
}

function evaluateWin(room) {
  const alive = alivePlayers(room);
  if (!alive.length) return 'none';
  const infected = alive.filter((player) => player.role === 'infected').length;
  if (infected === 0) return 'humans';
  const humans = alive.length - infected;
  if (infected >= humans) return 'infected';
  return null;
}

function removePlayer(room, player, cause, note) {
  player.alive = false;
  player.roleRevealed = true;
  player.death = { day: room.day, cause, note: note || null };
  const prefix = cause === 'exile' ? 'Изгнание' : cause === 'night' ? 'Ночная потеря' : cause === 'left' ? 'Выход' : 'Кризис';
  const tone = cause === 'exile' && player.role === 'infected' ? 'good' : 'bad';
  const reason = cause === 'crisis' && note ? ` Причина — ${note}.` : '';
  system(room, `${prefix}: ${player.name}.${reason} Роль — ${roleName(player.role)}.`, tone);
}

function checkRevealComplete(room) {
  const alive = alivePlayers(room);
  if (!alive.length) return;
  if (alive.every((player) => player.revealedThisRound)) {
    accelerate(room, 1300);
  }
}

// ---------- пошаговое раскрытие ----------
// room.turn = { order: [id...], index, stage: 'reveal' | 'confirm' | 'done' }
// Игроки ходят строго по очереди: раскрыл карту -> подтвердил конец хода.

function turnPlayer(room) {
  const turn = room.turn;
  if (!turn) return null;
  const player = playerById(room, turn.order[turn.index] || '');
  if (!player || !player.alive || player.left) return null;
  return player;
}

// Ставит таймер на текущий ход и возвращает игрока, чей ход начался.
function startTurn(room) {
  const order = room.turn?.order || [];
  let index = room.turn?.index ?? 0;
  while (index < order.length) {
    const player = playerById(room, order[index]);
    if (player && player.alive && !player.left) {
      const hidden = player.traits.some((trait) => !trait.revealed);
      room.turn = {
        order,
        index,
        stage: player.revealedThisRound || !hidden ? 'confirm' : 'reveal',
      };
      const ms = turnMs(room);
      room.timeoutFn = () => revealTimeout(room);
      room.phaseEndsAt = Date.now() + ms;
      armTimer(room, ms);
      return player;
    }
    index += 1;
  }
  room.turn = { order, index: order.length, stage: 'done' };
  return null;
}

function advanceTurn(room) {
  if (room.state !== 'reveal' || !room.turn) return;
  room.turn.index += 1;
  const next = startTurn(room);
  if (next) {
    changed(room);
    return;
  }
  finishReveal(room);
}

// Ход истёк: карту раскрываем сами (случайную), ход передаём дальше.
function revealTimeout(room) {
  if (room.state !== 'reveal') return;
  const player = turnPlayer(room);
  if (player && !player.revealedThisRound) autoReveal(room, player);
  advanceTurn(room);
}

function checkVoteComplete(room) {
  const alive = alivePlayers(room);
  if (!alive.length) return;
  if (alive.every((player) => room.votes[player.id])) {
    accelerate(room, 1600);
  }
}

function checkNightReady(room) {
  if (room.state !== 'night' || !room.night) return;
  const alive = alivePlayers(room);
  const mafia = alive.filter((player) => player.role === 'infected');
  const doctor = alive.find((player) => player.role === 'doctor');
  const mafiaReady = mafia.length > 0 && mafia.every((player) => room.night.mafiaVotes[player.id]);
  const doctorReady =
    !doctor ||
    room.resources.meds <= 0 ||
    room.night.doctorSkip ||
    Boolean(room.night.doctorTarget);
  if (mafiaReady && doctorReady) accelerate(room, 4200);
}

function autoReveal(room, player) {
  if (player.revealedThisRound) return;
  const hidden = player.traits.filter((trait) => !trait.revealed);
  if (hidden.length) {
    const trait = pick(hidden);
    trait.revealed = true;
    player.revealedThisRound = true;
    system(room, `${player.name} раскрывает — ${trait.label}: ${trait.value}.`, 'reveal');
  } else {
    player.revealedThisRound = true;
  }
}

function drawEvent(room) {
  if (room.usedEvents.length >= EVENTS.length) room.usedEvents = [];
  const available = EVENTS.filter((event) => !room.usedEvents.includes(event.id));
  const event = pick(available);
  room.usedEvents.push(event.id);
  return event;
}

function eventTone(effects) {
  let score = 0;
  for (const value of Object.values(effects)) score += value;
  return score > 0 ? 'good' : score < 0 ? 'bad' : 'warn';
}

function applyEffects(room, effects) {
  for (const [key, delta] of Object.entries(effects || {})) {
    if (!(key in room.resources) || typeof delta !== 'number') continue;
    room.resources[key] = Math.max(0, room.resources[key] + delta);
  }
}

function beginDay(room) {
  if (room.state === 'end') return;
  room.day += 1;
  const alive = alivePlayers(room);
  if (!alive.length) {
    finishGame(room, 'none');
    return;
  }

  system(room, `ДЕНЬ ${room.day}`, 'phase');
  const foodCost = alive.length;
  room.resources.food = Math.max(0, room.resources.food - foodCost);
  room.resources.energy = Math.max(0, room.resources.energy - ENERGY_DRAIN);
  system(room, `Расход бункера: еда −${foodCost}, энергия −${ENERGY_DRAIN}.`, 'muted');

  const event = drawEvent(room);
  room.event = event;
  system(room, `СОБЫТИЕ · ${event.title}. ${event.text}`, eventTone(event.effects));
  applyEffects(room, event.effects);

  if (room.resources.food === 0) {
    system(room, 'Еда закончилась. Бункер на грани.', 'bad');
  }
  if (room.resources.energy === 0) {
    system(room, 'Энергия на нуле. Холод пробирается в отсеки.', 'bad');
  }

  if (room.resources.food === 0 || room.resources.energy === 0) {
    const victim = pick(alive);
    const cause =
      room.resources.food === 0 && room.resources.energy === 0
        ? 'голод и холод'
        : room.resources.food === 0
          ? 'голод'
          : 'холод';
    removePlayer(room, victim, 'crisis', cause);
  }

  const winner = evaluateWin(room);
  if (winner) {
    finishGame(room, winner);
    return;
  }

  for (const player of room.players) {
    player.revealedThisRound = !player.alive || player.traits.every((trait) => trait.revealed);
  }
  room.votes = {};
  room.night = null;

  room.turn = {
    order: alivePlayers(room).map((player) => player.id),
    index: 0,
    stage: 'reveal',
  };
  startPhase(room, 'reveal', turnMs(room), () => revealTimeout(room));
  system(room, 'Раскрытие карт. По очереди: один факт о себе — для всех.', 'phase');
  const first = startTurn(room);
  if (first) changed(room);
  else finishReveal(room);
}

function finishReveal(room) {
  if (room.state !== 'reveal') return;
  for (const player of alivePlayers(room)) {
    if (!player.revealedThisRound) autoReveal(room, player);
  }
  room.turn = null;
  room.votes = {};
  startPhase(room, 'discussion', phaseMs(room, 'discussion'), () => startVote(room));
  system(room, 'Обсуждение. Слушайте. Сомневайтесь. Решайте.', 'phase');
  changed(room);
}

function startVote(room) {
  if (room.state !== 'discussion') return;
  room.votes = {};
  startPhase(room, 'vote', phaseMs(room, 'vote'), () => resolveVote(room));
  system(room, 'ГОЛОСОВАНИЕ · Кого изгнать из бункера?', 'phase');
  changed(room);
}

function tallyVotes(room) {
  const alive = alivePlayers(room);
  const aliveIds = new Set(alive.map((player) => player.id));
  const counts = {};
  let skipped = 0;
  for (const player of alive) {
    const vote = room.votes[player.id];
    if (!vote || vote === 'skip') {
      skipped += 1;
      continue;
    }
    if (!aliveIds.has(vote)) {
      skipped += 1;
      continue;
    }
    counts[vote] = (counts[vote] || 0) + 1;
  }
  return { counts, skipped };
}

function resolveVote(room) {
  if (room.state !== 'vote') return;
  const { counts, skipped } = tallyVotes(room);
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const summary = entries
    .map(([id, count]) => {
      const player = playerById(room, id);
      return `${player ? player.name : '—'} — ${count}`;
    })
    .join(' · ');
  system(
    room,
    `Итоги голосования: ${summary || 'никто не получил голосов'}${skipped ? ` · воздержались — ${skipped}` : ''}.`,
    'muted',
  );

  const leaders = entries.filter(([, count]) => count === entries[0]?.[1]);
  if (entries.length === 0 || leaders.length !== 1) {
    system(room, 'Голоса разделились. Никто не изгнан.', 'warn');
  } else {
    const target = playerById(room, leaders[0][0]);
    if (target && target.alive) {
      removePlayer(room, target, 'exile');
    } else {
      system(room, 'Голоса разделились. Никто не изгнан.', 'warn');
    }
  }

  const winner = evaluateWin(room);
  if (winner) {
    finishGame(room, winner);
    return;
  }
  startNight(room);
}

function startNight(room) {
  if (room.state === 'end') return;
  room.votes = {};
  room.night = { mafiaVotes: {}, doctorTarget: null, doctorSkip: false };
  startPhase(room, 'night', phaseMs(room, 'night'), () => resolveNight(room));
  system(room, `НОЧЬ ${room.day} · Свет гаснет.`, 'phase');
  changed(room);
}

function chooseMafiaTarget(room) {
  const alive = alivePlayers(room);
  const aliveById = new Map(alive.map((player) => [player.id, player]));
  const votes = room.night ? room.night.mafiaVotes : {};
  const counts = {};
  for (const [voterId, targetId] of Object.entries(votes)) {
    const voter = aliveById.get(voterId);
    const target = aliveById.get(targetId);
    if (!voter || voter.role !== 'infected') continue;
    if (!target || target.role === 'infected') continue;
    counts[targetId] = (counts[targetId] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length) {
    const top = entries.filter(([, count]) => count === entries[0][1]);
    return aliveById.get(pick(top)[0]) || null;
  }
  const possible = alive.filter((player) => player.role !== 'infected');
  return possible.length ? pick(possible) : null;
}

function resolveNight(room) {
  if (room.state !== 'night' || !room.night) return;
  const alive = alivePlayers(room);
  const target = chooseMafiaTarget(room);
  const doctor = alive.find((player) => player.role === 'doctor');
  const mafia = alive.filter((player) => player.role === 'infected');
  let saved = false;
  let medsUsed = false;

  if (doctor && room.resources.meds > 0 && room.night.doctorTarget) {
    const healTarget = alive.find((player) => player.id === room.night.doctorTarget);
    if (healTarget) {
      room.resources.meds = Math.max(0, room.resources.meds - 1);
      medsUsed = true;
      room.lastHealTarget = healTarget.id;
      if (target && target.id === healTarget.id) saved = true;
    }
  }

  if (target && saved) {
    system(room, 'Ночь прошла без потерь.', 'good');
    if (doctor) {
      privateMessage(
        room,
        doctor.id,
        `Вы спасли ${target.name}. Израсходован 1 медикамент. Осталось: ${room.resources.meds}.`,
        'good',
      );
    }
    for (const mafiaPlayer of mafia) {
      privateMessage(room, mafiaPlayer.id, `Цель — ${target.name} — выжила. Кто-то вмешался.`, 'bad');
    }
  } else if (target) {
    removePlayer(room, target, 'night');
    for (const mafiaPlayer of mafia) {
      privateMessage(room, mafiaPlayer.id, `${target.name} устранён.`, 'good');
    }
  } else {
    system(room, 'Ночь прошла без потерь.', 'info');
  }

  if (doctor && medsUsed && !saved) {
    privateMessage(
      room,
      doctor.id,
      `Вы провели ночь у операционного стола, но ваша цель не понадобилась. Израсходован 1 медикамент. Осталось: ${room.resources.meds}.`,
      'info',
    );
  }

  const winner = evaluateWin(room);
  if (winner) {
    finishGame(room, winner);
    return;
  }
  beginDay(room);
}

function startGame(room, playerId) {
  if (room.state !== 'lobby') return { ok: false, error: 'Игра уже идёт.' };
  if (room.hostId !== playerId) return { ok: false, error: 'Начать игру может только хост.' };
  if (room.players.length < MIN_PLAYERS) {
    return { ok: false, error: `Нужно хотя бы ${MIN_PLAYERS} выживших.` };
  }
  if (room.players.length > MAX_PLAYERS) {
    return { ok: false, error: `Максимум ${MAX_PLAYERS} выживших.` };
  }

  room.gameId += 1;
  room.day = 0;
  room.event = null;
  room.usedEvents = [];
  room.messages = [];
  room.msgSeq = 0;
  room.votes = {};
  room.night = null;
  room.lastHealTarget = null;
  room.winner = null;
  room.phaseEndsAt = null;
  room.phaseStartedAt = null;
  room.turn = null;

  const total = room.players.length;
  const counts = roleCounts(total);
  room.setup = counts;
  room.resources = {
    food: total * 4 + 8,
    energy: total * 2 + 8,
    meds: 3 + Math.floor(total / 5),
  };

  const roleOrder = shuffle(room.players);
  roleOrder.forEach((player, index) => {
    if (index < counts.infected) player.role = 'infected';
    else if (index === counts.infected) player.role = 'doctor';
    else player.role = 'human';
  });

  const pools = {};
  for (const category of TRAITS) {
    pools[category.key] = shuffle(category.values);
  }
  room.players.forEach((player, playerIndex) => {
    player.alive = true;
    player.left = false;
    player.roleRevealed = false;
    player.death = null;
    player.revealedThisRound = false;
    player.lastHealTarget = null;
    player.traits = TRAITS.map((category) => ({
      cat: category.key,
      label: category.label,
      value: pools[category.key][playerIndex],
      revealed: false,
    }));
  });

  system(room, 'СИГНАЛ ТИШИНЫ', 'title');
  system(
    room,
    'Дверь заперта. Снаружи — только тишина. Внутри — люди, ресурсы и что-то ещё. Найдите чужих до рассвета.',
    'info',
  );
  system(
    room,
    `Заражённых: ${counts.infected} · Врач: 1 · Обычных: ${counts.humans}. Роли розданы.`,
    'warn',
  );
  startPhase(room, 'intro', phaseMs(room, 'intro'), () => beginDay(room));
  changed(room);
  return { ok: true };
}

function createRoom({ name, avatar, socketId }) {
  const clean = cleanName(name);
  if (clean.length < 2) return { ok: false, error: 'Имя должно быть от 2 до 16 символов.' };
  const player = makePlayer({ name: clean, avatar, socketId });
  const room = {
    code: randomCode(),
    players: [player],
    hostId: player.id,
    state: 'lobby',
    day: 0,
    gameId: 0,
    settings: { pace: 'normal' },
    resources: { food: 0, energy: 0, meds: 0 },
    event: null,
    usedEvents: [],
    setup: null,
    messages: [],
    msgSeq: 0,
    votes: {},
    night: null,
    lastHealTarget: null,
    winner: null,
    phaseEndsAt: null,
    phaseStartedAt: null,
    phaseToken: 0,
    timeoutFn: null,
    timer: null,
    createdAt: Date.now(),
  };
  rooms.set(room.code, room);
  system(room, `Бункер создан. Хост: ${player.name}. Пригласите выживших.`, 'muted');
  return { ok: true, room, player, token: player.token };
}

function joinRoom({ code, name, avatar, token, socketId }) {
  const normalized = normalizeCode(code);
  const room = rooms.get(normalized);
  if (!room) return { ok: false, error: 'Бункер с таким кодом не найден.' };

  let previousSocketId = null;
  if (token) {
    const existing = room.players.find((player) => player.token === token);
    if (existing && !existing.left) {
      previousSocketId = existing.socketId;
      existing.connected = true;
      existing.socketId = socketId;
      existing.disconnectedAt = null;
      if (!room.hostId) room.hostId = existing.id;
      return {
        ok: true,
        room,
        player: existing,
        token: existing.token,
        reconnected: true,
        previousSocketId,
      };
    }
  }

  if (room.state !== 'lobby') {
    return { ok: false, error: 'Игра уже началась. Войти можно только по сохранённой сессии.' };
  }
  if (room.players.length >= MAX_PLAYERS) {
    return { ok: false, error: `В бункере уже ${MAX_PLAYERS} выживших.` };
  }
  const clean = cleanName(name);
  if (clean.length < 2) return { ok: false, error: 'Имя должно быть от 2 до 16 символов.' };
  if (room.players.some((player) => player.name.toLowerCase() === clean.toLowerCase())) {
    return { ok: false, error: 'Такое имя уже занято в бункере.' };
  }

  const player = makePlayer({ name: clean, avatar, socketId });
  room.players.push(player);
  if (!room.hostId) room.hostId = player.id;
  system(room, `${player.name} — теперь в бункере.`, 'muted');
  return { ok: true, room, player, token: player.token, reconnected: false, previousSocketId: null };
}

function leaveRoom(code, playerId) {
  const room = rooms.get(normalizeCode(code));
  if (!room) return { ok: true, deleted: true };
  const player = playerById(room, playerId);
  if (!player) return { ok: true, deleted: false };

  if (room.state === 'lobby') {
    room.players = room.players.filter((item) => item.id !== player.id);
    system(room, `${player.name} больше не в бункере.`, 'muted');
    if (room.hostId === player.id) {
      const next = connectedPlayers(room)[0] || room.players[0] || null;
      room.hostId = next ? next.id : null;
    }
    if (!room.players.length) {
      clearTimeout(room.timer);
      rooms.delete(room.code);
      return { ok: true, deleted: true };
    }
    changed(room);
    return { ok: true, deleted: false };
  }

  const wasAlive = player.alive;
  if (wasAlive) {
    player.alive = false;
    player.left = true;
    player.roleRevealed = true;
    player.death = { day: room.day, cause: 'left', note: 'покинул игру' };
    player.token = null;
    player.connected = false;
    player.socketId = null;
    system(room, `Выход: ${player.name}. Роль — ${roleName(player.role)}.`, 'warn');
    if (room.hostId === player.id) {
      const next = connectedPlayers(room)[0] || room.players.find((item) => item.id !== player.id) || null;
      room.hostId = next ? next.id : null;
    }
    const winner = evaluateWin(room);
    if (winner) {
      finishGame(room, winner);
      return { ok: true, deleted: false };
    }
    if (room.state === 'reveal') {
      player.revealedThisRound = true;
      if (room.turn && turnPlayer(room)?.id === player.id) advanceTurn(room);
      else checkRevealComplete(room);
    } else if (room.state === 'vote') {
      checkVoteComplete(room);
    } else if (room.state === 'night') {
      checkNightReady(room);
    }
    changed(room);
    return { ok: true, deleted: false };
  }

  player.left = true;
  player.token = null;
  player.connected = false;
  player.socketId = null;
  system(room, `Выход: ${player.name}.`, 'muted');
  if (room.hostId === player.id) {
    const next = connectedPlayers(room)[0] || room.players.find((item) => item.id !== player.id) || null;
    room.hostId = next ? next.id : null;
  }
  changed(room);
  return { ok: true, deleted: false };
}

function disconnect(code, playerId) {
  const room = rooms.get(normalizeCode(code));
  if (!room) return;
  const player = playerById(room, playerId);
  if (!player) return;
  player.connected = false;
  player.socketId = null;
  player.disconnectedAt = Date.now();
  if (room.hostId === player.id) {
    const next = connectedPlayers(room)[0] || null;
    if (next) room.hostId = next.id;
  }
  changed(room);
}

function skipPhase(code, playerId) {
  const room = rooms.get(normalizeCode(code));
  if (!room) return { ok: false, error: 'Бункер не найден.' };
  if (room.hostId !== playerId) return { ok: false, error: 'Пропускать фазу может только хост.' };
  if (room.state === 'lobby') return { ok: false, error: 'Игра ещё не началась.' };
  if (room.state === 'intro') {
    beginDay(room);
    return { ok: true };
  }
  if (room.state === 'reveal') {
    finishReveal(room);
    return { ok: true };
  }
  if (room.state === 'discussion') {
    startVote(room);
    return { ok: true };
  }
  if (room.state === 'vote') {
    resolveVote(room);
    return { ok: true };
  }
  if (room.state === 'night') {
    resolveNight(room);
    return { ok: true };
  }
  return { ok: false, error: 'Сейчас нечего пропускать.' };
}

function revealTrait(code, playerId, index) {
  const room = rooms.get(normalizeCode(code));
  if (!room) return { ok: false, error: 'Бункер не найден.' };
  if (room.state !== 'reveal') return { ok: false, error: 'Сейчас нельзя раскрывать карты.' };
  const player = playerById(room, playerId);
  if (!player || !player.alive) return { ok: false, error: 'Вы не участвуете в игре.' };
  const current = turnPlayer(room);
  if (!current) return { ok: false, error: 'Сейчас никто не раскрывает карты.' };
  if (current.id !== player.id) return { ok: false, error: `Сейчас ход ${current.name}.` };
  if (room.turn.stage !== 'reveal')
    return { ok: false, error: 'Карта уже раскрыта — подтвердите конец хода.' };
  if (player.revealedThisRound) return { ok: false, error: 'Вы уже раскрыли карту в этот день.' };
  const trait = player.traits[Number(index)];
  if (!trait || trait.revealed) return { ok: false, error: 'Эта карта уже раскрыта.' };
  trait.revealed = true;
  player.revealedThisRound = true;
  system(room, `${player.name} раскрывает — ${trait.label}: ${trait.value}.`, 'reveal');
  // карта на столе: ждём подтверждения, таймер хода начинается заново
  room.turn.stage = 'confirm';
  const ms = turnMs(room);
  room.timeoutFn = () => revealTimeout(room);
  room.phaseEndsAt = Date.now() + ms;
  armTimer(room, ms);
  changed(room);
  return { ok: true };
}

// Подтверждение конца хода: передаёт очередь следующему выжившему.
function endTurn(code, playerId) {
  const room = rooms.get(normalizeCode(code));
  if (!room) return { ok: false, error: 'Бункер не найден.' };
  if (room.state !== 'reveal') return { ok: false, error: 'Сейчас не этап раскрытия.' };
  const player = playerById(room, playerId);
  if (!player || !player.alive) return { ok: false, error: 'Вы наблюдаете со стороны.' };
  const current = turnPlayer(room);
  if (!current) return { ok: false, error: 'Очередь уже перешла дальше.' };
  if (current.id !== player.id) return { ok: false, error: `Сейчас ход ${current.name}.` };
  if (room.turn.stage === 'reveal') {
    const hidden = player.traits.some((trait) => !trait.revealed);
    if (hidden && !player.revealedThisRound)
      return { ok: false, error: 'Сначала раскройте одну карту.' };
  }
  advanceTurn(room);
  return { ok: true };
}

function castVote(code, playerId, targetId) {
  const room = rooms.get(normalizeCode(code));
  if (!room) return { ok: false, error: 'Бункер не найден.' };
  if (room.state !== 'vote') return { ok: false, error: 'Сейчас нет голосования.' };
  const player = playerById(room, playerId);
  if (!player || !player.alive) return { ok: false, error: 'Вы не участвуете в голосовании.' };
  if (targetId !== 'skip') {
    const target = playerById(room, targetId);
    if (!target || !target.alive) return { ok: false, error: 'Этот выживший уже не с нами.' };
  }
  room.votes[player.id] = targetId;
  checkVoteComplete(room);
  changed(room);
  return { ok: true };
}

function nightAction(code, playerId, targetId) {
  const room = rooms.get(normalizeCode(code));
  if (!room) return { ok: false, error: 'Бункер не найден.' };
  if (room.state !== 'night' || !room.night) return { ok: false, error: 'Сейчас не ночь.' };
  const player = playerById(room, playerId);
  if (!player || !player.alive) return { ok: false, error: 'Вы не участвуете в игре.' };
  const target = playerById(room, targetId);
  if (!target || !target.alive) return { ok: false, error: 'Цель недоступна.' };

  if (player.role === 'infected') {
    if (target.role === 'infected') return { ok: false, error: 'Своих не выбирают.' };
    room.night.mafiaVotes[player.id] = target.id;
    checkNightReady(room);
    changed(room);
    return { ok: true };
  }

  if (player.role === 'doctor') {
    if (room.resources.meds <= 0) return { ok: false, error: 'Медикаментов больше нет.' };
    if (room.lastHealTarget === target.id) {
      return { ok: false, error: 'Этого выжившего нельзя спасать две ночи подряд.' };
    }
    room.night.doctorTarget = target.id;
    room.night.doctorSkip = false;
    checkNightReady(room);
    changed(room);
    return { ok: true };
  }

  return { ok: false, error: 'У вас нет ночного действия.' };
}

function doctorSkip(code, playerId) {
  const room = rooms.get(normalizeCode(code));
  if (!room) return { ok: false, error: 'Бункер не найден.' };
  if (room.state !== 'night' || !room.night) return { ok: false, error: 'Сейчас не ночь.' };
  const player = playerById(room, playerId);
  if (!player || !player.alive || player.role !== 'doctor') {
    return { ok: false, error: 'У вас нет ночного действия.' };
  }
  room.night.doctorTarget = null;
  room.night.doctorSkip = true;
  checkNightReady(room);
  changed(room);
  return { ok: true };
}

function sendChat(code, playerId, channel, text) {
  const room = rooms.get(normalizeCode(code));
  if (!room) return { ok: false, error: 'Бункер не найден.' };
  const player = playerById(room, playerId);
  if (!player) return { ok: false, error: 'Вы не в бункере.' };
  const clean = cleanChat(text);
  if (!clean) return { ok: false, error: 'Пустое сообщение.' };
  const allowed = chatAvailability(room, player);
  if (!allowed[channel]) return { ok: false, error: 'Сейчас этот канал недоступен.' };
  chat(room, player, channel, clean);
  changed(room);
  return { ok: true };
}

function chatAvailability(room, player) {
  const result = { day: false, mafia: false, dead: false };
  if (room.state === 'end') {
    result.day = true;
    return result;
  }
  if (room.state === 'lobby') {
    result.day = true;
    return result;
  }
  if (!player.alive) {
    result.dead = true;
    return result;
  }
  if (['intro', 'reveal', 'discussion', 'vote'].includes(room.state)) result.day = true;
  if (room.state === 'night' && player.role === 'infected') result.mafia = true;
  return result;
}

function rematch(code, playerId) {
  const room = rooms.get(normalizeCode(code));
  if (!room) return { ok: false, error: 'Бункер не найден.' };
  if (room.hostId !== playerId) return { ok: false, error: 'Новую игру может начать только хост.' };
  if (room.state !== 'end') return { ok: false, error: 'Игра ещё не закончена.' };

  clearTimeout(room.timer);
  room.phaseToken += 1;
  room.players = room.players.filter((player) => !player.left);
  if (!room.players.length) {
    rooms.delete(room.code);
    return { ok: true, deleted: true };
  }
  room.players.forEach((player) => {
    player.role = null;
    player.traits = [];
    player.alive = true;
    player.left = false;
    player.roleRevealed = false;
    player.death = null;
    player.revealedThisRound = false;
    player.lastHealTarget = null;
  });
  room.state = 'lobby';
  room.turn = null;
  room.day = 0;
  room.event = null;
  room.usedEvents = [];
  room.setup = null;
  room.resources = { food: 0, energy: 0, meds: 0 };
  room.votes = {};
  room.night = null;
  room.lastHealTarget = null;
  room.winner = null;
  room.phaseEndsAt = null;
  room.phaseStartedAt = null;
  room.timeoutFn = null;
  room.messages = [];
  room.msgSeq = 0;
  if (!playerById(room, room.hostId)) {
    const next = connectedPlayers(room)[0] || room.players[0];
    room.hostId = next ? next.id : null;
  }
  system(room, 'Бункер снова открыт. Ждём выживших.', 'muted');
  changed(room);
  return { ok: true, deleted: false };
}

function setPace(code, playerId, pace) {
  const room = rooms.get(normalizeCode(code));
  if (!room) return { ok: false, error: 'Бункер не найден.' };
  if (room.hostId !== playerId) return { ok: false, error: 'Настройки меняет только хост.' };
  if (room.state !== 'lobby') return { ok: false, error: 'Темп можно менять только в лобби.' };
  if (!['normal', 'fast'].includes(pace)) return { ok: false, error: 'Неизвестный темп.' };
  room.settings.pace = pace;
  changed(room);
  return { ok: true };
}

function kickPlayer(code, hostId, targetId) {
  const room = rooms.get(normalizeCode(code));
  if (!room) return { ok: false, error: 'Бункер не найден.' };
  if (room.hostId !== hostId) return { ok: false, error: 'Исключать может только хост.' };
  if (room.state !== 'lobby') return { ok: false, error: 'В игре исключать нельзя.' };
  if (targetId === hostId) return { ok: false, error: 'Себя исключить нельзя.' };
  const target = playerById(room, targetId);
  if (!target) return { ok: false, error: 'Игрок не найден.' };
  room.players = room.players.filter((player) => player.id !== targetId);
  system(room, `Исключение: ${target.name}.`, 'muted');
  changed(room);
  return { ok: true, targetSocketId: target.socketId };
}

function messagesFor(room, viewer) {
  return room.messages
    .filter((message) => {
      if (message.to) return message.to === viewer.id;
      if (room.state === 'end') return true;
      if (message.channel === 'mafia') return viewer.role === 'infected' && viewer.alive;
      if (message.channel === 'dead') return !viewer.alive;
      return true;
    })
    .slice(-CHAT_LIMIT);
}

function serializeFor(room, viewer) {
  const isEnd = room.state === 'end';
  const alive = alivePlayers(room);
  const availableChat = chatAvailability(room, viewer);
  const aliveIds = new Set(alive.map((player) => player.id));
  const votesAgainst = {};
  if (room.state === 'vote') {
    for (const [voterId, targetId] of Object.entries(room.votes)) {
      if (!aliveIds.has(voterId) || targetId === 'skip') continue;
      votesAgainst[targetId] = (votesAgainst[targetId] || 0) + 1;
    }
  }

  const currentTurn = turnPlayer(room);
  const turn =
    room.state === 'reveal' && room.turn
      ? {
          playerId: currentTurn ? currentTurn.id : null,
          name: currentTurn ? currentTurn.name : null,
          stage: room.turn.stage,
          index: Math.min(room.turn.index + 1, room.turn.order.length),
          total: room.turn.order.length,
          order: room.turn.order
            .map((id, position) => {
              const player = playerById(room, id);
              if (!player) return null;
              return {
                id,
                name: player.name,
                alive: player.alive,
                revealed: Boolean(player.revealedThisRound),
                done: position < room.turn.index,
                current: position === room.turn.index,
              };
            })
            .filter(Boolean),
        }
      : null;

  const players = room.players.map((player) => {
    const visibleRole = isEnd || player.roleRevealed;
    const revealedTraits = isEnd
      ? player.traits
      : player.traits.filter((trait) => trait.revealed);
    return {
      id: player.id,
      name: player.name,
      avatar: player.avatar,
      avatarIndex: player.avatarIndex,
      connected: player.connected,
      isBot: player.isBot === true,
      alive: player.alive,
      left: player.left,
      isHost: room.hostId === player.id,
      teammate:
        viewer.role === 'infected' &&
        player.role === 'infected' &&
        player.id !== viewer.id &&
        !isEnd,
      role: visibleRole ? player.role : null,
      roleLabel: visibleRole ? roleName(player.role) : null,
      roleRevealed: player.roleRevealed,
      death: player.death,
      traits: revealedTraits.map((trait) => ({
        cat: trait.cat,
        label: trait.label,
        value: trait.value,
      })),
      // Слоты по категориям для карточки-подсказки: раскрытые — со значением,
      // скрытые — только категория («скрыта»). Ценность скрытых карт не утекает.
      traitSlots: TRAITS.map((category) => {
        const trait = player.traits.find((item) => item.cat === category.key);
        const isRevealed = Boolean(trait && trait.revealed) || isEnd;
        return {
          cat: category.key,
          label: category.label,
          revealed: isRevealed,
          value: isRevealed && trait ? trait.value : null,
        };
      }),
      traitsRevealed: revealedTraits.length,
      totalTraits: player.traits.length,
      revealedThisRound: Boolean(player.revealedThisRound),
      votedFor: room.state === 'vote' && room.votes[player.id] ? room.votes[player.id] : null,
      votesAgainst: votesAgainst[player.id] || 0,
    };
  });

  const night = {};
  if (room.state === 'night' && room.night) {
    if (viewer.role === 'infected' && viewer.alive) {
      const votes = {};
      for (const [voterId, targetId] of Object.entries(room.night.mafiaVotes)) {
        if (aliveIds.has(voterId) && aliveIds.has(targetId)) votes[voterId] = targetId;
      }
      night.mafiaVotes = votes;
    }
    if (viewer.role === 'doctor' && viewer.alive) {
      night.doctorTarget = room.night.doctorTarget;
      night.doctorSkip = room.night.doctorSkip;
      night.lastHealTarget = room.lastHealTarget;
    }
  }

  const myTraits = viewer.traits.map((trait) => ({
    cat: trait.cat,
    label: trait.label,
    value: trait.value,
    revealed: trait.revealed,
  }));
  const teammates =
    viewer.role === 'infected'
      ? room.players
          .filter((player) => player.role === 'infected' && player.id !== viewer.id)
          .map((player) => player.id)
      : [];

  const me = {
    id: viewer.id,
    name: viewer.name,
    avatar: viewer.avatar,
    avatarIndex: viewer.avatarIndex,
    isHost: room.hostId === viewer.id,
    connected: viewer.connected,
    alive: viewer.alive,
    left: viewer.left,
    role: viewer.role,
    roleLabel: viewer.role ? roleName(viewer.role) : null,
    traits: myTraits,
    canReveal:
      room.state === 'reveal' &&
      viewer.alive &&
      !viewer.revealedThisRound &&
      myTraits.some((trait) => !trait.revealed) &&
      turnPlayer(room)?.id === viewer.id &&
      room.turn?.stage === 'reveal',
    isMyTurn: room.state === 'reveal' && turnPlayer(room)?.id === viewer.id,
    canEndTurn:
      room.state === 'reveal' &&
      turnPlayer(room)?.id === viewer.id &&
      (viewer.revealedThisRound || !myTraits.some((trait) => !trait.revealed)),
    revealedThisRound: Boolean(viewer.revealedThisRound),
    votedFor: room.state === 'vote' ? room.votes[viewer.id] || null : null,
    lastHealTarget: viewer.role === 'doctor' ? room.lastHealTarget : null,
    teammates,
    death: viewer.death,
    nightTarget:
      room.state === 'night' && room.night
        ? viewer.role === 'infected'
          ? room.night.mafiaVotes[viewer.id] || null
          : viewer.role === 'doctor'
            ? room.night.doctorTarget
            : null
        : null,
    doctorSkip: room.state === 'night' && room.night ? Boolean(room.night.doctorSkip) : false,
  };

  return {
    code: room.code,
    state: room.state,
    day: room.day,
    gameId: room.gameId,
    hostId: room.hostId,
    settings: { ...room.settings },
    resources: { ...room.resources },
    event: room.event,
    setup: room.setup,
    preview: room.state === 'lobby' ? roleCounts(room.players.length) : null,
    players,
    me,
    turn,
    night,
    messages: messagesFor(room, viewer),
    winner: room.winner,
    phaseEndsAt: room.phaseEndsAt,
    phaseStartedAt: room.phaseStartedAt,
    chat: availableChat,
    aliveCount: alive.length,
    totalCount: room.players.length,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    now: Date.now(),
  };
}

function cleanupRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    let touched = false;
    if (!room.players.length) {
      clearTimeout(room.timer);
      rooms.delete(code);
      continue;
    }

    if (room.state === 'lobby') {
      const stale = room.players.filter(
        (player) => !player.connected && player.disconnectedAt && now - player.disconnectedAt > 120000,
      );
      for (const player of stale) {
        room.players = room.players.filter((item) => item.id !== player.id);
        system(room, `${player.name} больше не в бункере.`, 'muted');
        touched = true;
      }
      if (!room.players.length) {
        clearTimeout(room.timer);
        rooms.delete(code);
        continue;
      }
      if (!playerById(room, room.hostId)) {
        const next = connectedPlayers(room)[0] || room.players[0];
        room.hostId = next ? next.id : null;
        touched = true;
      }
    }

    if (!room.players.some((player) => player.connected)) {
      const lastDisconnect = Math.max(
        room.createdAt,
        ...room.players.map((player) => player.disconnectedAt || room.createdAt),
      );
      if (now - lastDisconnect > 30 * 60 * 1000) {
        clearTimeout(room.timer);
        rooms.delete(code);
        continue;
      }
    }

    if (touched) changed(room);
  }
}

module.exports = {
  rooms,
  setChangeHandler,
  createRoom,
  joinRoom,
  leaveRoom,
  disconnect,
  startGame,
  skipPhase,
  revealTrait,
  endTurn,
  castVote,
  nightAction,
  doctorSkip,
  sendChat,
  rematch,
  setPace,
  kickPlayer,
  serializeFor,
  cleanupRooms,
  resumeRoom,
  roleCounts,
  MIN_PLAYERS,
  MAX_PLAYERS,
};
