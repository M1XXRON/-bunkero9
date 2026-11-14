// БУНКЕР·9 — маленький интерактивный слой визуальной редакции 3.0.
// Никаких сетевых вызовов и зависимостей: только доступность и обратная связь.
(() => {
  const root = document.documentElement;
  const motionMedia = window.matchMedia("(prefers-reduced-motion: reduce)");
  const MOTION_KEY = "bunker-motion";
  const readMotionPreference = () => {
    try {
      return localStorage.getItem(MOTION_KEY);
    } catch {
      return null;
    }
  };

  // Постоянные декоративные движения можно остановить явно. Системный
  // prefers-reduced-motion имеет приоритет над ручным включением.
  function syncMotion() {
    const saved = readMotionPreference();
    const off = motionMedia.matches || saved === "off";
    root.dataset.motion = off ? "off" : "on";
    const systemOff = motionMedia.matches;
    document.querySelectorAll("[data-motion-toggle]").forEach((button) => {
      const label = systemOff
        ? "Анимация отключена системной настройкой"
        : off
          ? "Включить анимацию"
          : "Выключить анимацию";
      button.setAttribute("aria-label", label);
      button.title = label;
      button.disabled = systemOff;
    });
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest?.("[data-motion-toggle]");
    if (!button || motionMedia.matches) return;
    const off = root.dataset.motion !== "off";
    try {
      localStorage.setItem(MOTION_KEY, off ? "off" : "on");
    } catch {
      // Приватный режим: настройка действует до закрытия вкладки.
    }
    syncMotion();
  });
  motionMedia.addEventListener?.("change", syncMotion);
  syncMotion();

  // Одна вежливая live-region для действий, которые раньше проходили без
  // визуального подтверждения (например, копирование приглашения).
  let toastTimer = 0;
  function toast(message, tone = "success") {
    let node = document.getElementById("uiToast");
    if (!node) {
      node = document.createElement("div");
      node.id = "uiToast";
      node.className = "ui-toast";
      node.setAttribute("role", "status");
      node.setAttribute("aria-live", "polite");
      node.setAttribute("aria-atomic", "true");
      document.body.appendChild(node);
    }
    clearTimeout(toastTimer);
    node.hidden = true;
    node.textContent = message;
    node.dataset.tone = tone;
    // Перезапуск короткой entrance-анимации для повторного действия.
    void node.offsetWidth;
    node.hidden = false;
    toastTimer = window.setTimeout(() => {
      node.hidden = true;
      node.textContent = "";
    }, 3200);
  }
  window.bunkerToast = toast;

  function fallbackCopy(text) {
    const previousFocus = document.activeElement;
    const area = document.createElement("textarea");
    area.value = text;
    area.className = "clipboard-fallback";
    area.setAttribute("readonly", "");
    document.body.appendChild(area);
    area.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      // Пользователь получит понятную ошибку ниже.
    }
    area.remove();
    if (previousFocus instanceof HTMLElement) previousFocus.focus({ preventScroll: true });
    return copied;
  }

  window.bunkerCopyInvite = async (text) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(text);
      toast("Приглашение скопировано: код и ссылка готовы к отправке");
      return true;
    } catch {
      const copied = fallbackCopy(text);
      toast(
        copied
          ? "Приглашение скопировано: код и ссылка готовы к отправке"
          : "Не удалось скопировать. Нажмите на код в шапке и выделите его вручную.",
        copied ? "success" : "error",
      );
      return copied;
    }
  };

  // Поиск идёт строго по публичному содержимому стола. Скрытых характеристик
  // в этих карточках нет даже в исходном HTML.
  let filterTimer = 0;
  function applyBoardFilter() {
    const input = document.getElementById("boardFilter");
    if (!(input instanceof HTMLInputElement)) return;
    const query = input.value.trim().toLocaleLowerCase("ru");
    const cards = [...document.querySelectorAll("#board .rb-card")];
    let visible = 0;
    for (const card of cards) {
      const matches = !query || card.textContent.toLocaleLowerCase("ru").includes(query);
      card.hidden = !matches;
      if (matches) visible += 1;
    }
    const empty = document.getElementById("boardFilterEmpty");
    if (empty) empty.hidden = visible !== 0;
    clearTimeout(filterTimer);
    filterTimer = window.setTimeout(() => {
      const status = document.getElementById("boardFilterStatus");
      if (status)
        status.textContent = query
          ? `Найдено: ${visible} из ${cards.length}`
          : `${cards.length} карточек`;
    }, 160);
  }

  document.addEventListener("input", (event) => {
    if (event.target.id === "boardFilter") applyBoardFilter();
  });

  // Слеш фокусирует чат, на мобильном сначала открывает существующую вкладку.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
    ) {
      return;
    }
    if (document.querySelector("dialog[open]")) return;
    event.preventDefault();
    const tab = document.querySelector('.mtab[data-mtab-btn="chat"]');
    if (tab && getComputedStyle(tab).display !== "none") tab.click();
    const input = document.getElementById("chatInput");
    if (!input || input.disabled) return;
    window.setTimeout(() => input.focus({ preventScroll: true }), 30);
  });

  // Изменение числа должно быть заметно, но без мигания всей шапки.
  const resourceValues = new WeakMap();
  function syncResourceValues() {
    document.querySelectorAll(".res b").forEach((value) => {
      const current = value.textContent.trim();
      const previous = resourceValues.get(value);
      resourceValues.set(value, current);
      if (previous === undefined || previous === current) return;
      const resource = value.closest(".res");
      if (!resource) return;
      resource.classList.remove("resource-changed");
      void resource.offsetWidth;
      resource.classList.add("resource-changed");
    });
  }

  let previousFilter = null;
  new MutationObserver(() => {
    syncResourceValues();
    const filter = document.getElementById("boardFilter");
    if (filter !== previousFilter) {
      previousFilter = filter;
      applyBoardFilter();
    }
    // Кнопки безопасны и после полного морфа topbar через SSE.
    syncMotion();
  }).observe(document.body, { childList: true, subtree: true });

  syncResourceValues();
})();
