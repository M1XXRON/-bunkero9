// Рендер состояния в HTML. Фрагменты патчатся в браузер через Datastar (SSE),
// поэтому у каждого игрока свой HTML: роли и скрытые карты не утекают.
//
// Классы и разметка — под public/style.css. Оформление взято по мотивам
// «Убежища 42» (shelter42.ru): почти чёрный фон, крупная типографика Onest,
// оранжевый акцент #ff3500, карточки 20px, строки-списки с разделителями.
// Игровые правила и хендлеры при этом не менялись.

export type Player = {
  id: string;
  name: string;
  avatar: string;
  avatarIndex: number;
  connected: boolean;
  alive: boolean;
  left: boolean;
  isHost: boolean;
  death: { day: number; cause: string; note?: string } | null;
  traits: { cat: string; label: string; value: string }[];
  traitSlots: {
    cat: string;
    label: string;
    revealed: boolean;
    value: string | null;
    effect?: string | null;
  }[];
  traitsRevealed: number;
  spokeToday: boolean;
  totalTraits: number;
  isBot?: boolean;
  revealedThisRound: boolean;
  votedFor: string | null;
  votesAgainst: number;
};

export type Snapshot = {
  code: string;
  state: string;
  day: number;
  gameId: number;
  hostId: string;
  me: {
    id: string;
    name: string;
    ability: {
      kind: string;
      label: string;
      desc: string;
      used: boolean;
      available: boolean;
      pending: { stage: string; category: number | null } | null;
      targets: { id: string; name: string; avatar?: string; avatarIndex?: number }[];
    } | null;
    avatar: string;
    avatarIndex: number;
    isHost: boolean;
    alive: boolean;
    traits: {
      cat: string;
      label: string;
      value: string;
      revealed: boolean;
      effect?: string;
      desc?: string;
    }[];
    canReveal: boolean;
    isMyTurn: boolean;
    canEndTurn: boolean;
    revealedThisRound: boolean;
    votedFor: string | null;
  };
  players: Player[];
  resources: { food: number; energy: number; meds: number };
  event: { title: string; text: string; food: number; energy: number; meds: number } | null;
  settings: { pace: string };
  aliveCount: number;
  totalCount: number;
  ready: { me: boolean; count: number; total: number };
  minPlayers: number;
  maxPlayers: number;
  phaseEndsAt: number | null;
  winner: string | null;
  chat: { day: boolean; dead: boolean };
  messages: {
    id: number;
    kind: string;
    tone: string;
    channel: string;
    author: string;
    avatar: string;
    text: string;
  }[];
  hints: string[];
  story: { title: string; premise: string; threat?: string; source?: string } | null;
  recap: { title: string; paragraphs: string[]; verdict: string } | null;
  recapPending: boolean;
  crewMin: number;
  rescueDay: number | null;
  daysLeft: number | null;
  turn: {
    playerId: string | null;
    name: string | null;
    stage: "reveal" | "confirm" | "done";
    index: number;
    total: number;
    order: {
      id: string;
      name: string;
      alive: boolean;
      revealed: boolean;
      done: boolean;
      current: boolean;
    }[];
  } | null;
  ending: { title: string; text: string } | null;
};

const esc = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const PHASE_CHIP: Record<string, string> = {
  lobby: "ЛОББИ",
  intro: "СЦЕНАРИЙ",
  reveal: "РАССВЕТ",
  discussion: "ОБСУЖДЕНИЕ",
  vote: "ГОЛОСОВАНИЕ",
  end: "ИТОГ",
};

const PHASE_TONE: Record<string, string> = {
  vote: "vote",
  end: "end",
};

// ---------- аватар ----------

function avatar(
  player: { name: string; avatar: string; avatarIndex: number; connected?: boolean },
  size = "sm",
): string {
  const letter = esc((player.name || "?").slice(0, 1).toUpperCase());
  const idx = (((player.avatarIndex ?? 0) % 8) + 8) % 8;
  const dot = player.connected === false ? '<i class="avatar-dot offline"></i>' : "";
  // В кружке — выбранное на лендинге эмодзи, буква только как запасной вариант.
  const emoji = String(player.avatar || "").trim();
  const face = emoji ? `<span class="avatar-emoji">${esc(emoji)}</span>` : `<span>${letter}</span>`;
  return `<span class="avatar avatar-${size} avatar-c${idx}">${face}${dot}</span>`;
}

// ---------- верхняя панель ----------

// Крестик стоит рядом с «Правилами» и на телефоне его ловят пальцем мимо: в
// партии выход = смерть с раскрытием роли, так что спрашиваем подтверждение.
function leaveButton(snap: Snapshot): string {
  if (snap.state === "lobby")
    return `<button class="pill pill-icon" title="Выйти" aria-label="Выйти" data-on:click="@post('/act/leave', {retry: 'never'})">×</button>`;
  return `<button class="pill pill-icon" title="Выйти" aria-label="Выйти" data-on:click="confirm('Выйти из бункера? Персонаж погибнет, его карты откроются.') && @post('/act/leave', {retry: 'never'})">×</button>`;
}

// Приглашение копируется одной кнопкой: код, ссылка с автоподстановкой кода
// (?c=…) и строка, которую не стыдно отправить в чат друзьям.
function inviteText(snap: Snapshot, origin: string): string {
  const count = snap.players.length;
  const who = count <= 1 ? "я уже внутри" : `нас уже ${count}`;
  return `Тишина снаружи, а в бункере есть место. Заходи в «БУНКЕР·9» — ${who}, не хватает тебя.\nКод: ${snap.code}\n${origin}/?c=${snap.code}`;
}

