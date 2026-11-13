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
  teammate: boolean;
  role: string | null;
  roleLabel: string | null;
  death: { day: number; cause: string; note?: string } | null;
  traits: { cat: string; label: string; value: string }[];
  traitsRevealed: number;
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
    avatar: string;
    avatarIndex: number;
    isHost: boolean;
    alive: boolean;
    role: string | null;
    roleLabel: string | null;
    traits: { cat: string; label: string; value: string; revealed: boolean }[];
    canReveal: boolean;
    isMyTurn: boolean;
    canEndTurn: boolean;
    revealedThisRound: boolean;
    votedFor: string | null;
    nightTarget: string | null;
    doctorSkip: boolean;
    lastHealTarget: string | null;
    teammates: string[];
  };
  players: Player[];
  resources: { food: number; energy: number; meds: number };
  event: { title: string; text: string; food: number; energy: number; meds: number } | null;
  settings: { pace: string };
  aliveCount: number;
  minPlayers: number;
  maxPlayers: number;
  phaseEndsAt: number | null;
  winner: string | null;
  chat: { day: boolean; mafia: boolean; dead: boolean };
  messages: {
    id: number;
    kind: string;
    tone: string;
    channel: string;
    author: string;
    avatar: string;
    text: string;
  }[];
  preview: { infected: number; doctor: number; humans: number };
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
  night: { mafiaVotes?: Record<string, string>; doctorTarget?: string };
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
  intro: "ПРОБУЖДЕНИЕ",
  reveal: "РАССВЕТ",
  discussion: "ОБСУЖДЕНИЕ",
  vote: "ГОЛОСОВАНИЕ",
  night: "НОЧЬ",
  end: "ИТОГ",
};

const PHASE_TONE: Record<string, string> = {
  vote: "vote",
  night: "night",
  end: "end",
};

const ROLE_NAME: Record<string, string> = {
  human: "ЖИВОЙ",
  doctor: "ВРАЧ",
  infected: "ЗАРАЖЁННЫЙ",
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
  return `<button class="pill pill-icon" title="Выйти" aria-label="Выйти" data-on:click="confirm('Выйти из бункера? Персонаж погибнет, роль раскроется.') && @post('/act/leave', {retry: 'never'})">×</button>`;
}

