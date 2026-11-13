// Регресс: «Вы уже в бункере.» навсегда, когда комната/игрок исчезли, а cookie
// и сессия остались. Живой случай с прода: cleanupRooms убрал комнату, в
// памяти осталась сессия с room/player — лендинг на создание отвечал отказом,
// и выхода не было (крестик живёт в игровой оболочке).
//
//   bun tools/stale-session-e2e.mjs
//
// Поднимает свой сервер на временной базе, «теряет» комнату и проверяет, что
// создание после этого снова работает.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUN = process.execPath;
const ROOT = join(import.meta.dir, "..");
const PORT = 3112;
const SITE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const note = (c, m) => {
  console.log(`${c ? "  ✓" : "  ✗"} ${m}`);
  if (!c) problems.push(m);
};

const dir = mkdtempSync(join(tmpdir(), "bunker-stale-"));
const DB = join(dir, "stale.db");

const start = () =>
  spawn(BUN, ["run", "server.ts"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(PORT), BUNKER_DB: DB },
  });

const up = async () => {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${SITE}/health`, { signal: AbortSignal.timeout(1500) })).ok) return true;
    } catch {
      /* ждём */
    }
    await sleep(150);
  }
  return false;
};

const post = (sid, cmd, payload, form = false) =>
  fetch(`${SITE}/act/${cmd}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      ...(form
        ? { "content-type": "application/x-www-form-urlencoded" }
        : { "content-type": "application/json" }),
      ...(sid ? { cookie: `bunker_sid=${sid}` } : {}),
    },
    body: form ? new URLSearchParams(payload).toString() : JSON.stringify({ payload }),
  });

const page = async (sid) =>
  (await fetch(`${SITE}/`, { headers: { cookie: `bunker_sid=${sid}` } })).text();

let server = start();
if (!(await up())) {
  console.error("✗ сервер не поднялся");
  process.exit(1);
}

const SID = "stale-player";
await post(SID, "create", { name: "Застрявший", avatar: "🦉" });
let html = await page(SID);
const code = (html.match(/Код бункера <b>([A-Z0-9]{4})<\/b>/) || [])[1];
note(/^[A-Z0-9]{4}$/.test(code || ""), `комната создана (${code})`);

// «Теряем» комнату: убираем строку из базы, сессию оставляем как есть —
// именно так выглядит игрок, чью комнату унёс cleanupRooms (или чистка базы).
server.kill("SIGTERM");
await sleep(900);
{
  const { Database } = await import("bun:sqlite");
  const db = new Database(DB);
  db.prepare("DELETE FROM rooms WHERE code = ?").run(code);
  const sessions = db.prepare("SELECT sid, room FROM sessions").all();
  db.close();
  note(
    sessions.length === 1 && sessions[0].room === code,
    `сессия пережила потерю комнаты (${JSON.stringify(sessions)})`,
  );
}

server = start();
if (!(await up())) {
  console.error("✗ сервер не поднялся после рестарта");
  process.exit(1);
}

// До фикса здесь был отказ «Вы уже в бункере.» — и всё, тупик.
const recreate = await post(SID, "create", { name: "Застрявший", avatar: "🦉" }, true);
const loc = String(recreate.headers.get("location") || "");
note(
  recreate.status === 303 && !loc.includes("%D1%83%D0%B6%D0%B5"),
  `битая сессия больше не запирает на лендинге → ${recreate.status} ${loc}`,
);
html = await page(SID);
const newCode = (html.match(/Код бункера <b>([A-Z0-9]{4})<\/b>/) || [])[1];
note(/^[A-Z0-9]{4}$/.test(newCode || ""), `новая комната создана (${newCode})`);
note(newCode !== code, `код комнаты новый (${code} → ${newCode})`);

server.kill("SIGTERM");
await sleep(400);
rmSync(dir, { recursive: true, force: true });

console.log(
  problems.length ? `\nпровалы: ${problems.join(" | ")}` : "\nбитая сессия: проверки прошли",
);
process.exit(problems.length ? 1 : 0);