function topbar(snap: Snapshot, origin: string): string {
  const tone = PHASE_TONE[snap.state] || "day";
  // Таймер целиком на Datastar: интервал тикает сигнал, data-text его печатает.
  // __ifmissing здесь нельзя: топбар морфится на каждом патче, а сигнал живёт
  // дольше элемента — таймер замирал на значении первой фазы.
  const timer = snap.phaseEndsAt
    ? `<span class="phase-timer"
         data-signals="{endsAt: ${snap.phaseEndsAt}, left: ${Math.max(0, Math.round((snap.phaseEndsAt - Date.now()) / 1000))}}"
         data-on-interval__duration.250ms="$left = Math.max(0, Math.round(($endsAt - Date.now()) / 1000))"
         data-class="{urgent: $left <= 10}"
         data-text="$left + 'с'"></span>`
    : "";
  const res = snap.resources;
  const low = (value: number, limit: number) => (value <= limit ? " low" : "");
  return `
  <header class="topbar" id="topbar">
    <div class="topbar-left">
      <span class="wordmark"><span class="wordmark-text">БУНКЕР</span><span class="wordmark-mark">·9</span></span>
      <button class="pill room-pill" title="Скопировать код, ссылку и приглашение"
        data-on:click="navigator.clipboard?.writeText(${esc(JSON.stringify(inviteText(snap, origin)))})">
        <span class="room-code">${esc(snap.code)}</span><span class="room-copy">копировать</span>
      </button>
    </div>

    <div class="topbar-center">
      <span class="phase-chip tone-${tone}">${esc(PHASE_CHIP[snap.state] || "")}</span>
      ${
        snap.state !== "lobby" && snap.state !== "intro"
          ? `<span class="phase-day">день ${snap.day}${snap.daysLeft !== null ? ` · до спасения ${snap.daysLeft}` : ""}</span>`
          : ""
      }
      ${timer}
    </div>

    <div class="topbar-right">
      ${
        // В лобби ресурсов ещё нет (все нули) — не показываем пустые банки.
        snap.state === "lobby"
          ? ""
          : `<div class="resources">
        <span class="res${low(res.food, snap.aliveCount)}" title="еда"><i>еда</i><b>${res.food}</b></span>
        <span class="res${low(res.energy, 2)}" title="энергия"><i>энергия</i><b>${res.energy}</b></span>
        <span class="res${low(res.meds, 0)}" title="медикаменты"><i>меды</i><b>${res.meds}</b></span>
      </div>`
      }
      <div class="top-actions">
        <button class="pill pill-ghost" data-on:click="document.getElementById('rules').showModal()">Правила</button>
        ${leaveButton(snap)}
      </div>
    </div>
  </header>`;
}

// ---------- лобби ----------

function lobby(snap: Snapshot, origin: string): string {
  const seats = snap.players
    .map(
      (p) => `
      <div class="lobby-player ${p.id === snap.me.id ? "is-me" : ""} ${p.connected ? "" : "offline"}">
        ${avatar(p, "sm")}
        <div class="lobby-player-info">
          <div class="lobby-player-name">${esc(p.name)}
            ${p.isHost ? '<span class="mini-badge host">хост</span>' : ""}
            ${p.isBot ? '<span class="mini-badge bot">бот</span>' : ""}
            ${p.id === snap.me.id ? '<span class="mini-badge me">вы</span>' : ""}
          </div>
          <div class="lobby-player-meta">${p.isBot ? "под управлением сервера" : p.connected ? "на связи" : "нет связи"}</div>
        </div>
        ${
          p.isBot
            ? '<span class="status ok"><i></i>бот</span>'
            : p.connected
              ? '<span class="status ok"><i></i>в сети</span>'
              : '<span class="status"><i></i>офлайн</span>'
        }
        ${
          snap.me.isHost && p.id !== snap.me.id
            ? `<button class="row-action" data-on:click="@post('/act/kick', {payload: {target: '${p.id}'}, retry: 'never'})" title="Исключить" aria-label="Исключить">×</button>`
            : ""
        }
      </div>`,
    )
    .join("");

  // Пустые места не растягиваем на весь список: 14 пунктирных строк вытесняли
  // кнопку старта. Показываем до восьми и подписываем остаток.
  const freeSeats = Math.max(0, snap.maxPlayers - snap.players.length);
  const shownSeats = Math.min(freeSeats, 8);
  const empty = freeSeats
    ? `<div class="lobby-empty-seats">${Array.from({ length: shownSeats })
        .map(() => '<div class="lobby-player empty"><span class="seat-dash">—</span>свободно</div>')
        .join("")}${
        freeSeats > shownSeats
          ? `<div class="lobby-player empty more"><span class="seat-dash">+</span>ещё ${freeSeats - shownSeats} мест</div>`
          : ""
      }</div>`
    : "";

  const canStart = snap.me.isHost && snap.players.length >= snap.minPlayers;
  const startLabel = !snap.me.isHost
    ? "ЖДЁМ ХОСТА"
    : snap.players.length < snap.minPlayers
      ? `НУЖНО ЕЩЁ ${snap.minPlayers - snap.players.length}`
      : "ОТКРЫТЬ БУНКЕР";

  return `
  <div class="lobby-body">
    <section class="panel invite-card">
      <span class="eyebrow">ПРИГЛАСИТЕ ВЫЖИВШИХ</span>
      <h1>Код бункера <b>${esc(snap.code)}</b></h1>
      <p class="invite-text">Отправьте друзьям код и адрес: <b>${esc(origin)}</b></p>
      <div class="meta-row">
        <span class="status ok"><i></i>${snap.players.filter((p) => p.connected).length} на связи</span>
        <span class="chip">${snap.players.length} / ${snap.maxPlayers} мест</span>
        <span class="chip chip-warn">спасение через ${snap.rescueDay ?? "?"} дн.</span>
      </div>
    </section>

    <section class="panel players-lobby-panel">
      <header class="panel-head">
        <div>
          <span class="eyebrow">СПИСОК ВЫЖИВШИХ</span>
          <h2>Кто внутри</h2>
        </div>
        <span class="seat-count">${snap.players.length} / ${snap.maxPlayers}</span>
      </header>
      <div class="lobby-players">${seats}${empty}</div>
      <div class="lobby-start">
        <div class="pace-switch">
          <button class="chip ${snap.settings.pace === "normal" ? "on" : ""}" data-on:click="@post('/act/pace', {payload: {pace: 'normal'}, retry: 'never'})">обычный</button>
          <button class="chip ${snap.settings.pace === "fast" ? "on" : ""}" data-on:click="@post('/act/pace', {payload: {pace: 'fast'}, retry: 'never'})">быстрый</button>
        </div>
        ${botControls(snap)}
        <button class="btn btn-primary btn-wide" ${canStart ? "" : "disabled"}
          data-on:click="@post('/act/start', {retry: 'never'})">${startLabel}</button>
      </div>
    </section>
  </div>`;
}

// Боты: хост добивает состав, когда друзей не хватает (или для проверки партии
// в одиночку). Кнопки есть только у хоста в лобби и только пока есть места.
function botControls(snap: Snapshot): string {
  if (!snap.me.isHost) return "";
  const free = snap.maxPlayers - snap.players.length;
  if (free <= 0) return "";
  const add = (count: number, label: string) =>
    `<button class="chip bot-chip" data-on:click="@post('/act/bots', {payload: {count: ${count}}, retry: 'never'})">${label}</button>`;
  return `<div class="bot-row">
    <span class="bot-row-label">боты</span>
    ${add(1, "+1")}
    ${add(5, "+5")}
    ${free >= 10 ? add(10, "+10") : ""}
    ${free > 1 ? add(free, `заполнить (+${free})`) : ""}
  </div>`;
}

