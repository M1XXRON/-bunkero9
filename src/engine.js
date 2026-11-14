'use strict';

const crypto = require('crypto');
const { AVATARS, TRAITS, SPECIALS, EVENTS, ENDINGS, SCENARIOS, TRAIT_EFFECTS } = require('./content');

const MIN_PLAYERS = 5;
const MAX_PLAYERS = 15;
// Экономика бункера привязана к составу: и стартовые запасы, и суточный расход,
// и эффекты событий. Иначе на 15 игроков ресурсов хватало вдвое дольше.
//   еда      — старт 4·N + 8, расход 1 за каждого живого в день;
//   энергия  — расход 1 за каждые 3 живых (минимум 2), старт ~6 дней;
//   медикаменты — 2 + ⌈N/3⌉, расход по 1 за ночное лечение;
//   события  — дельты еды/энергии масштабируются от 0.6 (5 игроков) до 1.5 (15).
// Без ролей игра держится на выживании: дожить до спасения и не потерять смену.
//   спасение   — приходит после ночи дня rescueDay;
//   минимум смены — если живых меньше, бункер некому обслуживать (проигрыш);
//   кризис — если еда или энергия на нуле, ночью бункер теряет одного, но
//            медикаменты можно потратить, чтобы обойтись без потерь.
const CREW_SHARE = 0.7;
const RESCUE_BASE = 4;
const RESCUE_PER_PLAYER = 6;

function rescueDayFor(total) {
  return RESCUE_BASE + Math.ceil(total / RESCUE_PER_PLAYER);
}

// Минимум смены — доля от стартового состава: системы требуют людей, поэтому
// «проредить всех лишних» нельзя. Именно это делает голосование решением.
function crewMinFor(total) {
  return Math.max(3, Math.ceil(total * CREW_SHARE));
}

const FOOD_PER_PLAYER = 4;
const FOOD_DAYS = 8;
const ENERGY_PER_PLAYER = 3;
const ENERGY_DAYS = 6;

const round1 = (value) => Math.round(value * 10) / 10;

// Эффект характеристики по её значению («повар», «ящик консервов», …).
function effectOf(value) {
  const key = String(value || '').toLowerCase().trim();
  if (!key) return null;
  if (TRAIT_EFFECTS[key]) return TRAIT_EFFECTS[key];
  // Ранги и степени: «повар · 4 разряд», «астма · тяжёлая». Сначала первый
  // сегмент (профессия/хобби), затем последний (тяжесть/полнота).
  const parts = key.split('·').map((part) => part.trim()).filter(Boolean);
  for (const part of [parts[0], parts[parts.length - 1]]) {
    if (part && TRAIT_EFFECTS[part]) return TRAIT_EFFECTS[part];
  }
  return null;
}

function specialInfo(value) {
  return SPECIALS[String(value || '').toLowerCase().trim()] || null;
}

function playerEffectText(trait) {
  if (trait?.cat === 'special') {
    // В руке и на столе — короткая пометка; полное описание показываем
    // отдельной строкой в «Личном деле» (поле desc в снимке).
    return specialInfo(trait.value) ? 'один раз за партию' : '';
  }
  const effect = effectOf(trait?.value);
  return effect ? effect.label || '' : '';
}

// Влияние вскрытой карты на ресурсы: припасы — сразу, ранги/болезни — на
// суточный расход. Нужно только для подсветки: зелёный — помогает, красный —
// тянет запасы вниз.
function traitImpact(trait) {
  const effect = effectOf(trait?.value);
  if (!effect) return null;
  const supply = [];
  for (const [key, amount] of Object.entries(effect.supply || {})) {
    if (amount) supply.push(`${RESOURCE_LABEL[key]} +${amount}`);
  }
  if (supply.length) return { kind: 'gain', label: supply.join(' · ') };

  const drains = [];
  const saves = [];
  if (effect.crewEat) {
    const value = effect.crewEat;
    (value > 0 ? drains : saves).push(`${value > 0 ? '+' : '−'}${Math.abs(value)} еды/чел.`);
  }
  if (effect.eat) {
    (effect.eat > 0 ? drains : saves).push(
      `${effect.eat > 0 ? '+' : '−'}${Math.abs(effect.eat)} еды/день`,
    );
  }
  if (effect.crewPower) {
    const value = effect.crewPower;
    (value > 0 ? drains : saves).push(`${value > 0 ? '+' : '−'}${Math.abs(value)} энергии/день`);
  }
  if (drains.length) return { kind: 'drain', label: drains.join(' · ') };
  if (saves.length) return { kind: 'gain', label: saves.join(' · ') };
  return null;
}

