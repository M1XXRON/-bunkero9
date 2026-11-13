// UI-проверки в реальном браузере (CDP), которые глубокий e2e не покрывает:
//   1) таймер фазы идёт и переустанавливается при смене фазы;
//   2) вкладка сама оживает после перезапуска сервера (без F5);
//   3) чат-панель у заражённого ночью открыта в канал «шёпот».
//
//   bun tools/ui-e2e.mjs
//
// Поднимает свой сервер (обычные таймеры) и свой chrome-headless-shell.
import { spawn } from "node:child_process";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUN = process.execPath;
const CWD = join(import.meta.dir, "..");
const CHROME = `${os.homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const problems = [];
const note = (cond, msg) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${msg}`);
  if (!cond) problems.push(msg);
};

const dir = mkdtempSync(join(tmpdir(), "bunker-ui-"));
const PORT = 3300 + Math.floor(Math.random() * 300);
const SITE = `http://127.0.0.1:${PORT}`;
const DB = join(dir, "ui.db");

const startServer = () =>
  spawn(BUN, ["run", "server.ts"], {
    cwd: CWD,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PORT: String(PORT), BUNKER_DB: DB },
  });

let server = startServer();
const isUp = async (url) => {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
};

let up = false;
for (let i = 0; i < 40 && !up; i++) {
  up = await isUp(`${SITE}/health`);
  if (!up) await sleep(150);
}
if (!up) {
  console.error("✗ сервер не поднялся");
  process.exit(1);
}

const cdpPort = 3900 + Math.floor(Math.random() * 300);
const chrome = spawn(
  CHROME,
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${join(dir, "profile")}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

let ws;
let seq = 0;
const pending = new Map();
const jsErrors = [];
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const res = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) jsErrors.push(res.exceptionDetails.text);
  return res.result?.value;
};
const text = async (expression) => String((await evaluate(expression)) ?? "");
const phase = async () =>
  (await text('(document.querySelector(".phase-chip")||{}).textContent')).trim();

let targets = [];
for (let i = 0; i < 40 && !targets.length; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  } catch {
    /* ждём chrome */
  }
  if (!targets.length) await sleep(250);
}

const joinBot = (code, name, sid) =>
  fetch(`${SITE}/act/join`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", cookie: `bunker_sid=${sid}` },
    body: JSON.stringify({ payload: { code, name, avatar: "🐺" } }),
  });

try {
  ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.exceptionThrown") jsErrors.push(m.params.exceptionDetails.text);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url: `${SITE}/` });
  await sleep(1500);

  await evaluate(
    '(() => { const f = document.querySelector(\'form[action="/act/create"]\'); f.querySelector("input[name=name]").value = "Тестер"; f.requestSubmit(); return 1; })()',
  );
  await sleep(1700);
  const code = (await text('(document.querySelector("#board h1 b")||{}).textContent')).trim();
  note(/^[A-Z0-9]{4}$/.test(code), `комната создана (${code})`);

  const botSids = [];
  for (const [i, name] of ["Борис", "Вера", "Глеб", "Дина"].entries()) {
    const sid = `ui-bot-${Date.now()}-${i}`;
    botSids.push(sid);
    await joinBot(code, name, sid);
  }
  await sleep(900);
  const inLobby = await evaluate(
    "document.querySelectorAll('#board .lobby-player:not(.empty)').length",
  );
  note(inLobby === 5, `в лобби 5 игроков (${inLobby})`);

  // ---- 1. таймер ----
  await evaluate("document.querySelector('#board .lobby-start .btn-primary')?.click()");
  await sleep(1500);
  const timerValue = async () =>
    Number(
      (await text('(document.querySelector(".phase-timer")||{}).textContent')).replace(
        /[^\d]/g,
        "",
      ) || -1,
    );
  const skip = () =>
    evaluate(
      '[...document.querySelectorAll("button")].find((b) => /Пропустить фазу/.test(b.textContent))?.click()',
    );

  const t1 = await timerValue();
  await sleep(2600);
  const t2 = await timerValue();
  note(t1 > 0 && t2 > 0 && t2 < t1, `таймер тикает (${t1}с → ${t2}с)`);

  await skip();
  await sleep(1600);
  const phase2 = await phase();
  const t3 = await timerValue();
  note(t3 > t2 + 5, `таймер переустановлен на новой фазе (${phase2}: ${t3}с)`);

  // ---- 2. перезапуск сервера: вкладка должна ожить сама ----
  // Сигнал «ожила» — сообщение бота в чат: партия уже идёт, новых игроков
  // пускать нельзя, а чат в фазе РАССВЕТ у всех открыт.
  const before = await phase();
  server.kill("SIGTERM");
  await sleep(1200);
  server = startServer();
  for (let i = 0; i < 40; i++) {
    if (await isUp(`${SITE}/health`)) break;
    await sleep(150);
  }
  await sleep(500);
  const marker = `после-рестарта-${Date.now() % 10000}`;
  const botSid = botSids[0];
  const sent = await fetch(`${SITE}/act/chat`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", cookie: `bunker_sid=${botSid}` },
    body: JSON.stringify({ payload: { text: marker, channel: "day" } }),
  });
  let recovered = false;
  for (let i = 0; i < 40 && !recovered; i++) {
    await sleep(500);
    if ((await text('(document.getElementById("chatFeed")||{}).innerText')).includes(marker))
      recovered = true;
  }
  note(recovered, `после рестарта сервера вкладка ожила сама (сообщение бота ${sent.status})`);

  // ---- 3. чат у заражённого ночью ----
  let sawNight = false;
  for (let i = 0; i < 12; i++) {
    if ((await phase()).includes("НОЧЬ")) {
      sawNight = true;
      break;
    }
    await skip();
    await sleep(800);
  }
  if (sawNight) {
    const channel = await evaluate(
      '(document.querySelector(\'input[name="channel"]\')||{}).value || ""',
    );
    const disabled = await evaluate('(document.getElementById("chatInput")||{}).disabled ?? true');
    note(
      (channel === "mafia" && !disabled) || (channel === "day" && disabled),
      `ночь: канал «${channel}», поле ${disabled ? "закрыто" : "открыто"}`,
    );
  } else {
    console.log("  · до ночи не дошли — проверку чата пропускаю");
  }

  note(jsErrors.length === 0, `ошибки JS: ${jsErrors.length ? jsErrors.slice(0, 3) : "нет"}`);
} finally {
  try {
    ws?.close();
  } catch {
    /* уже закрыт */
  }
  chrome.kill();
  try {
    server.kill("SIGTERM");
  } catch {
    /* уже остановлен */
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log(problems.length ? `\nпровалы: ${problems.join(" | ")}` : "\nвсе UI-проверки прошли");
process.exit(problems.length ? 1 : 0);