// ---------- игровой экран ----------

// Подсказка при наведении: все восемь категорий по порядку. Раскрытые — зелёным
// со значением, скрытые — серым, только название категории (значение скрытой
// карты физически не приходит на клиент).
const LOCK_ICON =
  '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2.5" y="5.2" width="7" height="5" rx="1.2"/><path d="M4.3 5.2V4a1.7 1.7 0 0 1 3.4 0v1.2"/></svg>';
const CHECK_ICON =
  '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2.2 6.4l2.4 2.4 5.2-5.4"/></svg>';

function peekCard(p: Player): string {
  // Раскрытая — категория + значение зелёным. Скрытая — только категория серым,
  // вместо значения пунктир: видно, что слот есть, но содержимое неизвестно.
  const slots = (p.traitSlots || [])
    .map((slot) =>
      slot.revealed
        ? `<div class="peek-row on">
            <span class="peek-cat">${esc(slot.label)}</span>
            <span class="peek-val">${esc(slot.value || "—")}${
              slot.effect ? `<i class="peek-eff">${esc(slot.effect)}</i>` : ""
            }</span>
            <span class="peek-ico">${CHECK_ICON}</span>
          </div>`
        : `<div class="peek-row">
            <span class="peek-cat">${esc(slot.label)}</span>
            <span class="peek-val"></span>
            <span class="peek-ico">${LOCK_ICON}</span>
          </div>`,
    )
    .join("");
  const state = !p.alive
    ? p.left
      ? "вышел"
      : p.death?.cause === "exile"
        ? "изгнан"
        : "погиб"
    : p.isBot
      ? "бот"
      : p.connected
        ? "в бункере"
        : "нет связи";
  return `<div class="peek-head">
      ${avatar(p, "sm")}
      <div class="peek-id">
        <div class="peek-name">${esc(p.name)}</div>
        <div class="peek-meta">${esc(state)} · раскрыто ${p.traitsRevealed} из ${p.totalTraits}</div>
      </div>
    </div>
    <div class="peek-list">${slots}</div>`;
}

function playersPanel(snap: Snapshot): string {
  const rows = snap.players
    .map((p) => {
      const status = !p.alive
        ? `<span class="status dead"><i></i>${p.left ? "вышел" : p.death?.cause === "exile" ? "изгнан" : "погиб"}</span>`
        : "";
      const votes = p.votesAgainst > 0 ? `<span class="vote-pin">${p.votesAgainst}</span>` : "";
      return `
        <div class="players-row ${p.alive ? "" : "dead"} ${p.id === snap.me.id ? "is-me" : ""} ${
          snap.turn?.playerId === p.id ? "current-turn" : ""
        }" data-peek>
          <div class="peek-source" hidden aria-hidden="true">${peekCard(p)}</div>
          ${avatar(p, "xs")}
          <span class="pname">${esc(p.name)}</span>
          ${p.isBot ? '<span class="mini-badge bot">бот</span>' : ""}
          ${status}${votes}
          <span class="pdots">${"●".repeat(p.traitsRevealed)}${"○".repeat(Math.max(0, p.totalTraits - p.traitsRevealed))}</span>
        </div>`;
    })
    .join("");
  return `
    <section class="panel players-panel">
      <header class="panel-head">
        <div>
          <span class="eyebrow">В БУНКЕРЕ</span>
          <h2>Выжившие</h2>
        </div>
        <span class="seat-count">${snap.aliveCount} / ${snap.players.length}</span>
      </header>
      <div class="players-list">${rows}</div>
    </section>`;
}

// «Ваши карты» — всегда на экране: игрок в любой момент видит свои
// характеристики и что из них уже на столе.
function ownCards(snap: Snapshot): string {
  if (snap.state === "lobby") return "";
  const rows = snap.me.traits
    .map((t) => {
      const ability = snap.me.ability;
      const special = t.cat === "special";
      const mark = special
        ? ability?.used
          ? "использована"
          : ability?.available && !ability.pending
            ? `<button class="ability-use" data-on:click="@post('/act/ability', {payload: {action: 'start'}, retry: 'never'})">применить</button>`
            : "готова"
        : t.revealed
          ? "на столе"
          : "скрыта";
      return `<div class="own-card ${t.revealed ? "revealed" : ""} ${special ? "special" : ""}">
        <span class="own-cat">${esc(t.label)}</span>
        <span class="own-value">${esc(t.value)}${
          special && t.desc
            ? ` <button class="ability-info" data-ability-info="${esc(t.desc)}" aria-label="Что даёт спецвозможность">i</button>`
            : ""
        }</span>
        <span class="own-mark">${mark}</span>
        ${t.effect ? `<span class="own-eff">${esc(t.effect)}</span>` : ""}
      </div>`;
    })
    .join("");
  return `<section class="panel own-panel">
    <header class="panel-head">
      <div><span class="eyebrow">ЛИЧНОЕ ДЕЛО</span><h2>Ваши карты</h2></div>
      <span class="seat-count">${snap.me.traits.filter((t) => t.revealed).length} / ${snap.me.traits.length}</span>
    </header>
    <div class="own-list">${rows}</div>
  </section>`;
}

function turnStrip(snap: Snapshot): string {
  const turn = snap.turn;
  if (!turn || !turn.order.length) return "";
  const chips = turn.order
    .map((p) => {
      const cls = [
        "turn-chip",
        p.current ? "current" : "",
        p.done || p.revealed ? "done" : "",
        p.alive ? "" : "dead",
      ]
        .filter(Boolean)
        .join(" ");
      return `<span class="${cls}">${p.current ? '<i class="turn-dot"></i>' : ""}${esc(p.name)}<b>${p.revealed ? "✓" : ""}</b></span>`;
    })
    .join("");
  return `<div class="turn-strip">
    <div class="turn-head">
      <span class="eyebrow">ОЧЕРЕДЬ РАСКРЫТИЯ</span>
      <span class="seat-count">${turn.index} / ${turn.total}</span>
    </div>
    <div class="turn-chips">${chips}</div>
  </div>`;
}

