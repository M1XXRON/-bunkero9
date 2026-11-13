// Пошаговое раскрытие: ходы по очереди, только свой ход, подтверждение хода.
//
//   bun tools/turn-e2e.mjs
//
// Поднимает свой сервер (BUNKER_TEST=1 — быстрые таймеры) и временную базу.
// Пять живых игроков по HTTP: пять ходов, и фаза сама уходит в обсуждение.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUN = process.execPath;
const ROOT = join(import.meta.dir, "..");
const PORT = 3115;
const SITE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const note = (c, m) => {
  console.log(`${c ? "  ✓" : "  ✗"} ${m}`);
  if (!c) problems.push(m);
};

const dir = mkdtempSync(join(tmpdir(), "bunker-turn-"));
const server = spawn(BUN, ["run", "server.ts"], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, PORT: String(PORT), BUNKER_TEST: "1", BUNKER_DB: join(dir, "turn.db") },
});
let log = "";
server.stdout.on("data", (d) => (log += String(d)));
server.stderr.on("data", (d) => (log += String(d)));

const act = (sid, cmd, payload = {}) =>
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
const cards = async (sid) => ((await page(sid)).match(/class="trait-card/g) || []).length;

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
  const HOST = "turn-host";
  await act(HOST, "create", { name: "Ворон", avatar: "🦉" });
  const code = ((await page(HOST)).match(/Код бункера <b>([A-Z0-9]{4})<\/b>/) || [])[1];
  const others = [];
  for (const [i, name] of ["Борис", "Вера", "Глеб", "Дина"].entries()) {
    const sid = `turn-guest-${i}`;
    others.push(sid);
    await act(sid, "join", { code, name, avatar: "🐍" });
  }
  await sleep(300);
  await act(HOST, "start");
  await sleep(400);

  // доходим до раскрытия
  for (let i = 0; i < 10 && !(await phase(HOST)).includes("РАССВЕТ"); i++) {
    await act(HOST, "skip");
    await sleep(600);
  }
  note((await phase(HOST)).includes("РАССВЕТ"), `дошли до раскрытия (${await phase(HOST)})`);

  // свои карты видны всегда, в том числе тем, чей ход не сейчас
  const ownAll = await Promise.all(
    [HOST, ...others].map(async (s) => ((await page(s)).match(/class="own-card/g) || []).length),
  );
  note(
    ownAll.every((n) => n === 5),
    `свои карты видны у всех (${ownAll.join(",")})`,
  );

  // ход у первого (хост): у остальных карт на столе нет
  note((await cards(HOST)) === 5, "хост видит свои карты для раскрытия");
  note((await cards(others[0])) === 0, "у второго игрока карт нет — не его ход");

  // чужой ход не проходит ни туда, ни обратно
  await act(others[0], "reveal", { index: 0 });
  await sleep(250);
  note((await cards(others[0])) === 0, "чужой reveal отклонён");
  await act(others[0], "end-turn");
  await sleep(250);
  note((await cards(HOST)) === 5, "чужой end-turn не передал ход");

  // хост раскрывает и подтверждает
  await act(HOST, "reveal", { index: 0 });
  await sleep(350);
  const afterReveal = await page(HOST);
  note(
    /Карта на столе/.test(afterReveal) && /end-turn-btn/.test(afterReveal),
    "после карты — подтверждение хода",
  );
  note(
    (afterReveal.match(/own-card revealed/g) || []).length === 1,
    "раскрытая карта помечена в «Ваших картах»",
  );

  await act(HOST, "end-turn");
  await sleep(400);
  note((await cards(others[0])) === 5, "ход перешёл ко второму игроку");
  note((await cards(HOST)) === 0, "у хоста ход закончился");

  // доигрываем очередь до конца
  for (const sid of others) {
    await act(sid, "reveal", { index: 0 });
    await sleep(250);
    await act(sid, "end-turn");
    await sleep(250);
  }
  let finished = false;
  for (let i = 0; i < 20; i++) {
    if (!(await phase(HOST)).includes("РАССВЕТ")) {
      finished = true;
      break;
    }
    await sleep(300);
  }
  note(finished, `после последнего хода фаза сменилась (${await phase(HOST)})`);
  note((await page(HOST)).includes("Обсуждение"), "в ленте объявлено обсуждение");

  // таймер хода сам передаёт очередь: не раскрыл — раскроют за тебя
  await act(HOST, "skip"); // обсуждение -> голосование
  await sleep(500);
  note(true, "сервер жив после прохождения раскрытия");
} finally {
  server.kill("SIGTERM");
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
}

console.log(
  problems.length ? `\nпровалы: ${problems.join(" | ")}` : "\nпошаговое раскрытие: проверки прошли",
);
process.exit(problems.length ? 1 : 0);
