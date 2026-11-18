/*
 * peerjs-session.js — скелет P2P-сессии на PeerJS.
 *
 * Нужен только глобальный `window.Peer` (peerjs.min.js), остальное — нативный
 * браузерный API. Адаптируйте обработчики под своё приложение; протокол,
 * переключение сигнальных серверов, watchdog и Wake Lock уже собраны.
 *
 *   import { createP2P } from './peerjs-session.js';
 *
 *   const session = createP2P({
 *     onStatus: (status, detail) => renderStatus(status, detail), // connecting|waiting|online|error
 *     onMessage: (msg) => applyRemoteMessage(msg),               // валидируйте поля внутри
 *     onClosed: (reason) => showDisconnectedDialog(reason),
 *     onError: (message) => showToast(message)
 *   });
 *
 *   const code = await session.host();   // покажите code пользователю
 *   // или
 *   await session.join(codeFromUser);
 *
 *   session.send('move', { from: 'e2', to: 'e4' });
 *   session.destroy();                   // уход из сессии
 */

const PROTOCOL_VERSION = 1;
const ROOM_PREFIX = 'room';
const ROOM_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const ROOM_PATTERN = /^[A-Za-z0-9_-]{3,64}$/;
const DISCONNECT_GRACE_MS = 15000;
const WATCHDOG_INTERVAL_MS = 4000;

/*
 * Первый сервер — штатное облако PeerJS (options: null). Резервные говорят на
 * том же протоколе; ключ сервера попадает в код комнаты, поэтому второй игрок
 * подключается туда же автоматически. Для продакшена поднимите свой PeerServer
 * и поставьте его первым.
 */
const SIGNALING_SERVERS = [
  { key: 'c', options: null },
  {
    key: 'x',
    options: {
      host: 'xfenix.ru',
      port: 443,
      path: '/',
      secure: true,
      key: 'peerjs',
      config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
    }
  },
  {
    key: 'w',
    options: {
      host: 'slidemachina-broker.xfenix.workers.dev',
      port: 443,
      path: '/',
      secure: true,
      key: 'peerjs',
      config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
    }
  }
];

const FALLBACK_ERRORS = ['network', 'server-error', 'socket-error', 'socket-closed', 'ssl-unavailable'];

const ERROR_TEXT = {
  'browser-incompatible': 'Браузер не поддерживает WebRTC. Обновите его.',
  'invalid-id': 'Некорректный код комнаты.',
  'invalid-key': 'Сигнальный сервер отклонил ключ. Попробуйте позже.',
  network: 'Нет связи с сигнальным сервером. Проверьте интернет.',
  'peer-unavailable': 'Комната не найдена: проверьте код или создайте новую.',
  'server-error': 'Сигнальный сервер недоступен. Попробуйте через минуту.',
  'socket-error': 'Соединение с сигнальным сервером прервалось.',
  'socket-closed': 'Сигнальное соединение закрыто.',
  'ssl-unavailable': 'Для соединения нужен HTTPS.',
  'unavailable-id': 'Код комнаты занят — создайте новую.',
  webrtc: 'WebRTC не смог соединиться. Попробуйте другую сеть или отключите VPN.'
};

function errorTextFor(type) {
  return ERROR_TEXT[type] || 'Не удалось установить соединение. Попробуйте ещё раз.';
}

function randomToken(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += ROOM_ALPHABET[byte % ROOM_ALPHABET.length];
  return out;
}

function serverKeyOf(code) {
  const match = /^[a-z]+-([a-z])-/i.exec(String(code || ''));
  return match ? match[1].toLowerCase() : 'c';
}

function signalingServerFor(code) {
  const key = serverKeyOf(code);
  return SIGNALING_SERVERS.find((server) => server.key === key) || SIGNALING_SERVERS[0];
}