function introHero(snap: Snapshot): string {
  const story = snap.story;
  const ready = snap.ready || { me: false, count: 0, total: snap.totalCount };
  const pct = ready.total ? Math.round((ready.count / ready.total) * 100) : 0;
  const res = snap.resources;
  const readyButton = ready.me
    ? '<button class="btn btn-secondary intro-ready" disabled>Вы прочитали</button>'
    : `<button class="btn btn-secondary intro-ready" data-on:click="@post('/act/ready', {retry: 'never'})">Я прочитал</button>`;
  const hostButton = snap.me.isHost
    ? `<button class="btn btn-primary intro-start" data-on:click="@post('/act/skip', {retry: 'never'})">Начать день</button>`
    : `<span class="intro-wait">Ждём хоста: он откроет первый день.</span>`;
  const sparks = "<i></i>".repeat(14);
  return `<div class="intro-hero">
    <div class="intro-visual" aria-hidden="true">
      <div class="intro-glow"></div>
      <div class="intro-rings"><i></i><i></i><i></i></div>
      <svg class="intro-door" viewBox="0 0 200 200" fill="none" aria-hidden="true">
        <circle cx="100" cy="100" r="86" stroke="currentColor" stroke-width="1.5" opacity=".5"/>
        <circle cx="100" cy="100" r="70" stroke="currentColor" stroke-width="3"/>
        <circle cx="100" cy="100" r="58" stroke="currentColor" stroke-width="1.5" opacity=".7"/>
        <path d="M100 30v140M30 100h140" stroke="currentColor" stroke-width="2" opacity=".8"/>
        <path d="M54 54l92 92M146 54l-92 92" stroke="currentColor" stroke-width="1.2" opacity=".4"/>
        <circle cx="100" cy="100" r="14" stroke="currentColor" stroke-width="2"/>
        <circle cx="100" cy="100" r="5" fill="currentColor"/>
        <circle cx="100" cy="18" r="3.5" fill="currentColor"/>
        <circle cx="182" cy="100" r="3.5" fill="currentColor"/>
        <circle cx="100" cy="182" r="3.5" fill="currentColor"/>
        <circle cx="18" cy="100" r="3.5" fill="currentColor"/>
      </svg>
      <div class="intro-sparks">${sparks}</div>
      <div class="intro-visual-label">КОЛЬЦО-9<span>гермодверь закрыта</span></div>
    </div>

    <div class="intro-copy">
      <span class="intro-kicker">СИГНАЛ ТИШИНЫ · СЦЕНАРИЙ ПАРТИИ</span>
      <h1 class="intro-title">${esc(story?.title || "Смена собрана")}</h1>
      <p class="intro-premise">${esc(story?.premise || "Семнадцать дней назад мир замолчал. Вы — последние, кто успел закрыть за собой гермодверь.")}</p>
      ${
        story?.threat
          ? `<div class="intro-threat"><span>ЧТО НАСТОРАЖИВАЕТ</span><b>${esc(story.threat)}</b></div>`
          : ""
      }
      <div class="intro-stats">
        <div><b>${snap.totalCount}</b><span>человек в смене</span></div>
        <div><b>${snap.rescueDay ?? "?"}</b><span>дней до спасения</span></div>
        <div><b>${snap.crewMin}</b><span>минимум смены</span></div>
        <div class="intro-res">
          <span><b>${res.food}</b> еда</span>
          <span><b>${res.energy}</b> энергия</span>
          <span><b>${res.meds}</b> медицина</span>
        </div>
      </div>
      <div class="intro-read">
        <div class="intro-meter"><i style="width: ${pct}%"></i></div>
        <span class="intro-read-count">${ready.count} / ${ready.total} прочитали</span>
      </div>
      <div class="intro-actions">${readyButton}${hostButton}</div>
    </div>
  </div>`;
}

function abilityPanel(snap: Snapshot): string {
  const ability = snap.me.ability;
  if (!ability?.pending) return "";
  const cancel = `<button class="chip ability-cancel" data-on:click="@post('/act/ability', {payload: {action: 'cancel'}, retry: 'never'})">Отмена</button>`;
  if (ability.pending.stage === "category") {
    const cards = snap.me.traits
      .map((trait, index) =>
        trait.cat === "special"
          ? ""
          : `<button class="ability-pick" data-on:click="@post('/act/ability', {payload: {action: 'category', index: ${index}}, retry: 'never'})">
              <span class="ability-pick-cat">${esc(trait.label)}</span>
              <span class="ability-pick-val">${esc(trait.value)}</span>
              <span class="ability-pick-tag">${trait.revealed ? "на столе" : "скрыта"}</span>
            </button>`,
      )
      .join("");
    return `<div class="ability-panel">
      <span class="eyebrow">СПЕЦВОЗМОЖНОСТЬ · ${esc(ability.label)}</span>
      <h3>Какую карту обменять?</h3>
      <p>Выберите свою карту — потом выберете выжившего. Карты поменяются местами,
        категория останется у обоих.</p>
      <div class="ability-cats">${cards}</div>
      ${cancel}
    </div>`;
  }
  const targets = ability.targets
    .map(
      (p) => `<button class="target-card ability-target"
        data-on:click="@post('/act/ability', {payload: {action: 'target', target: '${p.id}'}, retry: 'never'})">
        ${avatar(p as Player, "xs")}
        <span class="target-name">${esc(p.name)}</span>
      </button>`,
    )
    .join("");
  return `<div class="ability-panel">
    <span class="eyebrow">СПЕЦВОЗМОЖНОСТЬ · ${esc(ability.label)}</span>
    <h3>${ability.kind === "swap" ? "С кем поменяться?" : "Чьё досье открыть?"}</h3>
    <p>${
      ability.kind === "swap"
        ? "Карты поменяются местами. Если карта уже на столе — на столе окажется новая."
        : "Скрытые карты увидите только вы. Остальные заметят только, что вы сверялись с досье."
    }</p>
    <div class="target-grid ability-targets">${targets}</div>
    ${cancel}
  </div>`;
}

function eventCard(snap: Snapshot): string {
  if (!snap.event) return "";
  const parts = [
    snap.event.food
      ? `<span class="${snap.event.food > 0 ? "up" : "down"}">ЕДА ${snap.event.food > 0 ? "+" : ""}${snap.event.food}</span>`
      : "",
    snap.event.energy
      ? `<span class="${snap.event.energy > 0 ? "up" : "down"}">ЭНЕРГИЯ ${snap.event.energy > 0 ? "+" : ""}${snap.event.energy}</span>`
      : "",
    snap.event.meds
      ? `<span class="${snap.event.meds > 0 ? "up" : "down"}">МЕДЫ ${snap.event.meds > 0 ? "+" : ""}${snap.event.meds}</span>`
      : "",
  ]
    .filter(Boolean)
    .join("");
  return `
    <div class="event-card">
      <div class="event-head"><span class="eyebrow">СОБЫТИЕ ДНЯ</span><span class="event-day">день ${snap.day}</span></div>
      <h3>${esc(snap.event.title)}</h3>
      <p>${esc(snap.event.text)}</p>
      <div class="event-effects">${parts}</div>
    </div>`;
}

