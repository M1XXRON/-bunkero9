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

  note(await evaluate('!!document.getElementById("shell")'), "лобби: экран открылся");
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
  note(/СЦЕНАРИЙ|РАССВЕТ/.test(startPhase), `старт: фаза ${startPhase}`);
  note(
    await evaluate(
      '!!document.querySelector(".intro-hero") && !document.querySelector(".phase-timer")',
    ),
    "сценарий: герой без таймера",
  );
  await evaluate('document.querySelector(".intro-start")?.click()');
  await sleep(1200);
  note(
    await evaluate('getComputedStyle(document.querySelector(".mtabbar")).display === "none"'),
    "десктоп: мобильные вкладки скрыты",
  );

  const bannerText = (await text('(document.getElementById("banner")||{}).textContent')).trim();
  note(bannerText.length > 0, `баннер фазы: "${bannerText}"`);
  note(
    !(await evaluate("document.documentElement.scrollWidth > window.innerWidth + 1")),
    "игра: без горизонтального скролла",
  );

  // голос: кнопка монтируется рядом со звуком (speechSynthesis есть в Chrome)

  // подсказка «кто что раскрыл»: наводим на строку второго игрока
  const hover = await evaluate(
    '(() => { const r = document.querySelectorAll(".players-row")[1]; if (!r) return null; const b = r.getBoundingClientRect(); return { x: Math.round(b.left + 60), y: Math.round(b.top + 12) }; })()',
  );
  if (hover) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: hover.x, y: hover.y });
    await sleep(600);
    const peekOpen = await evaluate("!document.getElementById('peek').hidden");
    note(peekOpen, "подсказка при наведении открывается");
    if (peekOpen) {
      const rows = await evaluate("document.querySelectorAll('#peek .peek-row').length");
      note(rows === 8, `в подсказке все восемь категорий (${rows})`);
      const open = await evaluate("document.querySelectorAll('#peek .peek-row.on').length");
      note(open === 0, `скрытые карты не раскрываются (открыто ${open})`);
      // у скрытой карты значения нет вовсе — только категория
      const slotsLeak = await evaluate(
        '(() => { const rows = [...document.querySelectorAll(".players-row .peek-source .peek-row:not(.on) .peek-val")]; return rows.some((e) => e.textContent.trim().length > 0); })()',
      );
      note(!slotsLeak, "значения скрытых карт не утекают в разметку");
      const srcHeight = await evaluate(
        "(() => { const e = document.querySelector('.players-row .peek-source'); return e ? e.getBoundingClientRect().height : -1; })()",
      );
      note(srcHeight === 0, `источник подсказки не влияет на строку (высота ${srcHeight})`);
    }
  }

  const autoScroll = await evaluate(
    "(() => { const f = document.getElementById('chatFeed'); return f ? f.scrollHeight - f.scrollTop - f.clientHeight < 12 : false; })()",
  );
  note(autoScroll, "чат: лента прижата к низу (автоскролл)");

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

  // кнопка отправки: нейтральная на пустом поле, цветная при вводе;
  // оттенок берём из темы, чтобы редизайн не ломал проверку поведения.
  const accentRgb = await evaluate(`(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--accent)";
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  })()`);
  const sendIdle = await evaluate(
    'getComputedStyle(document.querySelector(".send-btn")).backgroundColor',
  );
  await evaluate(`(() => {
    const i = document.getElementById("chatInput");
    i.value = "x"; i.dispatchEvent(new Event("input", { bubbles: true }));
    return 1;
  })()`);
  // ждём transition (0.15 с), иначе поймаем промежуточный цвет
  await sleep(300);
  const sendTyped = await evaluate(
    'getComputedStyle(document.querySelector(".send-btn")).backgroundColor',
  );
  await evaluate(`(() => {
    const i = document.getElementById("chatInput");
    i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true }));
    return 1;
  })()`);
  note(
    sendIdle !== accentRgb && sendTyped === accentRgb,
    `кнопка чата: покой ${sendIdle}, ввод ${sendTyped}, акцент ${accentRgb}`,
  );

  // модалки: остались только правила (досье убрано вместе с ролями)
  const rulesBtn = await evaluate(
    '[...document.querySelectorAll("button")].find((b) => /Правила/.test(b.textContent))?.getAttribute("data-on:click") || ""',
  );
  note(String(rulesBtn).includes("showModal"), `кнопка «Правила» открывает диалог (${rulesBtn})`);
  note(await evaluate('!document.getElementById("dossier")'), "досье из интерфейса убрано");
  await evaluate('document.getElementById("rules")?.showModal()');
  await sleep(300);
  note(
    await evaluate('document.getElementById("rules")?.open === true'),
    "правила открываются как <dialog>",
  );
  note(
    String(
      await evaluate('document.getElementById("rules")?.getAttribute("aria-labelledby") || ""'),
    ).length > 0,
    "правила: есть aria-labelledby",
  );
  await evaluate('document.getElementById("rules")?.close()');
  await sleep(200);
  note(await evaluate('document.getElementById("rules")?.open !== true'), "правила закрываются");

  // доходим до раскрытия карт и кликаем карту
  let sawReveal = false;
  for (let step = 0; step < 10; step++) {
    const phase = (await text('(document.querySelector(".phase-chip")||{}).textContent')).trim();
    if (phase.includes("РАССВЕТ")) {
      sawReveal = true;
      const cards = await evaluate("document.querySelectorAll('.trait-card').length");
      note(cards > 0, `раскрытие: карт отрисовано (${cards})`);
      const ownCards = await evaluate("document.querySelectorAll('.own-card').length");
      note(ownCards === 8, `свои карты всегда на экране (${ownCards})`);
      const queue = await evaluate("document.querySelectorAll('.turn-chip').length");
      note(queue >= 5, `очередь раскрытия видна (${queue})`);
      await evaluate("document.querySelector('.trait-card').click()");
      await sleep(1200);
      const body = await text("document.body.innerText");
      note(/Карта на столе|на столе/i.test(body), "раскрытие: карта ушла на стол");

      // раскрытие в чате — отдельной карточкой, день и фаза — разделителями
      const revealCards = await evaluate("document.querySelectorAll('.chat-reveal').length");
      note(revealCards > 0, `чат: раскрытия карт выделены (${revealCards})`);
      const revealValue = await evaluate(
        '(() => { const e = document.querySelector(".chat-reveal .cr-val"); return e ? e.textContent.trim().length : 0; })()',
      );
      note(revealValue > 0, "чат: в карточке раскрытия есть значение");
      const dayDivider = await evaluate("document.querySelectorAll('.chat-divider.day').length");
      note(dayDivider > 0, `чат: день отбит разделителем (${dayDivider})`);
      const phaseDivider = await evaluate(
        "document.querySelectorAll('.chat-divider.tone-phase').length",
      );
      note(phaseDivider > 0, `чат: фазы отбиты разделителем (${phaseDivider})`);
      const ownHover = await evaluate(
        '(() => { const r = document.querySelectorAll(".players-row")[0]; const b = r.getBoundingClientRect(); return { x: Math.round(b.left + 60), y: Math.round(b.top + 12) }; })()',
      );
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: ownHover.x, y: ownHover.y });
      await sleep(600);
      const revealedInPeek = await evaluate(
        "document.querySelectorAll('#peek .peek-row.on').length",
      );
      note(revealedInPeek === 1, `в подсказке видно раскрытую карту (${revealedInPeek})`);
      const greenValue = await evaluate(
        '(() => { const e = document.querySelector("#peek .peek-row.on .peek-val"); return e ? getComputedStyle(e).color : ""; })()',
      );
      note(
        String(greenValue).replace(/\s/g, "") === "rgb(111,220,140)",
        `раскрытое значение зелёное (${greenValue})`,
      );
      const endTurn = await evaluate("!!document.querySelector('.end-turn-btn')");
      note(endTurn, "раскрытие: есть кнопка «Завершить ход»");
      if (endTurn) {
        await evaluate("document.querySelector('.end-turn-btn').click()");
        await sleep(1200);
        const after = await text('(document.querySelector(".action-block")||{}).innerText || ""');
        note(
          /Сейчас ход|Покажите одну карту/.test(after) && !/Завершить ход/.test(after),
          `подтверждение хода передало очередь (${after.slice(0, 40)}…)`,
        );
      }
      break;
    }
    await evaluate(
      '[...document.querySelectorAll("button")].find((b) => /Пропустить фазу/.test(b.textContent))?.click()',
    );
    await sleep(850);
  }
  note(sawReveal, "раскрытие: фаза достигнута");

  // обсуждение: сводка раскрытий, подсказки и переключатель на старый вид
  for (let i = 0; i < 4; i++) {
    const now = (await text('(document.querySelector(".phase-chip")||{}).textContent')).trim();
    if (now.includes("ОБСУЖДЕНИЕ")) break;
    await evaluate(
      '[...document.querySelectorAll("button")].find((b) => /Пропустить фазу/.test(b.textContent))?.click()',
    );
    await sleep(900);
  }
  if (
    (await text('(document.querySelector(".phase-chip")||{}).textContent'))
      .trim()
      .includes("ОБСУЖДЕНИЕ")
  ) {
    const board = await evaluate("document.querySelectorAll('.rb-card').length");
    note(board >= 5, `обсуждение: стол раскрытий (${board} карточек)`);
    const chips = await evaluate("document.querySelectorAll('.rb-chip').length");
    note(chips > 0, `обсуждение: на столе есть раскрытые карты (${chips})`);
    const hints = await evaluate("document.querySelectorAll('.hint').length");
    note(hints > 0, `обсуждение: подсказки (${hints})`);
    const toggle = await evaluate(
      '(() => { const b = [...document.querySelectorAll(".head-actions button")].find((x) => /простой вид|сводка/i.test(x.textContent)); if (!b) return false; b.click(); return true; })()',
    );
    note(toggle, "обсуждение: есть переключатель вида");
    if (toggle) {
      await sleep(400);
      const plain = await evaluate(
        "(() => { const e = document.querySelector('.discuss-plain'); return e ? e.offsetParent !== null : false; })()",
      );
      const rich = await evaluate(
        "(() => { const e = document.querySelector('.discuss-rich'); return e ? e.offsetParent === null : false; })()",
      );
      note(plain && rich, "обсуждение: старый вид открывается по кнопке");
      await evaluate(
        '[...document.querySelectorAll(".head-actions button")].find((x) => /простой вид|сводка/i.test(x.textContent))?.click()',
      );
      await sleep(300);
      const back = await evaluate(
        "(() => { const e = document.querySelector('.discuss-rich'); return e ? e.offsetParent !== null : false; })()",
      );
      note(back, "обсуждение: сводка возвращается");
    }
  }

  // голосование
  let voted = false;
  for (let step = 0; step < 10; step++) {
    const phase = (await text('(document.querySelector(".phase-chip")||{}).textContent')).trim();
    if (phase.includes("ГОЛОСОВАНИЕ")) {
      await evaluate(
        '[...document.querySelectorAll(".target-card:not(.self)")].find((c) => !c.classList.contains("selected"))?.click()',
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

  // после голосования сразу новый день или финал — отдельной ночи нет
  let sawNextDay = false;
  let finalPhase = "";
  for (let step = 0; step < 8; step++) {
    finalPhase = (await text('(document.querySelector(".phase-chip")||{}).textContent')).trim();
    if (finalPhase.includes("РАССВЕТ") || finalPhase.includes("ИТОГ")) {
      sawNextDay = true;
      break;
    }
    await evaluate(
      '[...document.querySelectorAll("button")].find((b) => /Пропустить фазу/.test(b.textContent))?.click()',
    );
    await sleep(900);
  }
  note(sawNextDay, `новый день или финал достигнуты (${finalPhase || "фаза не найдена"})`);

  // мобильный вид
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await sleep(700);
  const mobileOverflow = await evaluate("document.documentElement.scrollWidth");
  note(mobileOverflow <= 391, `мобилка 390: без горизонтального скролла (${mobileOverflow})`);
  note(await evaluate("!!document.querySelector('.game-grid')"), "мобилка 390: сетка на месте");
  note(
    await evaluate("document.documentElement.scrollHeight <= innerHeight + 1"),
    "мобилка 390: страница не скроллится целиком",
  );
  note(
    await evaluate('getComputedStyle(document.querySelector(".mtabbar")).display !== "none"'),
    "мобилка 390: вкладки видны",
  );
  await evaluate("document.querySelector('[data-mtab-btn=\"chat\"]')?.click()");
  await sleep(400);
  note(
    await evaluate(
      'getComputedStyle(document.querySelector(".chat-panel")).display !== "none" && getComputedStyle(document.querySelector(".scene-panel")).display === "none"',
    ),
    "мобилка 390: вкладка чата открывает ленту",
  );
  await evaluate("document.querySelector('[data-mtab-btn=\"play\"]')?.click()");
  await sleep(400);
  note(
    await evaluate(
      'getComputedStyle(document.querySelector(".chat-panel")).display === "none" && getComputedStyle(document.querySelector(".scene-panel")).display !== "none"',
    ),
    "мобилка 390: вкладка стола возвращает игру",
  );
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
