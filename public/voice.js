// Голос: браузерный speechSynthesis — без ключей, запросов и задержек.
// Читает смену фаз, изгнания/потери и финал. Включается кнопкой в шапке,
// выбор живёт в localStorage. Не мешает sound.js: там эффекты, здесь речь.
const STORAGE = "bunker9-voice";
let enabled = localStorage.getItem(STORAGE) === "1";
let voice = null;

const synth = window.speechSynthesis;

function pickVoice() {
  if (!synth) return null;
  const voices = synth.getVoices();
  if (!voices.length) return null;
  const ru = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith("ru"));
  return ru.find((v) => /milena|alena|irina|yuri|pavel/i.test(v.name)) || ru[0] || null;
}

if (synth) {
  pickVoice();
  synth.addEventListener?.("voiceschanged", () => {
    voice = pickVoice();
  });
}

function speak(text, { interrupt = false } = {}) {
  if (!enabled || !synth || !text) return;
  const phrase = String(text).replace(/\s+/g, " ").trim().slice(0, 240);
  if (!phrase) return;
  try {
    if (interrupt) synth.cancel();
    const utter = new SpeechSynthesisUtterance(phrase);
    utter.lang = "ru-RU";
    if (voice) utter.voice = voice;
    utter.rate = 1.02;
    utter.pitch = 0.92;
    utter.volume = 0.9;
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

function mountButton() {
  const actions = document.querySelector(".top-actions");
  if (!actions || actions.querySelector(".voice-btn")) return;
  const btn = document.createElement("button");
  btn.className = "icon-btn voice-btn";
  btn.innerHTML = icon(enabled);
  btn.title = enabled ? "Выключить голос" : "Включить голос";
  btn.setAttribute("aria-pressed", enabled ? "true" : "false");
  btn.addEventListener("click", () => {
    enabled = !enabled;
    localStorage.setItem(STORAGE, enabled ? "1" : "0");
    btn.innerHTML = icon(enabled);
    btn.title = enabled ? "Выключить голос" : "Включить голос";
    btn.setAttribute("aria-pressed", enabled ? "true" : "false");
    if (enabled) speak("Голос включён");
    else synth?.cancel();
  });
  const sound = actions.querySelector(".sound-btn");
  if (sound && sound.nextSibling) actions.insertBefore(btn, sound.nextSibling);
  else if (sound) actions.appendChild(btn);
  else actions.prepend(btn);
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
    // баннер скрылся — следующий показ снова прочитаем
    lastBanner = "";
  }

  const events = document.querySelectorAll(".chat-event.bad, .chat-event.warn");
  for (const node of events) {
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
    const title = document
      .querySelector(".end-roster")
      ?.closest(".action-block")
      ?.querySelector("h3");
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

mountButton();