function revealScene(snap: Snapshot): string {
  const me = snap.me;
  const turn = snap.turn;

  if (!me.alive)
    return `<div class="action-block"><h3>Вы наблюдаете</h3>
      <p>Мёртвые не действуют и не раскрывают карты. Смотрите, кто что показывает.</p>
      ${turnStrip(snap)}</div>`;

  // мой ход: сначала карта, потом подтверждение
  if (turn && me.isMyTurn) {
    const last = me.traits.find((t) => t.revealed);
    if (turn.stage === "confirm" || !me.canReveal) {
      return `<div class="action-block">
        <span class="eyebrow turn-eyebrow">ВАШ ХОД · ${turn.index} / ${turn.total}</span>
        <h3>Карта на столе</h3>
        <p>${last ? `Все видят: <b>${esc(last.label)} — ${esc(last.value)}</b>.` : "Раскрывать больше нечего."}</p>
        <p class="note">Подтвердите конец хода — очередь перейдёт к следующему выжившему.</p>
        <button class="btn btn-primary end-turn-btn" data-on:click="@post('/act/end-turn', {retry: 'never'})">Завершить ход →</button>
        ${turnStrip(snap)}
      </div>`;
    }
    const cards = me.traits
      .map(
        (t, i) => `
      <button class="trait-card ${t.revealed ? "revealed" : ""}" ${t.revealed ? "disabled" : ""}
        data-on:click="@post('/act/reveal', {payload: {index: ${i}}, retry: 'never'})">
        <span class="trait-label">${esc(t.label)}</span>
        <span class="trait-value">${esc(t.value)}</span>
        ${t.effect ? `<span class="trait-eff">${esc(t.effect)}</span>` : ""}
        <span class="trait-mark">${t.revealed ? "на столе" : "скрыто"}</span>
      </button>`,
      )
      .join("");
    return `<div class="action-block">
        <span class="eyebrow turn-eyebrow">ВАШ ХОД · ${turn.index} / ${turn.total}</span>
        <h3>Покажите одну карту</h3>
        <p>Один факт станет публичным навсегда. Выбирайте осторожно — потом подтвердите конец хода.</p>
        <div class="trait-grid">${cards}</div>
        ${turnStrip(snap)}
      </div>`;
  }

  // чужой ход
  const who = turn?.name || "следующий";
  return `<div class="action-block">
      <span class="eyebrow">РАСКРЫТИЕ · ${turn ? `${turn.index} / ${turn.total}` : ""}</span>
      <h3>Сейчас ход: ${esc(who)}</h3>
      <p>Выжившие открывают по одной карте по очереди. ${turn?.stage === "confirm" ? "Карта на столе — ждём подтверждения хода." : "Смотрите и запоминайте."}</p>
      <p class="note">Свои карты всегда видны слева — их можно перечитать в любой момент.</p>
      ${turnStrip(snap)}
    </div>`;
}

function voteScene(snap: Snapshot): string {
  const me = snap.me;
  const alive = snap.players.filter((p) => p.alive);
  if (!me.alive)
    return `<div class="action-block"><h3>Вы наблюдаете</h3><p>Мёртвые не голосуют.</p>${tally(snap)}</div>`;
  const waiters = alive.filter((p) => !p.votedFor).map((p) => p.name);
  const waiting = waiters.length
    ? `Ждут голоса: ${esc(waiters.length <= 3 ? waiters.join(", ") : `${waiters.slice(0, 3).join(", ")} и ещё ${waiters.length - 3}`)}`
    : "Все голоса собраны · хост может закрыть голосование";
  const cards = alive
    .map((p) => {
      // за себя голосовать нельзя — показываем карточку, но не кнопкой
      if (p.id === me.id)
        return `<div class="target-card self" title="За себя голосовать нельзя">
          ${avatar(p, "xs")}
          <span class="target-name">${esc(p.name)} · вы</span>
          <span class="target-meta">за себя нельзя</span>
        </div>`;
      return `
      <button class="target-card ${me.votedFor === p.id ? "selected" : ""}"
        data-on:click="@post('/act/vote', {payload: {target: '${p.id}'}, retry: 'never'})">
        ${avatar(p, "xs")}
        <span class="target-name">${esc(p.name)}</span>
        <span class="target-meta">${p.traitsRevealed}/${p.totalTraits} карт</span>
        <span class="target-votes ${p.votesAgainst ? "" : "zero"}">${p.votesAgainst}</span>
      </button>`;
    })
    .join("");
  return `<div class="action-block">
      <h3>Кого изгнать?</h3>
      <p>Изгнанный покидает бункер навсегда, и все его карты становятся видны. При равенстве голосов не уходит никто.</p>
      <div class="target-grid">${cards}</div>
      <div class="vote-tools">
        <button class="chip skip-vote ${me.votedFor === "skip" ? "selected" : ""}"
          data-on:click="@post('/act/vote', {payload: {target: 'skip'}, retry: 'never'})">Воздержаться</button>
        <span class="note">${esc(waiting)}</span>
      </div>
      ${tally(snap)}
    </div>`;
}

function tally(snap: Snapshot): string {
  const voted = snap.players
    .filter((p) => p.alive && p.votedFor)
    .map((p) => {
      const target =
        p.votedFor === "skip"
          ? "воздержался"
          : snap.players.find((x) => x.id === p.votedFor)?.name || "—";
      return `<li><b>${esc(p.name)}</b> → ${esc(target)}</li>`;
    })
    .join("");
  return voted ? `<ul class="vote-tally">${voted}</ul>` : "";
}

function endScene(snap: Snapshot): string {
  const ending = snap.ending;
  const survived = snap.winner === "survived";
  const tag = survived ? "СПАСЕНИЕ" : "БУНКЕР ПОГИБ";
  const roster = snap.players
    .map((p) => {
      const fate = p.alive ? (survived ? "спасся" : "погиб") : p.left ? "вышел" : "изгнан";
      return `<li class="${p.alive && survived ? "survived" : ""}">${avatar(p, "xs")} <b>${esc(p.name)}</b> — ${esc(fate)}</li>`;
    })
    .join("");
  return `<div class="action-block">
      <span class="eyebrow">ПРОТОКОЛ ЗАВЕРШЁН${snap.story?.title ? ` · ${esc(snap.story.title)}` : ""}</span>
      <h3>${esc(tag)}</h3>
      <h4>${esc(ending?.title || "")}</h4>
      <p>${esc(ending?.text || "")}</p>
      <ul class="end-roster">${roster}</ul>
      ${recapBlock(snap)}
      ${
        snap.me.isHost
          ? `<button class="btn btn-primary" data-on:click="@post('/act/rematch', {retry: 'never'})">Сыграть ещё</button>`
          : '<p class="note">Хост откроет новый бункер.</p>'
      }
    </div>`;
}

