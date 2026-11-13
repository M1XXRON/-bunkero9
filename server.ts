// БУНКЕР·9 — сервер на Bun + Datastar.
//
// Транспорт: одна SSE-лента на игрока (/stream), действия — POST /act/:cmd.
// Состояние игры целиком в src/engine.js: правила не переписывались,
// меняется только слой транспорта и рендера.

import {
  renderApp,
  renderBoard,
  renderDossierBody,
  renderTopbar,
  renderTabs,
  renderFeed,
  renderError,
  renderTitle,
} from "./src/render.ts";

import {
  saveRoom,
  saveRoomNow,
  dropRoom,
  loadRooms,
  saveGame,
  lastGames,
  saveSession,
  loadSessions,
  dropSessionsOfRoom,
  stats as dbStats,
  flush,
  dbPath,
} from "./src/store.ts";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const engine = require("./src/engine.js");

const PORT = Number(process.env.PORT || 3100);
// Путь к статике: в компилированном бинарнике import.meta.url указывает внутрь
// исполняемого файла, поэтому берём каталог запуска (cwd), а не location бандла.
const PUBLIC = process.env.PUBLIC_DIR ?? `${process.cwd()}/public`;
// Палитра одна на весь проект: список живёт в src/content.js и его же читает
// движок для avatarIndex. Раньше здесь был свой список из 8 эмодзи — любой
// отсутствующий в движке (например 🐗) молча подменялся на 🦉, и выбранная
// аватарка «пропадала».
const AVATARS: string[] = require("./src/content.js").AVATARS;

// Версия стилей = хеш содержимого файла. Раньше её поднимали руками и однажды
// забыли: браузер с Cloudflare держали старый CSS, и новая разметка разъехалась.
const STYLE_VER = (() => {
  try {
    const text = require("node:fs").readFileSync(`${PUBLIC}/style.css`, "utf8");
    return Bun.hash(text).toString(36).slice(0, 8);
  } catch {
    return "6";
  }
})();

type Session = {
  room: string | null;
  player: string | null;
  stream: ReadableStreamDefaultController<Uint8Array> | null;
  phaseKey: string;
  lastPayload: string;
};

const sessions = new Map<string, Session>();
const enc = new TextEncoder();

