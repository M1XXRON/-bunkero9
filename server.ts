// БУНКЕР·9 — сервер на Bun + Datastar.
//
// Транспорт: одна SSE-лента на игрока (/stream), действия — POST /act/:cmd.
// Состояние игры целиком в src/engine.js: правила не переписывались,
// меняется только слой транспорта и рендера.

import {
  renderApp,
  renderBoard,
  renderOverlay,
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
const AVATARS = ["🦉", "🐺", "🦊", "🐻", "🦅", "🦌", "🐗", "🦎"];

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
setInterval(() => {
  engine.cleanupRooms();
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
  return snapshot.chat.day ? "day" : snapshot.chat.mafia ? "mafia" : "dead";
}

// ---------- широковещание ----------

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
    payload += patchElement(renderOverlay(snapshot));
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
  saveRoom(room);
  // финал партии пишем в историю один раз
  if (room.state === "end" && room.savedGameId !== room.gameId) {
    room.savedGameId = room.gameId;
    saveGame(room);
  }
  broadcast(room, currentOrigin);
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
  const payload = await readPayload(req);
  const room = session.room ? engine.rooms.get(session.room) : null;
  const playerId = session.player;

  const done = () => new Response(null, { status: 204 });

  switch (cmd) {
    case "create": {
      if (session.room && session.player) return fail(session, "Вы уже в бункере.");
      const result = engine.createRoom({
        name: payload.name,
        avatar: payload.avatar || AVATARS[0],
        socketId: sid,
      });
      if (!result.ok) return fail(session, result.error);
      session.room = result.room.code;
      session.player = result.player.id;
      session.phaseKey = "";
      session.lastPayload = "";
      saveSession(sid, result.room.code, result.player.id, null);
      broadcast(result.room, origin);
      return new Response(null, { status: 303, headers: { Location: "/", ...cookieFor(sid) } });
    }
    case "join": {
      // двойной клик по «Войти» не должен плодить второго персонажа
      if (session.room && session.player) return fail(session, "Вы уже в бункере.");
      const result = engine.joinRoom({
        code: payload.code,
        name: payload.name,
        avatar: payload.avatar || AVATARS[1],
        socketId: sid,
      });
      if (!result.ok) return fail(session, result.error);
      session.room = result.room.code;
      session.player = result.player.id;
      session.phaseKey = "";
      session.lastPayload = "";
      saveSession(sid, result.room.code, result.player.id, null);
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
      if (session.player)
        tabs.set(session.room + ":" + session.player, String(payload.tab || "day"));
      return done();
    }
    case "skip": {
      const result = engine.skipPhase(session.room, playerId);
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

function landingHtml(origin: string, error = ""): string {
  const avatars = AVATARS.map(
    (a, i) =>
      `<input type="radio" name="avatar" id="av${i}" value="${a}" ${i === 0 ? "checked" : ""}><label for="av${i}">${a}</label>`,
  ).join("");
  return `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>БУНКЕР·9 — Сигнал тишины</title>
<link rel="stylesheet" href="/style.css?v=3">
<script type="module" src="/sound.js"></script>
</head><body class="landing">
<main class="landing-main">
  <section class="landing-hero">
    <h1 class="wordmark">БУНКЕР<span class="wordmark-mark">·9</span></h1>
    <p class="tagline">Сигнал тишины</p>
    <p class="prose">Семнадцать дней назад мир замолчал. Вы — последние, кто успел закрыть за собой гермодверь. И кто-то внутри не был человеком ещё вчера.</p>
    <ul class="facts"><li>5–15 игроков</li><li>день и ночь</li><li>один голос — один изгнанный</li></ul>
  </section>
  <section class="landing-card panel">
    ${error ? `<p class="toast show">${error}</p>` : ""}
    <form method="post" action="/act/create" class="stack">
      <span class="eyebrow">СОЗДАТЬ БУНКЕР</span>
      <label>Позывной <input name="name" maxlength="16" required placeholder="Например, Ворон"></label>
      <fieldset class="avatars">${avatars}</fieldset>
      <button class="btn btn-primary btn-wide" type="submit">Открыть бункер</button>
    </form>
    <form method="post" action="/act/join" class="stack">
      <span class="eyebrow">ВОЙТИ ПО КОДУ</span>
      <div class="join-row">
        <input name="code" maxlength="4" required placeholder="КОД" class="code-input">
        <input name="name" maxlength="16" required placeholder="Позывной">
      </div>
      <input type="hidden" name="avatar" value="${AVATARS[1]}">
      <button class="btn btn-secondary btn-wide" type="submit">Войти</button>
    </form>
    <p class="note">Адрес: ${origin}</p>
  </section>
</main></body></html>`;
}

function appHtml(snapshot: any, origin: string): string {
  return `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>БУНКЕР·9 — ${snapshot.state === "lobby" ? "лобби" : "игра"}</title>
<link rel="stylesheet" href="/style.css?v=3">
<script type="module" src="/sound.js"></script>
<script type="module" src="/vendor/datastar-1.0.5.js"></script>
</head><body class="game">
${renderApp(snapshot, origin)}
<script>
// лента и модалки живут вне патчей, но ошибки сервера надо уметь гасить
document.addEventListener('click', (e) => {
  const t = e.target;
  if (t instanceof HTMLElement && t.closest('.modal-backdrop') && t.classList.contains('modal-backdrop')) {
    t.style.display = 'none';
  }
});
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
          payload += patchElement(renderOverlay(snapshot));
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
        return new Response(appHtml(data.snapshot, origin), {
          headers: { "content-type": "text/html; charset=utf-8", ...cookieFor(sid) },
        });
      }
      return new Response(landingHtml(origin), {
        headers: { "content-type": "text/html; charset=utf-8", ...cookieFor(sid) },
      });
    }

    for (const name of ["/style.css", "/sound.js", "/favicon.ico"]) {
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