// Разбор партии: пока модель думает — скелетон, потом текст (или фолбэк сервера).
function recapBlock(snap: Snapshot): string {
  if (snap.recapPending)
    return `<div class="recap pending">
      <span class="eyebrow">РАЗБОР ПАРТИИ</span>
      <div class="recap-skeleton"><i></i><i></i></div>
    </div>`;
  if (!snap.recap) return "";
  const paragraphs = snap.recap.paragraphs.map((text) => `<p>${esc(text)}</p>`).join("");
  return `<div class="recap">
    <span class="eyebrow">РАЗБОР ПАРТИИ</span>
    <h4>${esc(snap.recap.title)}</h4>
    ${paragraphs}
    ${snap.recap.verdict ? `<div class="recap-verdict">${esc(snap.recap.verdict)}</div>` : ""}
  </div>`;
}

// Стол раскрытий: кто что уже показал. Основа обсуждения — видно, у кого
// сколько карт на столе и какие именно.
function revealBoard(snap: Snapshot): string {
  const rows = snap.players
    .filter((p) => p.alive)
    .map((p) => {
      const chips = (p.traitSlots || [])
        .filter((slot) => slot.revealed)
        .map(
          (slot) =>
            `<span class="rb-chip"><i>${esc(slot.label)}</i>${esc(slot.value || "")}</span>`,
        )
        .join("");
      return `<div class="rb-card" data-peek>
        <div class="peek-source" hidden aria-hidden="true">${peekCard(p)}</div>
        <div class="rb-head">
          ${avatar(p, "xs")}
          <span class="rb-name">${esc(p.name)}</span>
          <span class="rb-count">${p.traitsRevealed}/${p.totalTraits}</span>
        </div>
        <div class="rb-chips">${chips || '<span class="rb-empty">ничего не показал</span>'}</div>
      </div>`;
    })
    .join("");
  const total = snap.players.filter((p) => p.alive).length;
  return `<div class="reveal-board">
    <div class="rb-title">
      <span class="eyebrow">СТОЛ РАСКРЫТИЙ</span>
      <span class="seat-count">${total} выживших</span>
    </div>
    <div class="rb-grid">${rows}</div>
  </div>`;
}

function hintList(snap: Snapshot): string {
  const hints = snap.hints || [];
  if (!hints.length) return "";
  return `<div class="hints">
    <span class="eyebrow">О ЧЁМ СПРОСИТЬ</span>
    <ul class="hint-list">${hints
      .map((h) => `<li class="hint"><span class="hint-dot"></span>${esc(h)}</li>`)
      .join("")}</ul>
  </div>`;
}

// Обсуждение. Два вида: сводка (по умолчанию) и старый текстовый — переключатель
// в шапке панели, выбор живёт в сигнале $simple до перезагрузки.
function discussionScene(snap: Snapshot): string {
  return `<div class="action-block">
    <div data-show="!$simple" class="discuss-rich">
      ${revealBoard(snap)}
      ${hintList(snap)}
    </div>

    <div data-show="$simple" class="discuss-plain">
      <h3>Кому вы верите?</h3>
      <p>Сопоставляйте карты, голоса и ночные потери. Голосование начнётся автоматически.</p>
      <p class="note">Доверие — ресурс. Здесь его расходуют быстрее еды.</p>
    </div>
  </div>`;
}

function scene(snap: Snapshot): string {
  const byState: Record<string, () => string> = {
    intro: () => introHero(snap),
    reveal: () => revealScene(snap),
    discussion: () => discussionScene(snap),
    vote: () => voteScene(snap),
    end: () => endScene(snap),
  };
  const titles: Record<string, string> = {
    intro: "Сценарий",
    reveal: "Раскрытие карт",
    discussion: "Обсуждение",
    vote: "Голосование",
    end: "Протокол завершён",
  };
  const body = (byState[snap.state] || (() => '<p class="note">Ждём начала…</p>'))();
  const host =
    snap.me.isHost && snap.state !== "end"
      ? `<button class="chip skip-phase" data-on:click="@post('/act/skip', {retry: 'never'})">Пропустить фазу</button>`
      : "";
  // На обсуждении два вида — переключатель живёт в шапке, чтобы не пропадал
  // вместе со сводкой.
  const viewToggle =
    snap.state === "discussion"
      ? `<button class="chip" data-on:click="$simple = !$simple"
          data-text="$simple ? 'сводка' : 'простой вид'">простой вид</button>`
      : "";
  const headActions = `<div class="head-actions">${viewToggle}${host}</div>`;
  // Сценарий — самостоятельный экран: заголовок панели и кнопка пропуска
  // дублировали бы герой и его кнопки.
  const head =
    snap.state === "intro"
      ? ""
      : `<header class="panel-head">
        <div>
          <span class="eyebrow">${snap.day ? `ДЕНЬ ${snap.day}` : "ПАРТИЯ"}</span>
          <h2>${esc(titles[snap.state] || "Ход партии")}</h2>
        </div>
        ${headActions}
      </header>`;
  return `
    <section class="panel scene-panel${snap.state === "intro" ? " intro-panel" : ""}">
      ${head}
      ${abilityPanel(snap)}
      ${eventCard(snap)}
      ${body}
    </section>`;
}

// Лента чата: у каждого типа сообщения свой вид, чтобы по ней можно было
// читать партию глазами, а не расшифровывать строки.
const BOLT_ICON =
  '<svg viewBox="0 0 12 12" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M6.6 0.6 2.2 6.5h2.6L4.9 11.4l4.6-6.1H6.8z"/></svg>';
const SKULL_ICON =
  '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><path d="M2.2 5.2a3.8 3.8 0 0 1 7.6 0v1.6c0 .9-.6 1.4-1.3 1.4H9v1.2H3v-1.2h-.5c-.7 0-1.3-.5-1.3-1.4z"/><circle cx="4.4" cy="5.6" r=".8" fill="currentColor" stroke="none"/><circle cx="7.6" cy="5.6" r=".8" fill="currentColor" stroke="none"/></svg>';
const SUN_ICON =
  '<svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><circle cx="6" cy="6" r="2.2"/><path d="M6 .8v1.4M6 9.8v1.4M.8 6h1.4M9.8 6h1.4M2.3 2.3l1 1M8.7 8.7l1 1M9.7 2.3l-1 1M3.3 8.7l-1 1"/></svg>';

