// Глубокий E2E нового клиента: полная партия в браузере + мобильная проверка.
// Запуск: SITE=http://localhost:3102 bun tools/deep-e2e.mjs
import { spawn } from "node:child_process";
import os from "node:os";

const SITE = process.env.SITE || "http://localhost:3102";
const W = Number(process.env.W || 1600);
const H = Number(process.env.H || 950);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = `${os.homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1254/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const PORT = 9400 + Math.floor(Math.random() * 60);
const PROFILE = `/tmp/deep-${Date.now()}`;

const problems = [];
const jsErrors = [];

const note = (cond, msg) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${msg}`);
  if (!cond) problems.push(msg);
};

const chrome = spawn(
  CHROME,
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
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

async function evaluate(expression) {
  const res = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.exceptionDetails) {
    problems.push(`JS: ${res.exceptionDetails.text}`);
    return null;
  }
  return res.result.value;
}

// текст, который не ломает парсер: вынесено из шаблонов
async function text(expression) {
  const value = await evaluate(expression);
  return value === null || value === undefined ? "" : String(value);
}

async function main() {
  let targets;
  for (let i = 0; i < 40; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      if (targets.length) break;
    } catch {
      /* ждём chrome */
    }
    await sleep(250);
  }
  const page = targets.find((t) => t.type === "page");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      jsErrors.push(`${d.text} ${d.exception?.description ?? ""}`.trim());
    }
    if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") {
      jsErrors.push(msg.params.entry.text);
    }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    }
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: W,
    height: H,
    deviceScaleFactor: 1,
    mobile: W < 600,
  });

  await send("Page.navigate", { url: `${SITE}/` });
  await sleep(1400);

  note((await text("location.href")).startsWith(SITE), "страница открылась");
  note(
    await evaluate("!!document.querySelector('form[action=\"/act/create\"]')"),
    "лендинг: форма создания",
  );
  const landOverflow = await evaluate("document.documentElement.scrollWidth");
  note(landOverflow <= W, `лендинг: без горизонтального скролла (${landOverflow}/${W})`);

  await evaluate(
    '(() => { const f = document.querySelector(\'form[action="/act/create"]\'); f.querySelector("input[name=name]").value = "Тестер"; f.requestSubmit(); return 1; })()',
  );
  await sleep(1700);

  note(await evaluate("!!document.getElementById('lobby')"), "лобби: экран открылся");
  const code = (await text('(document.querySelector("#board h1 b")||{}).textContent')).trim();
  note(/^[A-Z0-9]{4}$/.test(code), `лобби: код комнаты (${code})`);
  const lobbyH = await evaluate(
    "Math.round(document.querySelector('.lobby-main').getBoundingClientRect().height)",
  );
  const vh = await evaluate("window.innerHeight");
  note(lobbyH >= vh - 120, `лобби: занимает высоту (${lobbyH}/${vh})`);

  for (const [i, name] of ["Борис", "Вера", "Глеб", "Дина"].entries()) {
    const res = await fetch(`${SITE}/act/join`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", cookie: `bunker_sid=deep${Date.now()}${i}` },
      body: JSON.stringify({ payload: { code, name, avatar: "🦊" } }),
    });
    note(res.status === 303, `вход бота ${name}: ${res.status}`);
  }
  await sleep(1300);
  const inLobby = await evaluate(
    "document.querySelectorAll('#board .lobby-player:not(.empty)').length",
  );
  note(inLobby === 5, `лобби: 5 игроков (${inLobby})`);

  await evaluate("document.querySelector('#board .lobby-start .btn-primary')?.click()");
  await sleep(1600);
  const startPhase = (await text('(document.querySelector(".phase-chip")||{}).textContent')).trim();
  note(/ПРОБУЖДЕНИЕ|РАССВЕТ/.test(startPhase), `старт: фаза ${startPhase}`);

  const bannerText = (await text('(document.getElementById("banner")||{}).textContent')).trim();
  note(bannerText.length > 0, `баннер фазы: "${bannerText}"`);
  note(
    !(await evaluate("document.documentElement.scrollWidth > window.innerWidth + 1")),
    "игра: без горизонтального скролла",
  );

  const timer1 = (await text('(document.querySelector(".phase-timer")||{}).textContent')).trim();
  await sleep(300);
  const timer2 = (await text('(document.querySelector(".phase-timer")||{}).textContent')).trim();
  note(timer1.length > 0, `таймер есть (${timer1} → ${timer2})`);

  await evaluate(
    '(() => { const i = document.getElementById("chatInput"); i.value = "тест чата"; i.dispatchEvent(new Event("input", { bubbles: true })); i.form.requestSubmit(); return 1; })()',
  );
  await sleep(1200);
  note(
    await evaluate('(document.getElementById("chatFeed")||{}).innerText?.includes("тест чата")'),
    "чат: сообщение в ленте",
  );
  note(
    await evaluate('(document.getElementById("chatInput")||{}).value === ""'),
    "чат: поле очистилось",
  );

  await evaluate(
    '[...document.querySelectorAll("button")].find((b) => /Досье/.test(b.textContent))?.click()',
  );
  await sleep(600);
  note(
    await evaluate(
      '(() => { const m = document.querySelector(".modal-backdrop"); return !!m && getComputedStyle(m).display !== "none"; })()',
    ),
    "досье: открылось",
  );
  await evaluate('document.querySelector(".modal-close")?.click()');
  await sleep(400);
  note(
    await evaluate(
      '(() => { const m = document.querySelector(".modal-backdrop"); return !m || getComputedStyle(m).display === "none"; })()',
    ),
    "досье: закрылось",
  );

  // доходим до раскрытия карт и кликаем карту
  let sawReveal = false;
  for (let step = 0; step < 10; step++) {
    const phase = (await text('(document.querySelector(".phase-chip")||{}).textContent')).trim();
    if (phase.includes("РАССВЕТ")) {
      sawReveal = true;
      const cards = await evaluate("document.querySelectorAll('.trait-card').length");
      note(cards > 0, `раскрытие: карт отрисовано (${cards})`);
      await evaluate("document.querySelector('.trait-card').click()");
      await sleep(1200);
      const body = await text("document.body.innerText");
      note(/Ваша карта на столе|НА СТОЛЕ|на столе/i.test(body), "раскрытие: карта ушла на стол");
      break;
    }
    await evaluate(
      '[...document.querySelectorAll("button")].find((b) => /Пропустить фазу/.test(b.textContent))?.click()',
    );
    await sleep(850);
  }
  note(sawReveal, "раскрытие: фаза достигнута");

  // голосование
  let voted = false;
  for (let step = 0; step < 10; step++) {
    const phase = (await text('(document.querySelector(".phase-chip")||{}).textContent')).trim();
    if (phase.includes("ГОЛОСОВАНИЕ")) {
      await evaluate(
        '[...document.querySelectorAll(".target-card")].find((c) => !c.classList.contains("selected"))?.click()',
      );
      await sleep(900);
      const selected = await evaluate("document.querySelectorAll('.target-card.selected').length");
      note(selected > 0, `голосование: голос учтён (${selected})`);
      voted = true;
      break;
    }
    await evaluate(
      '[...document.querySelectorAll("button")].find((b) => /Пропустить фазу/.test(b.textContent))?.click()',
    );
    await sleep(850);
  }
  note(voted, "голосование: фаза достигнута");

  // ночь
  let sawNight = false;
  for (let step = 0; step < 6; step++) {
    const phase = (await text('(document.querySelector(".phase-chip")||{}).textContent')).trim();
    if (phase.includes("НОЧЬ")) {
      sawNight = true;
      break;
    }
    await evaluate(
      '[...document.querySelectorAll("button")].find((b) => /Пропустить фазу/.test(b.textContent))?.click()',
    );
    await sleep(850);
  }
  note(sawNight, "ночь: фаза достигнута");

  // мобильный вид
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await sleep(700);
  const mobileOverflow = await evaluate("document.documentElement.scrollWidth");
  note(mobileOverflow <= 391, `мобилка 390: без скролла (${mobileOverflow})`);
  note(await evaluate("!!document.querySelector('.game-grid')"), "мобилка 390: сетка на месте");
}

main()
  .catch((err) => {
    problems.push(`исключение: ${err.message}`);
  })
  .finally(() => {
    console.log("");
    console.log("ошибки JS:", jsErrors.length ? jsErrors.slice(0, 4) : "нет");
    console.log("проблемы:", problems.length ? problems : "нет");
    try {
      ws?.close();
    } catch {
      /* уже закрыт */
    }
    chrome.kill();
    process.exitCode = problems.length || jsErrors.length ? 1 : 0;
  });