const ABILITY_PHASES = ['intro', 'reveal', 'discussion', 'vote'];

// Суточный расход с учётом живых носителей: повар кормит смену дешевле,
// аллергия добавляет личную норму, электрик экономит энергию.
function dailyCost(room) {
  const alive = alivePlayers(room);
  const count = Math.max(1, alive.length);
  let crewEat = 0;
  let crewPower = 0;
  let personalEat = 0;
  for (const player of alive) {
    for (const trait of player.traits) {
      const effect = effectOf(trait.value);
      if (!effect) continue;
      if (effect.crewEat) crewEat += effect.crewEat;
      if (effect.crewPower) crewPower += effect.crewPower;
      if (effect.eat) personalEat += effect.eat;
    }
  }
  const perPerson = Math.max(0.25, 1 + crewEat);
  const food = Math.max(0, count * perPerson + personalEat);
  const basePower = Math.max(2, Math.ceil(count / ENERGY_PER_PLAYER));
  const energy = Math.max(1, basePower + crewPower);
  return { food: round1(food), energy: round1(energy), crewEat, crewPower, personalEat };
}

const RESOURCE_LABEL = { food: 'еда', energy: 'энергия', meds: 'медикаменты' };

// Припасы выдаются не на старте, а в момент вскрытия карты: пока игрок не
// показал «ящик консервов», бункер этих запасов не видит.
function grantSupply(room, player, trait) {
  const effect = effectOf(trait?.value);
  if (!effect?.supply) return;
  const parts = [];
  for (const [key, amount] of Object.entries(effect.supply)) {
    if (!amount) continue;
    room.resources[key] = round1((room.resources[key] || 0) + amount);
    parts.push(`${RESOURCE_LABEL[key] || key} +${amount}`);
  }
  if (parts.length) {
    system(room, `${player.name} вскрывает ${trait.value}: ${parts.join(', ')}.`, 'good');
  }
}

// Сумма припасов по всем картам комнаты — для тестов и подсказок.
function supplyOf(room) {
  const supply = { food: 0, energy: 0, meds: 0 };
  for (const player of room.players) {
    for (const trait of player.traits) {
      const effect = effectOf(trait.value);
      if (!effect?.supply) continue;
      supply.food += effect.supply.food || 0;
      supply.energy += effect.supply.energy || 0;
      supply.meds += effect.supply.meds || 0;
    }
  }
  return supply;
}

function energyCost(room) {
  const alive = alivePlayers(room).length || 1;
  return Math.max(2, Math.ceil(alive / ENERGY_PER_PLAYER));
}

// Запас стартует «чуть меньше, чем нужно дожить всем составом»: чтобы спастись,
// смена должна либо экономить (кого-то изгнать), либо поймать хорошие события,
// но не может позволить себе терять людей без счёта.
// Еды заведомо меньше, чем нужно протянуть всем составом: разницу закрывают
// либо изгнания (едоков меньше), либо удачные события. Перебор с изгнаниями
// убивает смену — она становится меньше минимума.
function startResources(total) {
  const rescue = rescueDayFor(total);
  const energy = Math.max(2, Math.ceil(total / ENERGY_PER_PLAYER));
  return {
    food: (rescue - 1) * total + 6,
    // энергии теперь тоже «на день меньше, чем нужно всем»: запас в днях
    // выровнен с едой, иначе энергия никогда не была узким местом
    energy: energy * (rescue - 1) + 4,
    meds: 2 + Math.ceil(total / 3),
  };
}

// События тоже зависят от состава: на 5 игроков «−8 еды» — это два дня, на 15 —
// половина дня. Масштаб мягкий, медикаменты не трогаем (там счёт на единицы).
function eventScale(total) {
  return Math.min(1.5, Math.max(0.6, total / 10));
}

function scaleEffects(effects, total) {
  const k = eventScale(total);
  const scaled = {};
  for (const [key, delta] of Object.entries(effects || {})) {
    if (typeof delta !== 'number') continue;
    if (key === 'meds' || delta === 0) {
      scaled[key] = delta;
      continue;
    }
    const value = Math.max(1, Math.round(Math.abs(delta) * k));
    scaled[key] = delta > 0 ? value : -value;
  }
  return scaled;
}
const CHAT_LIMIT = 160;
const CHAT_TEXT_MAX = 200;
const CHAT_COOLDOWN_MS = 350;