function feedHtml(snap: Snapshot, activeTab = "day"): string {
  const channel = activeTab || "day";
  const myId = snap.me.id;
  return snap.messages
    .filter((m) => m.kind !== "chat" || m.channel === channel || m.channel === "system")
    .slice(-60)
    .map((m) => {
      if (m.kind === "chat") {
        const mine = String((m as { authorId?: string }).authorId || "") === myId;
        return `<div class="chat-msg${mine ? " mine" : ""}">
          <span class="chat-ava">${esc(m.avatar || "•")}</span>
          <span class="chat-author">${esc(m.author)}</span>
          <span class="chat-text">${esc(m.text)}</span>
        </div>`;
      }

      // раскрытие карты — карточкой: кто, какая категория и что именно
      if (m.kind === "reveal") {
        const card = m as unknown as { traitLabel?: string; traitValue?: string };
        return `<div class="chat-reveal">
          <span class="cr-avatar">${esc(m.avatar || "•")}</span>
          <span class="cr-name">${esc(m.author)}<span> раскрывает</span></span>
          <span class="cr-line">
            <span class="cr-cat">${esc(card.traitLabel || "")}</span>
            <b class="cr-val">${esc(card.traitValue || "")}</b>
          </span>
        </div>`;
      }

      // итоги голосования: полоски, кто сколько набрал
      if (m.kind === "vote") {
        const vote = m as unknown as {
          votes?: { name: string; count: number }[];
          skipped?: number;
        };
        const list = vote.votes || [];
        const top = Math.max(1, ...list.map((v) => v.count));
        const bars = list
          .map(
            (v) => `<div class="cv-row">
              <span class="cv-name">${esc(v.name)}</span>
              <span class="cv-bar"><i style="width:${Math.round((v.count / top) * 100)}%"></i></span>
              <span class="cv-count">${v.count}</span>
            </div>`,
          )
          .join("");
        const skipped = vote.skipped
          ? `<div class="cv-skip">воздержались · ${vote.skipped}</div>`
          : "";
        return `<div class="chat-vote">
          <div class="cv-head">ИТОГИ ГОЛОСОВАНИЯ</div>
          ${bars || '<div class="cv-empty">голосов не было</div>'}
          ${skipped}
        </div>`;
      }

      const tone = m.tone || "info";
      // смена дня и фазы — разделитель на всю ширину ленты
      if (tone === "phase") {
        const text = esc(m.text);
        const day = /^ДЕНЬ\s+\d+$/.test(m.text.trim());
        return `<div class="chat-divider${day ? " day" : ""} tone-phase">
          <span class="cd-line"></span>
          <span class="cd-text">${day ? SUN_ICON : ""}${text}</span>
          <span class="cd-line"></span>
        </div>`;
      }
      if (tone === "title") return `<div class="chat-title">${esc(m.text)}</div>`;
      if (tone === "bad" || tone === "good" || tone === "warn") {
        const icon = tone === "good" ? SUN_ICON : tone === "warn" ? BOLT_ICON : SKULL_ICON;
        return `<div class="chat-event ${tone} tone-${tone}"><span class="ce-ico">${icon}</span><span>${esc(m.text)}</span></div>`;
      }
      if (tone === "muted") return `<div class="chat-note">${esc(m.text)}</div>`;
      return `<div class="chat-system tone-${esc(tone)}">${esc(m.text)}</div>`;
    })
    .join("");
}

function chatPanel(snap: Snapshot, activeTab = "day"): string {
  const allowed = [snap.chat.day ? "day" : null, snap.chat.dead ? "dead" : null].filter(
    Boolean,
  ) as string[];
  const label: Record<string, string> = { day: "ЗАЛ", dead: "МЁРТВЫЕ" };
  // Активный канал — серверное состояние (/act/tab), не сигнал: лента рендерится
  // на сервере, поэтому клик по «ШЁПОТ» не менял ничего до отправки сообщения.
  const tabs =
    allowed.length > 1
      ? `<div class="chat-tabs">${allowed
          .map(
            (ch) =>
              `<button class="chat-tab${ch === activeTab ? " on" : ""}" data-on:click="@post('/act/tab', {payload: {tab: '${ch}'}, retry: 'never'})">${label[ch]}</button>`,
          )
          .join("")}</div>`
      : "";

  return `
    <section class="panel chat-panel">
      <header class="panel-head"><div><span class="eyebrow">СВЯЗЬ</span><h2>Чат</h2></div></header>
      <div id="chatTabs">${tabs}</div>
      <div class="chat-feed" id="chatFeed" role="log" aria-live="polite" aria-relevant="additions" aria-label="Лента чата">${feedHtml(snap, activeTab)}</div>
      <form class="chat-form" data-on:submit="@post('/act/chat', {contentType: 'form'}); $msg = ''">
        <input id="chatInput" name="text" autocomplete="off" placeholder="Сообщение в ${{ day: "зал", dead: "мёртвых" }[activeTab] || "зал"}…"
          data-bind="msg" data-preserve-attr="value" ${allowed.length ? "" : "disabled"}>
        <input type="hidden" name="channel" value="${activeTab}">
        <button type="submit" class="send-btn" ${allowed.length ? "" : "disabled"} aria-label="Отправить">→</button>
      </form>
    </section>`;
}

// ---------- модалки ----------

function rules(snap: Snapshot): string {
  return `
        <button class="modal-close" data-on:click="document.getElementById('rules').close()" aria-label="Закрыть правила">×</button>
        <div class="modal-head"><span class="eyebrow">ПРОТОКОЛ «КОЛЬЦО-9»</span><h2 id="rulesTitle">Как выжить</h2></div>
        <div class="modal-section">
          <p><b>Цель.</b> Дожить до спасения. Оно приходит после голосования последнего дня — спасаются все, кто к тому моменту жив.</p>
          <p><b>Сценарий.</b> Партия начинается без таймера: прочитайте катастрофу и нажмите «Я прочитал». Когда прочитают все (или хост откроет день), начнётся раскрытие.</p>
          <p><b>День.</b> По очереди раскрываете по одной своей карте, обсуждаете и голосуете. Изгнанный выбывает навсегда, его карты становятся видны. При равенстве голосов никто не уходит.</p>
          <p><b>Карты.</b> У каждого восемь характеристик: пол и возраст, рост и вес, здоровье, профессия, хобби, багаж, крупный багаж и спецвозможность. Ранги, степени болезней и уровни навыка влияют на расход бункера.</p>
          <p><b>Спецвозможность.</b> Одна на партию, применяется днём: обменяться картой с выжившим, вскрыть НЗ (+6 еды, +4 энергии, +1 медикамент) или посмотреть скрытые карты одного игрока.</p>
          <p><b>Ресурсы.</b> Каждый день бункер тратит еду на всех живых и энергию на системы. Событие дня может добавить или отнять запасы.</p>
          <p><b>Кризис.</b> Отдельной ночи нет: сразу после голосования бункер проверяет запасы. Если еда или энергия на нуле, он теряет одного; медикаменты могут прикрыть один такой переход.</p>
          <p><b>Провал.</b> Бункер гибнет, если живых осталось меньше ${snap.crewMin}: системы некому обслуживать.</p>
        </div>`;
}

