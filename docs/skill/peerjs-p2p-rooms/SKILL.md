---
name: peerjs-p2p-rooms
description: Use when building or debugging a browser-to-browser P2P session on PeerJS/WebRTC — two devices need to find each other by a room code without a backend, exchange messages directly, stay in sync, survive network drops and phone sleep, or be verified with two real browsers.
---

# PeerJS P2P rooms

A reusable pattern for two browsers that meet through a room code and then talk
directly over a WebRTC DataConnection, with no application server. Extract from a
working "Морской бой" implementation (`js/app.js` in the dpskSeaBattle repo) and
generalize it; game rules are deliberately left out.

## When this applies

- Two people (or two tabs/devices) must play/chat/collaborate in real time.
- Data is small JSON: moves, cursor positions, chat lines, settings.
- No backend is available or wanted; static hosting is enough.
- Hosting is HTTPS (required for WebRTC on any non-localhost origin).

If you need a persistent room across reloads, many-to-many, or untrusted parties,
this pattern is not enough: add a real server or a TURN relay.

## 1. Architecture you are building

```
Browser A ── PeerJS DataConnection (WebRTC, direct) ── Browser B
     │                                                    │
     └──────────── signaling server (handshake only) ─────┘
```

- The signaling server only swaps SDP and ICE candidates. Game/app messages
  never pass through it.
- One peer registers an ID first (host), the other calls `peer.connect(id)`
  (guest). Either side can be the host; roles only decide who moves first.
- Use `reliable: true` and `serialization: 'json'` for predictable delivery and
  plain-object payloads.

## 2. Signaling that survives blocked clouds

The official cloud `0.peerjs.com` is the default, but it is blocked or
rate-limited in some networks (Cloudflare answers 403). A robust app:

1. Tries the official cloud.
2. On a *network-level* error falls back to alternative PeerJS-protocol servers.
3. Encodes the chosen server **in the room code**, so the guest automatically
   connects to the same server even if he only received the code.

```js
const SIGNALING_SERVERS = [
  { key: 'c', options: null },                                   // 0.peerjs.com
  { key: 'x', options: { host: 'example-peerjs.tld', port: 443, path: '/', secure: true, key: 'peerjs' } },
  { key: 'w', options: { host: 'backup.example.workers.dev', port: 443, path: '/', secure: true, key: 'peerjs' } },
];
const FALLBACK_ERRORS = ['network', 'server-error', 'socket-error', 'socket-closed', 'ssl-unavailable'];

const roomId = `room-${serverKey}-${randomToken(8)}`; // ← server key inside the code
const server = SIGNALING_SERVERS.find((s) => s.key === roomKeyOf(roomId)) || SIGNALING_SERVERS[0];
```

Rules that matter:

- Switch servers only while the peer never opened and is not connected yet;
  moving after a session started would drop the opponent.
- Give each attempt a timeout (~8–10 s) and fall through to the next server.
- On the fallback server provide an explicit STUN list (`stun:stun.l.google.com:19302`, `stun:stun.cloudflare.com:3478`); the default one belongs to the cloud config.
- Show the user which server is in use only as a footnote; the room code is all
  they need to share.
- Never claim a fallback server guarantees availability: they are third-party
  public services. For production, run `peerjs-server` yourself and keep it first.

## 3. Room code and invitation

- Random, prefixed, URL-safe: `room-c-a1b2c3d4` (prefix + server key + 8 chars
  from `crypto.getRandomValues`).
- Validate before connecting: `/^[A-Za-z0-9_-]{3,64}$/`.
- Accept a full link too: parse `?room=` (and `#room=`) and extract the code.
- Share both: "copy code" and "copy link" (`?room=<code>`), plus
  `navigator.share()` when available.
- On load, if the URL carries a room, land directly on the join screen with the
  field prefilled.

## 4. Connection lifecycle

```
create host peer → 'open'(id) → show code → wait 'connection'
guest: new Peer → 'open' → peer.connect(code) → connection 'open' → both ready
```

Implementation rules:

- Keep one `state.conn`. Reject any second incoming connection immediately.
- On `open`: mark connected, send a `hello`, start protocol and the connection
  watchdog, switch UI, and only then allow sending.
- Timeouts everywhere: peer open (~10–17 s), guest connect (~18–20 s), host
  waiting for the data channel (~15 s). Each timeout shows a human message and
  an explicit retry action.
- On leaving: send a `leave` message first, then close the connection and
  `peer.destroy()`. Guard `destroy()` calls in `try/catch` and set an
  `intentionalClose` flag so the resulting `close` event does not raise an error
  dialog.

## 5. Message protocol

Use a small versioned envelope and validate everything received:

```js
{ v: 1, type: 'hello' | 'ready' | 'shot' | 'shot-result' | 'resign' | 'leave' | 'rematch-request' | ... , ...payload }
```

- Ignore messages with an unknown version or type instead of throwing.
- Keep payloads JSON-serializable and small (PeerJS JSON channel warns above
  ~16 KiB per message).
- Make delivery idempotent: each action carries an id
  (`shotId = Date.now() + '-' + random`), and the receiver ignores repeats.
- Unknown sender state must not corrupt local state: validate coordinates,
  shapes, and sizes with the same functions used locally.

### Authoritative-owner pattern

Do not let the sender decide the outcome of an action that concerns the other
player's private state. Split it:

1. `action` — sender asks, carrying an id.
2. Receiver applies it to its own state, computes the result, replies
   `action-result` with the same id and enough data to render it on both sides
   (e.g. the list of cells of a destroyed object).
