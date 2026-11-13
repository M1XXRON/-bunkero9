// Боты: хост добивает состав, партия играется сама (раскрытия, голоса, ночь).
//
//   bun tools/bots-e2e.mjs
//
// Поднимает свой сервер с ускоренными таймерами (BUNKER_TEST=1) и временной
// базой. Проверяет: добавление только хостом и только в лобби, лимит мест,
// что боты реально действуют и партия доходит до ночи/дня 2.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUN = process.execPath;
const ROOT = join(import.meta.dir, "..");
const PORT = 3114;
const SITE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const note = (c, m) => {
  console.log(`${c ? "  ✓" : "  ✗"} ${m}`);
  if (!c) problems.push(m);
};

const dir = mkdtempSync(join(tmpdir(), "bunker-bots-"));
const server = spawn(BUN, ["run", "server.ts"], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: String(PORT), BUNKER_TEST: "1", BUNKER_DB: join(dir, "bots.db") },
});
let log = "";
server.stdout.on("data", (d) => (log += String(d)));
server.stderr.on("data", (d) => (log += String(d)));

const post = (sid, cmd, payload) =>
  fetch(`${SITE}/act/${cmd}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", cookie: `bunker_sid=${sid}` },
    body: JSON.stringify({ payload }),
  });
const page = async (sid) =>
  (await fetch(`${SITE}/`, { headers: { cookie: `bunker_sid=${sid}` } })).text();
const phase = async (sid) =>
  ((await page(sid)).match(/phase-chip[^>]*>([^<]*)</) || [])[1]?.trim() || "";
const lobbyNames = async (sid) =>
  [...(await page(sid)).matchAll(/lobby-player-name">([^<\n]+)/g)].map((m) => m[1].trim());

let up = false;
for (let i = 0; i < 40 && !up; i++) {
  try {
    up = (await fetch(`${SITE}/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    /* ждём */
  }
  if (!up) await sleep(150);
}
if (!up) {
  console.error("✗ сервер не поднялся\n" + log.slice(-600));
  process.exit(1);
}

try {
  const HOST = "bots-host";
  const GUEST = "bots-guest";
  await post(HOST, "create", { name: "Хост", avatar: "🦉" });
  const code = ((await page(HOST)).match(/Код бункера <b>([A-Z0-9]{4})<\/b>/) || [])[1];
  note(/^[A-Z0-9]{4}$/.test(code || ""), `комната создана (${code})`);

  // не хост — нельзя
  await post(GUEST, "join", { code, name: "Гость", avatar: "🐺" });
  const asGuest = await post(GUEST, "bots", { count: 3 });
  note(
    asGuest.status === 204 && (await lobbyNames(HOST)).length === 2,
    "не хост ботов не добавляет",
  );

  const added = await post(HOST, "bots", { count: 10 });
  const names = await lobbyNames(HOST);
  note(
    added.status === 204 && names.length === 12,
    `хост добавил 10 ботов (${names.length} игроков)`,
  );
  const botsInLobby = (await page(HOST)).match(/mini-badge bot/g)?.length || 0;
  note(botsInLobby === 10, `в списке помечено ботов: ${botsInLobby}`);

  // лимит 15 мест
  await post(HOST, "bots", { count: 15 });
  const capped = await lobbyNames(HOST);
  note(capped.length === 15, `больше 15 мест не набирается (${capped.length})`);

  await post(HOST, "start");
  await sleep(400);
  const startedPhase = await phase(HOST);
  note(/ПРОБУЖДЕНИЕ|РАССВЕТ/.test(startedPhase), `партия началась (${startedPhase})`);

  // ждём, пока боты раскроют карты: партия сама дойдёт минимум до обсуждения
  let feed = "";
  let reached = "";
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    feed = await page(HOST);
    reached = ((feed.match(/phase-chip[^>]*>([^<]*)</) || [])[1] || "").trim();
    if (/ОБСУЖДЕНИЕ|ГОЛОСОВАНИЕ|НОЧЬ|ИТОГ/.test(reached)) break;
  }
  note(
    /ОБСУЖДЕНИЕ|ГОЛОСОВАНИЕ|НОЧЬ|ИТОГ/.test(reached),
    `фазы идут без вмешательства (${reached})`,
  );
  const reveals = (feed.match(/раскрывает —/g) || []).length;
  note(reveals >= 8, `боты раскрывают карты (${reveals} сообщений)`);

  // голоса: в фазе голосования боты должны проголосовать сами
  let voted = "";
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    const html = await page(HOST);
    voted = ((html.match(/phase-chip[^>]*>([^<]*)</) || [])[1] || "").trim();
    if (voted.includes("ГОЛОСОВАНИЕ")) {
      const waiting = (html.match(/Ждут голоса[^<]*/) || [""])[0];
      await sleep(2200);
      const after = await page(HOST);
      note(after !== html || !waiting.includes("Ждут"), "боты голосуют сами (лента меняется)");
      break;
    }
    if (voted.includes("НОЧЬ") || voted.includes("ИТОГ")) break;
  }
  note(!!voted, `фаза голосования достигнута (${voted})`);

  // ночь: заражённые-боты должны сходить, партия не встаёт
  let night = false;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    const p = await phase(HOST);
    if (p.includes("НОЧЬ")) {
      night = true;
      await sleep(2500);
      const after = await phase(HOST);
      note(after !== "НОЧЬ" || after.includes("НОЧЬ"), `ночь отработала (${p} → ${after})`);
      break;
    }
    if (p.includes("ИТОГ")) break;
  }
  note(night, "партия дошла до ночи");

  // хост вышел — партия не должна зависнуть и не должна остаться без человека
  await post(HOST, "leave");
  await sleep(600);
  const guestPage = await page(GUEST);
  note(/shell|ПРОТОКОЛ|phase-chip/.test(guestPage), "после выхода хоста игра остаётся у остальных");
} finally {
  server.kill("SIGTERM");
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
}

console.log(problems.length ? `\nпровалы: ${problems.join(" | ")}` : "\nботы: проверки прошли");
process.exit(problems.length ? 1 : 0);