// ---------- сборка ответов ----------
// Контракт: #topbar и #board патчатся целиком, диалоги живут в оболочке.
// #board в партии — он же .game-grid (три колонки), в лобби — .lobby-main.

const TAB_STOL_ICON =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3.2" y="3.2" width="7.2" height="7.2" rx="1.6"/><rect x="13.6" y="3.2" width="7.2" height="7.2" rx="1.6"/><rect x="3.2" y="13.6" width="7.2" height="7.2" rx="1.6"/><rect x="13.6" y="13.6" width="7.2" height="7.2" rx="1.6"/></svg>';
const TAB_CHAT_ICON =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 5.4A2.4 2.4 0 0 1 6.4 3h11.2A2.4 2.4 0 0 1 20 5.4v8.2a2.4 2.4 0 0 1-2.4 2.4H9.8L5.2 20v-4H6.4A2.4 2.4 0 0 1 4 13.6z" stroke-linejoin="round"/></svg>';

// На телефоне интерфейс живёт вкладками: стол и чат по очереди, без длинного
// скролла. На десктопе панель скрыта (display:none в базовых стилях).
function mobileTabbar(): string {
  return `<nav class="mtabbar" aria-label="Разделы игры">
    <button type="button" class="mtab" data-mtab-btn="play" aria-pressed="true">
      <span class="mtab-ico">${TAB_STOL_ICON}</span><span>Стол</span>
    </button>
    <button type="button" class="mtab" data-mtab-btn="chat" aria-pressed="false">
      <span class="mtab-ico">${TAB_CHAT_ICON}</span><span>Чат</span>
    </button>
  </nav>`;
}

// Нужно ли действие от игрока прямо сейчас: на мобильной вкладке «Стол»
// появляется точка, даже если открыт чат.
function needsAction(snap: Snapshot): boolean {
  if (snap.state === "vote") return Boolean(snap.me.alive && !snap.me.votedFor);
  if (snap.state === "reveal")
    return Boolean(snap.me.isMyTurn && (snap.me.canReveal || snap.me.canEndTurn));
  if (snap.state === "lobby")
    return Boolean(snap.me.isHost && snap.players.length >= snap.minPlayers);
  return false;
}

export function renderApp(snap: Snapshot, origin: string, tab = "day"): string {
  const signals = `{reveal: false, msg: '', simple: false}`;
  // Оболочка одна на всё приложение: если менять её id при переходе
  // лобби -> игра, старые правила лобби продолжают применяться к игре.
  const stateClass = snap.state === "lobby" ? "state-lobby" : "state-game";
  return `<div id="app" data-signals="${signals}" data-init="@get('/stream', {retry: 'always', retryMaxWait: 5000, retryMaxCount: 100000})">
    <section id="shell" class="screen ${stateClass}">
      ${topbar(snap, origin)}
      <div id="banner" class="phase-banner"></div>
      ${renderBoard(snap, origin, tab)}
      ${mobileTabbar()}
      <dialog id="rules" class="sheet" aria-labelledby="rulesTitle">${rules(snap)}</dialog>
      <dialog id="abilityHelp" class="sheet ability-sheet" aria-labelledby="abilityHelpTitle">
        <button class="modal-close" data-on:click="document.getElementById('abilityHelp').close()" aria-label="Закрыть">×</button>
        <div class="modal-head"><span class="eyebrow">СПЕЦВОЗМОЖНОСТЬ</span><h2 id="abilityHelpTitle">Что она даёт</h2></div>
        <div class="modal-section"><p id="abilityHelpBody"></p></div>
      </dialog>
      <div id="error"></div>
      <div id="peek" class="peek" hidden></div>
    </section>
  </div>`;
}

export function renderBoard(snap: Snapshot, origin: string, tab = "day"): string {
  const action = needsAction(snap) ? "1" : "0";
  const myTurn = snap.state === "reveal" && snap.me.isMyTurn ? "1" : "0";
  if (snap.state === "lobby") {
    return `<div id="board" data-action="${action}" data-phase="lobby"><main class="lobby-main">
      ${lobby(snap, origin)}
      <div class="lobby-chat-panel">${chatPanel(snap, tab)}</div>
    </main></div>`;
  }
  return `<main id="board" class="game-grid" data-action="${action}" data-phase="${esc(snap.state)}" data-my-turn="${myTurn}">
    <div class="side-column">${ownCards(snap)}${playersPanel(snap)}</div>
    ${scene(snap)}
    ${chatPanel(snap, tab)}
  </main>`;
}

export function renderTopbar(snap: Snapshot, origin: string): string {
  return topbar(snap, origin);
}

export function renderTabs(snap: Snapshot, activeTab = "day"): string {
  const allowed = [snap.chat.day ? "day" : null, snap.chat.dead ? "dead" : null].filter(
    Boolean,
  ) as string[];
  const labels: Record<string, string> = { day: "ЗАЛ", dead: "МЁРТВЫЕ" };
  const tabs =
    allowed.length > 1
      ? allowed
          .map(
            (ch) =>
              `<button class="chat-tab${ch === activeTab ? " on" : ""}" data-on:click="@post('/act/tab', {payload: {tab: '${ch}'}, retry: 'never'})">${labels[ch]}</button>`,
          )
          .join("")
      : "";
  return `<div id="chatTabs">${tabs}</div>`;
}

export function renderChat(snap: Snapshot): string {
  return `<div id="chat">${chatPanel(snap)}</div>`;
}

export function renderFeed(snap: Snapshot, activeTab: string): string {
  return `<div id="chatFeed">${feedHtml(snap, activeTab)}</div>`;
}

export function renderTitle(snap: Snapshot): string {
  const parts = ["БУНКЕР·9"];
  if (snap.state === "lobby") parts.push("лобби");
  else {
    if (snap.day) parts.push(`день ${snap.day}`);
    const label: Record<string, string> = {
      intro: "сценарий",
      reveal: "раскрытие карт",
      discussion: "обсуждение",
      vote: "голосование",
      end: "итог",
    };
    if (label[snap.state]) parts.push(label[snap.state]);
  }
  return `<title>${esc(parts.join(" · "))}</title>`;
}

export function renderError(text: string): string {
  return `<div id="error" class="toast show">${esc(text)}</div>`;
}
