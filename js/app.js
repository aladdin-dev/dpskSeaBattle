/*
 * «Морской бой» — P2P-клиент.
 *
 * Сетевой протокол (поверх PeerJS DataConnection, JSON):
 *   hello          { role: 'host'|'guest' }
 *   ready          { layout: [{ size, cells: [[x,y], ...] }] }
 *   shot           { x, y, shotId }
 *   shot-result    { x, y, shotId, result: 'miss'|'hit'|'sunk'|'invalid', sunkCells, gameOver }
 *   resign         {}
 *   rematch-request / rematch-accept / rematch-decline
 *   leave          {}
 *
 * Соперник не может изменить состояние напрямую: каждый клиент хранит своё
 * поле, а результат выстрела подтверждает владелец поля. Это не защищает от
 * подмены клиента, но делает игровой поток детерминированным.
 */
(function () {
  'use strict';

  const Engine = window.BattleshipEngine;
  const PeerCtor = window.Peer;
  const PROTOCOL_VERSION = 1;
  const MAX_SHIPS = 10;
  const SHOT_RESULTS = ['miss', 'hit', 'sunk', 'invalid'];
  const ROOM_PREFIX = 'bsb-';
  const ROOM_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
  const PEER_DEBUG = new URLSearchParams(window.location.search).has('debug') ? 1 : 0;

  /*
   * Публичная сигнализация PeerJS.
   *
   * 0.peerjs.com — штатное облако библиотеки, используется первым. В некоторых
   * сетях (например, в России) Cloudflare отдаёт на него 403. Комната хранит
   * выбранный сервер в своём ID: bsb-c-… / bsb-x-… / bsb-w-…, поэтому второй
   * игрок автоматически подключается туда же. Резервные серверы говорят на
   * протоколе PeerJS и не проксируют игровые данные — только рукопожатие.
   */
  const SIGNALING_SERVERS = [
    {
      key: 'c',
      label: 'облако PeerJS',
      options: null
    },
    {
      key: 'x',
      label: 'резервный PeerJS-сервер xfenix.ru',
      options: {
        host: 'xfenix.ru',
        port: 443,
        path: '/',
        secure: true,
        key: 'peerjs'
      }
    },
    {
      key: 'w',
      label: 'резервный PeerJS-сервер slidemachina',
      options: {
        host: 'slidemachina-broker.xfenix.workers.dev',
        port: 443,
        path: '/',
        secure: true,
        key: 'peerjs'
      }
    }
  ];
  const SIGNALING_FALLBACK_ERRORS = ['network', 'server-error', 'socket-error', 'socket-closed', 'ssl-unavailable'];

  const $ = function (id) { return document.getElementById(id); };

  const ui = {
    appShell: document.querySelector('.app-shell'),
    brand: $('btn-brand'),
    home: $('btn-home'),
    statusPill: $('status-pill'),
    statusText: $('status-text'),
    main: $('app-main'),
    screens: {
      lobby: $('screen-lobby'),
      create: $('screen-create'),
      join: $('screen-join'),
      placement: $('screen-placement'),
      game: $('screen-game')
    },
    btnCreate: $('btn-create'),
    btnJoin: $('btn-join'),
    roomId: $('room-id'),
    copyId: $('btn-copy-id'),
    copyLink: $('btn-copy-link'),
    share: $('btn-share'),
    createTitle: $('create-status-title'),
    createText: $('create-status-text'),
    waitingCard: $('waiting-card'),
    createError: $('create-error'),
    createRetry: $('btn-create-retry'),
    createCancel: $('btn-create-cancel'),
    joinForm: $('join-form'),
    joinInput: $('join-input'),
    joinError: $('join-error'),
    joinLoader: $('join-loader'),
    joinLoaderText: $('join-loader-text'),
    paste: $('btn-paste'),
    connect: $('btn-connect'),
    inviteNote: $('invite-note'),
    inviteRoomId: $('invite-room-id'),
    placementBoard: $('placement-board'),
    placementCounter: $('placement-counter'),
    placementHint: $('placement-hint'),
    placementOpponent: $('placement-opponent'),
    placementOpponentText: $('placement-opponent-text'),
    fleetList: $('fleet-list'),
    fleetProgress: $('fleet-progress'),
    rotate: $('btn-rotate'),
    rotateLabel: $('rotate-label'),
    random: $('btn-random'),
    undo: $('btn-undo'),
    clear: $('btn-clear'),
    ready: $('btn-ready'),
    readyState: $('ready-state'),
    readyWaitText: $('ready-wait-text'),
    ownBoard: $('own-board'),
    enemyBoard: $('enemy-board'),
    enemyPanel: $('enemy-panel'),
    ownBadge: $('own-fleet-badge'),
    enemyBadge: $('enemy-fleet-badge'),
    turnBanner: $('turn-banner'),
    turnTitle: $('turn-title'),
    turnSubtitle: $('turn-subtitle'),
    enemyHint: $('enemy-hint'),
    gameLog: $('game-log'),
    logTurn: $('log-turn'),
    resign: $('btn-resign'),
    leaveGame: $('btn-leave-game'),
    modal: $('modal'),
    modalIcon: $('modal-icon'),
    modalEyebrow: $('modal-eyebrow'),
    modalTitle: $('modal-title'),
    modalText: $('modal-text'),
    modalActions: $('modal-actions'),
    toastRegion: $('toast-region'),
    announcer: $('sr-announcer')
  };

  const state = {
    screen: null,
    phase: 'lobby',
    role: null,
    peer: null,
    conn: null,
    roomId: '',
    inviteUrl: '',
    joinRoom: '',
    peerOpen: false,
    connected: false,
    intentionalClose: false,
    hostAttempts: 0,
    hostServerIndex: 0,
    serverKey: 'c',
    joinTimeout: null,
    connectionTimeout: null,
    createTimeout: null,
    createOpenTimer: null,
    watchdogTimer: null,
    pcDisconnectedSince: 0,
    remoteHello: false,
    ownBoard: null,
    enemyBoard: null,
    ownLayout: null,
    enemyLayout: null,
    orientation: 'h',
    selectedSize: 4,
    ownReady: false,
    opponentReady: false,
    myTurn: false,
    awaitingShot: false,
    lastSentShot: null,
    pendingShot: null,
    lastIncoming: null,
    lastResult: null,
    gameOver: false,
    outcome: null,
    turnNumber: 1,
    log: [],
    rematchRequested: false,
    opponentRematch: false,
    previewKey: '',
    modalDismissible: false,
    lastFocused: null
  };

  /* ========================================================================
     Базовые утилиты
     ======================================================================== */

  function setStatus(kind, text) {
    const allowed = ['offline', 'connecting', 'waiting', 'online', 'error'];
    ui.statusPill.dataset.state = allowed.indexOf(kind) >= 0 ? kind : 'offline';
    ui.statusText.textContent = text;
    ui.statusPill.title = text;
  }

  function showScreen(name) {
    const target = ui.screens[name];
    if (!target) return;
    Object.keys(ui.screens).forEach(function (key) {
      const screen = ui.screens[key];
      const active = key === name;
      screen.hidden = !active;
      screen.classList.toggle('is-active', active);
    });
    const changed = state.screen !== name;
    state.screen = name;
    document.body.dataset.screen = name;
    ui.home.hidden = name === 'lobby';
    window.scrollTo({ top: 0, behavior: 'auto' });
    if (changed) {
      const heading = target.querySelector('h1');
      if (heading) {
        window.setTimeout(function () {
          try { heading.focus({ preventScroll: true }); } catch (error) { /* no-op */ }
        }, 60);
      }
    }
  }

  function announce(text) {
    if (!ui.announcer) return;
    ui.announcer.textContent = '';
    window.setTimeout(function () { ui.announcer.textContent = text; }, 30);
  }

  function toast(message, kind, duration) {
    const types = ['info', 'success', 'error'];
    const type = types.indexOf(kind) >= 0 ? kind : 'info';
    const element = document.createElement('div');
    element.className = 'toast toast--' + type;
    element.textContent = message;
    while (ui.toastRegion.children.length >= 4) {
      ui.toastRegion.removeChild(ui.toastRegion.firstElementChild);
    }
    ui.toastRegion.appendChild(element);
    window.setTimeout(function () {
      element.classList.add('is-leaving');
      window.setTimeout(function () {
        if (element.parentNode) element.parentNode.removeChild(element);
      }, 240);
    }, duration || 3200);
  }

  function clearToasts() {
    ui.toastRegion.replaceChildren();
  }

  function openModal(config) {
    if (ui.modal.hidden) state.lastFocused = document.activeElement;
    const options = config || {};
    ui.modalIcon.dataset.tone = options.tone || 'win';
    const use = ui.modalIcon.querySelector('use');
    if (use) use.setAttribute('href', options.icon || '#i-trophy');
    ui.modalEyebrow.textContent = options.eyebrow || 'Игра завершена';
    ui.modalTitle.textContent = options.title || '';
    ui.modalText.textContent = options.text || '';
    ui.modalActions.replaceChildren();

    (options.actions || []).forEach(function (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn ' + (action.variant === 'primary' ? 'btn--primary' : action.variant === 'soft' ? 'btn--soft' : 'btn--secondary');
      if (action.icon) {
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('class', 'icon');
        const useIcon = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        useIcon.setAttribute('href', action.icon);
        icon.appendChild(useIcon);
        button.appendChild(icon);
      }
      const label = document.createElement('span');
      label.textContent = action.label;
      button.appendChild(label);
      button.addEventListener('click', function () {
        if (action.keepOpen !== true) closeModal();
        if (typeof action.onClick === 'function') action.onClick();
      });
      ui.modalActions.appendChild(button);
    });

    state.modalDismissible = options.dismissible === true;
    ui.modal.hidden = false;
    ui.appShell.inert = true;
    document.body.classList.add('modal-open');
    const first = ui.modalActions.querySelector('button');
    window.setTimeout(function () {
      if (first && !ui.modal.hidden) first.focus({ preventScroll: true });
    }, 40);
  }

  function closeModal() {
    if (ui.modal.hidden) return;
    ui.modal.hidden = true;
    ui.appShell.inert = false;
    document.body.classList.remove('modal-open');
    state.modalDismissible = false;
    const target = state.lastFocused;
    state.lastFocused = null;
    if (target && document.contains(target)) {
      try { target.focus({ preventScroll: true }); } catch (error) { /* no-op */ }
    }
  }

  async function copyText(text) {
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch (error) {
      ok = false;
    }
    if (!ok) {
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '-1000px';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        area.setSelectionRange(0, area.value.length);
        ok = document.execCommand('copy');
        document.body.removeChild(area);
      } catch (error) {
        ok = false;
      }
    }
    return ok;
  }

  function randomRoomId(serverKey) {
    const bytes = new Uint8Array(8);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    }
    let id = ROOM_PREFIX + (serverKey || 'c') + '-';
    for (let i = 0; i < bytes.length; i += 1) {
      id += ROOM_ALPHABET[bytes[i] % ROOM_ALPHABET.length];
    }
    return id;
  }

  function signalingServerForKey(key) {
    return SIGNALING_SERVERS.find(function (server) { return server.key === key; }) || SIGNALING_SERVERS[0];
  }

  function signalingServerForRoom(roomId) {
    const match = String(roomId || '').match(/^bsb-([a-z])-/i);
    if (!match) return SIGNALING_SERVERS[0];
    return signalingServerForKey(match[1].toLowerCase());
  }

  function peerOptionsForServer(server) {
    const options = Object.assign({ debug: PEER_DEBUG }, server.options || {});
    if (server.key !== 'c') {
      options.config = {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun.cloudflare.com:3478' }
        ]
      };
    }
    return options;
  }

  function buildInviteUrl(roomId) {
    try {
      const url = new URL(window.location.href);
      url.search = '';
      url.hash = '';
      url.searchParams.set('room', roomId);
      return url.toString();
    } catch (error) {
      return window.location.href.split('?')[0] + '?room=' + encodeURIComponent(roomId);
    }
  }

  function extractRoomId(raw) {
    let value = String(raw || '').trim();
    if (!value) return '';
    const directMatch = value.match(/bsb-[a-z0-9_-]{3,}/i);
    if (directMatch) return directMatch[0];
    try {
      const url = new URL(value, window.location.href);
      const fromQuery = url.searchParams.get('room');
      if (fromQuery) return fromQuery.trim();
      if (url.hash) {
        const hash = url.hash.replace(/^#/, '');
        const hashParams = new URLSearchParams(hash);
        const fromHash = hashParams.get('room');
        if (fromHash) return fromHash.trim();
      }
    } catch (error) {
      // Ниже попробуем обработать как обычную строку.
    }
    return value.replace(/\s+/g, '');
  }

  function isValidRoomId(id) {
    return typeof id === 'string' && /^[A-Za-z0-9_-]{3,64}$/.test(id);
  }

  function getInvitedRoom() {
    try {
      const url = new URL(window.location.href);
      const fromQuery = url.searchParams.get('room');
      if (fromQuery) return fromQuery.trim();
      if (url.hash) {
        const params = new URLSearchParams(url.hash.replace(/^#/, ''));
        const fromHash = params.get('room');
        if (fromHash) return fromHash.trim();
      }
    } catch (error) {
      // no-op
    }
    return '';
  }

  function vibrate(pattern) {
    try {
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (error) {
      // no-op
    }
  }

  function plural(count, one, few, many) {
    const value = Math.abs(count) % 100;
    const last = value % 10;
    if (value > 10 && value < 20) return many;
    if (last === 1) return one;
    if (last >= 2 && last <= 4) return few;
    return many;
  }

  /* ========================================================================
     Сетевая часть
     ======================================================================== */

  function clearNetTimeouts() {
    [state.joinTimeout, state.connectionTimeout, state.createOpenTimer, state.createTimeout].forEach(function (timer) {
      if (timer) window.clearTimeout(timer);
    });
    if (state.watchdogTimer) {
      window.clearInterval(state.watchdogTimer);
      state.watchdogTimer = null;
    }
    state.joinTimeout = null;
    state.connectionTimeout = null;
    state.createOpenTimer = null;
    state.createTimeout = null;
    state.pcDisconnectedSince = 0;
  }

  function destroyNetwork() {
    clearNetTimeouts();
    const conn = state.conn;
    const peer = state.peer;
    state.conn = null;
    state.peer = null;
    state.connected = false;
    state.peerOpen = false;
    state.intentionalClose = true;
    if (conn) {
      try { conn.close(); } catch (error) { /* no-op */ }
    }
    if (peer) {
      try { peer.destroy(); } catch (error) { /* no-op */ }
    }
    state.intentionalClose = false;
    state.role = null;
  }

  /*
   * PeerJS не во всех браузерах закрывает DataConnection при обрыве ICE,
   * поэтому дополнительно следим за состоянием RTCPeerConnection.
   */
  function startConnectionWatchdog() {
    if (state.watchdogTimer) window.clearInterval(state.watchdogTimer);
    state.pcDisconnectedSince = 0;
    state.watchdogTimer = window.setInterval(function () {
      if (!state.connected || !state.conn) return;
      const pc = state.conn.peerConnection;
      if (!pc) return;
      const connectionState = pc.connectionState;
      const iceState = pc.iceConnectionState;
      if (
        connectionState === 'failed' ||
        connectionState === 'closed' ||
        iceState === 'failed' ||
        iceState === 'closed' ||
        pc.signalingState === 'closed'
      ) {
        handleConnectionClosed('Соперник отключился или сеть прервала прямой канал. Партия остановлена.');
        return;
      }
      if (connectionState === 'disconnected' || iceState === 'disconnected') {
        if (!state.pcDisconnectedSince) state.pcDisconnectedSince = Date.now();
        if (Date.now() - state.pcDisconnectedSince > 15000) {
          handleConnectionClosed('Прямой канал с соперником перестал отвечать. Партия остановлена.');
        }
      } else {
        state.pcDisconnectedSince = 0;
      }
    }, 4000);
  }

  function sendMessage(payload) {
    if (!state.conn || !state.conn.open) return false;
    try {
      state.conn.send(Object.assign({
        v: PROTOCOL_VERSION,
        ts: Date.now()
      }, payload));
      return true;
    } catch (error) {
      console.warn('[battleship] send failed', error);
      return false;
    }
  }

  function resetCreateScreen() {
    ui.roomId.textContent = '······';
    ui.roomId.classList.add('is-loading');
    ui.copyId.disabled = true;
    ui.copyLink.disabled = true;
    ui.share.hidden = !navigator.share;
    ui.share.disabled = true;
    ui.waitingCard.hidden = true;
    ui.createError.hidden = true;
    ui.createError.textContent = '';
    ui.createRetry.hidden = true;
    ui.createTitle.textContent = 'Создаём комнату…';
    ui.createText.textContent = 'Соединяемся с сигнальным сервером PeerJS.';
  }

  function resetJoinScreen() {
    ui.joinError.hidden = true;
    ui.joinError.textContent = '';
    ui.joinLoader.hidden = true;
    ui.joinLoaderText.textContent = 'Ищем комнату в сети…';
    ui.joinInput.disabled = false;
    ui.paste.disabled = false;
    ui.connect.disabled = false;
    ui.connect.querySelector('span').textContent = 'Подключиться';
    ui.inviteNote.hidden = true;
  }

  function setJoinBusy(busy, text) {
    ui.joinInput.disabled = busy;
    ui.paste.disabled = busy;
    ui.connect.disabled = busy;
    ui.connect.querySelector('span').textContent = busy ? 'Подключаемся…' : 'Подключиться';
    ui.joinLoader.hidden = !busy;
    if (text) ui.joinLoaderText.textContent = text;
  }

  function showJoinError(message) {
    ui.joinError.textContent = message;
    ui.joinError.hidden = false;
  }

  function showCreateError(message) {
    clearNetTimeouts();
    state.phase = 'host-error';
    state.peerOpen = false;
    ui.createTitle.textContent = 'Не удалось создать комнату';
    ui.createText.textContent = message;
    ui.roomId.textContent = '——';
    ui.roomId.classList.remove('is-loading');
    ui.copyId.disabled = true;
    ui.copyLink.disabled = true;
    ui.share.disabled = true;
    ui.waitingCard.hidden = true;
    ui.createError.textContent = message;
    ui.createError.hidden = false;
    ui.createRetry.hidden = false;
    setStatus('error', 'Ошибка соединения');
  }

  function peerErrorMessage(type) {
    const messages = {
      'browser-incompatible': 'Этот браузер не поддерживает WebRTC. Откройте игру в актуальном Chrome, Safari или Firefox.',
      'invalid-id': 'ID комнаты содержит недопустимые символы.',
      'invalid-key': 'Публичный сигнальный сервер отклонил ключ. Попробуйте позже.',
      'network': 'Нет связи с сигнальным сервером PeerJS. Проверьте интернет и попробуйте ещё раз.',
      'peer-unavailable': 'Комната не найдена. Проверьте ID: возможно, соперник закрыл игру или ошибся в ссылке.',
      'server-error': 'Сигнальный сервер PeerJS временно недоступен. Попробуйте через минуту.',
      'socket-error': 'Соединение с сигнальным сервером прервалось. Проверьте интернет.',
      'socket-closed': 'Сигнальное соединение закрыто. Попробуйте ещё раз.',
      'ssl-unavailable': 'Не удалось установить защищённое соединение. Откройте игру по HTTPS.',
      'unavailable-id': 'Этот ID комнаты уже занят. Создайте новую комнату.',
      'webrtc': 'WebRTC не смог установить соединение. Попробуйте другую сеть или отключите VPN.'
    };
    return messages[type] || 'Не удалось установить соединение. Попробуйте ещё раз.';
  }

  function startHosting() {
    closeModal();
    destroyNetwork();
    resetRoundState();
    state.role = 'host';
    state.phase = 'creating';
    state.hostAttempts = 0;
    state.hostServerIndex = 0;
    state.serverKey = SIGNALING_SERVERS[0].key;
    state.roomId = '';
    state.inviteUrl = '';
    resetCreateScreen();
    showScreen('create');
    setStatus('connecting', 'Создаём комнату');
    createHostPeer();
  }

  function switchHostServer() {
    if (state.role !== 'host' || state.connected || state.phase !== 'creating') return;
    const nextIndex = state.hostServerIndex + 1;
    if (nextIndex >= SIGNALING_SERVERS.length) {
      showCreateError('Не удалось подключиться ни к облаку PeerJS, ни к резервным серверам. Проверьте интернет или отключите VPN.');
      return;
    }
    const previous = state.peer;
    state.peer = null;
    if (previous) {
      try { previous.destroy(); } catch (error) { /* no-op */ }
    }
    if (state.createOpenTimer) {
      window.clearTimeout(state.createOpenTimer);
      state.createOpenTimer = null;
    }
    state.hostServerIndex = nextIndex;
    state.serverKey = SIGNALING_SERVERS[nextIndex].key;
    state.hostAttempts = 0;
    state.peerOpen = false;
    state.phase = 'creating';
    ui.roomId.textContent = '······';
    ui.roomId.classList.add('is-loading');
    ui.createError.hidden = true;
    ui.createRetry.hidden = true;
    ui.createTitle.textContent = 'Облако PeerJS недоступно';
    ui.createText.textContent = 'Пробуем резервный сигнальный сервер: ' + SIGNALING_SERVERS[nextIndex].label + '…';
    setStatus('connecting', 'Резервный сервер');
    if (nextIndex === 1) {
      toast('Облако PeerJS недоступно в этой сети. Автоматически пробуем резервный сервер.', 'info', 4500);
    }
    state.createTimeout = window.setTimeout(createHostPeer, 120);
  }

  function createHostPeer() {
    if (state.role !== 'host') return;
    const previous = state.peer;
    if (previous) {
      try { previous.destroy(); } catch (error) { /* no-op */ }
    }
    state.conn = null;
    state.connected = false;
    state.peerOpen = false;
    state.phase = 'creating';
    const server = signalingServerForKey(state.serverKey);
    state.roomId = randomRoomId(server.key);
    ui.roomId.textContent = '······';
    ui.roomId.classList.add('is-loading');
    if (server.key === 'c') {
      setStatus('connecting', 'Создаём комнату');
    } else {
      setStatus('connecting', 'Резервный сервер');
    }

    let peer;
    try {
      peer = new PeerCtor(state.roomId, peerOptionsForServer(server));
    } catch (error) {
      if (state.hostServerIndex < SIGNALING_SERVERS.length - 1) {
        switchHostServer();
      } else {
        showCreateError('Браузер не позволил создать P2P-соединение. Проверьте настройки WebRTC.');
      }
      return;
    }
    state.peer = peer;

    state.createOpenTimer = window.setTimeout(function () {
      if (state.peer === peer && !state.peerOpen && state.phase === 'creating') {
        if (state.hostServerIndex < SIGNALING_SERVERS.length - 1) {
          switchHostServer();
        } else {
          showCreateError('Сигнальный сервер не отвечает. Проверьте интернет и попробуйте снова.');
        }
      }
    }, 10000);

    peer.on('open', function (id) {
      if (state.peer !== peer) return;
      window.clearTimeout(state.createOpenTimer);
      state.createOpenTimer = null;
      state.peerOpen = true;
      state.phase = 'waiting';
      state.hostAttempts = 0;
      state.roomId = id;
      state.inviteUrl = buildInviteUrl(id);
      ui.roomId.textContent = id;
      ui.roomId.classList.remove('is-loading');
      ui.copyId.disabled = false;
      ui.copyLink.disabled = false;
      ui.share.disabled = false;
      ui.waitingCard.hidden = false;
      ui.createError.hidden = true;
      ui.createRetry.hidden = true;
      ui.createTitle.textContent = 'Комната готова';
      if (server.key === 'c') {
        ui.createText.textContent = 'Отправьте ID или ссылку сопернику. Как только он подключится, вы перейдёте к расстановке флота.';
      } else {
        ui.createText.textContent = 'Облако PeerJS недоступно в этой сети, поэтому используется ' + server.label + '. Отправьте ID или ссылку сопернику — второй игрок подключится к тому же серверу автоматически.';
      }
      setStatus('waiting', 'Ждём соперника');
    });

    peer.on('connection', function (connection) {
      if (state.peer !== peer) return;
      handleIncomingConnection(connection);
    });

    peer.on('error', function (error) {
      if (state.peer !== peer) return;
      handleHostPeerError(error, peer);
    });

    peer.on('disconnected', function () {
      if (state.peer !== peer || state.connected) return;
      setStatus('connecting', 'Переподключаемся…');
      try {
        peer.reconnect();
      } catch (error) {
        showCreateError('Связь с сигнальным сервером потеряна. Попробуйте создать комнату снова.');
      }
    });

    peer.on('close', function () {
      if (state.peer !== peer || state.connected || state.intentionalClose) return;
      if (state.phase === 'waiting' || state.phase === 'creating') {
        showCreateError('Комната закрылась. Создайте новую.');
      }
    });
  }

  function handleHostPeerError(error, peer) {
    const type = error && error.type ? error.type : 'unknown';
    console.warn('[battleship] host peer error', type, error && error.message);

    if (type === 'unavailable-id' && state.hostAttempts < 3 && !state.connected) {
      state.hostAttempts += 1;
      try { peer.destroy(); } catch (destroyError) { /* no-op */ }
      if (state.peer === peer) state.peer = null;
      createHostPeer();
      return;
    }

    if (
      !state.connected &&
      state.phase === 'creating' &&
      !state.peerOpen &&
      SIGNALING_FALLBACK_ERRORS.indexOf(type) >= 0 &&
      state.hostServerIndex < SIGNALING_SERVERS.length - 1
    ) {
      switchHostServer();
      return;
    }

    if (state.connected) return;
    if (state.phase === 'lobby') return;
    showCreateError(peerErrorMessage(type));
    if (state.peer === peer) {
      state.peer = null;
      try { peer.destroy(); } catch (destroyError) { /* no-op */ }
    }
  }

  function handleIncomingConnection(connection) {
    if (state.role !== 'host') {
      try { connection.close(); } catch (error) { /* no-op */ }
      return;
    }
    if (state.connected || state.conn) {
      try { connection.close(); } catch (error) { /* no-op */ }
      return;
    }
    if (state.phase !== 'waiting' && state.phase !== 'connecting-peer') {
      try { connection.close(); } catch (error) { /* no-op */ }
      return;
    }
    state.conn = connection;
    state.phase = 'connecting-peer';
    setStatus('connecting', 'Гость подключается');
    state.connectionTimeout = window.setTimeout(function () {
      if (state.conn === connection && !state.connected) {
        try { connection.close(); } catch (error) { /* no-op */ }
        state.conn = null;
        state.phase = 'waiting';
        setStatus('waiting', 'Ждём соперника');
        toast('Не удалось установить канал с гостем. Ждём новое подключение.', 'error');
      }
    }, 15000);
    attachConnection(connection);
  }

  function openJoinScreen(options) {
    closeModal();
    destroyNetwork();
    resetRoundState();
    state.role = 'guest';
    state.phase = 'join-entry';
    resetJoinScreen();
    showScreen('join');
    setStatus('offline', 'Не подключено');
    const invited = options && options.room;
    if (invited) {
      ui.joinInput.value = invited;
      ui.inviteRoomId.textContent = invited;
      ui.inviteNote.hidden = false;
      state.phase = 'join-entry';
    }
  }

  function startJoining(rawRoom) {
    const roomId = extractRoomId(rawRoom);
    if (!isValidRoomId(roomId)) {
      showJoinError('ID выглядит некорректно. Вставьте ID комнаты или полную ссылку с параметром ?room=…');
      return;
    }
    if (state.phase === 'joining') return;

    destroyNetwork();
    closeModal();
    resetRoundState();
    state.role = 'guest';
    state.phase = 'joining';
    state.joinRoom = roomId;
    const server = signalingServerForRoom(roomId);
    state.serverKey = server.key;
    ui.joinInput.value = roomId;
    ui.joinError.hidden = true;
    ui.inviteNote.hidden = true;
    setJoinBusy(true, server.key === 'c' ? 'Ищем комнату в сети…' : 'Подключаемся через ' + server.label + '…');
    setStatus('connecting', 'Подключаемся');

    let peer;
    try {
      peer = new PeerCtor(peerOptionsForServer(server));
    } catch (error) {
      setJoinBusy(false);
      showJoinError('Браузер не позволил создать P2P-соединение. Проверьте настройки WebRTC.');
      setStatus('error', 'Ошибка');
      return;
    }
    state.peer = peer;

    state.joinTimeout = window.setTimeout(function () {
      if (state.peer === peer && state.phase === 'joining' && !state.connected) {
        failJoining('Не удалось подключиться за 20 секунд. Проверьте ID и интернет соперника.');
      }
    }, 20000);

    peer.on('open', function () {
      if (state.peer !== peer || state.phase !== 'joining') return;
      state.peerOpen = true;
      setJoinBusy(true, 'Сигнальный сервер на связи. Устанавливаем прямой канал…');
      connectToHost(peer, roomId);
    });

    peer.on('error', function (error) {
      if (state.peer !== peer) return;
      if (state.connected) return;
      console.warn('[battleship] join peer error', error && error.type, error && error.message);
      if (state.phase === 'joining') {
        failJoining(peerErrorMessage(error && error.type));
      }
    });

    peer.on('disconnected', function () {
      if (state.peer !== peer || state.connected) return;
      setJoinBusy(true, 'Переподключаемся к сигнальному серверу…');
      try {
        peer.reconnect();
      } catch (error) {
        failJoining('Связь с сигнальным сервером потеряна. Попробуйте снова.');
      }
    });

    peer.on('close', function () {
      if (state.peer !== peer || state.intentionalClose || state.connected) return;
      if (state.phase === 'joining') {
        failJoining('Соединение закрылось до установки канала. Попробуйте ещё раз.');
      }
    });
  }

  function connectToHost(peer, roomId) {
    let connection;
    try {
      connection = peer.connect(roomId, {
        reliable: true,
        serialization: 'json',
        metadata: { game: 'battleship', version: PROTOCOL_VERSION }
      });
    } catch (error) {
      failJoining('Не удалось начать подключение. Проверьте ID комнаты.');
      return;
    }
    state.conn = connection;
    setJoinBusy(true, 'Ищем комнату в сети…');

    state.connectionTimeout = window.setTimeout(function () {
      if (state.peer === peer && state.phase === 'joining' && !state.connected) {
        failJoining('Прямой канал не открылся. Возможно, соперник закрыл игру или сеть блокирует WebRTC.');
      }
    }, 18000);

    attachConnection(connection);
  }

  function failJoining(message) {
    if (state.phase !== 'joining' && state.phase !== 'join-entry') return;
    clearNetTimeouts();
    const peer = state.peer;
    state.peer = null;
    state.conn = null;
    state.connected = false;
    state.peerOpen = false;
    state.phase = 'join-entry';
    if (peer) {
      try { peer.destroy(); } catch (error) { /* no-op */ }
    }
    setJoinBusy(false);
    showJoinError(message);
    setStatus('error', 'Ошибка подключения');
  }

  function attachConnection(connection) {
    let opened = false;

    function handleOpen() {
      if (opened) return;
      opened = true;
      if (state.conn !== connection) return;
      onConnectionOpen();
    }

    connection.on('open', handleOpen);

    connection.on('data', function (data) {
      if (state.conn !== connection) return;
      handleIncomingData(data);
    });

    connection.on('close', function () {
      if (state.conn !== connection) return;
      state.conn = null;
      if (state.connected) {
        handleConnectionClosed();
      } else if (state.phase === 'joining') {
        failJoining('Соединение не установилось. Проверьте, что игра у соперника открыта.');
      } else if (state.phase === 'connecting-peer') {
        state.phase = 'waiting';
        setStatus('waiting', 'Ждём соперника');
        toast('Подключение не удалось. Можно попробовать ещё раз.', 'error');
      }
    });

    connection.on('error', function (error) {
      if (state.conn !== connection) return;
      console.warn('[battleship] data connection error', error);
      if (!state.connected && state.phase === 'joining') {
        failJoining(peerErrorMessage(error && error.type));
      }
    });

    if (connection.open) {
      window.setTimeout(handleOpen, 0);
    }
  }

  function onConnectionOpen() {
    if (state.connected) return;
    clearNetTimeouts();
    state.connected = true;
    state.peerOpen = true;
    state.phase = 'placement';
    state.remoteHello = false;
    setJoinBusy(false);
    setStatus('online', 'Соперник на связи');
    clearToasts();
    sendMessage({ type: 'hello', role: state.role });
    startConnectionWatchdog();
    initPlacement();
    toast('Соперник подключён. Расставьте флот.', 'success');
    announce('Соперник подключён. Переходим к расстановке флота.');
  }

  function handleConnectionClosed(customMessage) {
    if (state.phase === 'lobby' || state.phase === 'join-entry' || state.phase === 'joining' || state.phase === 'disconnected') return;
    const wasGame = state.phase === 'playing' || state.phase === 'over';
    state.connected = false;
    state.phase = 'disconnected';
    state.gameOver = true;
    state.myTurn = false;
    state.awaitingShot = false;
    setStatus('error', 'Связь потеряна');
    if (wasGame) {
      updateTurnUI();
      updateGameMeta();
    }
    destroyNetwork();
    openModal({
      tone: 'alert',
      icon: '#i-wifi',
      eyebrow: 'Соединение',
      title: 'Связь потеряна',
      text: customMessage || (wasGame
        ? 'Соперник отключился или сеть прервала прямой канал. Партия остановлена.'
        : 'Соперник отключился до начала боя. Создайте новую комнату, чтобы сыграть ещё раз.'),
      actions: [{ label: 'В лобби', icon: '#i-home', variant: 'primary', onClick: goToLobby }]
    });
  }

  function handleProtocolFailure(message) {
    if (state.phase === 'lobby') return;
    const peer = state.peer;
    state.phase = 'disconnected';
    state.connected = false;
    state.gameOver = true;
    setStatus('error', 'Ошибка протокола');
    destroyNetwork();
    if (peer) {
      try { peer.destroy(); } catch (error) { /* no-op */ }
    }
    openModal({
      tone: 'alert',
      icon: '#i-alert',
      eyebrow: 'Ошибка',
      title: 'Сессия остановлена',
      text: message || 'Получены некорректные игровые данные. Начните новую игру.',
      actions: [{ label: 'В лобби', icon: '#i-home', variant: 'primary', onClick: goToLobby }]
    });
  }

  function handleIncomingData(data) {
    if (!data || typeof data !== 'object') return;
    if (data.v !== PROTOCOL_VERSION || typeof data.type !== 'string') return;
    switch (data.type) {
      case 'hello':
        state.remoteHello = true;
        break;
      case 'ready':
        handleReadyMessage(data);
        break;
      case 'shot':
        handleShotMessage(data);
        break;
      case 'shot-result':
        handleShotResultMessage(data);
        break;
      case 'resign':
        handleResignMessage();
        break;
      case 'rematch-request':
        handleRematchRequest();
        break;
      case 'rematch-accept':
        handleRematchAccept();
        break;
      case 'rematch-decline':
        handleRematchDecline();
        break;
      case 'leave':
        handleOpponentLeave();
        break;
      default:
        break;
    }
  }

  /* ========================================================================
     Лобби, копирование, выход
     ======================================================================== */

  function goToLobby() {
    destroyNetwork();
    closeModal();
    resetRoundState();
    state.phase = 'lobby';
    state.role = null;
    state.roomId = '';
    state.inviteUrl = '';
    state.joinRoom = '';
    setStatus('offline', 'Не подключено');
    ui.home.hidden = true;
    showScreen('lobby');
    setJoinBusy(false);
    resetJoinScreen();
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has('room')) {
        url.searchParams.delete('room');
        window.history.replaceState({}, '', url.pathname + (url.search ? url.search : '') + url.hash);
      }
    } catch (error) {
      // no-op
    }
  }

  function confirmExit() {
    if (state.screen === 'lobby') return;
    if (state.screen === 'join' && state.phase === 'join-entry') {
      goToLobby();
      return;
    }
    if (state.screen === 'create' && (state.phase === 'host-error' || state.phase === 'creating' || state.phase === 'waiting')) {
      if (!state.connected) {
        openModal({
          tone: 'alert',
          icon: '#i-door',
          eyebrow: 'Выход',
          title: 'Закрыть комнату?',
          text: 'ID перестанет действовать, а соперник не сможет подключиться.',
          actions: [
            { label: 'Остаться', variant: 'secondary', onClick: function () {} },
            { label: 'Закрыть комнату', variant: 'primary', onClick: goToLobby }
          ]
        });
        return;
      }
    }
    if (state.screen === 'join' && state.phase === 'joining') {
      openModal({
        tone: 'alert',
        icon: '#i-door',
        eyebrow: 'Выход',
        title: 'Прервать подключение?',
        text: 'Попытка подключения к комнате будет отменена.',
        actions: [
          { label: 'Продолжить', variant: 'secondary', onClick: function () {} },
          { label: 'Прервать', variant: 'primary', onClick: goToLobby }
        ]
      });
      return;
    }
    if (state.connected || state.phase === 'placement' || state.phase === 'playing' || state.phase === 'over') {
      openModal({
        tone: 'alert',
        icon: '#i-door',
        eyebrow: 'Выход',
        title: state.phase === 'playing' ? 'Покинуть бой?' : state.phase === 'placement' ? 'Покинуть расстановку?' : 'Вернуться в лобби?',
        text: state.phase === 'playing'
          ? 'Текущая партия будет прервана, а соперник останется без продолжения.'
          : 'Соединение с соперником будет закрыто.',
        actions: [
          { label: 'Остаться', variant: 'secondary', onClick: function () {} },
          { label: 'Выйти', variant: 'primary', onClick: function () { leaveGameAndLobby(); } }
        ]
      });
      return;
    }
    goToLobby();
  }

  function leaveGameAndLobby() {
    if (state.phase === 'playing' || state.phase === 'placement' || state.phase === 'over') {
      sendMessage({ type: 'leave' });
    }
    window.setTimeout(goToLobby, 40);
  }

  function handleOpponentLeave() {
    if (state.phase === 'lobby' || state.phase === 'join-entry') return;
    state.connected = false;
    state.phase = 'disconnected';
    state.gameOver = true;
    state.myTurn = false;
    state.awaitingShot = false;
    setStatus('offline', 'Соперник вышел');
    destroyNetwork();
    if (state.screen === 'game') {
      updateTurnUI();
      updateGameMeta();
    }
    openModal({
      tone: 'info',
      icon: '#i-door',
      eyebrow: 'Соединение',
      title: 'Соперник вышел',
      text: 'Он покинул игру. Можно вернуться в лобби и создать новую комнату.',
      actions: [{ label: 'В лобби', icon: '#i-home', variant: 'primary', onClick: goToLobby }]
    });
  }

  /* ========================================================================
     Расстановка
     ======================================================================== */

  function resetRoundState() {
    state.ownBoard = null;
    state.enemyBoard = null;
    state.ownLayout = null;
    state.enemyLayout = null;
    state.orientation = 'h';
    state.selectedSize = 4;
    state.ownReady = false;
    state.opponentReady = false;
    state.myTurn = false;
    state.awaitingShot = false;
    state.lastSentShot = null;
    state.pendingShot = null;
    state.lastIncoming = null;
    state.lastResult = null;
    state.gameOver = false;
    state.outcome = null;
    state.turnNumber = 1;
    state.log = [];
    state.rematchRequested = false;
    state.opponentRematch = false;
    state.previewKey = '';
    state.remoteHello = false;
  }

  function initPlacement() {
    state.ownBoard = Engine.createBoard();
    state.ownLayout = null;
    state.enemyBoard = null;
    state.enemyLayout = null;
    state.orientation = 'h';
    state.selectedSize = 4;
    state.ownReady = false;
    state.opponentReady = false;
    state.myTurn = false;
    state.awaitingShot = false;
    state.lastSentShot = null;
    state.pendingShot = null;
    state.lastIncoming = null;
    state.lastResult = null;
    state.gameOver = false;
    state.outcome = null;
    state.turnNumber = 1;
    state.log = [];
    state.rematchRequested = false;
    state.opponentRematch = false;
    state.phase = 'placement';
    renderPlacement();
    updatePlacementOpponent();
    updateRotateLabel();
    showScreen('placement');
    setStatus('online', 'Соперник на связи');
    announce('Расставьте флот. Выберите корабль и коснитесь клетки.');
  }

  function requiredCount(size) {
    return Engine.FLEET_SIZES.filter(function (item) { return item === size; }).length;
  }

  function placedCount(size) {
    if (!state.ownBoard) return 0;
    return state.ownBoard.ships.filter(function (ship) { return ship.size === size; }).length;
  }

  function availableCount(size) {
    return requiredCount(size) - placedCount(size);
  }

  function firstAvailableSize() {
    const sizes = [4, 3, 2, 1];
    for (let i = 0; i < sizes.length; i += 1) {
      if (availableCount(sizes[i]) > 0) return sizes[i];
    }
    return null;
  }

  function nextAvailableSizeAfter(size) {
    if (size && availableCount(size) > 0) return size;
    return firstAvailableSize();
  }

  function createShipGlyph(size) {
    const glyph = document.createElement('span');
    glyph.className = 'ship-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < size; i += 1) glyph.appendChild(document.createElement('i'));
    return glyph;
  }

  function renderFleet() {
    ui.fleetList.replaceChildren();
    [4, 3, 2, 1].forEach(function (size) {
      const placed = placedCount(size);
      const total = requiredCount(size);
      const complete = placed >= total;
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'fleet-item';
      item.dataset.size = String(size);
      item.disabled = state.ownReady;
      if (complete) item.classList.add('is-complete');
      if (!complete && state.selectedSize === size) item.classList.add('is-selected');
      item.setAttribute('aria-pressed', String(!complete && state.selectedSize === size));

      const iconWrap = document.createElement('span');
      iconWrap.className = 'fleet-item__icon';
      iconWrap.appendChild(createShipGlyph(size));
      item.appendChild(iconWrap);

      const meta = document.createElement('span');
      meta.className = 'fleet-item__meta';
      const name = document.createElement('strong');
      name.textContent = Engine.SHIP_NAMES[size];
      const detail = document.createElement('span');
      detail.textContent = size + ' ' + plural(size, 'клетка', 'клетки', 'клеток') + ' · осталось ' + Math.max(0, total - placed);
      meta.appendChild(name);
      meta.appendChild(detail);
      item.appendChild(meta);

      const count = document.createElement('span');
      count.className = 'fleet-item__count';
      count.textContent = placed + '/' + total;
      item.appendChild(count);

      ui.fleetList.appendChild(item);
    });
    ui.fleetProgress.textContent = (state.ownBoard ? state.ownBoard.ships.length : 0) + ' / ' + MAX_SHIPS;
  }

  function shipSegmentClasses(cell, ship) {
    if (!ship) return [];
    const classes = [];
    if (ship.size === 1) {
      classes.push('ship-single');
      return classes;
    }
    const index = ship.cells.findIndex(function (item) {
      return item.x === cell.x && item.y === cell.y;
    });
    classes.push(ship.horizontal ? 'ship-h' : 'ship-v');
    if (index === 0) classes.push('ship-start');
    if (index === ship.cells.length - 1) classes.push('ship-end');
    return classes;
  }

  function appendColumnLabels(fragment) {
    const corner = document.createElement('div');
    corner.className = 'board__corner';
    corner.setAttribute('aria-hidden', 'true');
    fragment.appendChild(corner);
    for (let x = 0; x < Engine.BOARD_SIZE; x += 1) {
      const label = document.createElement('div');
      label.className = 'board__label board__label--col';
      label.textContent = String.fromCharCode(65 + x);
      label.setAttribute('aria-hidden', 'true');
      fragment.appendChild(label);
    }
  }

  function renderPlacementBoard() {
    if (!state.ownBoard) return;
    const fragment = document.createDocumentFragment();
    appendColumnLabels(fragment);
    for (let y = 0; y < Engine.BOARD_SIZE; y += 1) {
      const rowLabel = document.createElement('div');
      rowLabel.className = 'board__label board__label--row';
      rowLabel.textContent = String(y + 1);
      rowLabel.setAttribute('aria-hidden', 'true');
      fragment.appendChild(rowLabel);
      for (let x = 0; x < Engine.BOARD_SIZE; x += 1) {
        const ship = Engine.getShipAt(state.ownBoard, x, y);
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'cell';
        cell.dataset.x = String(x);
        cell.dataset.y = String(y);
        cell.disabled = state.ownReady;
        const label = Engine.coordLabel(x, y);
        if (ship) {
          cell.classList.add('cell--ship');
          shipSegmentClasses({ x: x, y: y }, ship).forEach(function (name) { cell.classList.add(name); });
        }
        cell.setAttribute('aria-label', label + (ship ? ', ' + Engine.SHIP_NAMES[ship.size] : ', вода'));
        fragment.appendChild(cell);
      }
    }
    ui.placementBoard.replaceChildren(fragment);
    ui.placementBoard.classList.toggle('is-locked', state.ownReady);
    const placed = state.ownBoard.ships.length;
    ui.placementCounter.textContent = placed + ' / ' + MAX_SHIPS;
    ui.fleetProgress.textContent = placed + ' / ' + MAX_SHIPS;
  }

  function updateRotateLabel() {
    ui.rotateLabel.textContent = state.orientation === 'h' ? 'Горизонтально' : 'Вертикально';
    ui.rotate.title = state.orientation === 'h' ? 'Повернуть вертикально (R)' : 'Повернуть горизонтально (R)';
  }

  function updatePlacementButtons() {
    const placed = state.ownBoard ? state.ownBoard.ships.length : 0;
    ui.ready.disabled = state.ownReady || placed !== MAX_SHIPS || !state.connected;
    ui.random.disabled = state.ownReady;
    ui.undo.disabled = state.ownReady || placed === 0;
    ui.clear.disabled = state.ownReady || placed === 0;
    ui.rotate.disabled = state.ownReady;
    ui.ready.hidden = state.ownReady;
    ui.readyState.hidden = !state.ownReady;
  }

  function updatePlacementCounter() {
    const placed = state.ownBoard ? state.ownBoard.ships.length : 0;
    ui.placementCounter.textContent = placed + ' / ' + MAX_SHIPS;
    ui.fleetProgress.textContent = placed + ' / ' + MAX_SHIPS;
  }

  function updatePlacementOpponent() {
    if (state.opponentReady) {
      ui.placementOpponent.dataset.state = 'ready';
      ui.placementOpponentText.textContent = state.ownReady ? 'Соперник готов' : 'Соперник уже готов';
    } else {
      ui.placementOpponent.dataset.state = 'waiting';
      ui.placementOpponentText.textContent = 'Соперник готовится';
    }
    if (state.ownReady) {
      ui.readyWaitText.textContent = state.opponentReady ? 'Начинаем бой…' : 'Ждём готовности соперника…';
    }
  }

  function renderPlacement() {
    renderFleet();
    renderPlacementBoard();
    updatePlacementButtons();
    updatePlacementCounter();
    updatePlacementOpponent();
    if (state.ownBoard && state.ownBoard.ships.length === MAX_SHIPS) {
      ui.placementHint.innerHTML = 'Флот готов. Нажмите <strong>«Флот готов — в бой»</strong>.';
    } else {
      ui.placementHint.textContent = 'Выберите корабль и коснитесь клетки. Корабли не могут касаться друг друга даже углами.';
    }
  }

  function placementAnchor(x, y, size, orientation) {
    const horizontal = orientation === 'h';
    const anchorX = horizontal ? Math.min(x, Engine.BOARD_SIZE - size) : x;
    const anchorY = horizontal ? y : Math.min(y, Engine.BOARD_SIZE - size);
    return { x: Math.max(0, anchorX), y: Math.max(0, anchorY), horizontal: horizontal };
  }

  function previewPlacement(x, y) {
    if (!state.ownBoard || state.ownReady) return;
    const size = state.selectedSize;
    if (!size || availableCount(size) <= 0) return;
    const anchor = placementAnchor(x, y, size, state.orientation);
    const key = anchor.x + ':' + anchor.y + ':' + size + ':' + state.orientation;
    if (key === state.previewKey) return;
    clearPlacementPreview();
    state.previewKey = key;
    const cells = Engine.cellsForShip(anchor.x, anchor.y, size, anchor.horizontal);
    const valid = Engine.canPlace(state.ownBoard, size, anchor.x, anchor.y, anchor.horizontal);
    cells.forEach(function (cell) {
      const element = ui.placementBoard.querySelector('[data-x="' + cell.x + '"][data-y="' + cell.y + '"]');
      if (element) element.classList.add(valid ? 'cell--preview' : 'cell--preview-invalid');
    });
  }

  function clearPlacementPreview() {
    if (!ui.placementBoard) return;
    Array.prototype.forEach.call(
      ui.placementBoard.querySelectorAll('.cell--preview, .cell--preview-invalid'),
      function (cell) {
        cell.classList.remove('cell--preview', 'cell--preview-invalid');
      }
    );
    state.previewKey = '';
  }

  function handlePlacementClick(event) {
    if (!state.ownBoard || state.ownReady || !state.connected) return;
    const cell = event.target.closest('.cell');
    if (!cell || !ui.placementBoard.contains(cell)) return;
    const x = Number(cell.dataset.x);
    const y = Number(cell.dataset.y);
    let size = state.selectedSize;
    if (!size || availableCount(size) <= 0) {
      size = firstAvailableSize();
      state.selectedSize = size;
    }
    if (!size) {
      toast('Все 10 кораблей уже расставлены.', 'info');
      return;
    }

    const anchor = placementAnchor(x, y, size, state.orientation);
    if (!Engine.canPlace(state.ownBoard, size, anchor.x, anchor.y, anchor.horizontal)) {
      ui.placementHint.textContent = 'Здесь нельзя: корабль выходит за поле или касается другого. Попробуйте другую клетку или поверните корабль.';
      ui.placementBoard.classList.remove('is-shaking');
      void ui.placementBoard.offsetWidth;
      ui.placementBoard.classList.add('is-shaking');
      vibrate(25);
      return;
    }

    Engine.placeShip(state.ownBoard, size, anchor.x, anchor.y, anchor.horizontal);
    state.selectedSize = nextAvailableSizeAfter(size);
    state.previewKey = '';
    renderFleet();
    renderPlacementBoard();
    updatePlacementButtons();
    updatePlacementCounter();
    vibrate(12);
    const placed = state.ownBoard.ships.length;
    if (placed === MAX_SHIPS) {
      ui.placementHint.innerHTML = 'Весь флот на месте. Проверьте расстановку и нажмите <strong>«Флот готов — в бой»</strong>.';
    } else {
      ui.placementHint.textContent = 'Корабль поставлен. Осталось ' + (MAX_SHIPS - placed) + ' ' + plural(MAX_SHIPS - placed, 'корабль', 'корабля', 'кораблей') + '.';
    }
  }

  function selectFleetSize(size) {
    if (!state.ownBoard || state.ownReady) return;
    if (availableCount(size) <= 0) {
      toast('Все корабли этого типа уже расставлены.', 'info');
      return;
    }
    state.selectedSize = size;
    state.previewKey = '';
    clearPlacementPreview();
    renderFleet();
    ui.placementHint.textContent = 'Коснитесь клетки на поле, чтобы поставить ' + Engine.SHIP_NAMES[size].toLowerCase() + ' (' + size + ' ' + plural(size, 'клетка', 'клетки', 'клеток') + ').';
  }

  function rotateShip() {
    if (!state.ownBoard || state.ownReady) return;
    state.orientation = state.orientation === 'h' ? 'v' : 'h';
    state.previewKey = '';
    clearPlacementPreview();
    updateRotateLabel();
    ui.placementHint.textContent = 'Поворот: ' + (state.orientation === 'h' ? 'горизонтально' : 'вертикально') + '. Теперь коснитесь клетки.';
  }

  function randomPlacement() {
    if (!state.ownBoard || state.ownReady) return;
    try {
      state.ownBoard = Engine.randomLayout();
    } catch (error) {
      toast('Не удалось сгенерировать расстановку. Попробуйте ещё раз.', 'error');
      return;
    }
    state.selectedSize = null;
    state.previewKey = '';
    renderPlacement();
    ui.placementHint.innerHTML = 'Случайная расстановка готова. Можно нажать <strong>«Флот готов — в бой»</strong> или переставить вручную.';
    vibrate(15);
  }

  function undoPlacement() {
    if (!state.ownBoard || state.ownReady) return;
    const removed = Engine.undoLastShip(state.ownBoard);
    if (!removed) return;
    state.selectedSize = removed.size;
    state.previewKey = '';
    renderFleet();
    renderPlacementBoard();
    updatePlacementButtons();
    updatePlacementCounter();
    ui.placementHint.textContent = 'Последний корабль убран. Коснитесь клетки, чтобы поставить его снова.';
  }

  function clearPlacement() {
    if (!state.ownBoard || state.ownReady || state.ownBoard.ships.length === 0) return;
    state.ownBoard = Engine.createBoard();
    state.selectedSize = 4;
    state.previewKey = '';
    renderPlacement();
  }

  function handleReadyClick() {
    if (!state.ownBoard || state.ownReady || !state.connected) return;
    if (state.ownBoard.ships.length !== MAX_SHIPS) {
      toast('Сначала расставьте все 10 кораблей.', 'error');
      return;
    }
    const layout = Engine.serializeLayout(state.ownBoard);
    const validation = Engine.validateLayout(layout);
    if (!validation.ok) {
      toast('Расстановка некорректна: ' + validation.message, 'error');
      return;
    }
    if (!sendMessage({ type: 'ready', layout: layout })) {
      toast('Нет соединения с соперником. Не удалось отправить флот.', 'error');
      return;
    }
    state.ownReady = true;
    state.ownLayout = layout;
    state.selectedSize = null;
    clearPlacementPreview();
    renderFleet();
    renderPlacementBoard();
    updatePlacementButtons();
    updatePlacementOpponent();
    ui.placementHint.textContent = 'Флот зафиксирован. Ждём, пока соперник закончит расстановку.';
    announce('Флот отправлен. Ждём соперника.');
    maybeStartGame();
  }

  function handleReadyMessage(message) {
    if (state.phase !== 'placement' || state.opponentReady) return;
    if (!Array.isArray(message.layout) || message.layout.length !== MAX_SHIPS) {
      handleProtocolFailure('Соперник отправил расстановку неверного формата.');
      return;
    }
    const validation = Engine.validateLayout(message.layout);
    if (!validation.ok) {
      handleProtocolFailure('Соперник отправил некорректную расстановку: ' + validation.message);
      return;
    }
    state.enemyLayout = Engine.serializeLayout(validation.board);
    state.opponentReady = true;
    updatePlacementOpponent();
    if (!state.ownReady) {
      ui.placementHint.textContent = 'Соперник уже расставил флот. Поторопитесь — бой начнётся, когда вы будете готовы.';
      toast('Соперник готов. Расставьте флот.', 'info');
    }
    maybeStartGame();
  }

  function maybeStartGame() {
    if (state.phase !== 'placement' || !state.connected || !state.ownReady || !state.opponentReady) return;
    if (!state.enemyLayout) return;
    const enemyBoard = Engine.boardFromLayout(state.enemyLayout);
    if (!enemyBoard) {
      handleProtocolFailure('Не удалось восстановить поле соперника.');
      return;
    }
    state.enemyBoard = enemyBoard;
    state.phase = 'playing';
    state.gameOver = false;
    state.awaitingShot = false;
    state.pendingShot = null;
    state.lastIncoming = null;
    state.lastResult = null;
    state.turnNumber = 1;
    state.log = [];
    state.myTurn = state.role === 'host';
    state.rematchRequested = false;
    state.opponentRematch = false;
    clearToasts();
    closeModal();
    renderGame();
    showScreen('game');
    addLog('Бой начался. ' + (state.myTurn ? 'Ваш ход.' : 'Ход соперника.'), 'info');
    setStatus('online', state.myTurn ? 'Ваш ход' : 'Ход соперника');
    announce(state.myTurn ? 'Бой начался. Ваш ход.' : 'Бой начался. Первым ходит соперник.');
    vibrate([20, 40, 30]);
  }

  /* ========================================================================
     Игровое поле
     ======================================================================== */

  function shotLabel(result) {
    if (result === 'miss') return 'мимо';
    if (result === 'hit') return 'попадание';
    if (result === 'sunk') return 'корабль потоплен';
    return 'выстрел не принят';
  }

  function buildGameCell(board, x, y, options) {
    const ship = options.showShips ? Engine.getShipAt(board, x, y) : null;
    const shot = Engine.shotAt(board, x, y);
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cell';
    cell.dataset.x = String(x);
    cell.dataset.y = String(y);
    const label = Engine.coordLabel(x, y);

    if (ship) {
      if (options.showShips) {
        cell.classList.add('cell--ship');
        shipSegmentClasses({ x: x, y: y }, ship).forEach(function (name) { cell.classList.add(name); });
      } else if (options.revealShips) {
        cell.classList.add('cell--revealed');
      }
    }

    if (shot) {
      cell.classList.add('cell--shot');
      if (shot === 'miss') cell.classList.add('cell--miss');
      if (shot === 'hit') cell.classList.add('cell--hit');
      if (shot === 'sunk') cell.classList.add('cell--sunk');
    }

    if (options.pending && options.pending.x === x && options.pending.y === y) {
      cell.classList.add('cell--pending');
    }
    if (options.lastShot && options.lastShot.x === x && options.lastShot.y === y) {
      cell.classList.add('cell--last');
    }

    const disabled = Boolean(options.disabled) || Boolean(shot);
    cell.disabled = disabled;

    let aria = label;
    if (ship && options.showShips) aria += ', ' + Engine.SHIP_NAMES[ship.size];
    if (ship && options.revealShips) aria += ', ' + Engine.SHIP_NAMES[ship.size];
    if (shot) aria += ', ' + shotLabel(shot);
    if (options.pending && options.pending.x === x && options.pending.y === y) aria += ', выстрел отправлен';
    cell.setAttribute('aria-label', aria);
    if (!disabled && options.interactive) {
      cell.setAttribute('aria-label', aria + '. Нажмите, чтобы выстрелить.');
    }
    return cell;
  }

  function renderGameBoard(container, board, options) {
    const fragment = document.createDocumentFragment();
    appendColumnLabels(fragment);
    for (let y = 0; y < Engine.BOARD_SIZE; y += 1) {
      const rowLabel = document.createElement('div');
      rowLabel.className = 'board__label board__label--row';
      rowLabel.textContent = String(y + 1);
      rowLabel.setAttribute('aria-hidden', 'true');
      fragment.appendChild(rowLabel);
      for (let x = 0; x < Engine.BOARD_SIZE; x += 1) {
        fragment.appendChild(buildGameCell(board, x, y, options));
      }
    }
    container.replaceChildren(fragment);
  }

  function renderGame() {
    if (!state.ownBoard || !state.enemyBoard) return;
    const interactive = state.phase === 'playing' && state.myTurn && !state.awaitingShot && !state.gameOver;
    renderGameBoard(ui.ownBoard, state.ownBoard, {
      showShips: true,
      disabled: true,
      lastShot: state.lastIncoming
    });
    renderGameBoard(ui.enemyBoard, state.enemyBoard, {
      showShips: false,
      revealShips: state.gameOver,
      disabled: !interactive,
      interactive: interactive,
      pending: state.pendingShot,
      lastShot: state.lastResult
    });
    ui.enemyBoard.classList.toggle('is-active', interactive);
    ui.enemyPanel.classList.toggle('is-active', interactive);
    updateTurnUI();
    updateGameMeta();
  }

  function updateGameMeta() {
    if (state.ownBoard) {
      const own = Engine.fleetStatus(state.ownBoard);
      ui.ownBadge.textContent = own.afloat + ' / ' + MAX_SHIPS;
      ui.ownBadge.title = 'Кораблей на плаву: ' + own.afloat + ' из ' + MAX_SHIPS;
    }
    if (state.enemyBoard) {
      const enemy = Engine.fleetStatus(state.enemyBoard);
      ui.enemyBadge.textContent = enemy.sunk + ' / ' + MAX_SHIPS;
      ui.enemyBadge.title = 'Потоплено кораблей соперника: ' + enemy.sunk + ' из ' + MAX_SHIPS;
    }
    ui.logTurn.textContent = 'Ход ' + state.turnNumber;
  }

  function updateTurnUI() {
    if (!ui.turnBanner) return;
    let mode = 'waiting';
    let title = 'Ход соперника';
    let subtitle = 'Ожидайте выстрела — он появится на вашем поле.';
    let hint = 'Сейчас стреляет соперник. Смотрите на своё поле.';

    if (state.phase === 'disconnected') {
      mode = 'over';
      title = 'Связь потеряна';
      subtitle = 'Партия остановлена.';
      hint = 'Нет соединения с соперником.';
    } else if (state.phase === 'playing') {
      if (state.awaitingShot) {
        mode = 'waiting';
        title = 'Выстрел отправлен';
        subtitle = 'Ждём ответа соперника…';
        hint = 'Выстрел отправлен. Ждём подтверждения.';
      } else if (state.myTurn) {
        mode = 'you';
        title = 'Ваш ход';
        subtitle = 'Коснитесь клетки на нижнем поле';
        hint = 'Ваш ход: выберите клетку для выстрела.';
      } else {
        mode = 'opponent';
        title = 'Ход соперника';
        subtitle = 'Снаряд уже в пути — следите за своим полем.';
        hint = 'Соперник целится. Дождитесь его выстрела.';
      }
    } else if (state.gameOver) {
      mode = 'over';
      title = 'Бой завершён';
      subtitle = state.outcome && state.outcome.win ? 'Победа за вами.' : 'Партия окончена.';
      hint = 'Бой завершён.';
    }

    ui.turnBanner.dataset.turn = mode;
    ui.turnTitle.textContent = title;
    ui.turnSubtitle.textContent = subtitle;
    ui.enemyHint.textContent = hint;
    if (state.phase === 'playing') {
      setStatus('online', state.myTurn ? 'Ваш ход' : 'Ход соперника');
    } else if (state.phase === 'over') {
      setStatus('online', 'Игра завершена');
    }
  }

  function addLog(message, kind) {
    state.log.unshift({ message: message, kind: kind || 'info' });
    if (state.log.length > 7) state.log.length = 7;
    renderLog();
  }

  function renderLog() {
    ui.gameLog.replaceChildren();
    if (!state.log.length) {
      const empty = document.createElement('p');
      empty.className = 'game-log__empty';
      empty.textContent = 'Сделайте первый выстрел.';
      ui.gameLog.appendChild(empty);
      return;
    }
    state.log.forEach(function (entry) {
      const row = document.createElement('div');
      row.className = 'log-entry log-entry--' + entry.kind;
      const dot = document.createElement('span');
      dot.className = 'log-entry__dot';
      dot.setAttribute('aria-hidden', 'true');
      const text = document.createElement('span');
      text.textContent = entry.message;
      row.appendChild(dot);
      row.appendChild(text);
      ui.gameLog.appendChild(row);
    });
  }

  function handleEnemyBoardClick(event) {
    const cell = event.target.closest('.cell');
    if (!cell || !ui.enemyBoard.contains(cell)) return;
    if (state.phase !== 'playing' || !state.myTurn || state.awaitingShot || state.gameOver) return;
    if (!state.enemyBoard || !state.connected) return;
    const x = Number(cell.dataset.x);
    const y = Number(cell.dataset.y);
    if (!Engine.inBounds(x, y)) return;
    if (Engine.shotAt(state.enemyBoard, x, y) !== null) {
      toast('Здесь уже стреляли. Выберите другую клетку.', 'info');
      return;
    }

    const shotId = String(Date.now()) + '-' + String(Math.floor(Math.random() * 100000));
    state.awaitingShot = true;
    state.pendingShot = { x: x, y: y };
    state.lastResult = null;
    state.lastSentShot = { x: x, y: y, shotId: shotId };
    const sent = sendMessage({ type: 'shot', x: x, y: y, shotId: shotId });
    if (!sent) {
      state.awaitingShot = false;
      state.pendingShot = null;
      state.lastSentShot = null;
      toast('Нет соединения. Выстрел не отправлен.', 'error');
      renderGame();
      return;
    }
    renderGame();
    vibrate(12);
  }

  function handleShotMessage(message) {
    if (state.phase !== 'playing' || state.gameOver) return;
    const x = Number(message.x);
    const y = Number(message.y);
    const shotId = message.shotId;
    if (!Engine.inBounds(x, y) || typeof shotId !== 'string') {
      sendMessage({ type: 'shot-result', x: x, y: y, shotId: shotId, result: 'invalid', reason: 'bad-coordinates' });
      return;
    }
    if (state.myTurn || state.awaitingShot) {
      sendMessage({ type: 'shot-result', x: x, y: y, shotId: shotId, result: 'invalid', reason: 'not-your-turn' });
      return;
    }

    const shot = Engine.registerShot(state.ownBoard, x, y);
    if (!shot.ok) {
      sendMessage({
        type: 'shot-result',
        x: x,
        y: y,
        shotId: shotId,
        result: 'invalid',
        reason: shot.error
      });
      return;
    }

    const coordinate = Engine.coordLabel(x, y);
    state.turnNumber += 1;
    state.lastIncoming = { x: x, y: y, result: shot.result };
    const logKind = shot.result === 'miss' ? 'miss' : shot.result === 'sunk' ? 'sunk' : 'hit';
    addLog('Соперник: ' + coordinate + ' — ' + shotLabel(shot.result) + '.', logKind);

    const resultPayload = {
      type: 'shot-result',
      x: x,
      y: y,
      shotId: shotId,
      result: shot.result,
      gameOver: shot.gameOver === true
    };
    if (shot.result === 'sunk') resultPayload.sunkCells = shot.sunkCells;
    sendMessage(resultPayload);

    if (shot.gameOver) {
      finishGame(false, 'fleet');
      vibrate([60, 40, 80]);
    } else {
      state.myTurn = shot.result === 'miss';
      renderGame();
      if (shot.result === 'miss') {
        announce('Соперник промахнулся. Ваш ход.');
        vibrate(15);
      } else {
        announce(shot.result === 'sunk' ? 'Соперник потопил ваш корабль. Его ход продолжается.' : 'Соперник попал. Его ход продолжается.');
        vibrate([35, 25, 35]);
      }
    }
  }

  function handleShotResultMessage(message) {
    if (state.phase !== 'playing') return;
    const x = Number(message.x);
    const y = Number(message.y);
    if (!state.awaitingShot || !state.lastSentShot) return;
    if (state.lastSentShot.x !== x || state.lastSentShot.y !== y) return;
    if (message.shotId && state.lastSentShot.shotId !== message.shotId) return;

    if (message.result === 'invalid') {
      state.awaitingShot = false;
      state.pendingShot = null;
      state.lastSentShot = null;
      toast('Соперник не принял выстрел. Попробуйте другую клетку.', 'error');
      renderGame();
      return;
    }
    if (SHOT_RESULTS.indexOf(message.result) === -1 || message.result === 'invalid') return;

    const sunkCells = message.result === 'sunk' ? message.sunkCells : undefined;
    if (message.result === 'sunk') {
      if (!Array.isArray(sunkCells) || sunkCells.length < 1 || sunkCells.length > 4) {
        handleProtocolFailure('Соперник отправил некорректные координаты потопленного корабля.');
        return;
      }
    }
    const applied = Engine.applyShotResult(state.enemyBoard, x, y, message.result, sunkCells);
    if (!applied) {
      handleProtocolFailure('Не удалось применить ответ соперника.');
      return;
    }

    state.awaitingShot = false;
    state.pendingShot = null;
    state.lastSentShot = null;
    state.lastResult = { x: x, y: y, result: message.result };
    state.turnNumber += 1;

    const coordinate = Engine.coordLabel(x, y);
    const logKind = message.result === 'miss' ? 'miss' : message.result === 'sunk' ? 'sunk' : 'hit';
    const prefix = message.result === 'miss' ? 'Вы: ' : 'Вы: ';
    addLog(prefix + coordinate + ' — ' + shotLabel(message.result) + '.', logKind);

    if (message.gameOver === true && message.result === 'sunk') {
      finishGame(true, 'fleet');
      vibrate([30, 40, 30, 40, 80]);
      return;
    }

    state.myTurn = message.result !== 'miss';
    renderGame();
    if (message.result === 'miss') {
      announce('Мимо. Ход переходит сопернику.');
    } else if (message.result === 'sunk') {
      announce('Корабль потоплен. Вы стреляете снова.');
    } else {
      announce('Попадание. Вы стреляете снова.');
    }
  }

  /* ========================================================================
     Завершение игры, реванш, сдача
     ======================================================================== */

  function finishGame(win, reason) {
    if (state.gameOver && state.outcome) return;
    state.gameOver = true;
    state.phase = 'over';
    state.myTurn = false;
    state.awaitingShot = false;
    state.pendingShot = null;
    state.outcome = { win: Boolean(win), reason: reason || 'fleet' };
    renderGame();
    const own = Engine.fleetStatus(state.ownBoard);
    const enemy = Engine.fleetStatus(state.enemyBoard);
    if (win) {
      addLog('Победа! Флот соперника уничтожен.', 'info');
      announce('Победа! Весь флот соперника уничтожен.');
    } else {
      addLog('Поражение. Ваш флот уничтожен.', 'info');
      announce('Поражение. Ваш флот уничтожен.');
    }
    window.setTimeout(function () {
      if (state.phase !== 'over' || !state.connected) return;
      showGameOverModal(own, enemy);
    }, 520);
  }

  function showGameOverModal(own, enemy) {
    if (!state.outcome) return;
    const win = state.outcome.win;
    const reason = state.outcome.reason;
    let text;
    if (reason === 'resign') {
      text = 'Вы сдались. Соперник празднует победу.';
    } else if (reason === 'opponent-resign') {
      text = 'Соперник сдался. Победа остаётся за вами.';
    } else if (win) {
      text = 'Весь флот соперника отправлен на дно. Отличная работа, адмирал!';
    } else {
      text = 'Ваш флот уничтожен. В следующий раз повезёт — или поможет тактика.';
    }
    const stats = own && enemy
      ? ' Ваши потери: ' + own.sunk + ' из ' + MAX_SHIPS + '. Потоплено у соперника: ' + enemy.sunk + ' из ' + MAX_SHIPS + '.'
      : '';
    openModal({
      tone: win ? 'win' : 'loss',
      icon: win ? '#i-trophy' : '#i-alert',
      eyebrow: 'Игра завершена',
      title: win ? 'Победа!' : 'Поражение',
      text: text + stats,
      actions: [
        {
          label: 'Реванш',
          icon: '#i-rotate',
          variant: 'primary',
          onClick: requestRematch
        },
        {
          label: 'В лобби',
          icon: '#i-home',
          variant: 'secondary',
          onClick: leaveGameAndLobby
        }
      ]
    });
  }

  function requestRematch() {
    if (!state.connected) {
      toast('Соперник уже отключился. Создайте новую комнату.', 'error');
      goToLobby();
      return;
    }
    if (state.opponentRematch) {
      acceptRematch();
      return;
    }
    if (!sendMessage({ type: 'rematch-request' })) {
      toast('Не удалось отправить предложение.', 'error');
      return;
    }
    state.rematchRequested = true;
    openModal({
      tone: 'info',
      icon: '#i-clock',
      eyebrow: 'Реванш',
      title: 'Предложение отправлено',
      text: 'Ждём, пока соперник согласится на новый бой.',
      actions: [
        { label: 'Отменить', variant: 'secondary', onClick: cancelRematch },
        { label: 'В лобби', variant: 'secondary', onClick: leaveGameAndLobby }
      ]
    });
  }

  function cancelRematch() {
    if (state.rematchRequested) {
      sendMessage({ type: 'rematch-decline' });
      state.rematchRequested = false;
    }
    if (state.phase === 'over') showGameOverModal();
  }

  function handleRematchRequest() {
    if (state.phase !== 'over') return;
    state.opponentRematch = true;
    if (state.rematchRequested) {
      acceptRematch();
      return;
    }
    openModal({
      tone: 'info',
      icon: '#i-rotate',
      eyebrow: 'Реванш',
      title: 'Соперник предлагает реванш',
      text: 'Готовы сыграть ещё один бой? Расстановка начнётся заново.',
      actions: [
        { label: 'Принять', icon: '#i-check', variant: 'primary', onClick: acceptRematch },
        { label: 'В лобби', variant: 'secondary', onClick: function () { sendMessage({ type: 'rematch-decline' }); leaveGameAndLobby(); } }
      ]
    });
  }

  function acceptRematch() {
    state.opponentRematch = false;
    state.rematchRequested = false;
    if (!sendMessage({ type: 'rematch-accept' })) {
      toast('Нет соединения с соперником.', 'error');
      return;
    }
    resetForRematch();
  }

  function handleRematchAccept() {
    if (state.phase !== 'over') return;
    state.opponentRematch = false;
    state.rematchRequested = false;
    resetForRematch();
  }

  function handleRematchDecline() {
    if (state.phase !== 'over') return;
    state.rematchRequested = false;
    state.opponentRematch = false;
    toast('Соперник отказался от реванша.', 'info');
    if (ui.modal.hidden || ui.modalEyebrow.textContent === 'Реванш') {
      closeModal();
      window.setTimeout(function () { if (state.phase === 'over') showGameOverModal(); }, 120);
    }
  }

  function resetForRematch() {
    closeModal();
    resetRoundState();
    state.phase = 'placement';
    initPlacement();
    toast('Новый бой! Расставьте флот заново.', 'success');
  }

  function confirmResign() {
    if (state.phase !== 'playing') return;
    openModal({
      tone: 'alert',
      icon: '#i-flag',
      eyebrow: 'Сдаться',
      title: 'Завершить бой?',
      text: 'Соперник будет объявлен победителем. Это действие нельзя отменить.',
      actions: [
        { label: 'Продолжить бой', variant: 'secondary', onClick: function () {} },
        { label: 'Сдаться', variant: 'primary', onClick: resignGame }
      ]
    });
  }

  function resignGame() {
    if (state.phase !== 'playing') return;
    sendMessage({ type: 'resign' });
    state.outcome = { win: false, reason: 'resign' };
    finishGame(false, 'resign');
    vibrate([80, 50, 120]);
  }

  function handleResignMessage() {
    if (state.phase !== 'playing') return;
    state.outcome = { win: true, reason: 'opponent-resign' };
    finishGame(true, 'opponent-resign');
  }

  /* ========================================================================
     События интерфейса
     ======================================================================== */

  function bindEvents() {
    ui.btnCreate.addEventListener('click', startHosting);
    ui.btnJoin.addEventListener('click', function () { openJoinScreen(); });
    ui.brand.addEventListener('click', function () {
      if (state.screen !== 'lobby') confirmExit();
    });
    ui.home.addEventListener('click', confirmExit);

    ui.copyId.addEventListener('click', async function () {
      if (!state.roomId) return;
      const ok = await copyText(state.roomId);
      toast(ok ? 'ID комнаты скопирован.' : 'Не удалось скопировать ID. Выделите его вручную.', ok ? 'success' : 'error');
    });

    ui.copyLink.addEventListener('click', async function () {
      if (!state.inviteUrl) return;
      const ok = await copyText(state.inviteUrl);
      toast(ok ? 'Ссылка на игру скопирована.' : 'Не удалось скопировать ссылку.', ok ? 'success' : 'error');
    });

    ui.share.addEventListener('click', async function () {
      if (!state.inviteUrl || !navigator.share) return;
      try {
        await navigator.share({
          title: 'Морской бой',
          text: 'Присоединяйся к моей игре в Морской бой!',
          url: state.inviteUrl
        });
      } catch (error) {
        if (error && error.name !== 'AbortError') toast('Не удалось открыть меню «Поделиться».', 'error');
      }
    });

    ui.createRetry.addEventListener('click', startHosting);
    ui.createCancel.addEventListener('click', confirmExit);

    ui.joinForm.addEventListener('submit', function (event) {
      event.preventDefault();
      if (state.phase === 'joining') return;
      ui.joinError.hidden = true;
      startJoining(ui.joinInput.value);
    });

    ui.joinInput.addEventListener('input', function () {
      ui.joinError.hidden = true;
    });

    ui.paste.addEventListener('click', async function () {
      try {
        if (!navigator.clipboard || !navigator.clipboard.readText || !window.isSecureContext) {
          throw new Error('Clipboard API unavailable');
        }
        const text = await navigator.clipboard.readText();
        if (text) {
          ui.joinInput.value = extractRoomId(text);
          ui.joinError.hidden = true;
          toast('ID вставлен.', 'success');
        }
      } catch (error) {
        ui.joinInput.focus();
        toast('Буфер обмена недоступен. Вставьте ID вручную.', 'info');
      }
    });

    Array.prototype.forEach.call(document.querySelectorAll('[data-go="lobby"]'), function (button) {
      button.addEventListener('click', confirmExit);
    });

    ui.fleetList.addEventListener('click', function (event) {
      const item = event.target.closest('.fleet-item');
      if (!item) return;
      selectFleetSize(Number(item.dataset.size));
    });

    ui.placementBoard.addEventListener('click', handlePlacementClick);
    ui.placementBoard.addEventListener('pointermove', function (event) {
      const cell = event.target.closest('.cell');
      if (cell && ui.placementBoard.contains(cell)) {
        previewPlacement(Number(cell.dataset.x), Number(cell.dataset.y));
      }
    });
    ui.placementBoard.addEventListener('pointerleave', clearPlacementPreview);

    ui.rotate.addEventListener('click', rotateShip);
    ui.random.addEventListener('click', randomPlacement);
    ui.undo.addEventListener('click', undoPlacement);
    ui.clear.addEventListener('click', clearPlacement);
    ui.ready.addEventListener('click', handleReadyClick);

    ui.enemyBoard.addEventListener('click', handleEnemyBoardClick);
    ui.leaveGame.addEventListener('click', confirmExit);
    ui.resign.addEventListener('click', confirmResign);

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && !ui.modal.hidden && state.modalDismissible) closeModal();
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const tag = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (!ui.modal.hidden) return;
      if ((event.key === 'r' || event.key === 'R' || event.code === 'KeyR') && state.screen === 'placement') {
        rotateShip();
      }
    });

    window.addEventListener('beforeunload', function () {
      if (state.connected) sendMessage({ type: 'leave' });
    });

    window.addEventListener('online', function () {
      if (!state.connected && (state.phase === 'waiting' || state.phase === 'creating')) {
        toast('Интернет снова доступен. Если комната не создалась — попробуйте ещё раз.', 'info');
      }
    });
  }

  function bootstrap() {
    if (!Engine) {
      setStatus('error', 'Ошибка загрузки');
      ui.createTitle.textContent = 'Не удалось загрузить игру';
      ui.createText.textContent = 'Обновите страницу. Если ошибка повторяется, проверьте файл js/engine.js.';
      return;
    }
    if (!PeerCtor) {
      setStatus('error', 'Нет PeerJS');
      showScreen('lobby');
      openModal({
        tone: 'alert',
        icon: '#i-alert',
        eyebrow: 'Ошибка',
        title: 'PeerJS не загрузился',
        text: 'Проверьте подключение к интернету и обновите страницу. Файл библиотеки находится в папке vendor.',
        actions: [{ label: 'Обновить', variant: 'primary', onClick: function () { window.location.reload(); } }]
      });
      return;
    }

    bindEvents();
    ui.share.hidden = !navigator.share;
    showScreen('lobby');
    setStatus('offline', 'Не подключено');

    if (window.location.protocol === 'file:') {
      window.setTimeout(function () {
        toast('Для игры по сети откройте страницу через HTTPS или локальный сервер. Сейчас адрес file://.', 'error', 7000);
      }, 500);
    }

    const invited = getInvitedRoom();
    if (invited && isValidRoomId(extractRoomId(invited))) {
      openJoinScreen({ room: extractRoomId(invited) });
      toast('Вас пригласили в игру. Проверьте ID и подключитесь.', 'info', 4500);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
