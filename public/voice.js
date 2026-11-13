// Голос: браузерный speechSynthesis. Голос и манера выбираются в меню кнопки,
// выбор живёт в localStorage. На каждом устройстве свои голоса (macOS, Android,
// iOS говорят разными голосами) — это нормально для браузерного синтеза.
const KEY = "bunker9-voice-cfg";
const DEFAULTS = { on: false, voiceURI: "", mode: "calm" };
const MODES = {
  calm: { rate: 1.02, pitch: 0.92, label: "Спокойно" },
  radio: { rate: 0.88, pitch: 0.7, label: "Диктор" },
  fast: { rate: 1.25, pitch: 1.0, label: "Быстро" },
};

const synth = window.speechSynthesis;

const load = () => {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || "{}") };
  } catch {
    return { ...DEFAULTS };
  }
};
const save = (cfg) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(cfg));
  } catch {
    /* приватный режим — живём без сохранения */
  }
};

let cfg = load();
let menu = null;

function voices() {
  if (!synth) return [];
  const all = synth.getVoices();
  const ru = all.filter((v) => (v.lang || "").toLowerCase().startsWith("ru"));
  return (ru.length ? ru : all).slice(0, 8);
}

function currentVoice() {
  const list = voices();
  return list.find((v) => v.voiceURI === cfg.voiceURI) || list[0] || null;
}

function speak(text, { interrupt = false } = {}) {
  if (!cfg.on || !synth || !text) return;
  const phrase = String(text).replace(/\s+/g, " ").trim().slice(0, 240);
  if (!phrase) return;
  const mode = MODES[cfg.mode] || MODES.calm;
  try {
    if (interrupt) synth.cancel();
    const utter = new SpeechSynthesisUtterance(phrase);
    utter.lang = "ru-RU";
    const voice = currentVoice();
    if (voice) utter.voice = voice;
    utter.rate = mode.rate;
    utter.pitch = mode.pitch;
    utter.volume = 0.92;
    synth.speak(utter);
  } catch {
    /* синтез недоступен — молчим */
  }
}

function icon(on) {
  return on
    ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18 6a8.5 8.5 0 0 1 0 12"/><path d="M20.5 12h1.5"/></svg>`
    : `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 10l5 4M21 10l-5 4"/></svg>`;
}

function renderMenu() {
  if (!menu) return;
  const list = voices();
  const rows = list.length
    ? list
        .map(
          (v, i) =>
            `<button class="vm-item ${currentVoice()?.voiceURI === v.voiceURI ? "on" : ""}" data-voice="${i}">
              ${v.name} <span>${v.lang || ""}</span>
            </button>`,
        )
        .join("")
    : `<div class="vm-empty">В этом браузере нет голосов</div>`;
  menu.innerHTML = `
    <button class="vm-toggle ${cfg.on ? "on" : ""}" data-toggle>${cfg.on ? "Голос включён" : "Голос выключен"}</button>
    <div class="vm-title">Голос</div>
    ${rows}
    <div class="vm-title">Манера</div>
    <div class="vm-modes">
      ${Object.entries(MODES)
        .map(
          ([key, mode]) =>
            `<button class="vm-item vm-mode ${cfg.mode === key ? "on" : ""}" data-mode="${key}">${mode.label}</button>`,
        )
        .join("")}
    </div>`;
}

function closeMenu() {
  if (!menu) return;
  menu.hidden = true;
  document.removeEventListener("click", onDocClick, true);
}

function onDocClick(event) {
  if (menu && !menu.contains(event.target) && !event.target.closest(".voice-btn")) closeMenu();
}

function openMenu(btn) {
  if (!menu) {
    menu = document.createElement("div");
    menu.className = "voice-menu";
    document.body.appendChild(menu);
  }
  bindMenu();
  renderMenu();
  const rect = btn.getBoundingClientRect();
  menu.hidden = false;
  menu.style.top = `${Math.round(rect.bottom + 8)}px`;
  menu.style.left = `${Math.round(Math.min(rect.left, window.innerWidth - 268))}px`;
  setTimeout(() => document.addEventListener("click", onDocClick, true), 0);
}

function bindMenu() {
  if (!menu || menu.dataset.bound) return;
  menu.dataset.bound = "1";
  menu.addEventListener("click", (event) => {
    const toggle = event.target.closest("[data-toggle]");
    if (toggle) {
      cfg.on = !cfg.on;
      save(cfg);
      refreshButton();
      renderMenu();
      if (cfg.on) speak("Голос включён");
      else synth?.cancel();
      return;
    }
    const modeBtn = event.target.closest("[data-mode]");
    if (modeBtn) {
      cfg.mode = modeBtn.dataset.mode;
      save(cfg);
      renderMenu();
      if (cfg.on) speak("Так звучит выбранная манера");
      return;
    }
    const voiceBtn = event.target.closest("[data-voice]");
    if (voiceBtn) {
      const voice = voices()[Number(voiceBtn.dataset.voice)];
      if (voice) cfg.voiceURI = voice.voiceURI;
      save(cfg);
      renderMenu();
      if (cfg.on) speak("Так звучит выбранный голос");
    }
  });
}

let button = null;

function refreshButton() {
  if (!button) return;
  button.innerHTML = icon(cfg.on);
  button.title = cfg.on ? "Голос включён — настроить" : "Голос выключен — настроить";
  button.setAttribute("aria-pressed", cfg.on ? "true" : "false");
}

function mountButton() {
  const actions = document.querySelector(".top-actions");
  if (!actions) return;
  if (actions.querySelector(".voice-btn")) {
    button = actions.querySelector(".voice-btn");
    return;
  }
  button = document.createElement("button");
  button.className = "icon-btn voice-btn";
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (menu && !menu.hidden) closeMenu();
    else openMenu(button);
  });
  refreshButton();
  const sound = actions.querySelector(".sound-btn");
  if (sound && sound.nextSibling) actions.insertBefore(button, sound.nextSibling);
  else if (sound) actions.appendChild(button);
  else actions.prepend(button);
  bindMenu();
}

// ---------- что читаем ----------

let lastBanner = "";
const spokenEvents = new Set();
let lastEnd = false;

function observe() {
  const banner = document.querySelector(".phase-banner.show");
  if (banner) {
    const text = banner.textContent.trim();
    if (text && text !== lastBanner) {
      lastBanner = text;
      speak(text);
    }
  } else if (lastBanner) {
    lastBanner = "";
  }

  for (const node of document.querySelectorAll(".chat-event.bad, .chat-event.warn")) {
    const text = node.textContent.trim();
    if (!spokenEvents.has(text)) {
      if (spokenEvents.size > 120) spokenEvents.clear();
      spokenEvents.add(text);
      speak(text);
    }
  }

  const end = document.querySelector(".end-roster");
  if (end && !lastEnd) {
    lastEnd = true;
    const title = end.closest(".action-block")?.querySelector("h3");
    if (title) speak(`Партия окончена. ${title.textContent.trim()}`, { interrupt: true });
  }
}

new MutationObserver(() => {
  mountButton();
  observe();
}).observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["class"],
});

if (synth)
  synth.addEventListener?.("voiceschanged", () => {
    if (menu && !menu.hidden) renderMenu();
    refreshButton();
  });

window.addEventListener("resize", () => closeMenu());
mountButton();