3. Sender applies the result locally only after the reply arrives.

The sender shows a pending state until the reply; on `result: 'invalid'` it
rolls back and lets the user retry. This keeps both sides consistent without a
server and prevents a peer from silently rewriting the other's board.

## 6. Deriving turn/state deterministically

Store only facts (who acted, what the result was) and derive UI state from them
on both sides using the same rule, e.g.:

```js
// after resolving an action
me.myTurn = result !== 'miss';
// opponent computes the mirror rule from the same result
```

Never send "now it is your turn" as a separate message — it can desync on a lost
or reordered reply.

## 7. Detecting a dead connection

PeerJS does not always fire `close` when ICE fails (the DataConnection object can
stay `open` while the transport is dead). Add a watchdog:

```js
setInterval(() => {
  if (!connected || !conn) return;
  if (document.visibilityState !== 'visible') { disconnectedSince = 0; return; } // tab asleep: give ICE a chance
  const pc = conn.peerConnection;
  if (!pc) return;
  if (['failed', 'closed'].includes(pc.connectionState) || ['failed', 'closed'].includes(pc.iceConnectionState)) {
    endSession('Связь потеряна');
  } else if (['disconnected'].includes(pc.connectionState) || ['disconnected'].includes(pc.iceConnectionState)) {
    disconnectedSince ||= Date.now();
    if (Date.now() - disconnectedSince > 15000) endSession('Связь потеряна');
  } else {
    disconnectedSince = 0;
  }
}, 4000);
```

Also handle `conn.on('close')`, `conn.on('error')`, `peer.on('close')`, and
`peer.on('error')`. On `visibilitychange → visible`, reset the timer so a phone
that wakes up gets a fresh grace period instead of an instant "connection lost".

## 8. Mobile keep-awake

A locked phone screen pauses JS and can kill the session. Request Screen Wake
Lock whenever the session is active:

```js
let lock = null;
async function keepAwake() {
  if (!navigator.wakeLock || document.visibilityState !== 'visible' || lock) return;
  try {
    lock = await navigator.wakeLock.request('screen');
    lock.addEventListener('release', () => { lock = null; showNote('Блокировка сна снята'); });
    showNote('Экран не погаснет во время игры');
  } catch {
    showNote('Не удалось удержать экран включённым — отключите автоблокировку вручную');
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { lock?.release(); lock = null; }
  else if (sessionActive) keepAwake();
});
```

- Call it on entering the active screen and again inside a tap handler (user
  gesture), because some browsers reject requests without activation.
- Retry periodically (every ~20 s while the session is active); a first request
  can be refused during page load and succeed later.
- Show the "screen stays on" note on phones/tablets (`maxTouchPoints > 0` or a
  narrow viewport); do not clutter the desktop UI where the screen is rarely
  locked by an idle timer.
- Release it when the session ends; keep the UI honest when it is unavailable
  (older Safari, in-app browsers, low-power mode).
- Never rely on it as the only protection: also make a lost connection
  recoverable or at least clearly reported.

## 9. Error UX checklist

- Map PeerJS `err.type` to human text: `peer-unavailable` → "room not found,
  check the code"; `unavailable-id` → retry with a new code; `network` →
  "check internet / try another network"; `browser-incompatible` → "update
  browser"; `webrtc` → "connection failed, try another network or VPN".
- Every failure state gets a primary action (retry / back to lobby), never a
  dead end.
- Do not show raw error objects or PeerJS logs to the user; log them with
  `console.warn` and keep `debug: 0` in production (`?debug` flag for support).
- Confirm destructive exits ("leave game?") instead of dropping the opponent
  silently.

## 10. Verify with two real browsers

Automated checks that catch the real bugs (signaling, ICE, state sync):

- Launch Playwright with installed Chrome (`channel: 'chrome'`), two isolated
  contexts (desktop + mobile viewport), both on the deployed URL.
- Host creates the room, read the code from the DOM, guest opens
  `?room=<code>`, both reach the waiting screen.
- Drive a full session, assert both sides show matching state after each move.
- Assert reconnect/handshake failures by joining a bogus code.
- Run the same suite against the deployed site, not just localhost — Pages
  deployment, HTTPS, and relative asset paths are common breakages.
- Allow a generous first-connect timeout (~45 s) and ignore the expected
  blocked-cloud console errors when the fallback kicks in.

A working harness to copy is in this skill's `references/` directory.

## 11. Common pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| Works on localhost, fails on the phone | page served over `http://` | publish over HTTPS |
| Guest never connects | host tab closed/reloaded; room code stale | keep the host tab open; show explicit "room closed" |
| `conn.send` throws `not-open-yet` | sending before `open` | queue or disable UI until `open` |
| Both sides think it is their turn | turn sent as a message | derive turn from the action result on both sides |
| "Connection lost" right after phone unlock | watchdog counted hidden time | skip counting while hidden, reset on visible |
| Works for the developer, not for a friend abroad | cloud signaling blocked in that network | server fallback encoded in the room code |
| Second `peer.destroy()` throws | double teardown | guard calls, track intentional close |

## 12. Files in this skill

- `references/peerjs-session.js` — dependency-free ES module skeleton: server
  fallback, room codes, connect flow with timeouts, message envelope, watchdog,
  wake lock. Adapt the `handlers` object.
- `references/e2e-two-browsers.mjs` — Playwright template for a two-context P2P
  smoke test against a deployed site.

Reference implementation with a full game on top:
<https://github.com/aladdin-dev/dpskSeaBattle> (`js/app.js`).
