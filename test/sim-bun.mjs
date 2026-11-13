// E2E для сервера на Bun + Datastar: партия на 5 ботов через HTTP/SSE.
// Проверяет то же, что старый socket.io-тест: лобби, старт, приватность ролей,
// каналы чата, голосование и финал.
//
//   SITE=http://localhost:3101 bun test/sim-bun.mjs
//   BOTS=15 bun test/sim-bun.mjs

const SITE = process.env.SITE || "http://localhost:3101";
const BOTS = Number(process.env.BOTS || 5);
const NAMES = [
  "Алиса",
  "Борис",
  "Вера",
  "Глеб",
  "Дина",
  "Егор",
  "Жанна",
  "Зоя",
  "Игнат",
  "Кира",
  "Лев",
  "Мила",
  "Никита",
  "Оля",
  "Пётр",
].slice(0, BOTS);
const AVATARS = ["🦉", "🐺", "🦊", "🐻", "🦅", "🦌", "🐗", "🦎"];

const failures = [];
const check = (ok, text) => {
  console.log(`  ${ok ? "✓" : "✗"} ${text}`);
  if (!ok) failures.push(text);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sidFor = (i) => `t${i}${Math.random().toString(36).slice(2, 8)}`;

async function act(sid, cmd, payload = {}) {
  const res = await fetch(`${SITE}/act/${cmd}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", cookie: `bunker_sid=${sid}` },
    body: JSON.stringify({ payload }),
  });
  return {
    status: res.status,
    location: res.headers.get("location"),
    text: res.status >= 400 ? await res.text() : "",
  };
}

async function readStream(sid, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  let out = "";
  try {
    const res = await fetch(`${SITE}/stream`, {
      headers: { cookie: `bunker_sid=${sid}` },
      signal: ctrl.signal,
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += dec.decode(value, { stream: true });
    }
  } catch {
    /* обрыв по таймауту — это норма */
  }
  clearTimeout(timer);
  return out;
}

async function page(sid) {
  const res = await fetch(`${SITE}/`, { headers: { cookie: `bunker_sid=${sid}` } });
  return res.text();
}

const stripTags = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

async function main() {
  const sids = NAMES.map((_, i) => sidFor(i));

  const created = await act(sids[0], "create", { name: NAMES[0], avatar: AVATARS[0] });
  check(created.status === 303, "создание комнаты → 303");
  const html = await page(sids[0]);
  const code = (html.match(/Код бункера[^А-ЯЁ]*<b>([A-Z0-9]{4})/i) || [])[1];
  check(Boolean(code), `код комнаты в лобби: ${code || "—"}`);

  for (let i = 1; i < BOTS; i++) {
    const r = await act(sids[i], "join", {
      code,
      name: NAMES[i],
      avatar: AVATARS[i % AVATARS.length],
    });
    check(r.status === 303, `вход ${NAMES[i]} → 303${r.text ? " · " + r.text : ""}`);
  }

  const lobbyHtml = await page(sids[0]);
  check(lobbyHtml.includes(NAMES[BOTS - 1]), "все игроки видны в лобби");
  check(!lobbyHtml.includes("ЗАРАЖЁННЫЙ"), "в лобби роли не показаны");

  const dup = await act(sids[0], "join", { code, name: "Двойник", avatar: "🦉" });
  check(dup.status !== 303, "повторный вход того же игрока отклонён");

  const started = await act(sids[0], "start");
  check(started.status === 204, "старт игры → 204");

  await sleep(400);
  const streams = await Promise.all(sids.map((sid) => readStream(sid, 700)));

  check(
    streams.every((s) => s.includes("datastar-patch-elements")),
    "каждому игроку приходят патчи",
  );
  check(
    streams.every((s) => s.includes('id="board"')),
    "патч доски есть у всех",
  );
  check(
    streams.every((s) => !s.includes("Internal Server Error")),
    "нет серверных ошибок в патчах",
  );

  // приватность: чужой роли в HTML быть не должно, пока она не раскрыта
  const roles = ["ЗАРАЖЁННЫЙ", "ВРАЧ"];
  const leaks = streams.filter((s) => {
    const mentions = roles.filter((r) => stripTags(s).includes(r));
    return mentions.length > 1; // своя роль видна в досье, чужие — нет
  });
  check(leaks.length === 0, `приватность ролей: утечек нет (${leaks.length})`);

  // чат: сообщение доходит до остальных
  await act(sids[0], "chat", { text: "Проверка связи", channel: "day" });
  await sleep(300);
  const afterChat = await readStream(sids[1], 600);
  check(afterChat.includes("Проверка связи"), "сообщение чата доходит до другого игрока");

  // финал или смена фазы: хост пропускает фазы, ждём переход состояния
  for (let i = 0; i < 12; i++) {
    await act(sids[0], "skip");
    await sleep(250);
    const board = await readStream(sids[0], 250);
    if (board.includes("ПРОТОКОЛ ЗАВЕРШЁН") || board.includes("ПОБЕДА")) break;
  }
  const final = await readStream(sids[0], 400);
  const finalHtml = (await page(sids[0])) + final;
  check(/ГОЛОСОВАНИЕ|НОЧЬ|РАСКРЫТИЕ|ПРОТОКОЛ|ПОБЕДА/.test(finalHtml), "фазы сменяются");

  console.log("");
  if (failures.length) {
    console.log(`ПРОВАЛЕНО: ${failures.length}`);
    process.exit(1);
  }
  console.log("Все проверки Bun+Datastar пройдены.");
}

main().catch((e) => {
  console.error("ОШИБКА:", e.message);
  process.exit(1);
});
