/* БУНКЕР·9 — client */
(() => {
  'use strict';

  const socket = io();
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const AVATARS = ['🦉', '🐺', '🦊', '🐻', '🦌', '🐍', '🐙', '🦅', '🐀', '🐇', '🦂', '🕷️', '🦇', '🐸', '🐢', '🦎'];
  const ROLE_META = {
    human: { name: 'ЖИВОЙ', sigil: 'Ч', color: 'human', objective: 'Найдите заражённых и изгоните их, пока бункер не опустел.' },
    doctor: { name: 'ВРАЧ', sigil: 'В', color: 'doctor', objective: 'Спасайте выживших ночью. Каждая попытка стоит 1 медикамент.' },
    infected: { name: 'ЗАРАЖЁННЫЙ', sigil: 'З', color: 'infected', objective: 'Устраняйте живых и не дайте себя вычислить. Победа, когда вас станет не меньше, чем их.' },
  };

  const PACE_MS = {
    normal: { intro: 20000, reveal: 40000, discussion: 120000, vote: 35000, night: 40000 },
    fast: { intro: 12000, reveal: 25000, discussion: 60000, vote: 20000, night: 25000 },
  };

  const state = {
    snapshot: null,
    session: loadJson('bunker9.session', null),
    name: loadJson('bunker9.name', '') || '',
    avatar: Number(loadJson('bunker9.avatar', randomInt(AVATARS.length))),
    sound: Boolean(loadJson('bunker9.sound', false)),
    activeTab: 'day',
    offset: 0,
    prevPhase: null,
    prevGameId: null,
    roleSeenGame: null,
    roleAutoOpenedGame: null,
    pendingReveal: null,
    endDismissed: false,
    endOpen: false,
    modalOpen: false,
    joining: false,
    connectAttempts: 0,
    lastMessageKey: '',
    unread: { mafia: 0, dead: 0 },
    lastMessageId: 0,
    activeModalType: null,
    activeModalData: null,
    audioCtx: null,
    lastTone: null,
    lanUrl: null,
  };

  let countdownTimer = null;
  let reconnectWanted = false;
  let landingErrorTimer = null;

  const el = {
    landing: $('#landing'),
    lobby: $('#lobby'),
    game: $('#game'),
    name: $('#nameInput'),
    code: $('#codeInput'),
    avatarPicker: $('#avatarPicker'),
    landingError: $('#landingError'),
    returnSession: $('#returnSession'),
    returnSessionText: $('#returnSessionText'),
    createBtn: $('#createBtn'),
    joinForm: $('#joinForm'),
    connection: $('#connectionBanner'),
    connectionText: $('#connectionText'),
    modalRoot: $('#modalRoot'),
    endRoot: $('#endRoot'),
    toastRoot: $('#toastRoot'),
    lobbyCode: $('#lobbyCode'),
    lobbyCodeBig: $('#lobbyCodeBig'),
    inviteLink: $('#inviteLink'),
    inviteQr: $('#inviteQr'),
    inviteQrImg: $('#inviteQrImg'),
    lobbyOnline: $('#lobbyOnline'),
    lobbyTotal: $('#lobbyTotal'),
    lobbySeatCount: $('#lobbySeatCount'),
    lobbyPlayers: $('#lobbyPlayers'),
    paceSwitch: $('#paceSwitch'),
    paceDescription: $('#paceDescription'),
    rolePreview: $('#rolePreview'),
    startBtn: $('#startBtn'),
    startTitle: $('#startTitle'),
    startHint: $('#startHint'),
    hostHint: $('#hostHint'),
    lobbyChatFeed: $('#lobbyChatFeed'),
    lobbyChatForm: $('#lobbyChatForm'),
    lobbyChatInput: $('#lobbyChatInput'),
    topCode: $('#topCode'),
    topPhase: $('#topPhase'),
    resources: $('#resources'),
    topActions: $('#topActions'),
    phaseBarFill: $('#phaseBarFill'),
    playersList: $('#playersList'),
    gameAliveCount: $('#gameAliveCount'),
    scene: $('#scene'),
    chatTabs: $('#chatTabs'),
    gameChatFeed: $('#gameChatFeed'),
    gameChatForm: $('#gameChatForm'),
    gameChatInput: $('#gameChatInput'),
    chatHint: $('#chatHint'),
  };

  /* ---------- boot ---------- */

  init();

  function init() {
    if (!Number.isInteger(state.avatar) || state.avatar < 0 || state.avatar >= AVATARS.length) {
      state.avatar = randomInt(AVATARS.length);
    }
    if (el.name) el.name.value = state.name;
    renderAvatarPicker();
    bindLanding();
    bindApp();
    bindSocket();
    bindGlobalClicks();
    loadServerInfo();
    prefillFromHash();
    maybeOfferReturn();
    countdownTimer = setInterval(updateCountdown, 250);
    socket.on('connect', onConnected);
    updateSoundButton();
  }

  function loadServerInfo() {
    fetch('/api/info')
      .then((response) => (response.ok ? response.json() : null))
      .then((info) => {
        if (!info?.lanUrl) return;
        state.lanUrl = info.lanUrl;
        if (state.snapshot?.state === 'lobby' && el.inviteLink) {
          el.inviteLink.value = inviteLink(state.snapshot.code);
        }
      })
      .catch(() => {});
  }

  function bindLanding() {
    el.createBtn?.addEventListener('click', () => {
      if (state.joining) return;
      const name = readName();
      if (!name) return;
      clearLandingError();
      state.joining = true;
      emitAck('create', { name, avatar: AVATARS[state.avatar] }, (res) => {
        state.joining = false;
        if (!res?.ok) showLandingError(res?.error || 'Не удалось создать бункер.');
      });
    });

    el.joinForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = readName();
      if (!name) return;
      const code = normalizeCode(el.code.value);
      if (code.length !== 4) {
        showLandingError('Введите четырёхзначный код бункера.');
        el.code.focus();
        return;
      }
      clearLandingError();
      joinWithCode(code, name);
    });

    el.code?.addEventListener('input', () => {
      el.code.value = normalizeCode(el.code.value);
    });

    el.returnBtn?.addEventListener('click', () => {
      const session = state.session;
      if (!session?.code) return;
      joinWithCode(session.code, session.name || readName() || 'Выживший');
    });

    el.code?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        el.joinForm?.requestSubmit();
      }
    });
  }

  function bindApp() {
    el.lobbyChatForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      sendChatFromInput('day', el.lobbyChatInput);
    });
    el.gameChatForm?.addEventListener('submit', (event) => {
      event.preventDefault();
      const channel = chatChannelForTab();
      sendChatFromInput(channel, el.gameChatInput);
    });
  }

  function bindGlobalClicks() {
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-action]');
      if (!button) return;
      const action = button.dataset.action;
      if (action === 'rules') openRules();
      else if (action === 'copy-code') copyText(state.snapshot?.code || state.session?.code || '');
      else if (action === 'copy-link') copyInvite();
      else if (action === 'leave') leaveRoom();
      else if (action === 'pace') setPace(button.dataset.pace);
      else if (action === 'start') startGame();
      else if (action === 'kick') kickPlayer(button.dataset.player);
      else if (action === 'character') openCharacter();
      else if (action === 'reveal-role') revealRoleCard();
      else if (action === 'profile') openProfile(button.dataset.player);
      else if (action === 'trait-select') selectTrait(Number(button.dataset.index));
      else if (action === 'trait-cancel') {
        state.pendingReveal = null;
        renderScene(true);
      } else if (action === 'trait-confirm') confirmTrait();
      else if (action === 'vote') castVote(button.dataset.target);
      else if (action === 'night') nightAction(button.dataset.target);
      else if (action === 'doctor-skip') doctorSkip();
      else if (action === 'skip') askSkip();
      else if (action === 'confirm-skip') confirmSkip();
      else if (action === 'close-modal') closeModal();
      else if (action === 'onboard-next') {
        if ((state.onboardStep || 0) >= ONBOARD.length - 1) finishOnboarding();
        else {
          state.onboardStep = (state.onboardStep || 0) + 1;
          openModal(onboardHtml(), 'onboard', true);
        }
      }
      else if (action === 'onboard-skip') finishOnboarding();
      else if (action === 'chat-tab') switchTab(button.dataset.tab);
      else if (action === 'sound') toggleSound();
      else if (action === 'show-end') showEndOverlay(true);
      else if (action === 'close-end') closeEndOverlay();
      else if (action === 'rematch') rematch();
      else if (action === 'copy-result') copyResult();
      else if (action === 'focus-chat') {
        const input = state.snapshot?.state === 'lobby' ? el.lobbyChatInput : el.gameChatInput;
        input?.focus();
      }
    });

    el.modalRoot?.addEventListener('click', (event) => {
      if (event.target === el.modalRoot) closeModal();
    });
    el.endRoot?.addEventListener('click', (event) => {
      if (event.target === el.endRoot) closeEndOverlay();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!el.endRoot?.classList.contains('hidden')) closeEndOverlay();
      else if (!el.modalRoot?.classList.contains('hidden')) closeModal();
    });
  }

  /* ---------- socket ---------- */

  function bindSocket() {
    socket.on('state', (snapshot) => {
      if (!snapshot?.me) return;
      const previous = state.snapshot;
      state.snapshot = snapshot;
      state.joining = false;
      clearLandingError();
      state.offset = snapshot.now - Date.now();
      if (snapshot.gameId !== state.prevGameId) {
        state.prevGameId = snapshot.gameId;
        state.endDismissed = false;
        state.endOpen = false;
        state.roleSeenGame = null;
        state.roleAutoOpenedGame = null;
        state.pendingReveal = null;
        state.unread = { mafia: 0, dead: 0 };
        closeEndOverlay(true);
      }
      if (previous?.state === 'lobby' && snapshot.state !== 'lobby') closeModal();
      if (snapshot.state === 'lobby') {
        state.activeTab = 'day';
        state.activeModalType = null;
        if (previous && previous.state !== 'lobby') {
          closeModal();
          closeEndOverlay(true);
          state.endDismissed = false;
        }
      }
      if (snapshot.state === 'end') {
        state.activeTab = 'day';
        if (previous && previous.state !== 'end') closeModal();
      } else if (previous?.state === 'end' && snapshot.state !== 'end') {
        closeEndOverlay(true);
        state.endDismissed = false;
      }
      if (snapshot.me.alive === false && previous?.me?.alive !== false && (snapshot.state === 'night' || snapshot.state === 'vote')) {
        ensureTabAvailable();
      }
      handlePhaseSound(previous, snapshot);
      announcePhase(previous, snapshot);
      handleAutoTab(previous, snapshot);
      handleUnread(previous, snapshot);
      render(snapshot);
      scrollToSceneOnPhaseChange(previous, snapshot);
      if (
        snapshot.state === 'intro' &&
        state.roleAutoOpenedGame !== snapshot.gameId &&
        state.roleSeenGame !== snapshot.gameId &&
        !state.modalOpen
      ) {
        state.roleAutoOpenedGame = snapshot.gameId;
        setTimeout(() => {
          if (state.snapshot?.state === 'intro' && !state.modalOpen) {
            if (needsOnboarding()) startOnboarding();
            else openCharacter(true);
          }
        }, 650);
      }
      if (snapshot.state === 'end' && !state.endDismissed) {
        setTimeout(() => {
          if (state.snapshot?.state === 'end' && !state.endDismissed) showEndOverlay();
        }, 500);
      }
      updateConnectionUI(true);
    });

    socket.on('session', (session) => {
      if (!session?.token || !session?.code) return;
      state.session = {
        code: session.code,
        token: session.token,
        name: session.name || state.name,
      };
      saveJson('bunker9.session', state.session);
      if (session.name) {
        state.name = session.name;
        saveJson('bunker9.name', state.name);
        if (el.name) el.name.value = state.name;
      }
      if (session.avatar) {
        const index = AVATARS.indexOf(session.avatar);
        if (index >= 0) {
          state.avatar = index;
          saveJson('bunker9.avatar', index);
          renderAvatarPicker();
        }
      }
      setUrlCode(session.code);
      reconnectWanted = true;
    });

    socket.on('left', () => {
      state.session = null;
      state.snapshot = null;
      state.activeTab = 'day';
      state.pendingReveal = null;
      saveJson('bunker9.session', null);
      removeUrlCode();
      showScreen('landing');
      updateConnectionUI(true);
    });

    socket.on('kicked', () => {
      toast('Хост исключил вас из бункера.', 'error');
      clearSessionLocal();
    });

    socket.on('session-replaced', () => {
      toast('Сессия открыта в другом окне. Управление передано туда.', 'error', 4000);
      clearSessionLocal();
    });

    socket.on('disconnect', () => {
      updateConnectionUI(false);
    });

    socket.io.on('reconnect_attempt', () => {
      if (state.snapshot || state.session) updateConnectionUI(false);
    });
  }

  function scrollToSceneOnPhaseChange(previous, snapshot) {
    if (!previous || previous.state === snapshot.state) return;
    if (snapshot.state === 'lobby' || snapshot.state === 'end') return;
    if (!window.matchMedia('(max-width: 860px)').matches) return;
    const active = document.activeElement;
    if (active && ['INPUT', 'TEXTAREA'].includes(active.tagName)) return;
    requestAnimationFrame(() => {
      if (!el.scene) return;
      const topbar = $('.topbar');
      const offset = (topbar?.getBoundingClientRect().height || 0) + 8;
      const rect = el.scene.getBoundingClientRect();
      if (rect.top >= offset && rect.top <= window.innerHeight * 0.55) return;
      window.scrollTo({
        top: Math.max(0, window.scrollY + rect.top - offset),
        behavior: 'smooth',
      });
    });
  }

  function onConnected() {
    updateConnectionUI(true);
    if (reconnectWanted && state.session?.code && state.session?.token && state.snapshot) {
      socket.emit('join', {
        code: state.session.code,
        token: state.session.token,
        name: state.name,
        avatar: AVATARS[state.avatar],
      }, (res) => {
        if (!res?.ok) {
          toast(res?.error || 'Не удалось восстановить сессию.', 'error');
          clearSessionLocal();
          showLandingError('Сессия больше не действует. Создайте новый бункер или войдите по коду.');
        }
      });
    }
  }

  function emitAck(event, payload, callback, timeout = 7000) {
    socket.timeout(timeout).emit(event, payload, (error, response) => {
      if (error) {
        callback({ ok: false, error: 'Сервер не отвечает. Проверьте соединение и попробуйте ещё раз.' });
        return;
      }
      callback(response);
    });
  }

  function joinWithCode(code, name) {
    if (state.joining) return;
    state.joining = true;
    const session = state.session;
    const token = session?.code === code ? session.token : undefined;
    emitAck('join', { code, name, avatar: AVATARS[state.avatar], token }, (res) => {
      state.joining = false;
      if (res?.ok) return;
      if (token && /сесси|восстанов|начал/i.test(res?.error || '')) {
        state.session = null;
        saveJson('bunker9.session', null);
        emitAck('join', { code, name, avatar: AVATARS[state.avatar] }, (second) => {
          if (!second?.ok) showLandingError(second?.error || 'Не удалось войти в бункер.');
        });
        return;
      }
      showLandingError(res?.error || 'Не удалось войти в бункер.');
    });
  }

  /* ---------- rendering ---------- */

  function render(snapshot) {
    if (snapshot.state === 'lobby') {
      renderLobby(snapshot);
      showScreen('lobby');
    } else {
      renderGame(snapshot);
      showScreen('game');
    }
  }

  function showScreen(name) {
    el.landing?.classList.toggle('hidden', name !== 'landing');
    el.lobby?.classList.toggle('hidden', name !== 'lobby');
    el.game?.classList.toggle('hidden', name !== 'game');
    document.body.dataset.screen = name;
  }

  function renderLobby(snapshot) {
    const me = snapshot.me;
    const players = snapshot.players;
    const connected = players.filter((player) => player.connected).length;
    el.lobbyCode.textContent = snapshot.code;
    el.lobbyCodeBig.textContent = snapshot.code;
    el.topCode.textContent = snapshot.code;
    el.lobbyOnline.textContent = String(connected);
    el.lobbyTotal.textContent = String(players.length);
    el.lobbySeatCount.textContent = `${players.length} / ${snapshot.maxPlayers}`;
    const link = inviteLink(snapshot.code);
    if (el.inviteLink && el.inviteLink.value !== link) el.inviteLink.value = link;
    // QR перерисовываем только при смене комнаты, а не на каждый state
    if (el.inviteQrImg && el.inviteQrImg.dataset.for !== link) {
      el.inviteQrImg.dataset.for = link;
      el.inviteQrImg.src = `/qr.svg?text=${encodeURIComponent(link)}`;
      if (el.inviteQr) el.inviteQr.hidden = false;
    }

    el.lobbyPlayers.innerHTML = players
      .map((player) => {
        const badges = [
          player.isHost ? '<span class="mini-badge host">хост</span>' : '',
          player.id === me.id ? '<span class="mini-badge me">вы</span>' : '',
        ].filter(Boolean).join('');
        const kick = me.isHost && player.id !== me.id
          ? `<button class="kick-btn" data-action="kick" data-player="${escAttr(player.id)}" title="Исключить" aria-label="Исключить">×</button>`
          : '';
        return `
          <div class="lobby-player ${player.id === me.id ? 'is-me' : ''} ${player.connected ? '' : 'offline'}">
            ${avatarHtml(player, 'sm')}
            <div class="lobby-player-info">
              <div class="lobby-player-name">${esc(player.name)}${badges}</div>
              <div class="lobby-player-meta">${player.connected ? 'на связи' : 'нет связи'}</div>
            </div>
            ${kick}
          </div>`;
      })
      .join('');

    $$('.pace-btn', el.paceSwitch).forEach((button) => {
      button.classList.toggle('active', button.dataset.pace === snapshot.settings.pace);
      button.disabled = !me.isHost;
    });
    el.paceDescription.textContent = snapshot.settings.pace === 'fast'
      ? 'Быстрые раунды: меньше времени на споры, больше темпа.'
      : 'Спокойные раунды: время договорить, переспросить и передумать.';

    const preview = snapshot.preview || { infected: 1, doctor: 1, humans: Math.max(0, players.length - 2) };
    el.rolePreview.innerHTML = [
      `<span class="role-chip infected">Заражённых: ${preview.infected}</span>`,
      `<span class="role-chip doctor">Врач: ${preview.doctor}</span>`,
      `<span class="role-chip human">Обычных: ${preview.humans}</span>`,
    ].join('');

    const canStart = me.isHost && players.length >= snapshot.minPlayers && !state.joining;
    el.startBtn.disabled = !canStart;
    if (me.isHost) {
      if (players.length < snapshot.minPlayers) {
        el.startTitle.textContent = 'Ждём выживших';
        el.startHint.textContent = `Нужно ещё ${snapshot.minPlayers - players.length} — минимум ${snapshot.minPlayers} человек.`;
        el.startBtn.textContent = 'Открыть бункер';
      } else {
        el.startTitle.textContent = players.length >= snapshot.maxPlayers ? 'Бункер заполнен' : 'Всё готово';
        el.startHint.textContent = 'Роли и карты раздадутся автоматически.';
        el.startBtn.textContent = 'Открыть бункер';
      }
      el.hostHint.textContent = 'Вы хост: можете менять темп и запустить игру, когда все соберутся.';
    } else {
      el.startTitle.textContent = 'Ждём хоста';
      el.startHint.textContent = players.length < snapshot.minPlayers
        ? `Нужно ещё ${snapshot.minPlayers - players.length} человек.`
        : 'Все на месте. Хост вот-вот откроет бункер.';
      el.startBtn.textContent = 'Хост запустит игру';
      el.hostHint.textContent = 'Пока можно познакомиться в чате лобби.';
    }

    renderChatFeed(el.lobbyChatFeed, lobbyMessages(snapshot), { lobby: true });
    updateLobbyChatForm(snapshot);
  }

  // ---------- лента фазы и потери ----------

  function phaseBannerText(snapshot) {
    const day = snapshot.day;
    if (snapshot.state === 'intro') return 'РОЛИ РОЗДАНЫ';
    if (snapshot.state === 'reveal') return `ДЕНЬ ${day} · РАСКРЫТИЕ КАРТ`;
    if (snapshot.state === 'discussion') return `ДЕНЬ ${day} · ОБСУЖДЕНИЕ`;
    if (snapshot.state === 'vote') return `ДЕНЬ ${day} · ГОЛОСОВАНИЕ`;
    if (snapshot.state === 'night') return `НОЧЬ ${day} · СВЕТ ГАСНЕТ`;
    if (snapshot.state === 'end') return 'ПРОТОКОЛ ЗАВЕРШЁН';
    return '';
  }

  let bannerTimer = null;

  function showBanner(text, tone = 'day', ms = 2800) {
    const node = document.getElementById('phaseBanner');
    if (!node || !text) return;
    node.textContent = text;
    node.dataset.tone = tone;
    node.classList.add('show');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => node.classList.remove('show'), ms);
  }

  // Сравниваем с предыдущим снапшотом: так не нужны свои счётчики,
  // а потери ловятся и при возврате из фона.
  function announcePhase(previous, snapshot) {
    if (!snapshot || snapshot.state === 'lobby' || !previous) return;
    const sameRoom = previous.gameId === snapshot.gameId;
    if (sameRoom) {
      const known = new Set((previous.players || []).filter((p) => !p.alive).map((p) => p.id));
      const fresh = snapshot.players.filter((p) => !p.alive && !p.left && p.death && !known.has(p.id));
      if (fresh.length) {
        const p = fresh[0];
        const cause = p.death.cause === 'exile' ? 'ИЗГНАН' : 'ПОГИБ';
        const role = p.role ? ` · ${(ROLE_META[p.role] || {}).name || p.role}` : '';
        showBanner(`${cause} · ${p.name}${role}`, 'bad', 4500);
        return;
      }
    }
    const changed = previous.state !== snapshot.state || previous.day !== snapshot.day;
    if (changed) {
      showBanner(phaseBannerText(snapshot), snapshot.state === 'night' ? 'night' : 'day');
    }
  }

  // ---------- онбординг ----------

  const ONBOARD = [
    {
      kicker: '01 · ДОСЬЕ',
      title: 'Ваша роль — только для вас',
      body: 'Кнопка «Досье» в верхней панели: там роль, пять личных карт и подсказки. Каждый день вы раскрываете одну карту — её увидят все остальные. Скрытые карты не показывает никто.',
    },
    {
      kicker: '02 · СВЯЗЬ',
      title: 'Чат решает исход',
      body: 'Днём говорит зал. Ночью заражённые шепчутся в своём канале, а погибшие — в канале мёртвых. Пишите коротко: у обсуждения таймер, и по нему видно, что осталось.',
    },
    {
      kicker: '03 · РЕСУРСЫ',
      title: 'Бункер считает всё',
      body: 'Еда уходит на каждого живого, энергия тает, медикаменты тратит врач. Если еда или энергия дойдут до нуля, на рассвете погибнет случайный выживший.',
    },
  ];

  function needsOnboarding() {
    try {
      return !localStorage.getItem('bunker9-onboarded');
    } catch {
      return false;
    }
  }

  function onboardHtml() {
    const step = Math.min(Math.max(state.onboardStep || 0, 0), ONBOARD.length - 1);
    const page = ONBOARD[step];
    const last = step === ONBOARD.length - 1;
    const dots = ONBOARD.map((_, i) => `<i class="${i === step ? 'on' : ''}"></i>`).join('');
    return `
      <div class="modal modal-onboard" role="document">
        <div class="modal-head">
          <span class="eyebrow">ПЕРВЫЙ РАЗ В БУНКЕРЕ</span>
          <h2>${esc(page.kicker)}</h2>
          <p>${esc(page.title)}</p>
        </div>
        <div class="modal-section"><p>${esc(page.body)}</p></div>
        <div class="onboard-foot">
          <span class="onboard-dots">${dots}</span>
          <button class="btn btn-ghost btn-small" data-action="onboard-skip">Пропустить</button>
          <button class="btn btn-primary" data-action="onboard-next">${last ? 'Понятно' : 'Дальше →'}</button>
        </div>
      </div>`;
  }

  function startOnboarding() {
    state.onboardStep = 0;
    openModal(onboardHtml(), 'onboard', true);
  }

  function finishOnboarding() {
    try {
      localStorage.setItem('bunker9-onboarded', '1');
    } catch {
      /* приватный режим — не страшно, покажем в следующий раз */
    }
    closeModal();
    // сразу после знакомства — досье с ролью, раз уж человек не видел её
    const snapshot = state.snapshot;
    if (snapshot && snapshot.state === 'intro' && state.roleSeenGame !== snapshot.gameId) {
      setTimeout(() => {
        if (state.snapshot?.state === 'intro' && !state.modalOpen) openCharacter(true);
      }, 260);
    }
  }

  function renderGame(snapshot) {
    const me = snapshot.me;
    const phase = phaseInfo(snapshot);
    const mode = me.alive ? (me.role || 'human') : 'dead';

    if (el.topCode) el.topCode.textContent = snapshot.code;
    el.phaseBarFill.classList.toggle('urgent', phase.tone === 'vote' || phase.tone === 'night');
    renderTopPhase(snapshot, phase);
    renderResources(snapshot);
    renderTopActions(snapshot);
    renderPlayers(snapshot);
    renderScene();
    renderChatTabs(snapshot);
    renderChatFeed(el.gameChatFeed, visibleMessages(snapshot), { tabs: true });
    updateGameChatForm(snapshot);
    document.body.dataset.role = me.role || 'none';
    document.body.dataset.phase = snapshot.state;
    if (!me.alive) document.body.dataset.dead = 'yes';
    else delete document.body.dataset.dead;
    if (mode === 'dead') state.roleSeenGame = state.roleSeenGame || snapshot.gameId;
  }

  function renderTopPhase(snapshot, phase) {
    const timer = snapshot.phaseEndsAt ? '<span id="phaseTimer" class="phase-timer">—:—</span>' : '';
    el.topPhase.innerHTML = `
      <span class="phase-chip tone-${phase.tone}">${esc(phase.chip)}</span>
      <span class="phase-name">${esc(phase.name)}</span>
      <span class="phase-day">${esc(phase.dayText)}</span>
      ${timer}
    `;
    updateCountdown();
  }

  function renderResources(snapshot) {
    const alive = Math.max(1, snapshot.aliveCount || 1);
    const items = [
      { key: 'food', label: 'ЕДА', value: snapshot.resources.food, icon: iconFood(), critical: snapshot.resources.food === 0, low: snapshot.resources.food <= alive },
      { key: 'energy', label: 'ЭНЕРГИЯ', value: snapshot.resources.energy, icon: iconBolt(), critical: snapshot.resources.energy === 0, low: snapshot.resources.energy <= 2 },
      { key: 'meds', label: 'МЕДЫ', value: snapshot.resources.meds, icon: iconCross(), critical: false, low: snapshot.resources.meds === 0 },
    ];
    el.resources.innerHTML = items.map((item) => `
      <div class="resource ${item.low ? 'low' : ''} ${item.critical ? 'critical' : ''}" title="${item.label}">
        ${item.icon}
        <span class="res-label">${item.label}</span>
        <b>${item.value}</b>
      </div>
    `).join('');
  }

  function renderTopActions(snapshot) {
    const me = snapshot.me;
    const canSound = state.sound;
    const needsLook = snapshot.state !== 'end' && state.roleSeenGame !== snapshot.gameId;
    el.topActions.innerHTML = `
      <button class="icon-btn ${canSound ? 'sound-on' : ''}" data-action="sound" title="${canSound ? 'Выключить звук' : 'Включить звук'}" aria-label="Звук">
        ${canSound ? iconSoundOn() : iconSoundOff()}
      </button>
      <button class="btn btn-secondary btn-small dossier-btn ${needsLook ? 'needs-look' : ''}" data-action="character">
        ${iconDossier()}<span>Досье</span>
      </button>
      <button class="btn btn-ghost btn-small" data-action="rules">${iconBook()}<span>Правила</span></button>
      <button class="icon-btn" data-action="leave" title="Покинуть бункер" aria-label="Покинуть бункер">${iconExit()}</button>
    `;
  }

  function renderPlayers(snapshot) {
    const me = snapshot.me;
    const alive = snapshot.players.filter((player) => player.alive);
    el.gameAliveCount.textContent = `${alive.length} / ${snapshot.players.length}`;
    const votersByTarget = {};
    if (snapshot.state === 'vote') {
      for (const player of snapshot.players) {
        if (player.votedFor && player.votedFor !== 'skip') {
          (votersByTarget[player.votedFor] ||= []).push(player.name);
        }
      }
    }
    el.playersList.innerHTML = snapshot.players.map((player) => {
      const role = player.role ? ROLE_META[player.role] : null;
      const death = player.death;
      const deadLabel = player.left
        ? 'покинул'
        : death?.cause === 'exile'
          ? `изгнан · д${death.day || 0}`
          : death?.cause === 'night'
            ? `погиб · н${death.day || 0}`
            : death?.cause === 'crisis'
              ? `кризис · д${death.day || 0}`
              : 'вне игры';
      const dots = [0, 1, 2, 3, 4].map((index) => `<i class="${index < player.traitsRevealed ? 'on' : ''}"></i>`).join('');
      const voters = votersByTarget[player.id];
      return `
        <button class="player-row ${player.id === me.id ? 'is-me' : ''} ${player.teammate ? 'is-teammate' : ''} ${player.alive ? '' : 'is-dead'} ${player.left ? 'is-left' : ''}"
          data-action="profile" data-player="${escAttr(player.id)}" title="Открыть досье ${escAttr(player.name)}">
          ${avatarHtml(player, '', !player.connected)}
          <div class="player-main">
            <div class="player-top">
              <span class="player-name">${esc(player.name)}</span>
              ${player.isHost ? '<span class="mini-badge host">хост</span>' : ''}
              ${player.id === me.id ? '<span class="mini-badge me">вы</span>' : ''}
            </div>
            <div class="player-meta">
              ${player.alive
                ? `<span class="trait-dots">${dots}</span><span>${player.traitsRevealed}/5</span>`
                : `<span>${esc(deadLabel)}</span>`}
              ${role ? `<span class="role-reveal ${role.color}">${role.name}</span>` : ''}
              ${player.teammate ? '<span class="role-reveal infected">СВОЙ</span>' : ''}
              ${player.connected ? '' : '<span>offline</span>'}
            </div>
          </div>
          ${snapshot.state === 'vote' && player.votesAgainst > 0 ? `<span class="vote-pin">${player.votesAgainst}</span>` : ''}
          ${snapshot.state === 'vote' && voters?.length ? `<span class="vote-arrow" title="${escAttr(voters.join(', '))}">← ${esc(voters[0])}${voters.length > 1 ? ` +${voters.length - 1}` : ''}</span>` : ''}
        </button>`;
    }).join('');
  }

  function renderScene(force = false) {
    const snapshot = state.snapshot;
    if (!snapshot) return;
    const scrollTop = el.scene.scrollTop;
    const html = sceneHtml(snapshot);
    if (el.scene.dataset.sig !== html || force) {
      el.scene.innerHTML = html;
      el.scene.dataset.sig = html;
      if (!force) el.scene.scrollTop = scrollTop;
    }
    syncTimerNodes();
  }

  function sceneHtml(snapshot) {
    if (snapshot.state === 'end') {
      return endSceneHtml(snapshot);
    }
    const phase = phaseInfo(snapshot);
    const head = `
      <div class="scene-head">
        <div class="scene-head-row">
          <div>
            <div class="kicker">${esc(phase.kicker)}</div>
            <h2>${esc(phase.title)}</h2>
            <p class="scene-lede">${phase.lede}</p>
          </div>
          <span class="scene-daymark">${esc(phase.dayText)}</span>
        </div>
      </div>
    `;
    const event = snapshot.event ? eventCardHtml(snapshot) : '';
    let body = '';
    if (snapshot.state === 'intro') body = introHtml(snapshot);
    else if (snapshot.state === 'reveal') body = revealHtml(snapshot);
    else if (snapshot.state === 'discussion') body = discussionHtml(snapshot);
    else if (snapshot.state === 'vote') body = voteHtml(snapshot);
    else if (snapshot.state === 'night') body = nightHtml(snapshot);
    const host = hostBarHtml(snapshot, phase);
    return `${head}${event}${body}${host}`;
  }

  function introHtml(snapshot) {
    const me = snapshot.me;
    const seen = state.roleSeenGame === snapshot.gameId;
    return `
      <div class="intro-grid">
        <div class="lore-card">
          <span class="eyebrow">ПРОТОКОЛ «КОЛЬЦО-9»</span>
          <h3>Снаружи нет ничего, кроме тишины</h3>
          <p>Семнадцать дней назад город замолчал. Сначала исчезли птицы. Потом — связь. Потом люди. Те, кто успел, спустились в старый военный бункер под названием «Кольцо-9».</p>
          <p>Здесь есть воздух, вода и запас еды. Здесь есть вы. И есть те, кто вошёл вместе с вами, но человеком уже не был. Днём они говорят вашими голосами. Ночью — приходят.</p>
          <div class="lore-signature">канал связи закрыт · гермодверь заперта · рассвет неизвестен</div>
        </div>
        <div class="intro-side">
          <div class="intro-card">
            <span class="eyebrow">ВАША РОЛЬ</span>
            <div class="intro-role-mini">
              <span class="role-sigil neutral">?</span>
              <div>
                <h4>${seen ? 'РОЛЬ ПРОСМОТРЕНА' : 'РОЛЬ СКРЫТА'}</h4>
                <p>${seen ? 'Откройте досье, чтобы освежить детали и увидеть свои карты.' : 'Откройте личное дело, когда рядом никого не будет.'}</p>
              </div>
            </div>
            <button class="btn btn-secondary btn-small" data-action="character" style="margin-top:12px;width:100%">${seen ? 'Открыть досье' : 'Показать мою роль'}</button>
          </div>
          <div class="intro-card">
            <span class="eyebrow">СОСТАВ БУНКЕРА</span>
            <div class="discussion-stats">
              <div class="stat-card"><span>заражённых</span><b>${snapshot.setup?.infected ?? '?'}</b></div>
              <div class="stat-card"><span>врач</span><b>${snapshot.setup?.doctor ?? '?'}</b></div>
              <div class="stat-card"><span>обычных</span><b>${snapshot.setup?.humans ?? '?'}</b></div>
              <div class="stat-card"><span>карт у вас</span><b>5</b></div>
            </div>
          </div>
        </div>
      </div>
      <div class="warning-line"><span>◈</span><div>Не показывайте экран соседям. Первое раскрытие карты — сразу после <b>пролога</b>. Заражённые видят друг друга.</div></div>
      ${introWaitHtml(snapshot)}
    `;
  }

  function introWaitHtml(snapshot) {
    const alive = snapshot.players.filter((player) => player.alive);
    const me = snapshot.me;
    return `
      <div class="intro-wait">
        <div class="wait-copy"><b>${alive.length}</b> выживших заперты внутри. ${me.role === 'infected' ? 'Ваши союзники отмечены красным.' : 'Слушайте. Запоминайте. Не верьте первому впечатлению.'}</div>
        <div class="mini-progress-row">
          ${alive.slice(0, 15).map((player) => avatarHtml(player, 'sm', !player.connected)).join('')}
        </div>
      </div>
    `;
  }

  function eventCardHtml(snapshot) {
    const event = snapshot.event;
    const tone = eventTone(event.effects);
    const effects = effectChips(event.effects);
    return `
      <div class="event-card tone-${tone}">
        <div class="event-top">
          <span class="eyebrow">СОБЫТИЕ ДНЯ</span>
          <span class="eyebrow">ДЕНЬ ${snapshot.day}</span>
        </div>
        <h3>${esc(event.title)}</h3>
        <p>${esc(event.text)}</p>
        ${effects ? `<div class="effect-row">${effects}</div>` : ''}
      </div>
    `;
  }

  function revealHtml(snapshot) {
    const me = snapshot.me;
    const alive = snapshot.players.filter((player) => player.alive);
    const done = alive.filter((player) => player.revealedThisRound).length;
    const selected = state.pendingReveal;
    const trait = Number.isInteger(selected) ? me.traits[selected] : null;
    if (!me.alive) {
      return `
        <div class="action-block">
          ${deadNoticeHtml(snapshot)}
          <div class="mini-progress-row">${alive.map((player) => avatarHtml(player, 'sm', false, player.revealedThisRound)).join('')}</div>
        </div>`;
    }
    if (me.revealedThisRound) {
      const revealed = me.traits.filter((item) => item.revealed).slice(-1)[0];
      return `
        <div class="action-block">
          <div class="action-head">
            <div>
              <span class="eyebrow">РАСКРЫТИЕ КАРТ</span>
              <h3>Ваша карта на столе</h3>
              <p>Теперь этот факт о вас знают все. Выберите, что скажете дальше — уже словами.</p>
            </div>
            <span class="action-progress"><b>${done}</b> / ${alive.length}</span>
          </div>
          <div class="revealed-note"><span class="check">✓</span>${revealed ? `${esc(revealed.label)}: <b>${esc(revealed.value)}</b>` : 'У вас не осталось скрытых карт.'}</div>
          <div class="mini-progress-row">${alive.map((player) => avatarHtml(player, 'sm', false, player.revealedThisRound)).join('')}</div>
          <div class="waiting-note" style="margin-top:14px">Ждём остальных. После раскрытия начнётся обсуждение.</div>
        </div>`;
    }
    const hidden = me.traits.filter((item) => !item.revealed);
    if (!hidden.length) {
      return `<div class="action-block">${deadNoticeHtml(snapshot)}</div>`;
    }
    const cards = me.traits.map((item, index) => {
      if (item.revealed) return '';
      return `
        <button class="trait-choice ${selected === index ? 'selected' : ''}" data-action="trait-select" data-index="${index}">
          <span class="trait-cat">${esc(item.label)}</span>
          <b>${esc(item.value)}</b>
          <span class="trait-role-note">${item.cat === 'profession' ? 'что вы умеете' : item.cat === 'health' ? 'что вы выдержите' : item.cat === 'baggage' ? 'что у вас есть' : item.cat === 'fact' ? 'что вы видели' : 'что вас выдаёт'}</span>
        </button>`;
    }).join('');
    return `
      <div class="action-block">
        <div class="action-head">
          <div>
            <span class="eyebrow">РАСКРЫТИЕ КАРТ</span>
            <h3>Выложите одну карту</h3>
            <p>Один факт станет публичным. Навсегда. Выбирайте тот, который поможет вам выжить. Если не выбрать — карта раскроется случайно.</p>
          </div>
          <span class="action-progress"><b>${done}</b> / ${alive.length}</span>
        </div>
        <div class="trait-choose-grid">${cards}</div>
        ${trait ? `
          <div class="confirm-strip">
            <p>Раскрыть <b>${esc(trait.label)}: ${esc(trait.value)}</b>? Это увидят все и это нельзя отменить.</p>
            <div class="confirm-actions">
              <button class="btn btn-ghost btn-small" data-action="trait-cancel">Передумать</button>
              <button class="btn btn-primary btn-small" data-action="trait-confirm">Раскрыть</button>
            </div>
          </div>` : ''}
        <div class="mini-progress-row">${alive.map((player) => avatarHtml(player, 'sm', false, player.revealedThisRound)).join('')}</div>
      </div>
    `;
  }

  function discussionHtml(snapshot) {
    const alive = snapshot.players.filter((player) => player.alive);
    const me = snapshot.me;
    const known = alive.filter((player) => player.role);
    const latest = [...snapshot.messages].reverse().find((message) => message.tone === 'reveal');
    return `
      <div class="action-block">
        <div class="action-head">
          <div>
            <span class="eyebrow">ОТКРЫТЫЙ РАУНД</span>
            <h3>Стол обсуждения</h3>
            <p>Обсуждайте раскрытые карты, поведение и ночные потери. Голосование начнётся автоматически.</p>
          </div>
          <button class="btn btn-secondary btn-small" data-action="focus-chat">Открыть чат</button>
        </div>
        <div class="discussion-grid">
          <div class="discussion-card">
            <h4>На столе</h4>
            <p>${latest ? esc(latest.text) : 'Пока никто не раскрыл новую карту. Начните разговор первым.'}</p>
            <div class="suspect-chips">
              ${alive.slice(0, 12).map((player) => `
                <button class="suspect-chip" data-action="profile" data-player="${escAttr(player.id)}">
                  ${avatarHtml(player, 'sm')}<span>${esc(player.name)}</span>
                </button>`).join('')}
            </div>
            <div class="quote-line">Доверие — это ресурс. Здесь его расходуют быстрее еды.</div>
          </div>
          <div class="discussion-card">
            <h4>Сводка</h4>
            <div class="discussion-stats">
              <div class="stat-card"><span>живых</span><b>${alive.length}</b></div>
              <div class="stat-card"><span>заражённых</span><b>${snapshot.setup?.infected ?? '?'}</b></div>
              <div class="stat-card"><span>день</span><b>${snapshot.day}</b></div>
              <div class="stat-card"><span>раскрыто ролей</span><b>${known.length}</b></div>
            </div>
            <p style="margin-top:12px">${me.alive ? 'Ваш голос решит, кто покинет бункер. Помните: ошибка стоит ещё одной ночи.' : 'Вы наблюдаете. Мёртвые не голосуют.'}</p>
          </div>
        </div>
        ${!me.alive ? deadNoticeHtml(snapshot) : ''}
        <div class="waiting-note" style="margin-top:16px"><span class="waiting-dots"><i></i><i></i><i></i></span> Голосование начнётся через несколько минут.</div>
      </div>
    `;
  }

  function waitingText(alive) {
    const waiters = alive.filter((player) => !player.votedFor);
    if (!waiters.length) return 'Все голоса собраны · хост может закрыть голосование';
    const names = waiters.map((player) => player.name);
    const short = names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')} и ещё ${names.length - 3}`;
    return `Ждут голоса: ${esc(short)} · не успевшие воздержатся`;
  }

  function voteHtml(snapshot) {
    const me = snapshot.me;
    const alive = snapshot.players.filter((player) => player.alive);
    if (!me.alive) {
      return `<div class="action-block">${deadNoticeHtml(snapshot)}${voteTallyHtml(snapshot)}</div>`;
    }
    const voted = alive.filter((player) => player.votedFor).length;
    const cards = alive.map((player) => {
      const role = player.role ? ROLE_META[player.role] : null;
      const selected = me.votedFor === player.id;
      return `
        <button class="target-card ${selected ? 'selected' : ''}" data-action="vote" data-target="${escAttr(player.id)}">
          ${avatarHtml(player, 'sm')}
          <span class="target-info">
            <span class="target-name">${esc(player.name)}${player.id === me.id ? ' · вы' : ''}</span>
            <span class="target-meta">${role ? role.name : `${player.traitsRevealed}/5 карт раскрыто`}</span>
          </span>
          <span class="target-votes ${player.votesAgainst ? '' : 'zero'}">${player.votesAgainst}</span>
        </button>`;
    }).join('');
    return `
      <div class="action-block">
        <div class="action-head">
          <div>
            <span class="eyebrow">ДНЕВНОЕ ГОЛОСОВАНИЕ</span>
            <h3>Кого изгнать?</h3>
            <p>Изгнанный покидает бункер навсегда, и его роль становится известна. При равенстве голосов не уходит никто.</p>
          </div>
          <span class="action-progress"><b>${voted}</b> / ${alive.length}</span>
        </div>
        <div class="target-grid">${cards}</div>
        <div class="vote-tools">
          <button class="skip-vote ${me.votedFor === 'skip' ? 'selected' : ''}" data-action="vote" data-target="skip">Воздержаться</button>
          <span class="note">${me.votedFor ? 'Голос учтён. Можно передумать до конца фазы.' : 'Нажмите на выжившего, чтобы отдать голос.'}</span>
        </div>
        <div class="vote-waiting">
          <span class="waiting-dots"><i></i><i></i><i></i></span>
          ${waitingText(alive)}
        </div>
        ${voteTallyHtml(snapshot)}
      </div>
    `;
  }

  function voteTallyHtml(snapshot) {
    const voters = snapshot.players.filter((player) => player.alive && player.votedFor);
    if (!voters.length) return '';
    return `
      <div class="mini-progress-row" style="margin-top:14px">
        ${voters.map((voter) => {
          const target = voter.votedFor === 'skip' ? null : snapshot.players.find((player) => player.id === voter.votedFor);
          return `<span class="target-meta" style="display:inline-flex;align-items:center;gap:5px">${avatarHtml(voter, 'sm')}${esc(voter.name)} → ${target ? esc(target.name) : 'воздержался'}</span>`;
        }).join('')}
      </div>
    `;
  }

  function nightHtml(snapshot) {
    const me = snapshot.me;
    const alive = snapshot.players.filter((player) => player.alive);
    if (!me.alive) {
      return `
        <div class="action-block">
          <div class="night-panel">
            <div class="night-eye">◉</div>
            <h3>Вы наблюдаете</h3>
            <p>Мёртвые не выбирают и не спасают. Но вы можете видеть, как бункер встречает ещё один рассвет.</p>
            <div class="quote-line">Тишина не отвечает на вопросы.</div>
          </div>
        </div>`;
    }
    if (me.role === 'infected') return mafiaNightHtml(snapshot, alive);
    if (me.role === 'doctor') return doctorNightHtml(snapshot, alive);
    return `
      <div class="action-block">
        <div class="night-panel">
          <div class="night-eye">☾</div>
          <h3>Свет гаснет</h3>
          <p>Вы заперты в отсеке. За стеной — шаги, которые не совпадают с ритмом ни одного из выживших. Остаётся только ждать рассвета.</p>
          <div class="quote-line">Если этой ночью кто-то не проснётся — утром будет на один голос меньше.</div>
        </div>
        <div class="role-action-note">
          <span>◈</span><div>У вас нет ночного действия. Смотрите в чат: возможно, кто-то уже проговорился. <b>Утро начнётся автоматически.</b></div>
        </div>
      </div>`;
  }

  function mafiaNightHtml(snapshot, alive) {
    const me = snapshot.me;
    const mates = snapshot.players.filter((player) => player.teammate);
    const mafiaAlive = snapshot.players.filter((player) => player.alive && (player.id === me.id || me.teammates?.includes(player.id)));
    const targets = alive.filter((player) => player.id !== me.id && !me.teammates?.includes(player.id));
    const votes = snapshot.night?.mafiaVotes || {};
    const counts = {};
    Object.values(votes).forEach((target) => {
      counts[target] = (counts[target] || 0) + 1;
    });
    const cards = targets.map((player) => {
      const selected = me.nightTarget === player.id;
      return `
        <button class="target-card ${selected ? 'selected is-night' : ''}" data-action="night" data-target="${escAttr(player.id)}">
          ${avatarHtml(player, 'sm')}
          <span class="target-info">
            <span class="target-name">${esc(player.name)}</span>
            <span class="target-meta">${player.traitsRevealed}/5 карт · ${player.alive ? 'жив' : 'мёртв'}</span>
          </span>
          ${counts[player.id] ? `<span class="target-votes">${counts[player.id]}</span>` : ''}
        </button>`;
    }).join('');
    return `
      <div class="action-block">
        <div class="action-head">
          <div>
            <span class="eyebrow">НОЧНОЙ ПРОТОКОЛ</span>
            <h3>Кого забрать?</h3>
            <p>Выберите жертву. Голоса заражённых суммируются; при равенстве всё решит случай.</p>
          </div>
          <span class="action-progress">${Object.keys(votes).length} / ${mafiaAlive.length}</span>
        </div>
        <div class="team-strip">
          <span class="eyebrow">ВАШИ:</span>
          ${mates.length ? mates.map((player) => `<span class="team-chip">${avatarHtml(player, 'sm')}${esc(player.name)}${player.alive ? '' : ' · мёртв'}</span>`).join('') : 'вы последний'}
          <span style="margin-left:auto;opacity:.65">шёпот доступен в чате</span>
        </div>
        <div class="target-grid">${cards}</div>
        <div class="vote-tools">
          <span class="note">Жертва не узнает вас. Но утром бункер узнает, что кто-то не проснулся.</span>
          <button class="skip-vote" data-action="chat-tab" data-tab="mafia">Открыть шёпот</button>
        </div>
        <div class="vote-waiting"><span class="waiting-dots"><i></i><i></i><i></i></span> Ночь закончится, когда все заражённые сделают выбор. Если время выйдет — жертву выберет случай.</div>
      </div>`;
  }

  function doctorNightHtml(snapshot, alive) {
    const me = snapshot.me;
    const canHeal = snapshot.resources.meds > 0;
    const last = me.lastHealTarget;
    const cards = alive.map((player) => {
      const disabled = player.id === last;
      const selected = me.nightTarget === player.id;
      return `
        <button class="target-card ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}" data-action="night" data-target="${escAttr(player.id)}" ${disabled ? 'disabled' : ''}>
          ${avatarHtml(player, 'sm')}
          <span class="target-info">
            <span class="target-name">${esc(player.name)}${player.id === me.id ? ' · вы' : ''}</span>
            <span class="target-meta">${disabled ? 'нельзя спасать 2 ночи подряд' : 'жив'}</span>
          </span>
        </button>`;
    }).join('');
    return `
      <div class="action-block">
        <div class="action-head">
          <div>
            <span class="eyebrow">НОЧНАЯ СМЕНА ВРАЧА</span>
            <h3>Кого спасти?</h3>
            <p>Выберите одного выжившего. Если заражённые придут именно за ним — он выживет. Каждая попытка стоит 1 медикамент.</p>
          </div>
          <span class="action-progress">${canHeal ? 'доступно' : 'аптечка пуста'}</span>
        </div>
        <div class="meds-line">${iconCross()} медикаментов: <b>${snapshot.resources.meds}</b> ${last ? `· прошлая ночь: ${esc(nameById(snapshot, last))}` : ''}</div>
        ${canHeal ? `<div class="target-grid">${cards}</div>` : `<div class="warning-line"><span>◈</span><div>Медикаментов не осталось. Вы не можете спасать этой ночью. Может быть, уже некому.</div></div>`}
        <div class="vote-tools">
          <button class="skip-vote ${me.doctorSkip ? 'selected' : ''}" data-action="doctor-skip">${canHeal ? 'Не тратить медикаменты' : 'Ждать рассвета'}</button>
          <span class="note">${canHeal ? 'Медикамент тратится, даже если заражённые пришли за другим. Если никого не выбрать — медикаменты сохранятся.' : 'Аптечка пуста.'}</span>
        </div>
        <div class="role-action-note"><span>◇</span><div>Ваша цель может быть и заражённым. Вы не узнаете, пока не станет слишком поздно.</div></div>
      </div>`;
  }

  function deadNoticeHtml(snapshot) {
    const me = snapshot.me;
    const cause = me.death?.cause;
    const label = cause === 'exile'
      ? 'Вас изгнали из бункера.'
      : cause === 'night'
        ? 'Вы не пережили эту ночь.'
        : cause === 'crisis'
          ? 'Бункер не пережил ещё один рассвет.'
          : cause === 'left'
            ? 'Вы покинули игру.'
            : 'Вы вне игры.';
    return `
      <div class="warning-line" style="border-color:rgba(224,108,93,.2);background:rgba(224,108,93,.06);color:#c79a93">
        <span>☠</span><div><b>${esc(label)}</b> Вы наблюдаете за бункером и можете писать в чат мёртвых. Роль: ${esc(ROLE_META[me.role]?.name || '—')}.</div>
      </div>`;
  }

  function hostBarHtml(snapshot, phase) {
    const me = snapshot.me;
    const isHost = me.isHost;
    if (snapshot.state === 'end') return '';
    const labels = {
      intro: 'Начать первый день',
      reveal: 'К обсуждению',
      discussion: 'К голосованию',
      vote: 'Закрыть голосование',
      night: 'Завершить ночь',
    };
    return `
      <div class="host-bar">
        <span class="host-note">${isHost
          ? 'Вы хост. Пропуск фазы увидит вся комната — используйте, если все готовы.'
          : 'Фаза закончится автоматически. Если все готовы — попросите хоста ускорить.'}</span>
        ${isHost ? `<button class="btn btn-ghost btn-small" data-action="skip">${iconSkip()} ${labels[snapshot.state] || 'Дальше'}</button>` : ''}
      </div>
    `;
  }

  function endSceneHtml(snapshot) {
    const me = snapshot.me;
    const winner = snapshot.winner;
    const label = winnerLabel(winner);
    return `
      <div class="scene-head">
        <div class="scene-head-row">
          <div>
            <div class="kicker">ПРОТОКОЛ ЗАВЕРШЁН</div>
            <h2>${esc(label.title)}</h2>
            <p class="scene-lede">${esc(label.short)}</p>
          </div>
          <span class="scene-daymark">ДЕНЬ ${snapshot.day}</span>
        </div>
      </div>
      <div class="end-banner">
        <div><b>${esc(label.tag)}</b><span>${esc(label.descr)}</span></div>
        <button class="btn btn-secondary btn-small" data-action="show-end">Открыть итоги</button>
      </div>
      <div class="intro-grid" style="margin-top:18px">
        <div class="lore-card">
          <span class="eyebrow">ЧТО ОСТАЛОСЬ ЗА ДВЕРЬЮ</span>
          <h3>${esc(label.endingTitle)}</h3>
          <p>${esc(label.endingText)}</p>
          <div class="lore-signature">бункер · итог · день ${snapshot.day}</div>
        </div>
        <div class="intro-card">
          <span class="eyebrow">ВАША РОЛЬ</span>
          <div class="intro-role-mini">
            <span class="role-sigil ${ROLE_META[me.role]?.color || 'human'}">${ROLE_META[me.role]?.sigil || '?'}</span>
            <div><h4>${esc(ROLE_META[me.role]?.name || '—')}</h4><p>${esc(roleText(me.role))}</p></div>
          </div>
          ${me.isHost ? '<button class="btn btn-primary btn-small" data-action="rematch" style="margin-top:14px;width:100%">Сыграть ещё</button>' : '<p style="margin-top:12px;color:var(--muted);font-size:11px">Хост может открыть новый бункер.</p>'}
        </div>
      </div>
    `;
  }

  /* ---------- top-level modals ---------- */

  function openRules() {
    const html = `
      <div class="modal" role="document">
        <button class="modal-close" data-action="close-modal" aria-label="Закрыть">×</button>
        <div class="modal-head">
          <span class="eyebrow">ПРОТОКОЛ «КОЛЬЦО-9»</span>
          <h2>Как выжить</h2>
          <p>Бункер — социальная игра на 5–15 человек. Здесь нет ведущего: все решения принимает сама комната.</p>
        </div>
        <div class="modal-section">
          <h3>День</h3>
          <div class="rule-steps">
            <div class="rule-step"><span class="rule-step-num">01</span><div><b>Раскройте одну карту</b><span>Профессия, здоровье, багаж, факт или привычка. Это увидят все. Каждый день — новая карта.</span></div></div>
            <div class="rule-step"><span class="rule-step-num">02</span><div><b>Обсуждайте</b><span>Сопоставляйте карты, реакции и ночные потери. Лгите, если есть что скрывать.</span></div></div>
            <div class="rule-step"><span class="rule-step-num">03</span><div><b>Голосуйте</b><span>Изгнанный выбывает, его роль раскрывается. При равенстве голосов не уходит никто.</span></div></div>
          </div>
        </div>
        <div class="modal-section">
          <h3>Ночь</h3>
          <p>Город затихает. Заражённые вместе выбирают жертву. Врач может спасти одного выжившего, потратив медикамент. Утром бункер узнает, кто не проснулся.</p>
        </div>
        <div class="modal-section">
          <h3>Роли</h3>
          <div class="role-rules-grid">
            <div class="role-rule"><span class="role-label" style="color:var(--teal)">● ЖИВОЙ</span><p>Вычислить и изгнать всех заражённых. Победа — когда в бункере не останется ни одного.</p></div>
            <div class="role-rule doctor"><span class="role-label" style="color:var(--blue)">● ВРАЧ</span><p>Живой с ночным действием. Спасает одного человека за ночь, тратя 1 медикамент. Нельзя спасать одного и того же две ночи подряд.</p></div>
            <div class="role-rule infected"><span class="role-label" style="color:var(--red)">● ЗАРАЖЁННЫЙ</span><p>Ночью вместе с союзниками выбирает жертву. Побеждает, когда заражённых становится не меньше, чем живых.</p></div>
          </div>
        </div>
        <div class="modal-section">
          <h3>Ресурсы</h3>
          <p><b>Еда</b> тратится каждое утро: по одной единице на каждого живого. <b>Энергия</b> убывает сама и от событий. <b>Медикаменты</b> нужны врачу.</p>
          <p>Если еда или энергия падают до нуля — на рассвете один случайный выживший погибает. Бункер не прощает беспечности.</p>
        </div>
        <div class="warning-line"><span>◈</span><div><b>Не показывайте экран.</b> Телефон удобнее держать ближе к себе: у каждого есть тайна, которую лучше не выдавать случайно.</div></div>
        <div class="modal-actions"><button class="btn btn-primary" data-action="close-modal">Понятно</button></div>
      </div>`;
    openModal(html, 'rules');
  }

  function openCharacter(auto = false) {
    const snapshot = state.snapshot;
    if (!snapshot?.me) return;
    const me = snapshot.me;
    const role = myselfRole(snapshot);
    const meta = ROLE_META[role?.role || me.role || 'human'];
    const roleSeen = state.roleSeenGame === snapshot.gameId || !me.alive || snapshot.state === 'end';
    const teammates = snapshot.players.filter((player) => me.teammates?.includes(player.id));
    const roleBlock = roleSeen ? `
      <div class="char-role ${meta.color}">
        <div class="char-role-head">
          <span class="role-sigil ${meta.color}">${meta.sigil}</span>
          <div><span class="eyebrow">ВАША РОЛЬ</span><h3>${meta.name}</h3><p>${esc(roleText(me.role))}</p></div>
        </div>
        <div class="role-objective"><b>Цель:</b> ${meta.objective}</div>
        ${me.role === 'infected' ? `
          <div class="teammates-list">
            <span class="eyebrow" style="width:100%">ВАШИ СОЮЗНИКИ</span>
            ${teammates.length ? teammates.map((player) => `<span class="teammate-chip">${avatarHtml(player, 'sm')}${esc(player.name)}${player.alive ? '' : ' · мёртв'}</span>`).join('') : '<span style="color:var(--muted);font-size:10px">Вы последний заражённый.</span>'}
          </div>` : ''}
        ${me.role === 'doctor' ? `
          <div class="role-action-note" style="margin-top:12px"><span>✚</span><div>Медикаментов в бункере: <b>${snapshot.resources.meds}</b>. Попытка спасти цель тратит 1 медикамент. Нельзя спасать одного и того же две ночи подряд.</div></div>` : ''}
      </div>
      <div class="char-traits">
        ${me.traits.map((trait) => `
          <div class="char-trait ${trait.revealed ? 'open' : ''}">
            <span class="ct-cat">${esc(trait.label)}</span>
            <span class="ct-value">${esc(trait.value)}</span>
            <span class="ct-state">${trait.revealed ? 'на столе' : 'скрыта'}</span>
          </div>`).join('')}
      </div>
      <p class="char-note">${me.alive ? 'Одна карта раскрывается каждый день. Скрытые карты видите только вы.' : 'Вы наблюдаете. Ваши карты больше не участвуют в игре.'}</p>
    ` : `
      <div class="char-role neutral">
        <div class="role-hidden">
          <span class="role-sigil neutral">?</span>
          <p>За этой дверью — ваша роль и пять личных карт. Убедитесь, что рядом нет чужих глаз.</p>
          <button class="btn btn-primary btn-small" data-action="reveal-role" style="margin-top:14px">Показать роль</button>
        </div>
      </div>
      <p class="char-note">Сначала посмотрите роль. Чужие глаза — плохая компания для тайны.</p>
    `;
    const html = `
      <div class="modal" role="document">
        <button class="modal-close" data-action="close-modal" aria-label="Закрыть">×</button>
        <div class="modal-head">
          <span class="eyebrow">ЛИЧНОЕ ДЕЛО · ${esc(snapshot.code)}</span>
          <h2>${esc(me.name)}</h2>
          <p>${me.alive ? 'Вы в бункере. Одна карта в день, одна ночь между вами и рассветом.' : 'Вы вне игры. Теперь можно наблюдать.'}</p>
        </div>
        ${roleBlock}
        <div class="modal-actions"><button class="btn btn-secondary" data-action="close-modal">Закрыть досье</button></div>
      </div>`;
    openModal(html, 'character', auto);
  }

  function revealRoleCard() {
    if (!state.snapshot) return;
    state.roleSeenGame = state.snapshot.gameId;
    openCharacter();
    renderTopActions(state.snapshot);
    renderScene(true);
  }

  function openProfile(playerId) {
    const snapshot = state.snapshot;
    if (!snapshot) return;
    const player = snapshot.players.find((item) => item.id === playerId);
    if (!player) return;
    const role = player.role ? ROLE_META[player.role] : null;
    const status = player.left
      ? 'покинул бункер'
      : player.alive
        ? 'жив'
        : player.death?.cause === 'exile'
          ? `изгнан · день ${player.death.day}`
          : player.death?.cause === 'night'
            ? `погиб · ночь ${player.death.day}`
            : player.death?.cause === 'crisis'
              ? `погиб · день ${player.death.day}`
              : 'вне игры';
    const traits = player.traits?.length
      ? player.traits.map((trait) => `<div class="profile-trait"><span>${esc(trait.label)}</span><b>${esc(trait.value)}</b></div>`).join('')
      : '<div class="profile-empty">Пока ни одной раскрытой карты. Всё, что вы знаете — слова и поведение.</div>';
    const html = `
      <div class="modal" role="document">
        <button class="modal-close" data-action="close-modal" aria-label="Закрыть">×</button>
        <div class="profile-head">
          ${avatarHtml(player, 'lg', !player.connected)}
          <div>
            <span class="eyebrow">ДОСЬЕ ВЫЖИВШЕГО${player.isHost ? ' · ХОСТ' : ''}</span>
            <h2>${esc(player.name)}${player.id === snapshot.me.id ? ' · вы' : ''}</h2>
            <div class="profile-meta">
              <span class="profile-status ${player.alive ? 'alive' : 'dead'}">${esc(status)}</span>
              ${player.teammate ? '<span class="profile-status host">ВАШ СОЮЗНИК</span>' : ''}
              ${player.connected ? '' : '<span class="profile-status">нет связи</span>'}
            </div>
          </div>
        </div>
        <div class="profile-role">
          <span class="role-sigil ${role?.color || 'human'}">${role?.sigil || '?'}</span>
          <div><b>${role ? `${role.name} · РОЛЬ РАСКРЫТА` : 'РОЛЬ НЕИЗВЕСТНА'}</b><span>${role ? roleText(player.role) : 'До изгнания или смерти этого выжившего роль остаётся тайной.'}</span></div>
        </div>
        <div class="modal-section" style="margin-top:16px;padding-top:0;border-top:0">
          <h3>Раскрытые карты · ${player.traits?.length || 0} / 5</h3>
          <div class="profile-traits">${traits}</div>
        </div>
        <div class="modal-actions"><button class="btn btn-secondary" data-action="close-modal">Закрыть</button></div>
      </div>`;
    openModal(html, 'profile', false, playerId);
  }

  function askSkip() {
    const snapshot = state.snapshot;
    if (!snapshot?.me?.isHost) return;
    const labels = {
      intro: 'начать первый день',
      reveal: 'завершить раскрытие карт',
      discussion: 'перейти к голосованию',
      vote: 'закрыть голосование',
      night: 'завершить ночь',
    };
    const html = `
      <div class="modal" style="max-width:460px" role="document">
        <button class="modal-close" data-action="close-modal" aria-label="Закрыть">×</button>
        <div class="modal-head">
          <span class="eyebrow">ХОСТ · УПРАВЛЕНИЕ ФАЗОЙ</span>
          <h2>Пропустить?</h2>
          <p>Это действие увидят все. Фаза завершится сразу — как если бы таймер дошёл до нуля.</p>
        </div>
        <div class="warning-line" style="margin-top:20px"><span>◈</span><div>Вы собираетесь <b>${labels[snapshot.state] || 'завершить фазу'}</b>. Убедитесь, что все успели сделать выбор.</div></div>
        <div class="modal-actions">
          <button class="btn btn-secondary" data-action="close-modal">Отмена</button>
          <button class="btn btn-primary" data-action="confirm-skip">Да, дальше</button>
        </div>
      </div>`;
    openModal(html, 'skip');
  }

  function confirmSkip() {
    closeModal();
    socket.emit('skip', {}, handleAck);
  }

  function openModal(html, type = '', auto = false, data = null) {
    state.modalOpen = true;
    state.activeModalType = type;
    state.activeModalData = data;
    el.modalRoot.innerHTML = html;
    el.modalRoot.classList.remove('hidden');
    document.body.classList.add('modal-active');
    if (!auto) {
      const focusable = el.modalRoot.querySelector('button, input');
      focusable?.focus({ preventScroll: true });
    }
  }

  function closeModal() {
    state.modalOpen = false;
    state.activeModalType = null;
    state.activeModalData = null;
    el.modalRoot.classList.add('hidden');
    el.modalRoot.innerHTML = '';
    if (!state.endOpen) document.body.classList.remove('modal-active');
  }

  function showEndOverlay(force = false) {
    const snapshot = state.snapshot;
    if (!snapshot || snapshot.state !== 'end') return;
    state.endDismissed = false;
    state.endOpen = true;
    el.endRoot.innerHTML = endOverlayHtml(snapshot);
    el.endRoot.classList.remove('hidden');
    document.body.classList.add('modal-active');
  }

  function closeEndOverlay(silent = false) {
    state.endOpen = false;
    if (!silent) state.endDismissed = true;
    el.endRoot.classList.add('hidden');
    el.endRoot.innerHTML = '';
    if (!state.modalOpen) document.body.classList.remove('modal-active');
  }

  function endOverlayHtml(snapshot) {
    const label = winnerLabel(snapshot.winner);
    const alive = snapshot.players.filter((player) => player.alive);
    const roles = {
      infected: snapshot.players.filter((player) => player.role === 'infected').length,
      doctor: snapshot.players.filter((player) => player.role === 'doctor').length,
      human: snapshot.players.filter((player) => player.role === 'human').length,
    };
    const roster = snapshot.players.map((player) => {
      const meta = ROLE_META[player.role] || { name: '—', color: 'human' };
      const status = player.left
        ? 'покинул'
        : player.alive
          ? 'выжил'
          : player.death?.cause === 'exile'
            ? `изгнан · д${player.death.day || 0}`
            : player.death?.cause === 'night'
              ? `погиб · н${player.death.day || 0}`
              : player.death?.cause === 'crisis'
                ? `кризис · д${player.death.day || 0}`
                : 'вне игры';
      return `
        <button class="end-player" data-action="profile" data-player="${escAttr(player.id)}">
          ${avatarHtml(player, 'sm', !player.connected)}
          <span class="end-player-main">
            <span class="end-player-name">${esc(player.name)}${player.id === snapshot.me.id ? ' · вы' : ''}</span>
            <span class="end-player-meta"><span class="end-role ${meta.color}">${meta.name}</span><span>${esc(status)}</span></span>
          </span>
        </button>`;
    }).join('');
    return `
      <div class="end-modal win-${snapshot.winner || 'none'}">
        <button class="modal-close end-close" data-action="close-end" aria-label="Закрыть итоги">×</button>
        <div class="end-top">
          <div>
            <span class="end-kicker">ПРОТОКОЛ ЗАВЕРШЁН · БУНКЕР ${esc(snapshot.code)}</span>
            <div class="winner-label ${label.color}">${label.tag}</div>
            <h1 class="end-title">${label.title}</h1>
            <p class="end-sub">${label.endingText}</p>
            <div class="end-stats">
              <div class="end-stat"><span>дней</span><b>${snapshot.day}</b></div>
              <div class="end-stat"><span>выжило</span><b>${alive.length} / ${snapshot.players.length}</b></div>
              <div class="end-stat"><span>заражённых</span><b>${roles.infected}</b></div>
              <div class="end-stat"><span>врач</span><b>${roles.doctor}</b></div>
              <div class="end-stat"><span>еда</span><b>${snapshot.resources.food}</b></div>
              <div class="end-stat"><span>энергия</span><b>${snapshot.resources.energy}</b></div>
            </div>
          </div>
        </div>
        <div class="end-roster">${roster}</div>
        <div class="end-actions">
          <div class="end-actions-group">
            ${snapshot.me.isHost ? '<button class="btn btn-primary" data-action="rematch">Сыграть ещё</button>' : ''}
            <button class="btn btn-secondary" data-action="copy-result">${iconCopy()} Скопировать итог</button>
            <button class="btn btn-ghost" data-action="leave">Выйти</button>
          </div>
          <button class="btn btn-secondary btn-small" data-action="close-end">Вернуться к столу</button>
        </div>
      </div>`;
  }

  /* ---------- chat ---------- */

  function renderChatTabs(snapshot) {
    if (snapshot.state === 'end') {
      el.chatTabs.innerHTML = '<span class="chat-tab active">Архив</span>';
      return;
    }
    const tabs = [{ id: 'day', label: 'Зал', cls: '' }];
    if (snapshot.me.role === 'infected' && snapshot.me.alive) tabs.push({ id: 'mafia', label: 'Шёпот', cls: 'tab-mafia' });
    if (!snapshot.me.alive) tabs.push({ id: 'dead', label: 'Мёртвые', cls: 'tab-dead' });
    ensureTabAvailable();
    el.chatTabs.innerHTML = tabs.map((tab) => `
      <button class="chat-tab ${tab.cls} ${state.activeTab === tab.id ? 'active' : ''}" data-action="chat-tab" data-tab="${tab.id}">
        ${tab.label}${state.unread[tab.id] ? '<i class="unread"></i>' : ''}
      </button>
    `).join('');
  }

  function switchTab(tab) {
    if (!['day', 'mafia', 'dead'].includes(tab)) return;
    if (tab === 'mafia' && state.snapshot?.me?.role !== 'infected') return;
    if (tab === 'dead' && state.snapshot?.me?.alive) return;
    state.activeTab = tab;
    state.unread[tab] = 0;
    if (state.snapshot) {
      renderChatTabs(state.snapshot);
      renderChatFeed(el.gameChatFeed, visibleMessages(state.snapshot), { tabs: true });
      updateGameChatForm(state.snapshot);
    }
  }

  function ensureTabAvailable() {
    const snapshot = state.snapshot;
    if (!snapshot) return;
    if (state.activeTab === 'mafia' && (snapshot.me.role !== 'infected' || !snapshot.me.alive)) state.activeTab = 'day';
    if (state.activeTab === 'dead' && snapshot.me.alive) state.activeTab = 'day';
    if (snapshot.state === 'end') state.activeTab = 'day';
  }

  function handleAutoTab(previous, snapshot) {
    if (!previous) return;
    if (snapshot.state === 'night' && previous.state !== 'night') {
      if (snapshot.me.role === 'infected' && snapshot.me.alive) state.activeTab = 'mafia';
      else if (!snapshot.me.alive) state.activeTab = 'dead';
      else state.activeTab = 'day';
      state.pendingReveal = null;
    }
    if (snapshot.state !== 'night' && previous.state === 'night') {
      if (snapshot.me.alive) state.activeTab = 'day';
    }
    if (!snapshot.me.alive && previous.me.alive) {
      if (snapshot.state !== 'end') state.activeTab = 'dead';
      toast(
        snapshot.state === 'end'
          ? 'Игра завершена. Все каналы открыты.'
          : 'Вы выбыли из игры. Теперь вам доступен чат мёртвых.',
        snapshot.state === 'end' ? 'accent' : 'error',
        4200,
      );
    }
    if (snapshot.state === 'vote' && previous.state !== 'vote') {
      state.pendingReveal = null;
    }
    if (snapshot.state === 'discussion' && previous.state !== 'discussion') {
      state.pendingReveal = null;
    }
  }

  function handleUnread(previous, snapshot) {
    if (!previous) return;
    if (snapshot.state === 'end') {
      state.unread = { mafia: 0, dead: 0 };
      return;
    }
    const prevIds = new Set((previous.messages || []).map((message) => message.id));
    const newOnes = (snapshot.messages || []).filter((message) => !prevIds.has(message.id) && message.kind === 'chat');
    for (const message of newOnes) {
      if (message.channel === 'mafia' && state.activeTab !== 'mafia') state.unread.mafia += 1;
      if (message.channel === 'dead' && state.activeTab !== 'dead') state.unread.dead += 1;
    }
  }

  function lobbyMessages(snapshot) {
    return (snapshot.messages || []).filter((message) => message.channel === 'system' || message.channel === 'day');
  }

  function visibleMessages(snapshot) {
    if (snapshot.state === 'end') return snapshot.messages || [];
    const tab = state.activeTab;
    return (snapshot.messages || []).filter((message) => {
      if (message.channel === 'system') return true;
      return message.channel === tab;
    });
  }

  function renderChatFeed(container, messages, options = {}) {
    if (!container) return;
    const previousKey = options.lobby ? state.lobbyKey : state.lastMessageKey;
    const namespace = state.snapshot ? `${state.snapshot.code}:${state.snapshot.gameId}` : '';
    const key = `${namespace}:${options.lobby ? 'lobby' : state.activeTab}:${messages.length}:${messages[messages.length - 1]?.id || 0}`;
    if (options.lobby) state.lobbyKey = key;
    else state.lastMessageKey = key;
    if (previousKey === key) return;
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 90;
    container.innerHTML = messages.length
      ? messages.map((message) => messageHtml(message)).join('')
      : `<div class="empty-state">${options.lobby ? 'Пока тихо. Скажите первым.' : 'Здесь пока пусто.'}</div>`;
    if (nearBottom || messages.length < 4) container.scrollTop = container.scrollHeight;
  }

  function messageHtml(message) {
    if (message.kind === 'chat') {
      const cls = message.channel === 'mafia' ? 'is-mafia' : message.channel === 'dead' ? 'is-dead' : '';
      return `
        <div class="msg msg-chat ${cls}">
          ${avatarHtml({ avatar: message.avatar, avatarIndex: message.avatarIndex }, 'sm')}
          <div class="msg-body">
            <div class="msg-head"><b>${esc(message.author || '—')}</b><time>${formatTime(message.at)}</time></div>
            <p>${esc(message.text)}</p>
          </div>
        </div>`;
    }
    const tone = message.tone || 'info';
    const privateCls = message.kind === 'private' ? 'private' : '';
    return `
      <div class="msg msg-system tone-${tone} ${privateCls}">
        <span class="msg-mark">${message.kind === 'private' ? '✉' : '›'}</span>
        <p>${esc(message.text)}</p>
      </div>`;
  }

  function updateLobbyChatForm(snapshot) {
    const can = snapshot.chat?.day && snapshot.state === 'lobby';
    if (!el.lobbyChatInput) return;
    el.lobbyChatInput.disabled = !can;
    el.lobbyChatInput.placeholder = can ? 'Сказать что-нибудь в бункер…' : 'Лобби закрыто';
    const send = el.lobbyChatForm?.querySelector('button');
    if (send) send.disabled = !can;
  }

  function updateGameChatForm(snapshot) {
    if (!el.gameChatInput) return;
    const channel = chatChannelForTab();
    const can = Boolean(snapshot.chat?.[channel]) && snapshot.state !== 'end';
    const canEnd = snapshot.state === 'end';
    const allowed = can || canEnd;
    el.gameChatInput.disabled = !allowed;
    el.gameChatInput.placeholder = chatPlaceholder(snapshot, channel, allowed);
    const send = el.gameChatForm?.querySelector('button');
    if (send) send.disabled = !allowed;
    el.chatHint.textContent = chatHint(snapshot, channel, allowed);
  }

  function chatChannelForTab() {
    if (state.snapshot?.state === 'end') return 'day';
    if (state.activeTab === 'mafia') return 'mafia';
    if (state.activeTab === 'dead') return 'dead';
    return 'day';
  }

  function chatPlaceholder(snapshot, channel, allowed) {
    if (allowed) {
      if (snapshot.state === 'end') return 'Бункер вскрыт. Скажите последнее слово…';
      if (channel === 'mafia') return 'Шёпот слышат только заражённые…';
      if (channel === 'dead') return 'Это услышат только мёртвые…';
      return snapshot.state === 'vote' ? 'Сказать перед голосованием…' : 'Написать в зал…';
    }
    if (snapshot.state === 'night') {
      if (!snapshot.me.alive) return 'Мёртвые не говорят с живыми в эту ночь.';
      return 'Ночью бункер молчит.';
    }
    if (!snapshot.me.alive) return 'Мёртвые говорят только в своём канале.';
    return 'Сейчас писать нельзя.';
  }

  function chatHint(snapshot, channel, allowed) {
    if (!snapshot.me.alive && snapshot.state !== 'end') {
      return 'Вы наблюдаете. Живые не увидят ваши сообщения.';
    }
    if (snapshot.state === 'night') {
      if (snapshot.me.role === 'infected' && channel === 'mafia') return 'Шёпот виден только заражённым.';
      if (channel === 'dead') return 'Канал мёртвых.';
      return 'Ночью канал зала закрыт.';
    }
    if (snapshot.state === 'end') return 'Бункер вскрыт. Все каналы доступны.';
    if (allowed) return 'Enter — отправить. Будьте осторожны с тем, что говорите.';
    return '';
  }

  function sendChatFromInput(channel, input) {
    if (!input || input.disabled) return;
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    socket.emit('chat', { channel, text }, (res) => {
      if (!res?.ok) {
        toast(res?.error || 'Сообщение не отправлено.', 'error');
        if (!input.value) input.value = text;
      }
    });
  }

  /* ---------- actions ---------- */

  function selectTrait(index) {
    const me = state.snapshot?.me;
    if (!me) return;
    if (state.pendingReveal === index) {
      state.pendingReveal = null;
    } else {
      state.pendingReveal = index;
    }
    renderScene(true);
  }

  function confirmTrait() {
    if (!Number.isInteger(state.pendingReveal)) return;
    const index = state.pendingReveal;
    state.pendingReveal = null;
    socket.emit('reveal', { index }, (res) => {
      if (!res?.ok) {
        toast(res?.error || 'Не удалось раскрыть карту.', 'error');
        renderScene(true);
      }
    });
  }

  function castVote(targetId) {
    socket.emit('vote', { targetId }, handleAck);
  }

  function nightAction(targetId) {
    socket.emit('night', { targetId }, handleAck);
  }

  function doctorSkip() {
    socket.emit('night-skip', {}, handleAck);
  }

  function startGame() {
    socket.emit('start', {}, (res) => {
      if (!res?.ok) toast(res?.error || 'Не удалось начать игру.', 'error');
    });
  }

  function setPace(pace) {
    if (!pace || !state.snapshot?.me.isHost) return;
    socket.emit('pace', { pace }, (res) => {
      if (!res?.ok) toast(res?.error || 'Не удалось изменить темп.', 'error');
    });
  }

  function kickPlayer(playerId) {
    if (!playerId) return;
    socket.emit('kick', { targetId: playerId }, (res) => {
      if (!res?.ok) toast(res?.error || 'Не удалось исключить игрока.', 'error');
    });
  }

  function leaveRoom() {
    const inGame = state.snapshot && state.snapshot.state !== 'lobby';
    if (inGame) {
      const label = state.snapshot.me?.alive ? 'Вы покинете игру и больше не сможете вернуться в этот бункер.' : 'Вы покинете бункер.';
      openModal(`
        <div class="modal" style="max-width:460px" role="document">
          <button class="modal-close" data-action="close-modal" aria-label="Закрыть">×</button>
          <div class="modal-head">
            <span class="eyebrow">ВЫХОД ИЗ БУНКЕРА</span>
            <h2>Уйти?</h2>
            <p>${esc(label)}</p>
          </div>
          <div class="warning-line" style="margin-top:20px"><span>◈</span><div>Вернуться в идущую игру можно только в том же браузере и только если вы не нажали «Выйти».</div></div>
          <div class="modal-actions">
            <button class="btn btn-secondary" data-action="close-modal">Остаться</button>
            <button class="btn btn-danger" data-action="leave-confirm">Выйти</button>
          </div>
        </div>`, 'leave');
    } else {
      socket.emit('leave', {}, () => {});
      clearSessionLocal();
    }
  }

  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="leave-confirm"]')) {
      closeModal();
      socket.emit('leave', {}, () => clearSessionLocal(true));
    }
  });

  function handleAck(res) {
    if (res && res.ok === false) toast(res.error || 'Действие недоступно.', 'error');
  }

  function rematch() {
    socket.emit('rematch', {}, (res) => {
      if (!res?.ok) toast(res?.error || 'Не удалось вернуться в лобби.', 'error');
      else {
        closeEndOverlay(true);
        closeModal();
        state.endDismissed = false;
      }
    });
  }

  function copyResult() {
    const snapshot = state.snapshot;
    if (!snapshot || snapshot.state !== 'end') return;
    const label = winnerLabel(snapshot.winner);
    const lines = [
      `БУНКЕР·9 — ${label.title}`,
      `День ${snapshot.day}. ${snapshot.players.filter((player) => player.alive).length} из ${snapshot.players.length} выжили.`,
      '',
      ...snapshot.players.map((player) => `${player.name} — ${ROLE_META[player.role]?.name || '—'} — ${player.alive ? 'выжил' : player.death?.cause === 'exile' ? 'изгнан' : player.left ? 'покинул' : 'погиб'}`),
      '',
      inviteLink(snapshot.code),
    ];
    copyText(lines.join('\n'), 'Итог скопирован.');
  }

  /* ---------- countdown / sounds / connection ---------- */

  function updateCountdown() {
    const snapshot = state.snapshot;
    if (!snapshot) return;
    const timerNodes = $$('#phaseTimer');
    const bar = $('#phaseBarFill');
    if (!snapshot.phaseEndsAt || snapshot.state === 'end') {
      timerNodes.forEach((node) => {
        node.textContent = '—:—';
        node.classList.add('waiting');
        node.classList.remove('urgent');
      });
      if (bar) bar.style.width = '0%';
      return;
    }
    const now = Date.now() + state.offset;
    const left = Math.max(0, snapshot.phaseEndsAt - now);
    const duration = Math.max(1000, (snapshot.phaseEndsAt - (snapshot.phaseStartedAt || snapshot.phaseEndsAt - 1)));
    const percent = Math.max(0, Math.min(100, (left / duration) * 100));
    const text = formatClock(left);
    timerNodes.forEach((node) => {
      node.textContent = text;
      node.classList.toggle('urgent', left <= 10000 && left > 0);
      node.classList.toggle('waiting', left <= 0);
    });
    if (bar) {
      bar.style.width = `${percent}%`;
      bar.classList.toggle('urgent', left <= 10000);
    }
  }

  function syncTimerNodes() {
    updateCountdown();
  }

  function handlePhaseSound(previous, snapshot) {
    const key = `${snapshot.state}:${snapshot.day}`;
    if (state.lastTone === key) return;
    const isFirst = !previous;
    state.lastTone = key;
    if (isFirst) return;
    if (!state.sound) return;
    const tone = snapshot.state === 'night' ? 'night' : snapshot.state === 'vote' ? 'vote' : snapshot.state === 'end' ? 'end' : snapshot.state === 'reveal' ? 'reveal' : 'day';
    playPhaseTone(tone);
  }

  function playPhaseTone(tone) {
    if (!state.sound) return;
    const ctx = getAudio();
    if (!ctx) return;
    const seq = {
      day: [[392, 0], [523, 0.11]],
      reveal: [[440, 0], [587, 0.1]],
      vote: [[330, 0], [262, 0.16]],
      night: [[196, 0], [147, 0.24]],
      end: [[262, 0], [392, 0.18], [523, 0.36]],
    }[tone] || [[440, 0]];
    for (const [freq, delay] of seq) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.000, ctx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.04, ctx.currentTime + delay + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.38);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + 0.42);
    }
  }

  function getAudio() {
    try {
      if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
      return state.audioCtx;
    } catch {
      return null;
    }
  }

  function toggleSound() {
    state.sound = !state.sound;
    saveJson('bunker9.sound', state.sound);
    updateSoundButton();
    if (state.sound) playPhaseTone('day');
    toast(state.sound ? 'Звук включён.' : 'Звук выключен.', 'accent');
  }

  function updateSoundButton() {
    const button = $('[data-action="sound"]');
    if (!button) return;
    button.classList.toggle('sound-on', state.sound);
    button.title = state.sound ? 'Выключить звук' : 'Включить звук';
    button.innerHTML = state.sound ? iconSoundOn() : iconSoundOff();
  }

  function updateConnectionUI(connected) {
    if (!el.connection) return;
    if (connected) {
      el.connection.classList.add('hidden');
      el.connection.classList.remove('reconnected');
      return;
    }
    el.connection.classList.remove('hidden');
    el.connection.classList.remove('reconnected');
    el.connectionText.textContent = 'Связь потеряна. Переподключаемся…';
  }

  /* ---------- landing helpers ---------- */

  function readName() {
    const value = (el.name?.value || '').trim();
    if (value.length < 2) {
      showLandingError('Позывной — минимум 2 символа.');
      el.name?.focus();
      return null;
    }
    if (value.length > 16) {
      showLandingError('Позывной — максимум 16 символов.');
      el.name?.focus();
      return null;
    }
    state.name = value;
    saveJson('bunker9.name', value);
    return value;
  }

  function showLandingError(text) {
    if (!el.landingError) return;
    el.landingError.textContent = text;
    clearTimeout(landingErrorTimer);
    landingErrorTimer = setTimeout(() => {
      if (el.landingError) el.landingError.textContent = '';
    }, 6500);
  }

  function clearLandingError() {
    if (el.landingError) el.landingError.textContent = '';
  }

  function renderAvatarPicker() {
    if (!el.avatarPicker) return;
    el.avatarPicker.innerHTML = AVATARS.map((avatar, index) => `
      <button class="avatar-choice ${index === state.avatar ? 'active' : ''}" type="button" data-avatar="${index}" role="option" aria-selected="${index === state.avatar}" title="Метка ${index + 1}">${avatar}</button>
    `).join('');
    $$('.avatar-choice', el.avatarPicker).forEach((button) => {
      button.addEventListener('click', () => {
        state.avatar = Number(button.dataset.avatar);
        saveJson('bunker9.avatar', state.avatar);
        renderAvatarPicker();
      });
    });
  }

  function prefillFromHash() {
    const code = normalizeCode(location.hash.replace('#', ''));
    if (!code || code.length !== 4) return;
    if (el.code) el.code.value = code;
    if (state.session?.code === code && state.session?.token) {
      state.name = state.session.name || state.name;
      if (el.name) el.name.value = state.name;
      reconnectWanted = true;
      const tryRejoin = () => {
        if (!socket.connected) {
          setTimeout(tryRejoin, 300);
          return;
        }
        socket.emit('join', {
          code,
          token: state.session.token,
          name: state.name || 'Выживший',
          avatar: AVATARS[state.avatar],
        }, (res) => {
          if (!res?.ok) {
            showLandingError(res?.error || 'Не удалось вернуться в бункер. Возможно, сессия истекла.');
            state.session = null;
            saveJson('bunker9.session', null);
            maybeOfferReturn();
          }
        });
      };
      tryRejoin();
    } else {
      el.name?.focus();
    }
  }

  function maybeOfferReturn() {
    if (!el.returnSession) return;
    if (state.session?.code) {
      el.returnSession.classList.remove('hidden');
      el.returnSessionText.textContent = `Бункер ${state.session.code} · ${state.session.name || 'выживший'}`;
    } else {
      el.returnSession.classList.add('hidden');
    }
  }

  function setUrlCode(code) {
    try {
      history.replaceState(null, '', `#${code}`);
    } catch {
      /* noop */
    }
  }

  function removeUrlCode() {
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch {
      /* noop */
    }
  }

  function clearSessionLocal(reload = false) {
    state.session = null;
    state.snapshot = null;
    state.activeTab = 'day';
    state.pendingReveal = null;
    reconnectWanted = false;
    saveJson('bunker9.session', null);
    removeUrlCode();
    closeModal();
    closeEndOverlay(true);
    showScreen('landing');
    maybeOfferReturn();
    if (reload) window.location.reload();
  }

  /* ---------- phase meta ---------- */

  function phaseInfo(snapshot) {
    const base = {
      intro: {
        tone: 'day', chip: 'ПРОБУЖДЕНИЕ', name: 'Роли розданы', kicker: 'ДЕНЬ 0 · ВНУТРИ',
        dayText: 'гермодверь заперта',
        title: 'Добро пожаловать в «Кольцо-9»',
        lede: 'Пять карт о каждом. Одна ложь среди всех. Первый день начнётся, как только все прочитают свои роли.',
      },
      reveal: {
        tone: 'day', chip: 'РАССВЕТ', name: 'Раскрытие карт', kicker: `ДЕНЬ ${snapshot.day} · РАСКРЫТИЕ`,
        dayText: `день ${snapshot.day} из неизвестного`,
        title: 'Покажите одну карту',
        lede: 'Каждый выживший выкладывает на стол один факт о себе. Выбирайте осторожно: назад пути нет.',
      },
      discussion: {
        tone: 'day', chip: 'ДЕНЬ', name: 'Обсуждение', kicker: `ДЕНЬ ${snapshot.day} · ОБСУЖДЕНИЕ`,
        dayText: `день ${snapshot.day}`,
        title: 'Кому вы верите?',
        lede: 'У вас есть раскрытые карты, чужие слова и ночные потери. Используйте всё, что осталось.',
      },
      vote: {
        tone: 'vote', chip: 'ГОЛОСОВАНИЕ', name: 'Изгнание', kicker: `ДЕНЬ ${snapshot.day} · ГОЛОСОВАНИЕ`,
        dayText: `день ${snapshot.day}`,
        title: 'Кто покинет бункер?',
        lede: 'Один голос — один шанс исправить ошибку. Или совершить новую. При равенстве никто не уйдёт.',
      },
      night: {
        tone: 'night', chip: 'НОЧЬ', name: 'Тишина', kicker: `НОЧЬ ${snapshot.day} · ТИШИНА`,
        dayText: `ночь ${snapshot.day}`,
        title: 'Свет гаснет',
        lede: 'Заражённые выбирают жертву. Врач — того, кого попытается сохранить. Остальным остаётся тишина.',
      },
      end: {
        tone: 'end', chip: 'ИТОГ', name: 'Протокол завершён', kicker: 'ПОСЛЕ ТИШИНЫ',
        dayText: 'дверь открыта',
        title: 'Всё закончилось',
        lede: 'Бункер выдержал или пал. Роли раскрыты. Осталось решить, что вы расскажете об этом снаружи.',
      },
    }[snapshot.state] || {};
    base.tone = base.tone || 'day';
    return base;
  }

  function eventTone(effects) {
    let score = 0;
    for (const value of Object.values(effects || {})) score += value;
    return score > 0 ? 'good' : score < 0 ? 'bad' : 'neutral';
  }

  function effectChips(effects = {}) {
    const labels = { food: 'еда', energy: 'энергия', meds: 'меды' };
    return Object.entries(effects)
      .filter(([, value]) => value)
      .map(([key, value]) => `<span class="effect ${value > 0 ? 'plus' : 'minus'}">${value > 0 ? '+' : ''}${value} ${labels[key] || key}</span>`)
      .join('');
  }

  function winnerLabel(winner) {
    if (winner === 'humans') {
      return {
        color: 'humans', tag: 'ПОБЕДА ЖИВЫХ', title: 'ТИШИНА ОТСТУПАЕТ',
        short: 'Все заражённые изгнаны. Бункер снова принадлежит живым.',
        descr: 'Рассвет встречают только люди.',
        endingTitle: 'Дверь открывается',
        endingText: 'Последний заражённый изгнан. Дверь бункера открывается в серый, но живой мир. Вы не знаете, что там снаружи. Но теперь вы знаете, кому можно верить.',
      };
    }
    if (winner === 'infected') {
      return {
        color: 'infected', tag: 'ПОБЕДА ЗАРАЖЁННЫХ', title: 'В БУНКЕРЕ ОСТАЛИСЬ ТОЛЬКО СВОИ',
        short: 'Заражённых стало не меньше, чем живых. Тишина победила.',
        descr: 'Те, кто не был человеком, больше не прячутся.',
        endingTitle: 'Тишина обрела дом',
        endingText: 'К утру голоса стихли. Заражённые больше не прячутся — им незачем. Тишина наконец обрела дом.',
      };
    }
    return {
      color: 'none', tag: 'НИЧЬЯ', title: 'БУНКЕР МОЛЧИТ',
      short: 'Никто не выжил. Протокол завершён сам собой.',
      descr: 'Еда, свет, люди — всё закончилось одновременно.',
      endingTitle: 'Никто не выжил',
      endingText: 'Никто не выжил. Еда, свет, люди — всё закончилось одновременно. Снаружи никто не придёт.',
    };
  }

  /* ---------- utilities ---------- */

  function roleText(role) {
    return {
      human: 'Вы человек. Ваша задача — вычислить заражённых и изгнать их до того, как бункер опустеет.',
      doctor: 'Вы человек и врач. Раз за ночь можете попытаться спасти одного выжившего от заражения. Каждая попытка стоит 1 медикамент.',
      infected: 'Вы не человек. Каждую ночь вместе с остальными заражёнными выбирайте жертву. Днём — лгите, ищите врача, сейте панику.',
    }[role] || '';
  }

  function myselfRole(snapshot) {
    const me = snapshot.me;
    if (!me?.role) return null;
    return { role: me.role, label: me.roleLabel };
  }

  function nameById(snapshot, id) {
    return snapshot.players.find((player) => player.id === id)?.name || '—';
  }

  function avatarHtml(player, size = '', offline = false, done = false) {
    const hue = Math.round(((player.avatarIndex ?? 0) * 47 + 20) % 360);
    const avatar = player.avatar || '👤';
    return `<span class="avatar ${size} ${done ? 'done' : ''}" style="--h:${hue}">${avatar}<i class="conn-dot ${offline ? 'off' : ''} ${offline ? '' : 'hidden'}"></i></span>`;
  }

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escAttr(value) {
    return esc(value).replace(/`/g, '&#96;');
  }

  function normalizeCode(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  }

  function inviteLink(code) {
    const isLocal = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname);
    const base = isLocal && state.lanUrl ? state.lanUrl.replace(/\/$/, '') : location.origin;
    const pathPart = location.pathname && location.pathname !== '/' ? location.pathname : '/';
    return `${base}${pathPart}#${code}`;
  }

  function formatTime(ts) {
    try {
      return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
    } catch {
      return '';
    }
  }

  function formatClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  function randomInt(max) {
    return Math.floor(Math.random() * max);
  }

  function loadJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  function saveJson(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* noop */
    }
  }

  function copyText(text, success = 'Скопировано.') {
    if (!text) return;
    const done = () => toast(success, 'success');
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      done?.();
    } catch {
      toast('Не удалось скопировать. Выделите текст вручную.', 'error');
    }
  }

  function copyInvite() {
    const code = state.snapshot?.code || state.session?.code;
    if (code) copyText(inviteLink(code), 'Ссылка-приглашение скопирована.');
  }

  function toast(text, tone = 'info', ms = 2800) {
    if (!el.toastRoot) return;
    const node = document.createElement('div');
    node.className = `toast tone-${tone}`;
    node.textContent = text;
    el.toastRoot.appendChild(node);
    setTimeout(() => {
      node.classList.add('leaving');
      setTimeout(() => node.remove(), 240);
    }, ms);
  }

  /* ---------- icons ---------- */

  function iconFood() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8h14l-1.5 11h-11L5 8z"/><path d="M8 8V6a4 4 0 0 1 8 0v2M9 12h6"/></svg>';
  }
  function iconBolt() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M13 2 4.5 13.5H11L9.5 22 19 9.5h-6.5L13 2z"/></svg>';
  }
  function iconCross() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 4v16M4 12h16"/></svg>';
  }
  function iconBook() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5v-15z"/><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20v3H6.5A2.5 2.5 0 0 1 4 20.5zM8 7h8M8 10h5"/></svg>';
  }
  function iconDossier() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M5 3h10l4 4v14H5V3z"/><path d="M15 3v4h4M8 12h8M8 16h5"/></svg>';
  }
  function iconExit() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4H5v16h5M14 8l4 4-4 4M9 12h9"/></svg>';
  }
  function iconSoundOn() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10v4h4l5 4V6l-5 4H4z"/><path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12"/></svg>';
  }
  function iconSoundOff() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10v4h4l5 4V6l-5 4H4z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>';
  }
  function iconSkip() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M5 12h14M14 7l5 5-5 5"/></svg>';
  }
  function iconCopy() {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="8" y="8" width="10" height="10" rx="2"/><path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"/></svg>';
  }
})();
