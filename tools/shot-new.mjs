// Снимок нового UI (Bun+Datastar) в двух размерах: десктоп и телефон.
//   SITE=https://next.bunker9.lol bun tools/shot-new.mjs
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";

const SITE = process.env.SITE || "http://localhost:3101";
const OUT = "/tmp/newui";
mkdirSync(OUT, { recursive: true });
const CHROME = `${os.homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOST_RULE = `--host-resolver-rules=MAP next.bunker9.lol 104.21.84.106`;

async function run(w, h, tag) {
  const PORT = 9260 + w;
  const chrome = spawn(
    CHROME,
    [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=/tmp/newui-${tag}-${Date.now()}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  let ws,
    id = 0;
  const pend = new Map();
  const send = (m, p = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pend.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, method: m, params: p }));
    });
  const ev = async (x) => {
    const r = await send("Runtime.evaluate", {
      expression: x,
      returnByValue: true,
      awaitPromise: true,
    });
    return r.exceptionDetails ? "ERR " + r.exceptionDetails.text : r.result.value;
  };
  let list;
  for (let i = 0; i < 40; i++) {
    try {
      list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      if (list.length) break;
    } catch {}
    await sleep(250);
  }
  ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id);
      pend.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: w,
    height: h,
    deviceScaleFactor: 2,
    mobile: w < 600,
  });
  await send("Page.navigate", { url: SITE + "/" });
  await sleep(1600);
  await ev(`(() => { const f = document.querySelector('form[action="/act/create"]');
    f.querySelector('input[name=name]').value = 'Ворон'; f.requestSubmit(); return 1; })()`);
  await sleep(2200);
  const code = await ev(`(document.querySelector('#board h1 b')||{}).textContent || ''`);
  for (const [i, n] of ["Борис", "Вера", "Глеб", "Дина"].entries()) {
    const r = await fetch(`${SITE}/act/join`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        cookie: `bunker_sid=shot${tag}${Date.now()}${i}`,
      },
      body: JSON.stringify({ payload: { code, name: n, avatar: "🦊" } }),
    });
    console.log("    join", n, "→", r.status, r.status >= 400 ? (await r.text()).slice(0, 60) : "");
  }
  await sleep(1300);
  console.log(
    "  игроков до старта:",
    await ev(`document.querySelectorAll('#board .lobby-player:not(.empty)').length`),
    "· кнопка:",
    await ev(`((document.querySelector('#board .btn-primary')||{}).textContent||'').trim()`),
    "· disabled:",
    await ev(`!!(document.querySelector('#board .btn-primary')||{}).disabled`),
  );
  await ev(`document.querySelector('#board .btn-primary')?.click()`);
  await sleep(1800);
  console.log(
    "  #game высота:",
    await ev(`getComputedStyle(document.getElementById('game')||document.body).height`),
    "· лента:",
    await ev(`(document.getElementById('banner')||{}).className`),
  );
  console.log("  #error:", await ev(`(document.getElementById('error')||{}).innerText || 'нет'`));
  const png = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/${tag}.png`, Buffer.from(png.data, "base64"));
  console.log(
    `${tag} (${w}×${h}) · код ${code} · фаза ${await ev(`(document.querySelector('.phase-chip')||{}).textContent`)} · колонок в сетке ${await ev(`getComputedStyle(document.querySelector('.game-grid')||document.body).gridTemplateColumns`)}`,
  );
  ws.close();
  chrome.kill();
}

await run(1400, 900, "desktop");
await run(390, 844, "mobile");