const TEST_PACE = process.env.BUNKER_TEST === '1';
const PACE = TEST_PACE
  ? {
      normal: { intro: 700, reveal: 700, discussion: 900, vote: 700 },
      fast: { intro: 700, reveal: 700, discussion: 900, vote: 700 },
    }
  : {
      normal: { intro: 20000, reveal: 40000, discussion: 120000, vote: 35000 },
      fast: { intro: 12000, reveal: 25000, discussion: 60000, vote: 20000 },
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
    .slice(0, CHAT_TEXT_MAX);
}

function normalizeCode(raw) {
  return typeof raw === 'string' ? raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) : '';
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

    traits: [],
    alive: true,
    left: false,
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
    day: room.day,
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

// Раскрытие карты — не просто строка текста, а событие: в чате оно рисуется
// карточкой (кто, какая категория, что именно). Текст оставляем для логов.
function revealMessage(room, player, trait) {
  return pushMessage(room, {
    channel: 'system',
    kind: 'reveal',
    tone: 'reveal',
    text: `${player.name} раскрывает — ${trait.label}: ${trait.value}.`,
    impact: traitImpact(trait),
    authorId: player.id,
    author: player.name,
    avatar: player.avatar,
    avatarIndex: player.avatarIndex,
    traitLabel: trait.label,
    traitValue: trait.value,
  });
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
  // duration=null — фаза без таймера: сценарий читают, пока не нажмут «Я прочитал»
  // или хост не откроет первый день.
  room.phaseEndsAt = duration == null ? null : Date.now() + duration;
  room.timeoutFn = duration == null ? null : timeoutFn;
  if (duration == null) room.timer = null;
  else armTimer(room, duration);
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
  reveal: (room) => revealTimeout(room),
  discussion: (room) => startVote(room),
  vote: (room) => resolveVote(room),
};

function resumeRoom(room) {
  room.timer = null;
  room.timeoutFn = null;
  room.phaseToken = (room.phaseToken || 0) + 1;
  room.players = (room.players || []).map((player) => ({
    ...player,
    socketId: null,
    // боту лента не нужна: он не «отваливается» вместе с людьми
    connected: Boolean(player.isBot),
    disconnectedAt: player.isBot ? null : (player.disconnectedAt ?? Date.now()),
  }));
  if (room.state === 'lobby' || room.state === 'end') return room;
  // Сценарий открыт без таймера: после рестарта ждём «Я прочитал» или хоста,
  // а не досчитываем старый таймер.
  if (room.state === 'intro') {
    room.readyIds = Array.isArray(room.readyIds) ? room.readyIds : [];
    room.phaseEndsAt = null;
    room.timeoutFn = null;
    room.phaseStartedAt = room.phaseStartedAt || Date.now();
    return room;
  }
  // Комнаты из базы со старой фазой «ночь»: ночи больше нет, сразу утро.
  if (room.state === 'night') {
    room.state = 'discussion';
    resolveLegacyNight(room);
    return room;
  }
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
    player.traits.forEach((trait) => {
      trait.revealed = true;
    });
  }
  const ending = ENDINGS[winner] || ENDINGS.none;
  const tone = winner === 'survived' ? 'good' : 'warn';
  system(room, ending.title, tone);
  system(room, ending.text, 'info');
  changed(room);
}

// Исход без ролей: либо дожили до спасения, либо смена кончилась.
function checkEnd(room) {
  const alive = alivePlayers(room);
  if (!alive.length) return 'none';
  if (alive.length < room.crewMin) return 'none';
  if (room.day >= room.rescueDay) return 'survived';
  return null;
}