function topbar(snap: Snapshot): string {
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
      <button class="pill room-pill" title="Скопировать код"
        data-on:click="navigator.clipboard?.writeText('${esc(snap.code)}')">
        <span class="room-code">${esc(snap.code)}</span><span class="room-copy">копировать</span>
      </button>
    </div>

    <div class="topbar-center">
      <span class="phase-chip tone-${tone}">${esc(PHASE_CHIP[snap.state] || "")}</span>
      ${snap.state !== "lobby" ? `<span class="phase-day">день ${snap.day}</span>` : ""}
      ${timer}
    </div>

    <div class="topbar-right">
      <div class="resources">
        <span class="res${low(res.food, snap.aliveCount)}"><i>еда</i><b>${res.food}</b></span>
        <span class="res${low(res.energy, 2)}"><i>энергия</i><b>${res.energy}</b></span>
        <span class="res${low(res.meds, 0)}"><i>меды</i><b>${res.meds}</b></span>
      </div>
      <div class="top-actions">
        <button class="pill" data-on:click="document.getElementById('dossier').showModal()">Досье</button>
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
        <span class="chip chip-warn">заражённых ${snap.preview.infected}</span>
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

function playersPanel(snap: Snapshot): string {
  const rows = snap.players
    .map((p) => {
      const status = !p.alive
        ? `<span class="status dead"><i></i>${p.left ? "вышел" : p.death?.cause === "exile" ? "изгнан" : "погиб"}</span>`
        : "";
      const role = p.role
        ? `<span class="prole tone-${p.role}">${esc(p.roleLabel || ROLE_NAME[p.role] || "")}</span>`
        : "";
      const votes = p.votesAgainst > 0 ? `<span class="vote-pin">${p.votesAgainst}</span>` : "";
      return `
        <div class="players-row ${p.alive ? "" : "dead"} ${p.id === snap.me.id ? "is-me" : ""} ${
          snap.turn?.playerId === p.id ? "current-turn" : ""
        }">
          ${avatar(p, "xs")}
          <span class="pname">${esc(p.name)}</span>
          ${p.teammate ? '<span class="mini-badge mafia">свой</span>' : ""}
          ${p.isBot ? '<span class="mini-badge bot">бот</span>' : ""}
          ${status}${role}${votes}
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

// «Ваши карты» — всегда на экране, не только в досье: игрок в любой момент
// видит свои характеристики и что из них уже на столе.
function ownCards(snap: Snapshot): string {
  if (snap.state === "lobby") return "";
  const rows = snap.me.traits
    .map(
      (t) => `<div class="own-card ${t.revealed ? "revealed" : ""}">
        <span class="own-cat">${esc(t.label)}</span>
        <span class="own-value">${esc(t.value)}</span>
        <span class="own-mark">${t.revealed ? "на столе" : "скрыта"}</span>
      </div>`,
    )
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
    .map(
      (p) => `
      <button class="target-card ${me.votedFor === p.id ? "selected" : ""}"
        data-on:click="@post('/act/vote', {payload: {target: '${p.id}'}, retry: 'never'})">
        ${avatar(p, "xs")}
        <span class="target-name">${esc(p.name)}${p.id === me.id ? " · вы" : ""}</span>
        <span class="target-meta">${p.traitsRevealed}/${p.totalTraits} карт</span>
        <span class="target-votes ${p.votesAgainst ? "" : "zero"}">${p.votesAgainst}</span>
      </button>`,
    )
    .join("");
  return `<div class="action-block">
      <h3>Кого изгнать?</h3>
      <p>Изгнанный покидает бункер навсегда, и его роль становится известна. При равенстве голосов не уходит никто.</p>
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

function nightScene(snap: Snapshot): string {
  const me = snap.me;
  const alive = snap.players.filter((p) => p.alive);
  if (!me.alive)
    return `<div class="action-block"><h3>Вы наблюдаете</h3><p>Ночь переживают молча.</p></div>`;
  if (me.role === "infected") {
    const targets = alive.filter((p) => p.id !== me.id && !me.teammates.includes(p.id));
    const cards = targets
      .map(
        (p) => `
        <button class="target-card ${me.nightTarget === p.id ? "selected" : ""}"
          data-on:click="@post('/act/night', {payload: {target: '${p.id}'}, retry: 'never'})">
          ${avatar(p, "xs")}
          <span class="target-name">${esc(p.name)}</span>
          <span class="target-meta">${p.traitsRevealed}/${p.totalTraits} карт</span>
        </button>`,
      )
      .join("");
    return `<div class="action-block">
        <h3>Кого забрать?</h3>
        <p>Голоса заражённых суммируются. При равенстве цель выбирает случай.</p>
        ${me.teammates.length ? `<p class="note">Свои рядом — их не выбирают.</p>` : ""}
        <div class="target-grid">${cards}</div>
      </div>`;
  }
  if (me.role === "doctor") {
    const targets = alive.filter((p) => p.id !== me.lastHealTarget);
    const cards = targets
      .map(
        (p) => `
        <button class="target-card ${me.nightTarget === p.id ? "selected" : ""}"
          data-on:click="@post('/act/night', {payload: {target: '${p.id}'}, retry: 'never'})">
          ${avatar(p, "xs")}
          <span class="target-name">${esc(p.name)}</span>
          <span class="target-meta">жив</span>
        </button>`,
      )
      .join("");
    return `<div class="action-block">
        <h3>Кого спасти?</h3>
        <p>Медикаментов в бункере: <b>${snap.resources.meds}</b>. Попытка спасти тратит один.</p>
        <div class="target-grid">${cards}</div>
        <button class="chip skip-vote ${me.doctorSkip ? "selected" : ""}"
          data-on:click="@post('/act/doctor-skip', {retry: 'never'})">Не тратить медикаменты</button>
      </div>`;
  }
  return `<div class="action-block">
      <h3>Вы заперты в отсеке</h3>
      <p>За стеной — шаги, которые не совпадают с ритмом ни одного из выживших. Остаётся ждать рассвета.</p>
      <p class="note">У вас нет ночного действия. Смотрите в чат: возможно, кто-то уже проговорился.</p>
    </div>`;
}

function endScene(snap: Snapshot): string {
  const ending = snap.ending;
  const tag =
    snap.winner === "humans"
      ? "ПОБЕДА ЖИВЫХ"
      : snap.winner === "infected"
        ? "ПОБЕДА ЗАРАЖЁННЫХ"
        : "НИЧЬЯ";
  const roster = snap.players
    .map(
      (p) =>
        `<li>${avatar(p, "xs")} <b>${esc(p.name)}</b> — ${esc(p.roleLabel || ROLE_NAME[p.role || ""] || "—")}</li>`,
    )
    .join("");
  return `<div class="action-block">
      <span class="eyebrow">ПРОТОКОЛ ЗАВЕРШЁН</span>
      <h3>${esc(tag)}</h3>
      <h4>${esc(ending?.title || "")}</h4>
      <p>${esc(ending?.text || "")}</p>
      <ul class="end-roster">${roster}</ul>
      ${
        snap.me.isHost
          ? `<button class="btn btn-primary" data-on:click="@post('/act/rematch', {retry: 'never'})">Сыграть ещё</button>`
          : '<p class="note">Хост откроет новый бункер.</p>'
      }
    </div>`;
}

function scene(snap: Snapshot): string {
  const byState: Record<string, () => string> = {
    intro: () => `<div class="action-block">
        <h3>Добро пожаловать в «Кольцо-9»</h3>
        <p>Семнадцать дней назад мир замолчал. Теперь у вас есть еда, генератор и чужие голоса за стеной.</p>
        <p class="note">Роли уже розданы. Первый день начнётся автоматически.</p>
        <button class="btn btn-secondary" data-on:click="document.getElementById('dossier').showModal()">Открыть досье</button>
      </div>`,
    reveal: () => revealScene(snap),
    discussion: () => `<div class="action-block">
        <h3>Кому вы верите?</h3>
        <p>Сопоставляйте карты, голоса и ночные потери. Голосование начнётся автоматически.</p>
        <p class="note">Доверие — ресурс. Здесь его расходуют быстрее еды.</p>
      </div>`,
    vote: () => voteScene(snap),
    night: () => nightScene(snap),
    end: () => endScene(snap),
  };
  const titles: Record<string, string> = {
    intro: "Роли розданы",
    reveal: "Раскрытие карт",
    discussion: "Обсуждение",
    vote: "Голосование",
    night: "Свет гаснет",
    end: "Протокол завершён",
  };
  const body = (byState[snap.state] || (() => '<p class="note">Ждём начала…</p>'))();
  const host =
    snap.me.isHost && snap.state !== "end"
      ? `<button class="chip skip-phase" data-on:click="@post('/act/skip', {retry: 'never'})">Пропустить фазу</button>`
      : "";
  return `
    <section class="panel scene-panel">
      <header class="panel-head">
        <div>
          <span class="eyebrow">${snap.day ? `ДЕНЬ ${snap.day}` : "ПАРТИЯ"}</span>
          <h2>${esc(titles[snap.state] || "Ход партии")}</h2>
        </div>
        ${host}
      </header>
      ${eventCard(snap)}
      ${body}
    </section>`;
}

function feedHtml(snap: Snapshot, activeTab = "day"): string {
  const channel = activeTab || "day";
  return snap.messages
    .filter((m) => m.kind !== "chat" || m.channel === channel || m.channel === "system")
    .slice(-60)
    .map((m) => {
      if (m.kind === "chat") {
        return `<div class="chat-msg"><span class="chat-author">${esc(m.author)}</span><span class="chat-text">${esc(m.text)}</span></div>`;
      }
      return `<div class="chat-system tone-${esc(m.tone || "info")}">${esc(m.text)}</div>`;
    })
    .join("");
}

function chatPanel(snap: Snapshot, activeTab = "day"): string {
  const allowed = [
    snap.chat.day ? "day" : null,
    snap.chat.mafia ? "mafia" : null,
    snap.chat.dead ? "dead" : null,
  ].filter(Boolean) as string[];
  const label: Record<string, string> = { day: "ЗАЛ", mafia: "ШЁПОТ", dead: "МЁРТВЫЕ" };
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
        <input id="chatInput" name="text" autocomplete="off" placeholder="Сообщение в ${{ day: "зал", mafia: "шёпот", dead: "мёртвых" }[activeTab] || "зал"}…"
          data-bind="msg" data-preserve-attr="value" ${allowed.length ? "" : "disabled"}>
        <input type="hidden" name="channel" value="${activeTab}">
        <button type="submit" class="send-btn" ${allowed.length ? "" : "disabled"} aria-label="Отправить">→</button>
      </form>
    </section>`;
}

// ---------- модалки ----------

function dossierBody(snap: Snapshot): string {
  const me = snap.me;
  const roleHidden = snap.state !== "end";
  const traits = me.traits
    .map(
      (t) => `<div class="trait-row ${t.revealed ? "revealed" : ""}">
        <span class="trait-label">${esc(t.label)}</span>
        <span class="trait-value">${esc(t.value)}</span>
        <span class="trait-mark">${t.revealed ? "на столе" : "скрыта"}</span>
      </div>`,
    )
    .join("");
  return `
        <button class="modal-close" data-on:click="document.getElementById('dossier').close()" aria-label="Закрыть досье">×</button>
        <div class="modal-head">
          <span class="eyebrow">ЛИЧНОЕ ДЕЛО</span>
          <h2 id="dossierTitle">${esc(me.name)}</h2>
        </div>
        <div class="modal-section">
          ${
            roleHidden && me.alive
              ? `<p class="note">За этой дверью — роль и пять личных карт.</p>
               <div class="role-card"><span class="role-sigil">?</span><b>РОЛЬ СКРЫТА</b></div>
               <button class="btn btn-primary btn-wide" data-on:click="$reveal = true"
                 data-show="!$reveal">Показать роль</button>
               <div data-show="$reveal" class="role-card role-open">
                 <b class="tone-${me.role}">${esc(me.roleLabel || "")}</b>
                 <p>${esc(roleHint(me.role))}</p>
               </div>`
              : `<div class="role-card role-open"><b class="tone-${me.role}">${esc(me.roleLabel || "")}</b>
                 <p>${esc(roleHint(me.role))}</p></div>`
          }
        </div>
        <div class="modal-section">
          <span class="eyebrow">КАРТЫ ПЕРСОНАЖА</span>
          ${traits}
        </div>`;
}

function roleHint(role: string | null): string {
  if (role === "infected")
    return "Вы не человек. Ночью выбирайте жертву. Днём — лгите и ищите врача.";
  if (role === "doctor")
    return "Вы человек и врач. Раз за ночь спасайте одного выжившего за медикамент.";
  if (role === "human")
    return "Вы человек. Найдите заражённых и изгоните их до того, как бункер опустеет.";
  return "";
}

function rules(): string {
  return `
        <button class="modal-close" data-on:click="document.getElementById('rules').close()" aria-label="Закрыть правила">×</button>
        <div class="modal-head"><span class="eyebrow">ПРОТОКОЛ «КОЛЬЦО-9»</span><h2 id="rulesTitle">Как выжить</h2></div>
        <div class="modal-section">
          <p><b>День.</b> Раскройте одну карту, обсудите и проголосуйте. Изгнанный выбывает, его роль раскрывается. При равенстве голосов никто не уходит.</p>
          <p><b>Ночь.</b> Заражённые вместе выбирают жертву. Врач может спасти одного, потратив медикамент.</p>
          <p><b>Победа.</b> Живые — когда заражённых не осталось. Заражённые — когда их не меньше, чем живых.</p>
        </div>`;
}

// ---------- сборка ответов ----------
// Контракт: #topbar и #board патчатся целиком, диалоги живут в оболочке.
// #board в партии — он же .game-grid (три колонки), в лобби — .lobby-main.

export function renderApp(snap: Snapshot, origin: string, tab = "day"): string {
  const signals = `{reveal: false, msg: ''}`;
  // Оболочка одна на всё приложение: если менять её id при переходе
  // лобби -> игра, старые правила лобби продолжают применяться к игре.
  const stateClass = snap.state === "lobby" ? "state-lobby" : "state-game";
  return `<div id="app" data-signals="${signals}" data-init="@get('/stream', {retry: 'always', retryMaxWait: 5000, retryMaxCount: 100000})">
    <section id="shell" class="screen ${stateClass}">
      ${topbar(snap)}
      <div id="banner" class="phase-banner"></div>
      ${renderBoard(snap, origin, tab)}
      <dialog id="dossier" class="sheet" aria-labelledby="dossierTitle">
        <div id="dossierBody">${dossierBody(snap)}</div>
      </dialog>
      <dialog id="rules" class="sheet" aria-labelledby="rulesTitle">${rules()}</dialog>
      <div id="error"></div>
    </section>
  </div>`;
}

export function renderBoard(snap: Snapshot, origin: string, tab = "day"): string {
  if (snap.state === "lobby") {
    return `<div id="board"><main class="lobby-main">
      ${lobby(snap, origin)}
      <div class="lobby-chat-panel">${chatPanel(snap, tab)}</div>
    </main></div>`;
  }
  return `<main id="board" class="game-grid">
    <div class="side-column">${ownCards(snap)}${playersPanel(snap)}</div>
    ${scene(snap)}
    ${chatPanel(snap, tab)}
  </main>`;
}

// Содержимое досье патчится отдельно: диалог живёт в оболочке, поэтому морфинг
// внутренностей не закрывает открытое окно.
export function renderDossierBody(snap: Snapshot): string {
  return `<div id="dossierBody">${dossierBody(snap)}</div>`;
}

export function renderTopbar(snap: Snapshot): string {
  return topbar(snap);
}

export function renderTabs(snap: Snapshot, activeTab = "day"): string {
  const allowed = [
    snap.chat.day ? "day" : null,
    snap.chat.mafia ? "mafia" : null,
    snap.chat.dead ? "dead" : null,
  ].filter(Boolean) as string[];
  const labels: Record<string, string> = { day: "ЗАЛ", mafia: "ШЁПОТ", dead: "МЁРТВЫЕ" };
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
  const channel = activeTab || "day";
  const list = snap.messages
    .filter((m) => m.kind !== "chat" || m.channel === channel || m.channel === "system")
    .slice(-60)
    .map((m) => {
      if (m.kind === "chat") {
        return `<div class="chat-msg"><span class="chat-author">${esc(m.author)}</span><span class="chat-text">${esc(m.text)}</span></div>`;
      }
      return `<div class="chat-system tone-${esc(m.tone || "info")}">${esc(m.text)}</div>`;
    })
    .join("");
  return `<div id="chatFeed">${list}</div>`;
}

export function renderTitle(snap: Snapshot): string {
  const parts = ["БУНКЕР·9"];
  if (snap.state === "lobby") parts.push("лобби");
  else {
    if (snap.day) parts.push(`день ${snap.day}`);
    const label: Record<string, string> = {
      intro: "роли розданы",
      reveal: "раскрытие карт",
      discussion: "обсуждение",
      vote: "голосование",
      night: "ночь",
      end: "итог",
    };
    if (label[snap.state]) parts.push(label[snap.state]);
  }
  return `<title>${esc(parts.join(" · "))}</title>`;
}

export function renderError(text: string): string {
  return `<div id="error" class="toast show">${esc(text)}</div>`;
}
