// Проверки уровня HTTP: ночной шёпот заражённых, ошибки лендинга, таймер фазы,
// подтверждение выхода. Не требует браузера — только SITE с живым сервером.
//
//   bun tools/http-e2e.mjs                      # по умолчанию localhost:3101
//   SITE=https://bunker9.lol bun tools/http-e2e.mjs
//
// Под ускоренными таймерами (BUNKER_TEST=1) «дойти до ночи» не получится:
// фазы уезжают вперёд сами — сервер для этих проверок должен быть обычным.
const SITE = process.env.SITE || "http://localhost:3101";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const problems = [];
const note = (cond, msg) => {
  console.log(`${cond ? "  ✓" : "  ✗"} ${msg}`);
  if (!cond) problems.push(msg);
};

const post = async (sid, cmd, payload, form = false) =>
  fetch(`${SITE}/act/${cmd}`, {
    method: "POST",
    redirect: "manual",
    headers: form
      ? { "content-type": "application/x-www-form-urlencoded" }
      : { "content-type": "application/json", cookie: `bunker_sid=${sid}` },
    body: form ? new URLSearchParams(payload).toString() : JSON.stringify({ payload }),
  });

const page = async (sid) =>
  (await fetch(`${SITE}/`, { headers: { cookie: `bunker_sid=${sid}` } })).text();

const chatOf = (html) =>
  (html.match(/<section class="panel chat-panel">[\s\S]*?<\/section>/) || [""])[0];
const phaseOf = async (sid) => ((await page(sid)).match(/phase-chip[^>]*>([^<]*)</) || [])[1] || "";

const stamp = Date.now();

// ---------- комната и входы ----------
const H = `he-host-${stamp}`;
await post(H, "create", { name: "Хост", avatar: "🦉" });
const code = ((await page(H)).match(/Код бункера <b>([A-Z0-9]{4})<\/b>/) || [])[1];
note(/^[A-Z0-9]{4}$/.test(code || ""), `комната создана (${code})`);
const sids = [];
for (const [i, name] of ["Борис", "Вера", "Глеб", "Дина"].entries()) {
  const sid = `he-bot-${stamp}-${i}`;
  sids.push(sid);
  await post(sid, "join", { code, name, avatar: "🐺" });
}
await sleep(400);
const startRes = await post(H, "start");
note(startRes.status === 204, `старт игры → ${startRes.status}`);

// ---------- таймер: значение приходит с сервера и меняется по фазам ----------
const endsAt = async (sid) =>
  Number(((await page(sid)).match(/data-signals="\{endsAt: (\d+)/) || [])[1] || 0);
const t1 = await endsAt(H);
if ((await phaseOf(H)) === "ПРОБУЖДЕНИЕ") {
  note(t1 > 0, `таймер: endsAt в разметке (${t1})`);
  await post(H, "skip");
  await sleep(1200);
  const t2 = await endsAt(H);
  note(t2 > 0 && Math.abs(t2 - t1) > 500, `таймер: endsAt меняется по фазам (${t1} → ${t2})`);
  const html = await page(H);
  note(!/__ifmissing/.test(html), "таймер: без data-signals__ifmissing (иначе замирает на 0с)");
  note(/confirm\('Выйти из бункера/.test(html), "выход: в партии есть подтверждение");
} else {
  console.log("  · фаза уже не ПРОБУЖДЕНИЕ — проверку таймера пропускаю");
}

// ---------- ночь: чат закрыт у всех, шёпота больше нет ----------
let night = false;
for (let i = 0; i < 14; i++) {
  if ((await phaseOf(H)).includes("НОЧЬ")) {
    night = true;
    break;
  }
  await post(H, "skip");
  await sleep(700);
}
note(night, `дошли до ночи (${await phaseOf(H)})`);
if (night) {
  const all = [H, ...sids];
  const pages = {};
  for (const sid of all) pages[sid] = await page(sid);
  note(
    all.every((sid) => /id="chatInput"[^>]*disabled/.test(chatOf(pages[sid]))),
    `ночь: у всех чат закрыт (${all.length})`,
  );
  note(
    all.every((sid) => !/name="channel" value="mafia"/.test(pages[sid])),
    "ночь: канала «шёпот» больше нет",
  );
  const closed = await post(all[0], "chat", { text: "в ночь не пишут", channel: "day" });
  note(
    closed.status === 204 && !(await page(all[0])).includes("в ночь не пишут"),
    "ночь: сообщение не проходит",
  );
}

// ---------- лендинг: ошибки вместо тишины ----------
const bad = await post("", "join", { code: "ZZZZ", name: "Опечатка", avatar: "🦊" }, true);
const badLoc = bad.headers.get("location") || "";
note(
  bad.status === 303 && badLoc.startsWith("/?e="),
  `лендинг: неверный код → ${bad.status} ${badLoc}`,
);
const badPage = await (await fetch(`${SITE}${badLoc}`)).text();
note(/class="toast"/.test(badPage) && /не найден/i.test(badPage), "лендинг: текст ошибки показан");

const escaped = await (
  await fetch(`${SITE}/?e=${encodeURIComponent("<script>alert(1)</script>")}`)
).text();
note(!escaped.includes("<script>alert(1)</script>"), "лендинг: текст ошибки экранирован");

const late = await post("", "join", { code, name: "Опоздавший", avatar: "🦊" }, true);
const latePage = await (await fetch(`${SITE}${late.headers.get("location") || "/"}`)).text();
note(
  late.status === 303 && /уже началась/i.test(latePage),
  "лендинг: «игра уже началась» показано",
);

// ---------- фавикон: вкладка не должна быть пустой ----------
for (const [path, type] of [
  ["/favicon.svg", "image/svg+xml"],
  ["/favicon-32.png", "image/png"],
  ["/apple-touch-icon.png", "image/png"],
  ["/favicon.ico", "image/png"],
]) {
  const res = await fetch(`${SITE}${path}`);
  const kind = res.headers.get("content-type") || "";
  note(
    res.status === 200 && kind.includes(type),
    `фавикон ${path} → ${res.status} ${kind.split(";")[0]}`,
  );
}
const head = await page(H);
note(/rel="icon"[^>]*favicon\.svg/.test(head), "страница объявляет svg-иконку для вкладки");
note(/rel="apple-touch-icon"/.test(head), "страница объявляет иконку для iOS");

// ---------- аватар: выбор на лендинге должен доехать до лобби ----------
const landingNow = await (await fetch(`${SITE}/`)).text();
const palette = [...landingNow.matchAll(/name="avatar" id="av\d+" value="([^"]+)"/g)].map(
  (m) => m[1],
);
note(palette.length >= 16, `лендинг: ${palette.length} аватарок на выбор`);
note(new Set(palette).size === palette.length, "лендинг: аватарки не повторяются");

if (palette.length) {
  const emoji = palette[palette.length - 1];
  const sidAvatar = `he-avatar-${stamp}`;
  await post(sidAvatar, "create", { name: "Аватар", avatar: emoji });
  const lobbyHtml = await page(sidAvatar);
  note(
    lobbyHtml.includes(`avatar-emoji">${emoji}`),
    `аватар ${emoji} виден в лобби (не подменён на 🦉)`,
  );
  await post(sidAvatar, "leave", {});
}

// ---------- уборка: выходим из комнаты ----------
for (const sid of [H, ...sids]) await post(sid, "leave", {});

console.log(problems.length ? `\nпровалы: ${problems.join(" | ")}` : "\nвсе HTTP-проверки прошли");
process.exit(problems.length ? 1 : 0);