function removePlayer(room, player, cause, note, options = {}) {
  player.alive = false;
  if (room.ability?.playerId === player.id) room.ability = null;
  player.death = { day: room.day, cause, note: note || null };
  // Мёртвый хост не должен распоряжаться темпом: передаём живому человеку,
  // если людей нет — любому живому.
  if (room.hostId === player.id) {
    const alive = alivePlayers(room).filter((item) => !item.left);
    const next = alive.find((item) => !item.isBot) || alive[0] || null;
    room.hostId = next ? next.id : null;
  }
  if (options.quiet) return;
  const prefix = cause === 'exile' ? 'Изгнание' : cause === 'night' ? 'Ночная потеря' : cause === 'left' ? 'Выход' : 'Кризис';
  const reason = cause === 'crisis' && note ? ` Причина — ${note}.` : '';
  system(room, `${prefix}: ${player.name}.${reason}`, 'bad');
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



function autoReveal(room, player) {
  if (player.revealedThisRound) return;
  const hidden = player.traits.filter((trait) => !trait.revealed);
  if (hidden.length) {
    const trait = pick(hidden);
    trait.revealed = true;
    player.revealedThisRound = true;
    revealMessage(room, player, trait);
    grantSupply(room, player, trait);
  } else {
    player.revealedThisRound = true;
  }
}

function drawEvent(room) {
  // Событие, заранее сгенерированное моделью (сервер кладёт его в room.nextEvent
  // во время ночи). Числа приходят от ИИ, поэтому их режет scaleEffects ниже.
  if (room.nextEvent) {
    const ai = room.nextEvent;
    room.nextEvent = null;
    return {
      id: `ai-${room.day}`,
      title: String(ai.title || '').slice(0, 60),
      text: String(ai.text || '').slice(0, 240),
      effects: ai.effects || {},
      source: 'ai',
    };
  }
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
  const cost = dailyCost(room);
  const foodCost = cost.food;
  const powerCost = cost.energy;
  room.resources.food = round1(Math.max(0, room.resources.food - foodCost));
  room.resources.energy = round1(Math.max(0, room.resources.energy - powerCost));
  const signed = (value) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(round1(value))}`;
  const modifiers = [
    cost.crewEat ? `кухня: ${signed(cost.crewEat)} на человека` : '',
    cost.personalEat ? `личные нормы ${signed(cost.personalEat)}` : '',
    cost.crewPower ? `электрик: ${signed(cost.crewPower)} к энергии` : '',
  ].filter(Boolean);
  system(
    room,
    `Расход бункера: еда −${foodCost}, энергия −${powerCost} (${alive.length} выживших${
      modifiers.length ? ` · ${modifiers.join(' · ')}` : ''
    }).`,
    'muted',
  );

  const event = drawEvent(room);
  // в карточке события показываем те же числа, что реально применились
  room.event = { ...event, effects: scaleEffects(event.effects, room.players.length) };
  system(room, `СОБЫТИЕ · ${event.title}. ${event.text}`, eventTone(event.effects));
  applyEffects(room, room.event.effects);

  if (room.resources.food === 0) {
    system(room, 'Еда закончилась. Бункер на грани.', 'bad');
  }
  if (room.resources.energy === 0) {
    system(room, 'Энергия на нуле. Холод пробирается в отсеки.', 'bad');
  }

  // Кризис разрешается сразу после голосования (resolveCrisis).
  const winner = checkEnd(room);
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
  // Итоги — не строка, а данные: в чате они рисуются полосками голосов.
  pushMessage(room, {
    channel: 'system',
    kind: 'vote',
    tone: 'vote',
    text: `Итоги голосования: ${summary || 'никто не получил голосов'}${skipped ? ` · воздержались — ${skipped}` : ''}.`,
    votes: entries.map(([id, count]) => ({
      id,
      name: playerById(room, id)?.name || '—',
      count,
    })),
    skipped,
  });

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

  const winner = checkEnd(room);
  if (winner) {
    finishGame(room, winner);
    return;
  }
  // Отдельной фазы «ночь» больше нет: кризис разрешается сразу после
  // голосования, а следующий день начинается тем же действием.
  resolveCrisis(room);
}

// Кризис: если еда или энергия на нуле, бункер теряет одного. Медикаменты
// могут прикрыть один такой переход к утру.
function resolveCrisis(room) {
  if (room.state === 'end') return;
  room.ability = null;
  const alive = alivePlayers(room);
  const starving = room.resources.food <= 0;
  const cold = room.resources.energy <= 0;

  if (starving || cold) {
    const reason = starving && cold ? 'голод и холод' : starving ? 'голод' : 'холод';
    if (room.resources.meds > 0) {
      room.resources.meds -= 1;
      system(
        room,
        `Ночь на пределе (${reason}), но медикаменты и воля смены вытянули всех. Осталось медикаментов: ${room.resources.meds}.`,
        'warn',
      );
    } else if (alive.length) {
      const victim = pick(alive);
      system(room, `Ночь на пределе — ${reason}.`, 'bad');
      removePlayer(room, victim, 'crisis', reason, { quiet: true });
    }
  }

  const winner = checkEnd(room);
  if (winner) {
    finishGame(room, winner);
    return;
  }
  beginDay(room);
}

// Совместимость: комнаты, сохранённые в базе со старой фазой «ночь».
function resolveLegacyNight(room) {
  const alive = alivePlayers(room);
  const starving = room.resources.food <= 0;
  const cold = room.resources.energy <= 0;
  if (starving || cold) {
    const reason = starving && cold ? 'голод и холод' : starving ? 'голод' : 'холод';
    if (room.resources.meds > 0) {
      room.resources.meds -= 1;
      system(room, `Ночь на пределе (${reason}), но медикаменты вытянули всех.`, 'warn');
    } else if (alive.length) {
      const planned = room.night?.crisis?.victimId
        ? playerById(room, room.night.crisis.victimId)
        : null;
      const victim = planned && planned.alive ? planned : pick(alive);
      const epitaph = room.night?.crisis?.epitaph;
      if (epitaph) system(room, epitaph, 'bad');
      else system(room, `Ночь на пределе — ${reason}.`, 'bad');
      removePlayer(room, victim, 'crisis', reason, { quiet: Boolean(epitaph) });
    }
  }
  room.night = null;
  const winner = checkEnd(room);
  if (winner) finishGame(room, winner);
  else beginDay(room);
}

function startGame(room, playerId, options = {}) {
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
  room.ability = null;
  room.readyIds = [];
  room.lastHealTarget = null;
  room.winner = null;
  room.phaseEndsAt = null;
  room.phaseStartedAt = null;
  room.turn = null;

  const total = room.players.length;
  // Сюжет: модель присылает свой, иначе берём сценарий из content.js.
  room.story =
    options.story && options.story.title
      ? {
          title: String(options.story.title).slice(0, 40),
          premise: String(options.story.premise || '').slice(0, 280),
          threat: String(options.story.threat || '').slice(0, 80),
          source: 'ai',
        }
      : { ...pick(SCENARIOS), source: 'static' };
  room.rescueDay = rescueDayFor(total);
  room.crewMin = crewMinFor(total);
  room.resources = startResources(total);

  const pools = {};
  for (const category of TRAITS) {
    pools[category.key] = shuffle(category.values);
  }
  room.players.forEach((player, playerIndex) => {
    player.alive = true;
    player.left = false;
    player.death = null;
    player.revealedThisRound = false;
    player.abilityUsed = false;
    player.lastHealTarget = null;
    // Карты берём из пула, но если сервер принёс персонажей от модели —
    // используем их значения (порядок категорий тот же, что в TRAITS).
    const persona = Array.isArray(options.personas) ? options.personas[playerIndex] : null;
    player.traits = TRAITS.map((category, index) => ({
      cat: category.key,
      label: category.label,
      value:
        persona && typeof persona.values?.[index] === 'string'
          ? String(persona.values[index]).slice(0, 60)
          : pools[category.key][playerIndex % pools[category.key].length],
      revealed: false,
    }));
  });

  system(room, 'СИГНАЛ ТИШИНЫ', 'title');
  system(room, room.story.title, 'title');
  system(room, room.story.premise, 'info');
  if (room.story.threat) system(room, `Что настораживает: ${room.story.threat}.`, 'warn');
  system(
    room,
    `Смена: ${total} человек. Спасение — через ${room.rescueDay} дней. Бункер выдержит, только если в нём останется хотя бы ${room.crewMin}.`,
    'warn',
  );
  room.readyIds = room.players.filter((player) => player.isBot).map((player) => player.id);
  startPhase(room, 'intro', null, null);
  changed(room);
  return { ok: true };
}

// «Я прочитал»: сценарий открыт без таймера, день начинается, когда прочитали
// все (боты отмечаются сразу) или когда хост нажал «Начать день».
function markReady(code, playerId) {
  const room = rooms.get(normalizeCode(code));
  if (!room) return { ok: false, error: 'Бункер не найден.' };
  if (room.state !== 'intro') return { ok: false, error: 'Сценарий уже закрыт.' };
  const player = playerById(room, playerId);
  if (!player || !player.alive) return { ok: false, error: 'Вы не участвуете.' };
  room.readyIds = Array.isArray(room.readyIds) ? room.readyIds : [];
  if (!room.readyIds.includes(player.id)) room.readyIds.push(player.id);
  const total = room.players.filter((item) => !item.left).length;
  if (room.readyIds.length >= total) beginDay(room);
  else changed(room);
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
    rescueDay: null,
    crewMin: 3,
    messages: [],
    msgSeq: 0,
    votes: {},
    night: null,
    ability: null,
    readyIds: [],
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
  const wanted = cleanName(name);
  if (
    wanted &&
    room.players.some((player) => player.name.toLowerCase() === wanted.toLowerCase())
  ) {
    return { ok: false, error: 'Такой позывной уже занят в этом бункере.' };
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
    player.death = { day: room.day, cause: 'left', note: 'покинул игру' };
    player.token = null;
    player.connected = false;
    player.socketId = null;
    if (room.ability?.playerId === player.id) room.ability = null;
    system(room, `Выход: ${player.name}.`, 'warn');
    if (room.hostId === player.id) {
      const next = connectedPlayers(room)[0] || room.players.find((item) => item.id !== player.id) || null;
      room.hostId = next ? next.id : null;
    }
    const winner = checkEnd(room);
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
    // старая комната из базы: ночи больше нет
    resolveLegacyNight(room);
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
  revealMessage(room, player, trait);
  grantSupply(room, player, trait);
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
    if (target.id === player.id) return { ok: false, error: 'За себя голосовать нельзя.' };
  }
  room.votes[player.id] = targetId;
  checkVoteComplete(room);
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
  // Антифлуд: удержанный Enter не должен заливать ленту.
  const now = Date.now();
  if (player.lastChatAt && now - player.lastChatAt < CHAT_COOLDOWN_MS) {
    return { ok: false, error: 'Не так быстро — дайте остальным прочитать.' };
  }
  player.lastChatAt = now;
  chat(room, player, channel, clean);
  changed(room);
  return { ok: true };
}

function chatAvailability(room, player) {
  const result = { day: false, dead: false };
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
    player.traits = [];
    player.alive = true;
    player.left = false;
    player.death = null;
    player.revealedThisRound = false;
    player.abilityUsed = false;
    player.lastHealTarget = null;
  });
  room.state = 'lobby';
  room.turn = null;
  room.day = 0;
  room.event = null;
  room.usedEvents = [];
  room.resources = { food: 0, energy: 0, meds: 0 };
  room.votes = {};
  room.night = null;
  room.ability = null;
  room.readyIds = [];
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

// Спецвозможности. Одна на партию, только днём, с явным подтверждением:
// supply — сразу, swap/peek — через выбор карты и игрока.
function applySpecialSupply(room, player, special) {
  const parts = [];
  for (const [key, amount] of Object.entries(special.supply || {})) {
    if (!amount) continue;
    room.resources[key] = round1((room.resources[key] || 0) + amount);
    parts.push(`${RESOURCE_LABEL[key]} +${amount}`);
  }
  system(room, `${player.name} вскрывает НЗ: ${parts.join(', ')}.`, 'good');
}

function useAbility(code, playerId, payload = {}) {
  const room = rooms.get(normalizeCode(code));
  if (!room) return { ok: false, error: 'Бункер не найден.' };
  const player = playerById(room, playerId);
  if (!player || !player.alive) return { ok: false, error: 'Вы не участвуете.' };
  const trait = player.traits.find((item) => item.cat === 'special');
  const special = specialInfo(trait?.value);
  if (!special) return { ok: false, error: 'У вас нет спецвозможности.' };

  const action = typeof payload.action === 'string' ? payload.action : 'start';

  if (action === 'cancel') {
    if (room.ability?.playerId === player.id) {
      room.ability = null;
      changed(room);
    }
    return { ok: true };
  }

  if (!ABILITY_PHASES.includes(room.state)) {
    return { ok: false, error: 'Спецвозможность доступна только днём.' };
  }
  if (player.abilityUsed) return { ok: false, error: 'Возможность уже израсходована.' };
  if (room.ability && room.ability.playerId !== player.id) {
    return { ok: false, error: 'Сейчас кто-то уже применяет спецвозможность.' };
  }

  if (action === 'start') {
    if (special.kind === 'supply') {
      applySpecialSupply(room, player, special);
      player.abilityUsed = true;
      room.ability = null;
      changed(room);
      return { ok: true };
    }
    room.ability = {
      playerId: player.id,
      kind: special.kind,
      stage: special.kind === 'swap' ? 'category' : 'target',
      category: null,
    };
    changed(room);
    return { ok: true };
  }

  const pending = room.ability;
  if (!pending || pending.playerId !== player.id) {
    return { ok: false, error: 'Сначала начните спецвозможность.' };
  }

  if (pending.stage === 'category' && action === 'category') {
    const index = Number(payload.index);
    const chosen = player.traits[index];
    if (!chosen || chosen.cat === 'special') {
      return { ok: false, error: 'Эту карту менять нельзя.' };
    }
    pending.category = index;
    pending.stage = 'target';
    changed(room);
    return { ok: true };
  }

  if (pending.stage === 'target' && action === 'target') {
    const target = playerById(room, String(payload.target));
    if (!target || !target.alive) return { ok: false, error: 'Этот выживший уже не с нами.' };
    if (target.id === player.id) return { ok: false, error: 'Нужен другой выживший.' };

    if (pending.kind === 'swap') {
      const index = Number(pending.category);
      const mine = player.traits[index];
      const theirs = target.traits[index];
      if (!mine || !theirs || mine.cat === 'special') {
        return { ok: false, error: 'Карта не найдена.' };
      }
      player.traits[index] = theirs;
      target.traits[index] = mine;
      const open = mine.revealed && theirs.revealed;
      const detail = open
        ? ` Теперь у ${player.name} — ${theirs.value}, у ${target.name} — ${mine.value}.`
        : '';
      system(
        room,
        `Спецвозможность · ${player.name} и ${target.name} обменялись картами: ${mine.label}.${detail}`,
        'warn',
      );
    } else if (pending.kind === 'peek') {
      const hidden = target.traits.filter((item) => !item.revealed);
      const list = hidden.length
        ? hidden.map((item) => `${item.label}: ${item.value}`).join('; ')
        : 'все карты уже на столе';
      pushMessage(room, {
        channel: 'system',
        kind: 'system',
        tone: 'info',
        to: player.id,
        text: `Разведка · ${target.name} — ${list}.`,
      });
      system(room, `Спецвозможность · ${player.name} сверяется с досье ${target.name}.`, 'muted');
    } else {
      return { ok: false, error: 'Неизвестная спецвозможность.' };
    }

    player.abilityUsed = true;
    room.ability = null;
    changed(room);
    return { ok: true };
  }

  return { ok: false, error: 'Неизвестное действие.' };
}

function messagesFor(room, viewer) {
  return room.messages
    .filter((message) => {
      if (message.to) return message.to === viewer.id;
      if (room.state === 'end') return true;
      if (message.channel === 'dead') return !viewer.alive;
      return true;
    })
    .slice(-CHAT_LIMIT);
}

// Подсказки для обсуждения: не рандом, а факты дня — кто молчит, у кого
// закрыто больше всех, кто уже выложил слишком много карт.
function discussionHints(room, spokenToday) {
  if (room.state !== 'discussion') return [];
  // Готовые подсказки от модели (сервер кладёт их на входе в обсуждение).
  if (room.aiHints && room.aiHints.day === room.day && room.aiHints.list?.length) {
    return room.aiHints.list.slice(0, 3);
  }
  const alive = alivePlayers(room);
  if (!alive.length) return [];
  const hints = [];

  // Главная подсказка теперь про ресурсы и спасение, а не про роли.
  const daysLeft = Math.max(0, (room.rescueDay || 0) - room.day);
  const foodDays = Math.floor(room.resources.food / Math.max(1, alive.length));
  hints.push(
    foodDays <= 1
      ? `Еды осталось на день — пора решать, кто лишний за столом.`
      : `Еды хватит примерно на ${foodDays} дн., до спасения ${daysLeft} дн.`,
  );
  if (alive.length <= room.crewMin + 1) {
    hints.push(
      `В бункере ${alive.length} человек, минимум для смены — ${room.crewMin}. Следующее изгнание может стать последним для всех.`,
    );
  }

  const silent = alive.filter((player) => !spokenToday.has(player.id));
  if (silent.length) {
    const names = silent.slice(0, 3).map((player) => player.name);
    hints.push(
      `Сегодня ещё не говорили: ${names.join(', ')}${silent.length > 3 ? ` и ещё ${silent.length - 3}` : ''}.`,
    );
  }

  const closed = alive.filter((player) => player.traits.some((trait) => !trait.revealed));
  if (closed.length) {
    const player = closed[(room.day + room.gameId) % closed.length];
    const trait = player.traits.find((item) => !item.revealed);
    hints.push(`Спросите ${player.name}: что скрыто в категории «${trait.label}»?`);
  }

  // «больше всех» пишем только когда лидер действительно один: при равенстве
  // подсказка врёт и путает.
  const ranked = [...alive]
    .map((player) => ({
      player,
      count: player.traits.filter((trait) => trait.revealed).length,
    }))
    .sort((a, b) => b.count - a.count);
  if (ranked.length && ranked[0].count > 0 && ranked[0].count > (ranked[1]?.count ?? 0)) {
    hints.push(
      `У ${ranked[0].player.name} на столе больше всех карт (${ranked[0].count}) — версия должна быть стройнее.`,
    );
  }

  if (room.resources.meds <= 1) {
    hints.push('Медикаментов почти нет — кризис прикрыть больше нечем.');
  }

  return hints.slice(0, 3);
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

  // Кто сегодня уже говорил в зале — для блока подсказок на обсуждении.
  const spokenToday = new Set(
    room.messages
      .filter(
        (message) =>
          message.kind === 'chat' && message.day === room.day && message.channel === 'day',
      )
      .map((message) => message.authorId),
  );

  const players = room.players.map((player) => {
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
          effect: isRevealed && trait ? playerEffectText(trait) : null,
          impact: isRevealed && trait ? traitImpact(trait) : null,
        };
      }),
      traitsRevealed: revealedTraits.length,
      totalTraits: player.traits.length,
      spokeToday: spokenToday.has(player.id),
      revealedThisRound: Boolean(player.revealedThisRound),
      votedFor: room.state === 'vote' && room.votes[player.id] ? room.votes[player.id] : null,
      votesAgainst: votesAgainst[player.id] || 0,
    };
  });

  const myTraits = viewer.traits.map((trait) => ({
    cat: trait.cat,
    label: trait.label,
    value: trait.value,
    revealed: trait.revealed,
    effect: playerEffectText(trait),
    desc:
      trait.cat === 'special'
        ? specialInfo(trait.value)?.desc || ''
        : '',
  }));
  const me = {
    id: viewer.id,
    name: viewer.name,
    avatar: viewer.avatar,
    avatarIndex: viewer.avatarIndex,
    isHost: room.hostId === viewer.id,
    connected: viewer.connected,
    alive: viewer.alive,
    left: viewer.left,
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
    death: viewer.death,
    ability: (() => {
      const trait = viewer.traits.find((item) => item.cat === 'special');
      const special = specialInfo(trait?.value);
      if (!special) return null;
      const pending = room.ability?.playerId === viewer.id ? room.ability : null;
      return {
        kind: special.kind,
        label: special.label,
        desc: special.desc,
        used: Boolean(viewer.abilityUsed),
        available: Boolean(
          viewer.alive && !viewer.abilityUsed && ABILITY_PHASES.includes(room.state),
        ),
        pending: pending
          ? { stage: pending.stage, category: pending.category ?? null }
          : null,
        targets: alive
          .filter((item) => item.id !== viewer.id)
          .map((item) => ({
            id: item.id,
            name: item.name,
            avatar: item.avatar,
            avatarIndex: item.avatarIndex,
          })),
      };
    })(),
  };

  return {
    hints: discussionHints(room, spokenToday),
    code: room.code,
    state: room.state,
    day: room.day,
    gameId: room.gameId,
    hostId: room.hostId,
    settings: { ...room.settings },
    resources: { ...room.resources },
    event: room.event,
    story: room.story || null,
    crewMin: room.crewMin || crewMinFor(room.players.length),
    rescueDay: room.rescueDay || null,
    daysLeft: room.rescueDay ? Math.max(0, room.rescueDay - room.day) : null,
    players,
    me,
    turn,
    messages: messagesFor(room, viewer),
    winner: room.winner,
    recap: room.recap || null,
    recapPending: Boolean(room.recapPending),
    phaseEndsAt: room.phaseEndsAt,
    phaseStartedAt: room.phaseStartedAt,
    chat: availableChat,
    aliveCount: alive.length,
    totalCount: room.players.length,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    ready: {
      me: Boolean((room.readyIds || []).includes(viewer.id)),
      count: room.players.filter(
        (item) => !item.left && (room.readyIds || []).includes(item.id),
      ).length,
      total: room.players.filter((item) => !item.left).length,
    },
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
  // чистые помощники — для тестов экономики и характеристик
  scaleEffects,
  dailyCost,
  supplyOf,
  castVote,
  useAbility,
  markReady,
  sendChat,
  rematch,
  setPace,
  kickPlayer,
  serializeFor,
  cleanupRooms,
  resumeRoom,
  MIN_PLAYERS,
  MAX_PLAYERS,
};
