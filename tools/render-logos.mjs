// Генерация витрины из 6 концептов логотипа БУНКЕР·9 в реальном Chromium.
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import os from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "screenshots", "logo-concepts.png");
const CHROME =
  process.env.CHROME ||
  `${os.homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const temp = mkdtempSync(join(tmpdir(), "bunker-logos-"));
const cdpPort = 9600 + Math.floor(Math.random() * 200);

const html = `<!doctype html>
<html lang="ru"><head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Onest:wght@500;700;800;900&family=JetBrains+Mono:wght@500;600;700&display=swap">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 1440px;
    background:
      radial-gradient(900px 500px at 85% 0%, rgba(255, 91, 54, 0.08), transparent 70%),
      radial-gradient(800px 500px at 10% 100%, rgba(169, 206, 124, 0.06), transparent 70%),
      #090b08;
    color: #f4f2ec;
    font-family: "Onest", -apple-system, sans-serif;
    padding: 40px 48px 48px;
  }
  .head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    margin-bottom: 28px;
    padding-bottom: 18px;
    border-bottom: 1px solid #283022;
  }
  .kicker {
    font: 600 11px/1 "JetBrains Mono", monospace;
    letter-spacing: 0.18em;
    color: #9bb282;
    margin-bottom: 8px;
    display: block;
  }
  h1 {
    font-size: 34px;
    font-weight: 900;
    letter-spacing: -0.04em;
  }
  h1 span { color: #ff5b36; }
  .sub {
    font: 500 12px/1.4 "JetBrains Mono", monospace;
    color: #7c896d;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 20px;
  }
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 24px 24px 20px;
    border: 1px solid #2b3324;
    border-radius: 20px;
    background:
      radial-gradient(280px 160px at 100% 0%, rgba(255, 91, 54, 0.05), transparent 70%),
      linear-gradient(150deg, #151912, #0e110c);
    box-shadow: 0 20px 50px rgba(0,0,0,0.35), inset 0 1px rgba(255,255,255,0.03);
    min-height: 290px;
  }
  .card-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .num {
    padding: 4px 10px;
    border-radius: 999px;
    border: 1px solid rgba(255, 91, 54, 0.4);
    background: rgba(255, 91, 54, 0.1);
    color: #ffb199;
    font: 700 11px/1 "JetBrains Mono", monospace;
    letter-spacing: 0.1em;
  }
  .style-tag {
    font: 500 10px/1 "JetBrains Mono", monospace;
    letter-spacing: 0.12em;
    color: #6f7d60;
    text-transform: uppercase;
  }
  .stage {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 18px;
    margin: 26px 0;
    padding: 26px 18px;
    border-radius: 14px;
    background: #0a0c09;
    border: 1px solid #1f261a;
  }
  .desc h3 {
    font-size: 17px;
    font-weight: 800;
    letter-spacing: -0.02em;
    margin-bottom: 5px;
    color: #eef2e6;
  }
  .desc p {
    font-size: 12.5px;
    line-height: 1.45;
    color: #88947a;
  }

  /* Wordmark treatments */
  .wm {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .wm-main {
    font-size: 28px;
    font-weight: 900;
    letter-spacing: -0.045em;
    line-height: 1;
    color: #f5f4ee;
    display: flex;
    align-items: baseline;
  }
  .wm-main .acc { color: #ff5b36; }
  .wm-sub {
    font: 600 8.5px/1 "JetBrains Mono", monospace;
    letter-spacing: 0.22em;
    color: #778667;
    text-transform: uppercase;
  }

  /* Variant specific */
  .v2 .wm-main { letter-spacing: -0.02em; }
  .v2 .pill-9 {
    margin-left: 6px;
    padding: 2px 7px;
    border-radius: 6px;
    background: #ff5b36;
    color: #090b08;
    font: 800 21px/1 "JetBrains Mono", monospace;
  }
  .v4 .wm-main {
    font-family: "Onest", sans-serif;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }
  .v4 .stencil-box {
    margin-left: 6px;
    padding: 2px 7px;
    border: 2px solid #ff5b36;
    color: #ff5b36;
    font: 800 20px/1 "JetBrains Mono", monospace;
  }
  .v6 .wm-main {
    font-weight: 900;
    letter-spacing: -0.06em;
  }
</style>
</head>
<body>
  <div class="head">
    <div>
      <span class="kicker">КОНЦЕПТЫ АЙДЕНТИКИ · БУНКЕР·9</span>
      <h1>Выбери новый логотип <span>БУНКЕР·9</span></h1>
    </div>
    <div class="sub">Напиши номер варианта (01–06) — поставлю его в шапку, лендинг и фавикон</div>
  </div>

  <div class="grid">
    <!-- 01 -->
    <div class="card v1">
      <div class="card-top"><span class="num">ВАРИАНТ 01</span><span class="style-tag">BLAST DOOR / ШЛЮЗ</span></div>
      <div class="stage">
        <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
          <circle cx="28" cy="28" r="25" fill="#141811" stroke="#3c4732" stroke-width="2"/>
          <circle cx="28" cy="28" r="20" stroke="#ff5b36" stroke-width="1.5" stroke-dasharray="6 4"/>
          <path d="M28 3v6M28 47v6M3 28h6M47 28h6" stroke="#9bb282" stroke-width="2.5" stroke-linecap="round"/>
          <circle cx="28" cy="28" r="13" fill="#0d100b" stroke="#536244" stroke-width="1.5"/>
          <text x="28" y="34" text-anchor="middle" fill="#ff5b36" font-family="Onest" font-weight="900" font-size="18">9</text>
        </svg>
        <div class="wm">
          <div class="wm-main">БУНКЕР<span class="acc">·9</span></div>
          <div class="wm-sub">ГЕРМОЗАТВОР ЗАКРЫТ</div>
        </div>
      </div>
      <div class="desc">
        <h3>01. Гермозатвор «Кольцо-9»</h3>
        <p>Массивное колесо бункерного шлюза с четырьмя силовыми ригелями и огненной девяткой в ядре.</p>
      </div>
    </div>

    <!-- 02 -->
    <div class="card v2">
      <div class="card-top"><span class="num">ВАРИАНТ 02</span><span class="style-tag">RADAR TELEMETRY</span></div>
      <div class="stage">
        <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
          <rect x="3" y="3" width="50" height="50" rx="14" fill="#121710" stroke="#39452f" stroke-width="1.8"/>
          <circle cx="28" cy="28" r="17" stroke="#313d28" stroke-width="1.4"/>
          <circle cx="28" cy="28" r="9" stroke="#313d28" stroke-width="1.2" stroke-dasharray="3 3"/>
          <path d="M28 28 L42 16 A18 18 0 0 1 45 28 Z" fill="rgba(255,91,54,0.32)"/>
          <line x1="28" y1="28" x2="42" y2="16" stroke="#ff5b36" stroke-width="2" stroke-linecap="round"/>
          <circle cx="28" cy="28" r="3" fill="#a9ce7c"/>
          <circle cx="37" cy="22" r="2.2" fill="#ff5b36"/>
        </svg>
        <div class="wm">
          <div class="wm-main">БУНКЕР<span class="pill-9">09</span></div>
          <div class="wm-sub">СИГНАЛ ТИШИНЫ</div>
        </div>
      </div>
      <div class="desc">
        <h3>02. Радар «Сигнал тишины»</h3>
        <p>Экран пеленгатора с засечкой сигнала и контрастной плашкой [09] в духе военной телеметрии.</p>
      </div>
    </div>

    <!-- 03 -->
    <div class="card v3">
      <div class="card-top"><span class="num">ВАРИАНТ 03</span><span class="style-tag">HEX ARMOR / ЩИТ</span></div>
      <div class="stage">
        <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
          <polygon points="28,3 50,15.5 50,40.5 28,53 6,40.5 6,15.5" fill="#141911" stroke="#4a583d" stroke-width="2"/>
          <polygon points="28,8 45,18 45,38 28,48 11,38 11,18" fill="#0c0f0a" stroke="#ff5b36" stroke-width="1.4"/>
          <path d="M18 23 L28 17 L38 23" stroke="#a9ce7c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <text x="28" y="38" text-anchor="middle" fill="#f4f2ec" font-family="JetBrains Mono" font-weight="800" font-size="16">Б·9</text>
        </svg>
        <div class="wm">
          <div class="wm-main">БУНКЕР<span class="acc">/09</span></div>
          <div class="wm-sub">ПРОТОКОЛ ВЫЖИВАНИЯ</div>
        </div>
      </div>
      <div class="desc">
        <h3>03. Бронещит «Гексагон»</h3>
        <p>Шестигранный тактический шеврон с крышей убежища, индексом Б·9 и косой чертой /09.</p>
      </div>
    </div>

    <!-- 04 -->
    <div class="card v4">
      <div class="card-top"><span class="num">ВАРИАНТ 04</span><span class="style-tag">STENCIL DOSSIER</span></div>
      <div class="stage">
        <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
          <path d="M12 4H48L52 8V44L44 52H8L4 48V12L12 4Z" fill="#ff5b36"/>
          <path d="M14 8H45L48 11V41L41 48H11L8 45V14L14 8Z" fill="#0d100b"/>
          <text x="28" y="35" text-anchor="middle" fill="#ff5b36" font-family="JetBrains Mono" font-weight="800" font-size="22">09</text>
          <line x1="16" y1="41" x2="40" y2="41" stroke="#a9ce7c" stroke-width="2"/>
        </svg>
        <div class="wm">
          <div class="wm-main">БУНКЕР<span class="stencil-box">9</span></div>
          <div class="wm-sub">ДОСЬЕ · СЕКРЕТНО</div>
        </div>
      </div>
      <div class="desc">
        <h3>04. Трафарет «Спецдопуск»</h3>
        <p>Брутальная плашка со срезанными под 45° углами, как маркировка на бетонных стенах бункера.</p>
      </div>
    </div>

    <!-- 05 -->
    <div class="card v5">
      <div class="card-top"><span class="num">ВАРИАНТ 05</span><span class="style-tag">CONTAINMENT RING</span></div>
      <div class="stage">
        <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
          <circle cx="28" cy="28" r="24" fill="#131710" stroke="#2f3827" stroke-width="1.5"/>
          <path d="M28 7 A21 21 0 0 1 46.2 17.5" stroke="#ff5b36" stroke-width="3.5" stroke-linecap="round"/>
          <path d="M46.2 38.5 A21 21 0 0 1 28 49" stroke="#a9ce7c" stroke-width="3.5" stroke-linecap="round"/>
          <path d="M9.8 38.5 A21 21 0 0 1 9.8 17.5" stroke="#ff5b36" stroke-width="3.5" stroke-linecap="round"/>
          <circle cx="28" cy="28" r="11" fill="#1b2116" stroke="#a9ce7c" stroke-width="1.5"/>
          <text x="28" y="33.5" text-anchor="middle" fill="#f4f2ec" font-family="Onest" font-weight="900" font-size="16">9</text>
        </svg>
        <div class="wm">
          <div class="wm-main">БУНКЕР<span class="acc">•9</span></div>
          <div class="wm-sub">КОНТУР ИЗОЛЯЦИИ</div>
        </div>
      </div>
      <div class="desc">
        <h3>05. Трёхсекторный контур</h3>
        <p>Динамичное кольцо биозащиты (оранжевый + оливковый) вокруг герметичной капсулы №9.</p>
      </div>
    </div>

    <!-- 06 -->
    <div class="card v6">
      <div class="card-top"><span class="num">ВАРИАНТ 06</span><span class="style-tag">ARCHITECTURAL VAULT</span></div>
      <div class="stage">
        <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
          <rect x="4" y="4" width="48" height="48" rx="13" fill="#141812" stroke="#3a4530" stroke-width="1.8"/>
          <path d="M12 40V24L28 13L44 24V40" stroke="#e8ece0" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M19 40V28L28 22L37 28V40" stroke="#7d8f69" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="28" cy="34" r="4.5" fill="#ff5b36"/>
        </svg>
        <div class="wm">
          <div class="wm-main">БУНКЕР<span class="acc">·9</span></div>
          <div class="wm-sub">ПОДЗЕМНЫЙ СВОД</div>
        </div>
      </div>
      <div class="desc">
        <h3>06. Архитектурный свод</h3>
        <p>Лаконичный двойной купол подземного бункера с горящим маяком внутри. Максимально узнаваемо в малом размере.</p>
      </div>
    </div>
  </div>
</body></html>`;

const htmlPath = join(temp, "logos.html");
writeFileSync(htmlPath, html);

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
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

try {
  let targets = [];
  for (let i = 0; i < 40 && !targets.length; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
    } catch {}
    if (!targets.length) await sleep(100);
  }
  ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 780,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await send("Page.navigate", { url: `file://${htmlPath}` });
  await sleep(1200);
  await send("Runtime.evaluate", { expression: "document.fonts.ready", awaitPromise: true });
  const png = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(OUT, Buffer.from(png.data, "base64"));
  console.log("  ✓", OUT);
} finally {
  try {
    ws?.close();
  } catch {}
  chrome.kill();
  rmSync(temp, { recursive: true, force: true });
}