export function createP2P(options = {}) {
  const handlers = {
    onStatus: () => {},
    onMessage: () => {},
    onClosed: () => {},
    onError: () => {},
    ...options
  };

  const state = {
    role: null,
    peer: null,
    conn: null,
    code: '',
    connected: false,
    intentionalClose: false,
    serverKey: 'c',
    watchdogTimer: null,
    disconnectedSince: 0,
    wakeLock: null
  };

  const timers = new Set();
  function later(fn, ms) {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
    return id;
  }
  function cancel(timer) {
    if (!timer) return;
    clearTimeout(timer);
    timers.delete(timer);
  }
  function clearTimers() {
    for (const id of timers) clearTimeout(id);
    timers.clear();
  }

  function status(kind, detail) {
    try {
      handlers.onStatus(kind, detail);
    } catch (error) {
      console.error('[p2p] status handler failed', error);
    }
  }

  function send(type, payload = {}) {
    if (!state.conn || !state.conn.open) return false;
    try {
      state.conn.send({ v: PROTOCOL_VERSION, ts: Date.now(), type, ...payload });
      return true;
    } catch (error) {
      console.warn('[p2p] send failed', error);
      return false;
    }
  }

  /* ---------------------------- соединение ---------------------------- */

  function wireConnection(conn, onOpen) {
    state.conn = conn;
    let opened = false;

    const handleOpen = () => {
      if (opened || state.conn !== conn) return;
      opened = true;
      clearTimers();
      state.connected = true;
      status('online');
      send('hello', { role: state.role });
      startWatchdog();
      keepAwake();
      if (typeof onOpen === 'function') onOpen();
    };

    conn.on('open', handleOpen);

    conn.on('data', (data) => {
      if (state.conn !== conn) return;
      if (!data || typeof data !== 'object') return;
      if (data.v !== PROTOCOL_VERSION || typeof data.type !== 'string') return;
      try {
        handlers.onMessage(data);
      } catch (error) {
        console.error('[p2p] message handler failed', error);
      }
    });

    conn.on('close', () => {
      if (state.conn !== conn) return;
      state.conn = null;
      if (!state.intentionalClose) endSession('Соединение с соперником закрыто.');
    });

    conn.on('error', (error) => {
      if (state.conn !== conn) return;
      console.warn('[p2p] connection error', error);
      if (!state.intentionalClose) handlers.onError(errorTextFor(error && error.type));
    });
  }

  /* ------------------------------ watchdog ----------------------------- */

  function startWatchdog() {
    stopWatchdog();
    state.disconnectedSince = 0;
    state.watchdogTimer = setInterval(() => {
      if (!state.connected || !state.conn) return;
      // Вкладка скрыта (погас экран, приложение свёрнуто): браузер душит таймеры,
      // а ICE может восстановиться сам — не обрываем сессию по таймауту.
      if (document.visibilityState !== 'visible') {
        state.disconnectedSince = 0;
        return;
      }
      const pc = state.conn.peerConnection;
      if (!pc) return;
      const dead = ['failed', 'closed'];
      if (dead.includes(pc.connectionState) || dead.includes(pc.iceConnectionState)) {
        endSession('Связь потеряна.');
        return;
      }
      const unstable = pc.connectionState === 'disconnected' || pc.iceConnectionState === 'disconnected';
      if (unstable) {
        if (!state.disconnectedSince) state.disconnectedSince = Date.now();
        else if (Date.now() - state.disconnectedSince > DISCONNECT_GRACE_MS) endSession('Связь потеряна.');
      } else {
        state.disconnectedSince = 0;
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  function stopWatchdog() {
    if (state.watchdogTimer) clearInterval(state.watchdogTimer);
    state.watchdogTimer = null;
    state.disconnectedSince = 0;
  }

  /* ----------------------------- Wake Lock ----------------------------- */

  async function keepAwake() {
    if (!navigator.wakeLock || document.visibilityState !== 'visible') return;
    if (state.wakeLock) return;
    try {
      const lock = await navigator.wakeLock.request('screen');
      state.wakeLock = lock;
      lock.addEventListener('release', () => {
        if (state.wakeLock === lock) state.wakeLock = null;
      });
    } catch (error) {
      console.warn('[p2p] wake lock rejected', error);
    }
  }

  function releaseWakeLock() {
    const lock = state.wakeLock;
    state.wakeLock = null;
    if (!lock) return;
    try {
      const released = lock.release();
      if (released && typeof released.catch === 'function') released.catch(() => {});
    } catch (error) {
      // Браузер уже освободил блокировку.
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      releaseWakeLock();
      return;
    }
    state.disconnectedSince = 0;
    if (state.connected) keepAwake();
  });

  /* ---------------------------- завершение ----------------------------- */

  function endSession(reason) {
    if (!state.connected && !state.conn) return;
    state.connected = false;
    stopWatchdog();
    clearTimers();
    releaseWakeLock();
    const conn = state.conn;
    state.conn = null;
    if (conn) {
      try { conn.close(); } catch (error) { /* no-op */ }
    }
    handlers.onClosed(reason);
  }

  function destroy() {
    state.intentionalClose = true;
    stopWatchdog();
    clearTimers();
    releaseWakeLock();
    if (state.conn) {
      try { send('leave'); } catch (error) { /* no-op */ }
      try { state.conn.close(); } catch (error) { /* no-op */ }
      state.conn = null;
    }
    if (state.peer) {
      try { state.peer.destroy(); } catch (error) { /* no-op */ }
      state.peer = null;
    }
    state.connected = false;
    state.code = '';
    state.intentionalClose = false;
  }

  /* -------------------------------- host ------------------------------- */

  function host() {
    destroy();
    state.role = 'host';

    return new Promise((resolve, reject) => {
      let serverIndex = 0;
      let settled = false;

      const fail = (message) => {
        if (settled) return;
        settled = true;
        status('error');
        reject(new Error(message));
      };

      const attempt = () => {
        const server = SIGNALING_SERVERS[serverIndex];
        state.serverKey = server.key;
        const code = `${ROOM_PREFIX}-${server.key}-${randomToken(8)}`;

        let peer;
        try {
          peer = new window.Peer(code, { debug: 0, ...(server.options || {}) });
        } catch (error) {
          fail('WebRTC недоступен в этом браузере.');
          return;
        }
        state.peer = peer;
        status('connecting', server.key);

        const openTimer = later(() => {
          if (state.peer !== peer || state.connected) return;
          fallback('Сигнальный сервер не отвечает.');
        }, 10000);

        const fallback = (message) => {
          cancel(openTimer);
          if (state.peer !== peer) return;
          try { peer.destroy(); } catch (error) { /* no-op */ }
          state.peer = null;
          if (serverIndex + 1 < SIGNALING_SERVERS.length) {
            serverIndex += 1;
            status('connecting', SIGNALING_SERVERS[serverIndex].key);
            later(attempt, 150);
          } else {
            fail(message);
          }
        };

        peer.on('open', (id) => {
          if (state.peer !== peer) return;
          cancel(openTimer);
          state.code = id;
          state.connected = false;
          if (!settled) {
            settled = true;
            status('waiting');
            resolve(id);
          }
        });

        peer.on('connection', (conn) => {
          if (state.peer !== peer) return;
          if (state.conn || state.connected) {
            try { conn.close(); } catch (error) { /* no-op */ }
            return;
          }
          wireConnection(conn);
          later(() => {
            if (state.conn !== conn || state.connected) return;
            try { conn.close(); } catch (error) { /* no-op */ }
            state.conn = null;
            handlers.onError('Не удалось открыть канал с гостем. Ждём новое подключение.');
            status('waiting');
          }, 15000);
        });

        peer.on('error', (error) => {
          if (state.peer !== peer) return;
          const type = error && error.type;
          if (type === 'unavailable-id' && !state.connected) {
            cancel(openTimer);
            try { peer.destroy(); } catch (destroyError) { /* no-op */ }
            state.peer = null;
            later(attempt, 120);
            return;
          }
          if (!state.connected && FALLBACK_ERRORS.includes(type)) {
            fallback(errorTextFor(type));
          } else if (!state.connected) {
            cancel(openTimer);
            fail(errorTextFor(type));
          }
        });

        peer.on('disconnected', () => {
          if (state.peer !== peer || state.connected) return;
          try { peer.reconnect(); } catch (error) { /* no-op */ }
        });
      };

      attempt();
    });
  }

  /* -------------------------------- join ------------------------------- */

  function join(rawCode) {
    destroy();
    state.role = 'guest';
    const code = String(rawCode || '').trim();

    return new Promise((resolve, reject) => {
      if (!ROOM_PATTERN.test(code)) {
        reject(new Error('Некорректный код комнаты.'));
        return;
      }

      const server = signalingServerFor(code);
      state.serverKey = server.key;
      let settled = false;
      let peer;

      const fail = (message) => {
        if (settled) return;
        settled = true;
        destroy();
        status('error');
        reject(new Error(message));
      };

      try {
        peer = new window.Peer({ debug: 0, ...(server.options || {}) });
      } catch (error) {
        fail('WebRTC недоступен в этом браузере.');
        return;
      }
      state.peer = peer;
      status('connecting', server.key);

      const joinTimer = later(() => {
        if (state.peer === peer && !state.connected) fail('Не удалось подключиться за 20 секунд.');
      }, 20000);

      peer.on('open', () => {
        if (state.peer !== peer) return;
        let conn;
        try {
          conn = peer.connect(code, { reliable: true, serialization: 'json' });
        } catch (error) {
          fail('Не удалось начать подключение. Проверьте код комнаты.');
          return;
        }
        wireConnection(conn, () => {
          cancel(joinTimer);
          if (!settled) {
            settled = true;
            resolve();
          }
        });
        later(() => {
          if (state.peer === peer && !state.connected) {
            fail('Прямой канал не открылся. Возможно, комната закрыта.');
          }
        }, 18000);
      });

      peer.on('error', (error) => {
        if (state.peer !== peer || state.connected) return;
        cancel(joinTimer);
        fail(errorTextFor(error && error.type));
      });
    });
  }

  return {
    host,
    join,
    send,
    destroy,
    isConnected: () => state.connected,
    get code() { return state.code; },
    get role() { return state.role; }
  };
}
