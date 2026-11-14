// Скриншоты визуальной редакции 2.0 в реальном Chromium/CDP.
//
//   SITE=http://127.0.0.1:3101 bun tools/shot-redesign.mjs
//  SITE=http://127.0.0.1:3101 ONLY=landing bun tools/shot-redesign.mjs
//
// Без SITE скрипт сам поднимает сервер на свободном порту с временной SQLite.
// OUT=... переопределяет каталог (по умолчанию — screenshots/).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import os from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUT = process.env.OUT || join(ROOT, "screenshots");
const CHROME =
  process.env.CHROME ||
  `${os.homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
if (!existsSync(CHROME)) throw new Error(`Не найден Chromium: ${CHROME}; задайте CHROME=...`);
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const temp = mkdtempSync(join(tmpdir(), "bunker-shots-"));
const port = 3700 + Math.floor(Math.random() * 200);
const SITE = process.env.SITE || `http://127.0.0.1:${port}`;
const server = process.env.SITE
  ? null
  : spawn(process.execPath, ["run", "server.ts"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), BUNKER_DB: join(temp, "shots.db") },
      stdio: ["ignore", "pipe", "pipe"],
    });
const cdpPort = 9500 + Math.floor(Math.random() * 300);
const chrome = spawn(
  CHROME,
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${join(temp, "profile")}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

let ws;
let seq = 0;
const pending = new Map();
const errors = [];
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    errors.push(text);
    throw new Error(text);
  }
  return result.result?.value;
};
const click = (selector) =>
  evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`);
const phase = () => evaluate(`document.getElementById("board")?.dataset.phase || ""`);
const viewport = async (width, height) => {
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 600,
  });
  await sleep(350);
};
const shot = async (name, fullPage = false) => {
  await sleep(1250);
  await evaluate("document.fonts.ready");
  const options = { format: "png", captureBeyondViewport: fullPage };
  if (fullPage) {
    const metrics = await send("Page.getLayoutMetrics");
    const width = Math.ceil(metrics.cssContentSize.width);
    const height = Math.ceil(metrics.cssContentSize.height);
    options.clip = { x: 0, y: 0, width, height, scale: 1 };
  }
  const png = await send("Page.captureScreenshot", options);
  writeFileSync(join(OUT, name), Buffer.from(png.data, "base64"));
  console.log(`  ✓ ${name}`);
};
const waitFor = async (predicate, attempts = 50) => {
  for (let i = 0; i < attempts; i += 1) {
    if (await predicate()) return;
    await sleep(120);
  }
  throw new Error("Таймаут ожидания состояния");
};
const gotoPhase = async (target) => {
  for (let i = 0; i < 60; i += 1) {
    const current = await phase();
    if (current === target) {
      await sleep(350);
      return;
    }
    if (current === "intro") await click(".intro-start");
    else await click(".skip-phase");
    await sleep(250);
  }
  throw new Error(`Не удалось перейти в фазу ${target}`);
};

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i += 1) {
    try {
      up = (await fetch(`${SITE}/health`, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      /* сервер ещё поднимается */
    }
    if (!up) await sleep(150);
  }
  if (!up) throw new Error(`Сервер не отвечает: ${SITE}`);

  let targets = [];
  for (let i = 0; i < 50 && !targets.length; i += 1) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    } catch {
      /* Chromium ещё поднимается */
    }
    if (!targets.length) await sleep(100);
  }
  ws = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve) => (ws.onopen = resolve));
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") {
      errors.push(message.params.exceptionDetails.text);
    }
    if (message.id && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      message.error
        ? request.reject(new Error(message.error.message))
        : request.resolve(message.result);
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await viewport(1440, 960);
  await send("Page.navigate", { url: `${SITE}/` });
  await waitFor(async () => Boolean(await evaluate(`document.querySelector(".create-card")`)));
  await shot("01-landing.png");
  await viewport(390, 844);
  await shot("08-mobile-landing.png", true);
  if (process.env.ONLY === "landing") {
    console.log("Скриншоты лендинга готовы");
  } else {
    await viewport(1440, 960);
    await evaluate(`(() => {
      const form = document.querySelector('.create-card');
      form.querySelector('input[name=name]').value = 'Ворон';
      form.querySelectorAll('input[name=avatar]')[2].checked = true;
      form.requestSubmit();
    })()`);
    await waitFor(async () => (await phase()) === "lobby");
    const code = await evaluate(`document.querySelector('#board h1 b')?.textContent?.trim()`);
    if (!/^[A-Z0-9]{4}$/.test(code || "")) throw new Error(`Не получен код комнаты: ${code}`);
    for (const [index, name] of ["Дозорный", "Вера", "Механик", "Дина"].entries()) {
      const response = await fetch(`${SITE}/act/join`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          cookie: `bunker_sid=shots-${Date.now()}-${index}`,
        },
        body: JSON.stringify({ payload: { code, name, avatar: ["🐺", "🦊", "🐻", "🦉"][index] } }),
      });
      if (response.status >= 400) throw new Error(`Игрок ${name}: HTTP ${response.status}`);
    }
    await waitFor(
      async () =>
        (await evaluate(`document.querySelectorAll('.lobby-player:not(.empty)').length`)) === 5,
    );
    await shot("02-lobby.png");
    await viewport(390, 844);
    await shot("09-mobile-lobby.png");

    await viewport(1440, 960);
    await click("#board .lobby-start .btn-primary");
    await waitFor(async () => (await phase()) === "intro");
    await shot("03-scenario.png");
    await viewport(390, 844);
    await shot("10-mobile-scenario.png");

    await viewport(1440, 960);
    await gotoPhase("reveal");
    await shot("04-reveal.png");
    await viewport(390, 844);
    await evaluate(`document.querySelector('.game-grid')?.scrollTo({top: 0})`);
    await shot("11-mobile-reveal.png");

    await viewport(1440, 960);
    await gotoPhase("discussion");
    await shot("05-discussion.png");
    await click(".ability-info");
    await waitFor(async () =>
      Boolean(await evaluate(`document.querySelector('#abilityHelp')?.open`)),
    );
    await shot("06-special.png");
    await click("#abilityHelp .modal-close");

    await gotoPhase("vote");
    await shot("07-vote.png");
    await viewport(390, 844);
    await click('.mtab[data-mtab-btn="chat"]');
    await waitFor(async () => (await evaluate(`document.documentElement.dataset.mtab`)) === "chat");
    await shot("12-mobile-chat.png");

    const overflow = await evaluate("document.documentElement.scrollWidth - innerWidth");
    if (overflow > 1) errors.push(`Горизонтальный скролл на мобильном: ${overflow}px`);
    console.log(`Комната ${code}; ошибок браузера: ${errors.length}`);
  }
  if (errors.length) console.error(errors.slice(0, 5));
} finally {
  try {
    ws?.close();
  } catch {
    /* соединение уже закрыто */
  }
  chrome.kill();
  server?.kill("SIGTERM");
  rmSync(temp, { recursive: true, force: true });
}

process.exitCode = errors.length ? 1 : 0;