function newSid(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function sidOf(req: Request): string {
  const jar = new Bun.CookieMap(req.headers.get("cookie") ?? "");
  return jar.get("bunker_sid") ?? "";
}

// Брошенные комнаты: в прежнем сервере engine.cleanupRooms() крутился
// по таймеру, при переносе на Bun вызов потеряли — комнаты копились в памяти.
// Брошенная комната (все закрыли вкладки) раньше жила вечно: на вебе игрок
// никогда не помечается offline, поэтому правило движка «никто не подключён
// 30 минут» не срабатывало. Считаем иначе — по живости SSE и активности:
// ни одного открытого потока + ни одного изменения за IDLE_MINUTES.
const IDLE_MS = Number(process.env.BUNKER_IDLE_MIN || 30) * 60_000;

function hasLiveStream(code: string): boolean {
  for (const session of sessions.values()) {
    if (session.room === code && session.stream) return true;
  }
  return false;
}

function reapIdleRooms(): void {
  for (const room of [...engine.rooms.values()]) {
    const last = room.touchedAt || room.createdAt || 0;
    if (Date.now() - last < IDLE_MS) continue;
    if (hasLiveStream(room.code)) continue;
    clearTimeout(room.timer);
    botPhase.delete(room.code);
    engine.rooms.delete(room.code);
    dropRoom(room.code);
    dropSessionsOfRoom(room.code);
  }
}

setInterval(() => {
  engine.cleanupRooms();
  reapIdleRooms();
  // в базе не должно оставаться комнат, которых уже нет в памяти
  for (const row of loadRooms()) {
    if (!engine.rooms.has(row.code)) {
      dropRoom(row.code);
      dropSessionsOfRoom(row.code);
    }
  }
}, 30_000);

// Сессии без комнаты и закрытые потоки копятся — подчищаем раз в 10 минут.
setInterval(
  () => {
    for (const [sid, session] of sessions) {
      if (session.stream) continue;
      if (session.room && engine.rooms.get(session.room)) continue;
      sessions.delete(sid);
      if (session.room && session.player) {
        const room = engine.rooms.get(session.room);
        if (!room) tabs.clear();
      }
    }
  },
  10 * 60 * 1000,
).unref?.();

function sessionOf(sid: string): Session {
  // Клиент без cookie не должен попадать в чужую сессию: даём ему одноразовую,
  // которую не сохраняем (в неё нельзя войти — нет room).
  if (!sid) return { room: null, player: null, stream: null, phaseKey: "", lastPayload: "" };
  let session = sessions.get(sid);
  if (!session) {
    session = { room: null, player: null, stream: null, phaseKey: "", lastPayload: "" };
    sessions.set(sid, session);
  }
  return session;
}

// Заголовок собираем руками: меньше зависимости от версии Cookie-API в Bun.
function cookieFor(sid: string): Record<string, string> {
  return {
    "Set-Cookie": `bunker_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
  };
}

// ---------- снимок игрока ----------

function snapshotFor(session: Session) {
  if (!session.room || !session.player) return null;
  const room = engine.rooms.get(session.room);
  if (!room) return null;
  const player = room.players.find((p: { id: string }) => p.id === session.player);
  if (!player) return null;
  return { room, player, snapshot: engine.serializeFor(room, player) };
}

// ---------- патчи ----------

const patchElement = (html: string) =>
  `event: datastar-patch-elements\ndata: elements ${html.replace(/\n/g, "")}\n\n`;

// Тот же формат, но с адресацией по селектору (например, title)
const patchSelector = (selector: string, html: string) =>
  `event: datastar-patch-elements\ndata: selector ${selector}\ndata: elements ${html.replace(/\n/g, "")}\n\n`;

function phaseLabel(snapshot: any): string {
  const day = snapshot.day;
  switch (snapshot.state) {
    case "intro":
      return "РОЛИ РОЗДАНЫ";
    case "reveal":
      return `ДЕНЬ ${day} · РАСКРЫТИЕ КАРТ`;
    case "discussion":
      return `ДЕНЬ ${day} · ОБСУЖДЕНИЕ`;
    case "vote":
      return `ДЕНЬ ${day} · ГОЛОСОВАНИЕ`;
    case "night":
      return `НОЧЬ ${day} · СВЕТ ГАСНЕТ`;
    case "end":
      return "ПРОТОКОЛ ЗАВЕРШЁН";
    default:
      return "";
  }
}

const tabs = new Map<string, string>();
function sessionTab(session: Session): string {
  const data = snapshotFor(session);
  if (!data) return "day";
  const { snapshot } = data;
  const saved = session.room && snapshot ? tabs.get(session.room + ":" + session.player) : null;
  if (saved === "mafia" && snapshot.chat.mafia) return "mafia";
  if (saved === "dead" && snapshot.chat.dead) return "dead";
  // запасной вариант — «зал»: в ночи у людей каналов нет вовсе, и подпись
  // «Сообщение в мёртвых…» на закрытом поле только путала.
  return snapshot.chat.day
    ? "day"
    : snapshot.chat.mafia
      ? "mafia"
      : snapshot.chat.dead
        ? "dead"
        : "day";
}

// ---------- боты ----------
//
// Бот — обычный игрок из engine.joinRoom с фейковым socketId и флагом isBot:
// правил движка не касаемся, SSE-ленты у бота нет, broadcast его молча
// пропускает. Всё поведение — здесь, поверх публичного API движка.

const BOT_NAMES = [
  "Дозорный",
  "Механик",
  "Санитар",
  "Радист",
  "Повар",
  "Электрик",
  "Биолог",
  "Связист",
  "Штурман",
  "Металлург",
  "Химик",
  "Агроном",
  "Психолог",
  "Слесарь",
  "Навигатор",
];

const BOT_LINES = [
  "Я тут никого не знаю. И это взаимно.",
  "Профессия у меня мирная, но руки могу и приложить.",
  "Считаю по картам: двое врут.",
  "Меня больше беспокоит вентиляция, чем люди.",
  "Голосую по интуиции. Пока не подводила.",
  "Кто-то из нас не тот, за кого себя выдаёт.",
  "У меня с собой был фонарь и три пачки сигарет.",
  "Предлагаю не паниковать и смотреть на руки.",
  "Ночь покажет, кто действительно спал.",
  "Мне не нравится, как вы молчите.",
];

const pick = (list: any[]): any => list[Math.floor(Math.random() * list.length)];

// В комнате turn хранит order+index (без playerId — это поле снапшота).
const turnId = (room: any): string | null =>
  room.turn ? room.turn.order[room.turn.index] || null : null;

// Ускоренные таймеры (BUNKER_TEST=1) идут по 0.7–0.9 с — боты должны успевать.
const botDelay = () => (process.env.BUNKER_TEST === "1" ? 120 : 1200);

function addBots(room: any, count: number): number {
  if (room.state !== "lobby") return 0;
  const usedNames = new Set(room.players.map((p: any) => p.name.toLowerCase()));
  const usedAvatars = new Set(room.players.map((p: any) => p.avatar));
  let added = 0;
  for (let i = 0; i < count; i += 1) {
    if (room.players.length >= room.maxPlayers) break;
    const name =
      BOT_NAMES.find((n) => !usedNames.has(n.toLowerCase())) ?? `Бот-${room.players.length + 1}`;
    if (usedNames.has(name.toLowerCase())) break;
    const avatar = AVATARS.find((a) => !usedAvatars.has(a)) ?? AVATARS[i % AVATARS.length];
    const result = engine.joinRoom({
      code: room.code,
      name,
      avatar,
      socketId: `bot-${crypto.randomUUID()}`,
    });
    if (!result?.ok) break;
    // метка живёт в снимке комнаты (SQLite), так что переживает рестарт
    result.player.isBot = true;
    result.player.token = null;
    result.player.connected = true;
    usedNames.add(name.toLowerCase());
    usedAvatars.add(avatar);
    added += 1;
  }
  return added;
}

// Боты действуют раз в фазу: защита от повторного запуска на каждый патч.
const botPhase = new Map<string, string>();

function botTurn(room: any, bot: any): void {
  const current = engine.rooms.get(room.code);
  if (current !== room) return; // комната уже заменена/убрана // комната уже заменена/убрана
  const me = room.players.find((p: any) => p.id === bot.id);
  if (!me || !me.alive || me.left) return;

  if (room.state === "discussion" && room.day > (me.lastChatDay || 0)) {
    // один короткий реплика в день — оживляет ленту, но не спамит
    me.lastChatDay = room.day;
    if (Math.random() > 0.35) engine.sendChat(room.code, me.id, "day", pick(BOT_LINES));
    return;
  }

  // Пошаговое раскрытие: бот действует только в свой ход — сначала карта,
  // потом подтверждение хода.
  if (room.state === "reveal") {
    if (!room.turn || turnId(room) !== me.id) return;
    if (room.turn.stage === "reveal" && !me.revealedThisRound) {
      const index = me.traits.findIndex((t: any) => !t.revealed);
      if (index >= 0) engine.revealTrait(room.code, me.id, index);
      else engine.endTurn(room.code, me.id);
      return;
    }
    if (room.turn.stage === "confirm") engine.endTurn(room.code, me.id);
    return;
  }

  if (room.state === "vote" && !room.votes?.[me.id]) {
    const targets = room.players.filter((p: any) => p.alive && p.id !== me.id);
    if (targets.length) engine.castVote(room.code, me.id, pick(targets).id);
    return;
  }

  if (room.state === "night" && room.night) {
    if (me.role === "infected" && !room.night.mafiaVotes?.[me.id]) {
      const targets = room.players.filter((p: any) => p.alive && p.role !== "infected");
      const all = targets.length
        ? targets
        : room.players.filter((p: any) => p.alive && p.id !== me.id);
      if (all.length) engine.nightAction(room.code, me.id, pick(all).id);
      return;
    }
    if (me.role === "doctor" && !room.night.doctorTarget && !room.night.doctorSkip) {
      const targets = room.players.filter((p: any) => p.alive);
      if (targets.length && Math.random() > 0.35)
        engine.nightAction(room.code, me.id, pick(targets).id);
      else engine.doctorSkip(room.code, me.id);
    }
  }
}

function driveBots(room: any): void {
  const bots = room.players.filter((p: any) => p.isBot);
  if (!bots.length) return;

  // Хостом не может быть бот: игра встанет без человека (никто не начнёт партию
  // и не пропустит фазу). Если хост ушёл — передаём первому живому человеку.
  const host = room.players.find((p: any) => p.id === room.hostId);
  if (host?.isBot) {
    const human = room.players.find((p: any) => !p.isBot && !p.left);
    if (human) {
      room.hostId = human.id;
      saveRoom(room);
      broadcast(room, currentOrigin);
    }
  }

  // Людей не осталось — боты доиграют сами с собой вечно. Комнату убираем.
  if (!room.players.some((p: any) => !p.isBot && !p.left)) {
    botPhase.delete(room.code);
    clearTimeout(room.timer);
    engine.rooms.delete(room.code);
    return;
  }

  // В раскрытии ключ включает ход: иначе бот сходил бы один раз за фазу.
  const key = `${room.gameId}:${room.state}:${room.day}:${room.turn?.index ?? ""}:${room.turn?.stage ?? ""}`;
  if (botPhase.get(room.code) === key) return;
  botPhase.set(room.code, key);

  const alive = bots.filter((p: any) => p.alive && !p.left);
  // В пошаговой фазе ходит ровно один — не будим остальных.
  const currentId = room.state === "reveal" ? turnId(room) : null;
  const actors = currentId ? alive.filter((bot: any) => bot.id === currentId) : alive;
  // В пошаговой фазе ждёт только один бот — задержку не размазываем, иначе
  // партия на 15 игроков ползёт по секунде на ход.
  const isTest = process.env.BUNKER_TEST === "1";
  const stepDelay = room.state === "reveal" ? (isTest ? 60 : 500) : botDelay();
  const stagger = room.state === "reveal" ? 0 : isTest ? 40 : 500;
  actors.forEach((bot: any, i: number) => {
    setTimeout(
      () => {
        try {
          botTurn(room, bot);
        } catch {
          /* бот не должен ронять сервер */
        }
      },
      stepDelay + i * stagger,
    ).unref?.();
  });
}

// ---------- широковещание ----------

// Keepalive: Cloudflare (и любой прокси) закрывает простаивающий ответ примерно
// через 100 с. В тихой фазе (обсуждение — две минуты) событий нет вовсе, и
// соединение умирало — вкладки замирали до F5. Комментарий SSE не меняет DOM,
// но держит канал живым. Заодно ловятся мёртвые контроллеры.
setInterval(() => {
  for (const session of sessions.values()) {
    if (!session.stream) continue;
    try {
      session.stream.enqueue(enc.encode(": keepalive\n\n"));
    } catch {
      session.stream = null;
    }
  }
}, 15_000);

function broadcast(room: any, origin: string) {
  if (process.env.DEBUG_BROADCAST) {
    const live = [...sessions.entries()]
      .filter(([, s]) => s.stream)
      .map(([k, s]) => k.slice(0, 6) + ":" + s.room + "/" + (s.player || "").slice(0, 4));
    console.log("broadcast", room.code, "sessions", sessions.size, "streams", live);
  }
  for (const [sid, session] of sessions) {
    if (session.room !== room.code || !session.stream) continue;
    const player = room.players.find((p: { id: string }) => p.id === session.player);
    if (!player || !player.connected) continue;

    const snapshot = engine.serializeFor(room, player);
    const key = `${snapshot.gameId}:${snapshot.state}:${snapshot.day}`;
    const banner = session.phaseKey !== "" && session.phaseKey !== key;
    session.phaseKey = key;

    let payload = "";
    payload += patchElement(renderTopbar(snapshot));
    payload += patchElement(renderBoard(snapshot, origin, sessionTab(session)));
    payload += patchElement(renderDossierBody(snapshot));
    payload += patchSelector("title", renderTitle(snapshot));
    if (banner)
      payload += patchElement(
        `<div id="banner" class="phase-banner show" data-tone="${snapshot.state === "night" ? "night" : "day"}">${phaseLabel(snapshot)}</div>`,
      );

    if (payload === session.lastPayload) continue;
    session.lastPayload = payload;
    try {
      session.stream.enqueue(enc.encode(payload));
    } catch {
      session.stream = null;
    }
  }
}

engine.setChangeHandler((room: any) => {
  room.touchedAt = Date.now();
  saveRoom(room);
  // финал партии пишем в историю один раз
  if (room.state === "end" && room.savedGameId !== room.gameId) {
    room.savedGameId = room.gameId;
    saveGame(room);
  }
  broadcast(room, currentOrigin);
  // боты ходят вслед за фазой (у них нет своей ленты — им нужен внешний толчок)
  driveBots(room);
});

let currentOrigin = "";

// ---------- действия ----------

// Datastar шлёт JSON ({payload, signals}), обычные формы с лендинга — urlencoded.
async function readPayload(req: Request): Promise<Record<string, any>> {
  const type = req.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      const body = await req.json();
      return body?.payload ?? body?.signals ?? body ?? {};
    }
    if (type.includes("form")) {
      const form = await req.formData();
      return Object.fromEntries(form.entries());
    }
  } catch {
    /* пустое тело — вернём пустой объект */
  }
  return {};
}

// Обычные формы с лендинга не имеют SSE-ленты (#error прилетает только в игровую
// оболочку), а 204 браузер просто игнорирует — друг с опечаткой в коде комнаты
// не видел НИЧЕГО. Для форм отдаём 303 на лендинг с текстом, для Datastar/ботов —
// прежние 204.
const isFormPost = (req: Request) => (req.headers.get("content-type") ?? "").includes("form");

function landingFail(message: string, payload: Record<string, unknown> = {}): Response {
  // Позывной/аватар/код возвращаем в лендинг: игрок не должен терять выбор
  // аватара из-за опечатки в коде комнаты.
  const query = new URLSearchParams({ e: message });
  const name = typeof payload.name === "string" ? payload.name.trim().slice(0, 16) : "";
  const avatar = typeof payload.avatar === "string" ? payload.avatar : "";
  const code = typeof payload.code === "string" ? payload.code.trim().slice(0, 4) : "";
  if (name) query.set("n", name);
  if (AVATARS.includes(avatar)) query.set("a", avatar);
  if (code) query.set("c", code);
  return new Response(null, { status: 303, headers: { Location: `/?${query}` } });
}

function fail(session: Session, message: string): Response {
  if (session.stream) {
    try {
      session.stream.enqueue(enc.encode(patchElement(renderError(message))));
    } catch {
      /* поток уже закрыт */
    }
  }
  return new Response(null, { status: 204 });
}

async function handleAction(
  req: Request,
  cmd: string,
  sid: string,
  origin: string,
): Promise<Response> {
  const session = sessionOf(sid);

  // Cookie живёт месяц, а комната — нет: cleanupRooms убирает лобби без
  // подключённых (и игрока из него через 2 мин), сервер может подняться с
  // чистой базой. Старая сессия при этом запирала игрока на лендинге с
  // «Вы уже в бункере.» без единой возможности выйти. Если комната или игрок
  // исчезли — сессия битая, начинаем с чистого листа.
  if ((session.room || session.player) && !snapshotFor(session)) {
    session.room = null;
    session.player = null;
    session.stream = null;
    session.phaseKey = "";
    session.lastPayload = "";
    saveSession(sid, null, null, null);
  }

  const payload = await readPayload(req);
  const room = session.room ? engine.rooms.get(session.room) : null;
  const playerId = session.player;

  const done = () => new Response(null, { status: 204 });

  switch (cmd) {
    case "create": {
      if (session.room && session.player)
        return isFormPost(req)
          ? landingFail("Вы уже в бункере.", payload)
          : fail(session, "Вы уже в бункере.");
      const result = engine.createRoom({
        name: payload.name,
        avatar: payload.avatar || AVATARS[0],
        socketId: sid,
      });
      if (!result.ok)
        return isFormPost(req) ? landingFail(result.error, payload) : fail(session, result.error);
      session.room = result.room.code;
      session.player = result.player.id;
      session.phaseKey = "";
      session.lastPayload = "";
      saveSession(sid, result.room.code, result.player.id, null);
      // createRoom/joinRoom не зовут changed(), поэтому saveRoom сам по себе не
      // случится: без этого лобби жило только в памяти и исчезало при
      // рестарте (а cookie и сессия оставались — игрок получал тупик
      // «Вы уже в бункере.»).
      saveRoom(result.room);
      broadcast(result.room, origin);
      return new Response(null, { status: 303, headers: { Location: "/", ...cookieFor(sid) } });
    }
    case "join": {
      // двойной клик по «Войти» не должен плодить второго персонажа
      if (session.room && session.player)
        return isFormPost(req)
          ? landingFail("Вы уже в бункере.", payload)
          : fail(session, "Вы уже в бункере.");
      const result = engine.joinRoom({
        code: payload.code,
        name: payload.name,
        avatar: payload.avatar || AVATARS[1],
        socketId: sid,
      });
      if (!result.ok)
        return isFormPost(req) ? landingFail(result.error, payload) : fail(session, result.error);
      session.room = result.room.code;
      session.player = result.player.id;
      session.phaseKey = "";
      session.lastPayload = "";
      saveSession(sid, result.room.code, result.player.id, null);
      saveRoom(result.room);
      broadcast(result.room, origin);
      return new Response(null, { status: 303, headers: { Location: "/", ...cookieFor(sid) } });
    }
    case "start": {
      // исключение из общего правила: startGame принимает объект комнаты
      const result = room
        ? engine.startGame(room, playerId)
        : { ok: false, error: "Бункер не найден." };
      return result?.ok === false ? fail(session, result.error) : done();
    }
    case "pace": {
      const result = engine.setPace(session.room, playerId, payload.pace);
      return result?.ok === false ? fail(session, result.error) : done();
    }
    case "reveal": {
      const result = engine.revealTrait(session.room, playerId, Number(payload.index));
      return result?.ok === false ? fail(session, result.error) : done();
    }
    case "vote": {
      const result = engine.castVote(session.room, playerId, String(payload.target));
      return result?.ok === false ? fail(session, result.error) : done();
    }
    case "night": {
      const result = engine.nightAction(session.room, playerId, String(payload.target));
      return result?.ok === false ? fail(session, result.error) : done();
    }
    case "doctor-skip": {
      const result = engine.doctorSkip(session.room, playerId);
      return result?.ok === false ? fail(session, result.error) : done();
    }
    case "chat": {
      const channel =
        payload.channel === "mafia" || payload.channel === "dead" ? payload.channel : "day";
      if (session.player) tabs.set(session.room + ":" + session.player, channel);
      const result = engine.sendChat(session.room, playerId, channel, String(payload.text || ""));
      return result?.ok === false ? fail(session, result.error) : done();
    }
    case "tab": {
      if (session.player && session.room)
        tabs.set(session.room + ":" + session.player, String(payload.tab || "day"));
      // лента рендерится на сервере — без broadcast клик по табу ничего не меняет
      if (room) broadcast(room, origin);
      return done();
    }
    case "skip": {
      const result = engine.skipPhase(session.room, playerId);
      return result?.ok === false ? fail(session, result.error) : done();
    }
    case "bots": {
      if (!room) return fail(session, "Бункер не найден.");
      if (room.hostId !== playerId) return fail(session, "Ботов добавляет хост.");
      if (room.state !== "lobby") return fail(session, "Ботов можно добавить только до старта.");
      const count = Math.max(1, Math.min(15, Math.round(Number(payload.count) || 1)));
      const added = addBots(room, count);
      if (!added) return fail(session, "Мест больше нет.");
      saveRoom(room);
      broadcast(room, origin);
      return done();
    }
    case "end-turn": {
      // подтверждение конца хода при пошаговом раскрытии
      const result = engine.endTurn(session.room, playerId);
      return result?.ok === false ? fail(session, result.error) : done();
    }
    case "kick": {
      const result = engine.kickPlayer(session.room, playerId, String(payload.target));
      return result?.ok === false ? fail(session, result.error) : done();
    }
    case "rematch": {
      const result = engine.rematch(session.room, playerId);
      return result?.ok === false ? fail(session, result.error) : done();
    }
    case "leave": {
      if (session.room && session.player) engine.leaveRoom(session.room, session.player);
      saveSession(sid, null, null, null);
      session.room = null;
      session.player = null;
      return new Response(null, { status: 303, headers: { Location: "/" } });
    }
    default:
      return new Response("неизвестное действие", { status: 400 });
  }
}

// ---------- страницы ----------

// Текст ошибки приходит из query (?e=...) и попадает в HTML — экранируем.
const escText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function landingHtml(origin: string, error = "", keep: Record<string, string> = {}): string {
  const problem = error ? escText(error).slice(0, 200) : "";
  // Выбор игрока переживает неудачную попытку: иначе после любого отказа
  // (код с опечаткой, партия уже началась) позывной и аватар сбрасывались на
  // самые первые, и выглядело так, будто выбранное эмодзи «пропало».
  const chosenAvatar = AVATARS.includes(keep.avatar) ? keep.avatar : AVATARS[0];
  const name = escText(keep.name || "").slice(0, 16);
  const code = escText(keep.code || "")
    .slice(0, 4)
    .toUpperCase();
  const avatars = AVATARS.map(
    (a, i) =>
      `<input type="radio" name="avatar" id="av${i}" value="${a}" ${a === chosenAvatar ? "checked" : ""}><label for="av${i}">${a}</label>`,
  ).join("");
  return `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#101010">
<title>БУНКЕР·9 — Бункер онлайн</title>
<link rel="icon" href="/favicon.svg?v=1" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png?v=1" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Onest:wght@400;500;700;800;900&family=Inter:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/style.css?v=${STYLE_VER}">
<script type="module" src="/sound.js"></script>
</head><body class="landing">
<header class="landing-top">
  <span class="wordmark"><span class="wordmark-text">БУНКЕР</span><span class="wordmark-mark">·9</span></span>
  <span class="landing-top-note">бесплатная браузерная игра · без установки</span>
</header>
<main class="landing-main">
  <section class="landing-hero">
    <div class="hero-tags">
      <span class="tag">5–15 игроков</span>
      <span class="tag">день и ночь</span>
      <span class="tag">≈20 минут</span>
    </div>
    <h1 class="hero-title">БУНКЕР<span class="accent">·9</span></h1>
    <p class="hero-lead">Семнадцать дней назад мир замолчал. Вы — последние, кто успел закрыть за собой гермодверь, и кто-то внутри не был человеком ещё вчера. Один голос — один изгнанный.</p>
  </section>

  <section class="landing-forms">
    <form method="post" action="/act/create" class="landing-card">
      <span class="eyebrow">СОЗДАТЬ ИГРУ</span>
      <h2>Открыть бункер</h2>
      ${problem ? `<p class="toast">${problem}</p>` : ""}
      <label class="field">Позывной
        <input name="name" maxlength="16" required placeholder="Например, Ворон" value="${name}">
      </label>
      <fieldset class="avatars">${avatars}</fieldset>
      <button class="btn btn-primary btn-wide" type="submit">Создать игру</button>
    </form>

    <form method="post" action="/act/join" class="landing-card">
      <span class="eyebrow">ПОДКЛЮЧИТЬСЯ</span>
      <h2>Войти по коду</h2>
      <label class="field">Код комнаты
        <input name="code" maxlength="4" required placeholder="КОД" class="code-input" value="${code}">
      </label>
      <label class="field">Позывной
        <input name="name" maxlength="16" required placeholder="Позывной" value="${name}">
      </label>
      <input type="hidden" name="avatar" value="${AVATARS[1]}">
      <button class="btn btn-secondary btn-wide" type="submit">Подключиться</button>
    </form>
  </section>

  <p class="landing-foot">Адрес: ${origin}</p>
</main></body></html>`;
}

function appHtml(snapshot: any, origin: string, tab = "day"): string {
  return `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#101010">
<title>БУНКЕР·9 — ${snapshot.state === "lobby" ? "лобби" : "игра"}</title>
<link rel="icon" href="/favicon.svg?v=1" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png?v=1" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Onest:wght@400;500;700;800;900&family=Inter:wght@400;500;600&display=swap">
<link rel="stylesheet" href="/style.css?v=${STYLE_VER}">
<script type="module" src="/sound.js"></script>
<script type="module" src="/vendor/datastar-1.0.5.js"></script>
</head><body class="game">
${renderApp(snapshot, origin, tab)}
<script>
// лента и модалки живут вне патчей, но ошибки сервера надо уметь гасить
document.addEventListener('click', (e) => {
  const t = e.target;
  if (t instanceof HTMLElement && t.closest('.modal-backdrop') && t.classList.contains('modal-backdrop')) {
    t.style.display = 'none';
  }
});

// Подсказка «кто что раскрыл» при наведении на выжившего. Содержимое строки
// живёт в .peek-source (его присылает сервер, скрытые карты — без значений),
// а плавающая карточка стоит в оболочке и патчами не затирается.
(function () {
  const peek = document.getElementById('peek');
  if (!peek) return;
  let hideTimer = 0;
  let openRow = null;

  const show = (row) => {
    const src = row.querySelector('.peek-source');
    if (!src) return;
    clearTimeout(hideTimer);
    peek.innerHTML = src.innerHTML;
    peek.hidden = false;
    const r = row.getBoundingClientRect();
    const w = peek.offsetWidth;
    const h = peek.offsetHeight;
    const gap = 12;
    let left = r.right + gap;
    if (left + w > window.innerWidth - 8) left = r.left - w - gap;
    if (left < 8) left = Math.min(window.innerWidth - w - 8, Math.max(8, r.left));
    let top = r.top - 10;
    if (top + h > window.innerHeight - 8) top = window.innerHeight - h - 8;
    peek.style.left = Math.max(8, Math.round(left)) + 'px';
    peek.style.top = Math.max(8, Math.round(top)) + 'px';
    openRow = row;
  };

  const hide = (delay = 100) => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      peek.hidden = true;
      openRow = null;
    }, delay);
  };

  document.addEventListener('pointerover', (e) => {
    const row = e.target.closest && e.target.closest('[data-peek]');
    if (!row) return;
    show(row);
  });

  document.addEventListener('pointerout', (e) => {
    const row = e.target.closest && e.target.closest('[data-peek]');
    if (!row || row !== openRow) return;
    if (row.contains(e.relatedTarget)) return;
    hide();
  });

  // тап на телефоне: открыть и закрыть повторным тапом
  document.addEventListener('click', (e) => {
    const row = e.target.closest && e.target.closest('[data-peek]');
    if (!row || (e.target.closest && e.target.closest('.row-action'))) return;
    if (openRow === row && !peek.hidden) hide(0);
    else show(row);
  });

  window.addEventListener('scroll', () => hide(0), true);
  window.addEventListener('resize', () => hide(0));
  document.addEventListener('keydown', (e) => e.key === 'Escape' && hide(0));
})();
</script>
</body></html>`;
}

// ---------- сервер ----------

// восстановление комнат из базы: партии переживают рестарт
for (const saved of loadRooms()) {
  const room = engine.resumeRoom(saved);
  engine.rooms.set(room.code, room);
  console.log(
    `  ↑ восстановлена комната ${room.code} (${room.state}, день ${room.day}, игроков ${room.players.length})`,
  );
}

for (const saved of loadSessions()) {
  if (!saved.room || !engine.rooms.has(saved.room)) {
    dropSessionsOfRoom(saved.room ?? "");
    continue;
  }
  if (!sessions.has(saved.sid)) {
    sessions.set(saved.sid, {
      room: saved.room,
      player: saved.player,
      stream: null,
      phaseKey: "",
      lastPayload: "",
    });
  }
  if (saved.tab) tabs.set(`${saved.room}:${saved.player}`, saved.tab);
}
console.log(`  ↑ сессий восстановлено: ${loadSessions().length}`);

Bun.serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    // cookie выдаём всегда: без него нельзя ни создать бункер, ни войти
    const sid = sidOf(req) || newSid();
    const origin = `${url.protocol}//${url.host}`;
    currentOrigin = origin;

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        rooms: engine.rooms.size,
        sessions: sessions.size,
        db: dbStats(),
      });
    }

    if (url.pathname === "/api/games") {
      return Response.json({ games: lastGames(10) });
    }

    if (url.pathname.startsWith("/act/")) {
      const cmd = url.pathname.slice("/act/".length);
      return handleAction(req, cmd, sid, origin);
    }

    if (url.pathname === "/stream") {
      const session = sessionOf(sid);
      if (!session.room || !session.player) return new Response(null, { status: 204 });
      const data = snapshotFor(session);
      if (!data) return new Response(null, { status: 204 });

      // После рестарта сервера resumeRoom помечает всех offline. broadcast() таким
      // игрокам не шлёт НИЧЕГО — вкладка получала один снимок и замирала навсегда,
      // хотя соединение живое. Живой поток = игрок снова онлайн.
      data.room.touchedAt = Date.now();
      if (data.player.connected === false) {
        data.player.connected = true;
        data.player.disconnectedAt = null;
        saveRoom(data.room);
        broadcast(data.room, origin);
      }

      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          session.stream = controller;
          const snapshot = data.snapshot;
          const key = `${snapshot.gameId}:${snapshot.state}:${snapshot.day}`;
          session.phaseKey = key;
          session.lastPayload = "";
          let payload = "";
          payload += patchElement(renderTopbar(snapshot));
          payload += patchElement(renderBoard(snapshot, origin, sessionTab(session)));
          payload += patchElement(renderDossierBody(snapshot));
          controller.enqueue(enc.encode(payload));
        },
        cancel() {
          session.stream = null;
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        },
      });
    }

    // статика
    const assetPath = url.pathname;
    if (assetPath.startsWith("/vendor/")) {
      const file = Bun.file(`${PUBLIC}${assetPath}`);
      if (await file.exists()) {
        return new Response(file, {
          headers: { "cache-control": "public, max-age=60, must-revalidate" },
        });
      }
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const session = sessionOf(sid);
      const data = snapshotFor(session);
      if (data) {
        return new Response(appHtml(data.snapshot, origin, sessionTab(session)), {
          headers: { "content-type": "text/html; charset=utf-8", ...cookieFor(sid) },
        });
      }
      const note = url.searchParams.get("e") || "";
      const keep = {
        name: url.searchParams.get("n") || "",
        avatar: url.searchParams.get("a") || "",
        code: url.searchParams.get("c") || "",
      };
      return new Response(landingHtml(origin, note, keep), {
        headers: { "content-type": "text/html; charset=utf-8", ...cookieFor(sid) },
      });
    }

    // фавикон: SVG — для браузерных вкладок, PNG — для iOS и старых браузеров.
    // /favicon.ico спрашивают сами браузеры — отдаём 32-px PNG с правильным типом.
    if (url.pathname === "/favicon.ico") {
      const file = Bun.file(`${PUBLIC}/favicon-32.png`);
      if (await file.exists())
        return new Response(file, {
          headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" },
        });
    }

    for (const name of [
      "/style.css",
      "/sound.js",
      "/favicon.svg",
      "/favicon-32.png",
      "/apple-touch-icon.png",
    ]) {
      if (url.pathname === name) {
        const file = Bun.file(`${PUBLIC}${name}`);
        if (await file.exists()) {
          return new Response(file, {
            headers: { "cache-control": "public, max-age=60, must-revalidate" },
          });
        }
      }
    }

    return new Response("не найдено", { status: 404 });
  },
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    for (const room of engine.rooms.values()) saveRoomNow(room);
    flush();
    process.exit(0);
  });
}

console.log(
  `БУНКЕР·9 · bun ${Bun.version} · порт ${PORT} · база ${dbPath} (${dbStats().rooms} комнат, ${dbStats().games} партий)`,
);
