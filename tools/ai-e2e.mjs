// ИИ-слой на mock-режиме (без сети): персонажи, событие дня, разбор партии,
// голосовой скрипт. Проверяем, что пайплайн собирается и рендерится.
//
//   bun tools/ai-e2e.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUN = process.execPath;
const ROOT = join(import.meta.dir, "..");
const PORT = 3121;
const SITE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const note = (c, m) => {
  console.log(`${c ? "  ✓" : "  ✗"} ${m}`);
  if (!c) problems.push(m);
};

const dir = mkdtempSync(join(tmpdir(), "bunker-ai-"));
const server = spawn(BUN, ["run", "server.ts"], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    PORT: String(PORT),
    BUNKER_TEST: "1",
    BUNKER_AI: "mock",
    BUNKER_DB: join(dir, "ai.db"),
  },
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
  const H = "ai-host";
  await act(H, "create", { name: "Хост", avatar: "🦉" });
  await act(H, "bots", { count: 6 });
  const started = await act(H, "start");
  await sleep(600);
  note(started.status === 204, "партия стартовала");

  const roster = await page(H);
  const personas = (roster.match(/ИИ-профессия \d+/g) || []).length;
  note(personas >= 1, `персонажи пришли от модели (${personas} карт)`);

  // ждём второй день: событие должно прийти от ИИ
  let aiEvent = false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    const html = await page(H);
    if (/ИИ-событие/.test(html)) {
      aiEvent = true;
      break;
    }
    if ((await phase(H)) === "ИТОГ") break;
  }
  note(aiEvent, "событие дня сгенерировано моделью");

  // доводим до финала: хост скипает, если жив, иначе ждём таймеры
  let ended = false;
  for (let i = 0; i < 120; i += 1) {
    await sleep(400);
    if ((await phase(H)) === "ИТОГ") {
      ended = true;
      break;
    }
    await act(H, "skip");
  }
  note(ended, `партия дошла до финала (${await phase(H)})`);

  // разбор: сначала скелетон, потом текст
  let pending = false;
  let recap = "";
  for (let i = 0; i < 40; i += 1) {
    const html = await page(H);
    if (/recap-skeleton/.test(html)) pending = true;
    const title = html.match(/class="recap"[\s\S]{0,800}?<h4>([^<]*)<\/h4>/);
    if (title) {
      recap = title[1];
      break;
    }
    await sleep(300);
  }
  void pending;
  note(Boolean(recap), `разбор партии отрисован («${recap}»)`);
  const verdict = (await page(H)).match(/recap-verdict">([^<]*)/);
  note(Boolean(verdict && verdict[1].length), "у разбора есть итоговая фраза");

  const voice = await fetch(`${SITE}/voice.js`);
  note(voice.status === 200, `голосовой скрипт отдаётся (${voice.status})`);
  const appHtml = await page(H);
  note(/voice\.js/.test(appHtml), "voice.js подключён в игровом документе");
} finally {
  server.kill("SIGTERM");
  await sleep(300);
  rmSync(dir, { recursive: true, force: true });
}

console.log(problems.length ? `\nпровалы: ${problems.join(" | ")}` : "\nИИ: проверки прошли");
process.exit(problems.length ? 1 : 0);
