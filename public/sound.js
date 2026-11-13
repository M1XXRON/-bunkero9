// БУНКЕР·9 — звуки интерфейса. Синтезируются WebAudio на лету:
// ни одного аудиофайла, ни одной внешней зависимости.
// Первый клик по странице разблокирует AudioContext (требование браузеров).

const Ctx = window.AudioContext || window.webkitAudioContext;
let ctx = null;
let master = null;
let muted = localStorage.getItem("bunker9-mute") === "1";

function ensure() {
  if (ctx) return ctx.state !== "suspended";
  if (!Ctx) return false;
  ctx = new Ctx();
  master = ctx.createGain();
  master.gain.value = 0.32; // громкость общего микса
  master.connect(ctx.destination);
  return true;
}

// мягкий «блип» с изменением частоты и спадом
function tone({ from = 600, to = 400, dur = 0.09, vol = 0.5, type = "sine", noise = 0 }) {
  if (muted || !ensure()) return;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(40, to), t + dur);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.linearRampToValueAtTime(vol, t + Math.min(0.012, dur / 4));
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain);
  gain.connect(master);
  if (noise > 0) {
    // лёгкий шип для «ошибок» и «смертей»
    const len = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) * noise;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const ng = ctx.createGain();
    ng.gain.value = vol * 0.6;
    src.connect(ng);
    ng.connect(master);
    src.start(t);
  }
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

// нисходящий аккорд — «стук»
function thud(vol = 0.6) {
  tone({ from: 180, to: 55, dur: 0.22, vol, type: "triangle", noise: 0.35 });
}

export const sfx = {
  click: () => tone({ from: 760, to: 520, dur: 0.05, vol: 0.34 }),
  tick: () => tone({ from: 980, to: 940, dur: 0.03, vol: 0.16 }),
  message: () => tone({ from: 1240, to: 980, dur: 0.07, vol: 0.26 }),
  reveal: () => {
    tone({ from: 520, to: 780, dur: 0.09, vol: 0.3 });
    setTimeout(() => tone({ from: 780, to: 1040, dur: 0.09, vol: 0.26 }), 90);
  },
  vote: () => tone({ from: 640, to: 440, dur: 0.08, vol: 0.3, type: "square" }),
  night: () => {
    tone({ from: 420, to: 180, dur: 0.5, vol: 0.28, type: "sine" });
    thud(0.3);
  },
  day: () => {
    tone({ from: 520, to: 660, dur: 0.14, vol: 0.26 });
    setTimeout(() => tone({ from: 660, to: 880, dur: 0.16, vol: 0.22 }), 130);
  },
  death: () => {
    thud(0.55);
    setTimeout(
      () => tone({ from: 300, to: 90, dur: 0.4, vol: 0.24, type: "sawtooth", noise: 0.25 }),
      120,
    );
  },
  error: () => tone({ from: 220, to: 150, dur: 0.14, vol: 0.3, type: "square", noise: 0.3 }),
  win: () => {
    [523, 659, 784].forEach((f, i) =>
      setTimeout(() => tone({ from: f, to: f * 1.06, dur: 0.16, vol: 0.24 }), i * 130),
    );
  },
  lose: () => {
    [392, 330, 262].forEach((f, i) =>
      setTimeout(
        () => tone({ from: f, to: f * 0.94, dur: 0.2, vol: 0.24, type: "triangle" }),
        i * 150,
      ),
    );
  },
};

// ---------- события DOM ----------

// разблокировка звука + клики по кнопкам
document.addEventListener(
  "pointerdown",
  (e) => {
    if (!ensure()) return;
    if (ctx.state === "suspended") ctx.resume();
    if (e.target.closest("button, .trait-card, .target-card, .chip, .chat-tab")) sfx.click();
  },
  { capture: true },
);

// сообщения чата и ошибки приходят патчами — ловим изменения ленты
new MutationObserver((muts) => {
  for (const m of muts) {
    if (m.type === "childList") {
      for (const n of m.addedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        if (n.classList.contains("chat-msg")) sfx.message();
        else if (n.classList.contains("chat-system")) {
          if (n.classList.contains("tone-bad")) sfx.death();
          else sfx.message();
        } else if (n.id === "error") sfx.error();
      }
    }
  }
}).observe(document.body, { childList: true, subtree: true });

// ---------- кнопка звука в шапке ----------

function icon(muted) {
  return muted
    ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M18 9l4 6M22 9l-4 6"/></svg>`
    : `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/><path d="M19 6a8.5 8.5 0 0 1 0 12"/></svg>`;
}

function mountButton() {
  const actions = document.querySelector(".top-actions");
  if (!actions || actions.querySelector(".sound-btn")) return;
  const btn = document.createElement("button");
  btn.className = "icon-btn sound-btn";
  btn.title = muted ? "Включить звук" : "Выключить звук";
  btn.innerHTML = icon(muted);
  btn.addEventListener("click", () => {
    muted = !muted;
    localStorage.setItem("bunker9-mute", muted ? "1" : "0");
    btn.innerHTML = icon(muted);
    btn.title = muted ? "Включить звук" : "Выключить звук";
    if (!muted) sfx.message();
  });
  actions.prepend(btn);
}

new MutationObserver(() => mountButton()).observe(document.body, {
  childList: true,
  subtree: true,
});
mountButton();

// ---------- реакция на фазу: лента .phase-banner уже патчится сервером ----------

const bannerObs = new MutationObserver(() => {
  const banner = document.querySelector(".phase-banner.show");
  if (!banner || banner.dataset.played === "1") return;
  banner.dataset.played = "1";
  const tone = banner.dataset.tone || "day";
  if (tone === "night") sfx.night();
  else if (tone === "bad") sfx.death();
  else sfx.day();
});
bannerObs.observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["class"],
});

console.log("[БУНКЕР·9] звук:", muted ? "выключен" : "включён");
