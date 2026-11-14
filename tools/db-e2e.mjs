// Проверка персистентности (bun:sqlite): комната, сессии и история партий
// переживают перезапуск сервера. Запуск: bun tools/db-e2e.mjs
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";

const PORT = 3111;
const DB = "/tmp/bunker-test.db";
const ROOT = new URL("..", import.meta.url).pathname;
const BUN = `${process.env.HOME}/.bun/bin/bun`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const ok = (c, m) => {
  console.log(`${c ? "  ✓" : "  ✗"} ${m}`);
  if (!c) problems.push(m);
};

function start() {
  const p = spawn(BUN, ["run", "server.ts"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), BUNKER_DB: DB },
    stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", (d) => process.stdout.write(`    [srv] ${d}`));
  return p;
}
const post = (sid, cmd, payload) =>
  fetch(`http://127.0.0.1:${PORT}/act/${cmd}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", cookie: `bunker_sid=${sid}` },
    body: JSON.stringify({ payload }),
  });
const page = async (sid) =>
  (await fetch(`http://127.0.0.1:${PORT}/`, { headers: { cookie: `bunker_sid=${sid}` } })).text();
const health = async () => await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();

rmSync(DB, { force: true });
rmSync(`${DB}-wal`, { force: true });
rmSync(`${DB}-shm`, { force: true });

let server = start();
await sleep(1800);

const H = "sess-host";
await post(H, "create", { name: "Хост", avatar: "🦉" });
const html = await page(H);
const code = (html.match(/Код бункера <b>([A-Z0-9]{4})<\/b>/) || [])[1];
ok(!!code, `комната создана (${code})`);
// createRoom не зовёт changed(): без явного saveRoom лобби до старта партии
// не попадало в базу и пропадало при рестарте, оставляя игрока с cookie без комнаты.
await sleep(500);
const dbAfterCreate = await health();
ok(dbAfterCreate.db?.rooms >= 1, `лобби до старта уже в базе (rooms=${dbAfterCreate.db?.rooms})`);
for (const [i, n] of ["Борис", "Вера", "Глеб", "Дина"].entries())
  await post(`sess-${i}`, "join", { code, name: n, avatar: "🦊" });
await sleep(600);
await post(H, "start");
await sleep(900);
const phaseBefore = ((await page(H)).match(/phase-chip[^>]*>([^<]+)</) || [])[1]?.trim();
ok(!!phaseBefore, `партия идёт, фаза: ${phaseBefore}`);
const token = (await page(H)).match(/bunker_sid=([a-z0-9]+)/i)?.[1];

console.log("  · убиваю сервер (SIGTERM) и запускаю снова");
server.kill("SIGTERM");
await sleep(900);
server = start();
await sleep(1800);

const after = await health();
ok(after.rooms === 1, `комната восстановлена из базы (rooms=${after.rooms})`);
ok(after.db && after.db.rooms >= 1, `в базе ${after.db?.rooms} комнат`);

const htmlAfter = await page(H);
const codeAfter =
  (htmlAfter.match(/class="room-code"[^>]*>\s*([A-Z0-9]{4})/) || [])[1] ??
  (htmlAfter.match(/room-code-chip[^>]*>\s*([A-Z0-9]{4})/) || [])[1] ??
  (htmlAfter.match(/Код бункера <b>([A-Z0-9]{4})<\/b>/) || [])[1];
const phaseAfter = (htmlAfter.match(/phase-chip[^>]*>([^<]+)</) || [])[1]?.trim();
ok(codeAfter === code, `та же комната после рестарта (${codeAfter})`);
ok(!!phaseAfter, `фаза после рестарта: ${phaseAfter}`);

// игрок возвращается по токену после рестарта
const r = await fetch(`http://127.0.0.1:${PORT}/act/join`, {
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/json", cookie: "new-session" },
  body: JSON.stringify({ payload: { token } }),
});
ok([303, 204].includes(r.status), `попытка возврата по токену: ${r.status}`);

// доводим до финала и проверяем историю
let finished = false;
for (let i = 0; i < 26; i++) {
  await post(H, "skip");
  await sleep(450);
  const h = await health();
  if (h.db && h.db.games > 0) {
    finished = true;
    break;
  }
}
ok(finished, "партия дошла до финала и записана в историю");
const games = await (await fetch(`http://127.0.0.1:${PORT}/api/games`)).json();
ok(Array.isArray(games.games), `история партий доступна (${games.games.length})`);

server.kill("SIGTERM");
await sleep(500);
console.log("\nпровалы:", problems.length ? problems : "нет");
process.exitCode = problems.length ? 1 : 0;
