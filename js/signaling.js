import { apiOrigin, normalizeCode } from "./config.js";

// V1.12: liveness. Cloudflare closes a WebSocket after ~100 s without traffic,
// and iOS (dimmed screen, Guided Access, Wi-Fi power save) can leave a socket
// that still says OPEN but is dead (half-open). So:
// - every HEARTBEAT_MS send "ping"; the Worker edge answers "pong" (auto
//   response, does not wake the Durable Object);
// - no pong / no message within PONG_TIMEOUT_MS -> force a fresh socket;
// - a heartbeat tick that comes far too late means the page was frozen ->
//   fresh socket right away (the Worker replays a still-ringing call on hello);
// - messages sent while (re)connecting are queued and sent after "hello"
//   instead of being dropped (a caller tapping "Anrufen" right after the app
//   came back used to lose the call silently);
// - reconnect also on "online" and "focus"; close backoff 1.5 s .. 10 s.
export const HEARTBEAT_MS = 25000;
export const PONG_TIMEOUT_MS = 8000;
const OUTBOX_MAX = 40;
const OUTBOX_TTL_MS = 30000;

export class Signaling {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.personNr = null;
    this.deviceId = null;
    this.code = null;
    this.wanted = false;
    this.outbox = [];
    this.hbTimer = null;
    this.pongTimer = null;
    this.lastTick = 0;
    this.lastRx = 0;
    this.closes = 0;
    this.reopenTimer = null;
    this.stats = { opens: 0, pings: 0, pongs: 0, deadReconnects: 0, frozenReconnects: 0, queued: 0, flushed: 0 };
    this.heartbeatMs = HEARTBEAT_MS;
    this.pongTimeoutMs = PONG_TIMEOUT_MS;
    this._bound = false;
  }

  on(type, fn) {
    this.handlers.set(type, fn);
  }

  connect(code, personNr, deviceId) {
    this.code = normalizeCode(code);
    this.personNr = personNr;
    this.deviceId = deviceId || "";
    this.wanted = true;
    this._bindWindow();
    this._open();
  }

  _bindWindow() {
    if (this._bound || typeof window === "undefined") return;
    this._bound = true;
    const check = () => this.check();
    window.addEventListener("online", () => this.reconnect());
    window.addEventListener("focus", check);
  }

  _open() {
    if (!this.wanted) return;
    clearTimeout(this.reopenTimer);
    this.reopenTimer = null;
    const prev = this.ws;
    this.ws = null;
    if (prev) {
      try { prev.close(); } catch { /* ignore */ }
    }
    const base = apiOrigin().replace(/^http/, "ws");
    const u = new URL(`${base}/api/ws`);
    u.searchParams.set("code", this.code);
    u.searchParams.set("person", String(this.personNr));
    if (this.deviceId) u.searchParams.set("device", this.deviceId);
    const ws = new WebSocket(u);
    this.ws = ws;
    this.stats.opens++;
    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.closes = 0;
      this.lastRx = Date.now();
      this._raw(JSON.stringify({ type: "hello", personNr: this.personNr, deviceId: this.deviceId }));
      this._flush();
      this._startHeartbeat();
    });
    ws.addEventListener("message", (ev) => {
      if (this.ws !== ws || ws.__stall) return;
      this.lastRx = Date.now();
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
      if (ev.data === "pong") {
        this.stats.pongs++;
        return;
      }
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      const fn = this.handlers.get(data.type);
      if (fn) fn(data);
    });
    ws.addEventListener("close", () => {
      if (this.ws !== ws || !this.wanted) return;
      this._stopHeartbeat();
      this.closes++;
      const delay = Math.min(10000, 1500 * Math.pow(1.6, Math.max(0, this.closes - 1)));
      clearTimeout(this.reopenTimer);
      this.reopenTimer = setTimeout(() => this._open(), delay);
    });
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.lastTick = Date.now();
    this.hbTimer = setInterval(() => this._tick(), this.heartbeatMs);
  }

  _stopHeartbeat() {
    clearInterval(this.hbTimer);
    clearTimeout(this.pongTimer);
    this.hbTimer = null;
    this.pongTimer = null;
  }

  _tick() {
    const now = Date.now();
    const late = now - this.lastTick > this.heartbeatMs * 2 + 5000;
    this.lastTick = now;
    if (late) {
      // Timers were frozen (dimmed/locked screen): do not trust the socket.
      this.stats.frozenReconnects++;
      this._open();
      return;
    }
    this.ping();
  }

  // Send "ping"; if nothing at all comes back in time, the socket is dead.
  ping() {
    if (!this.isOpen()) {
      this.reconnect();
      return;
    }
    this._raw("ping");
    this.stats.pings++;
    if (this.pongTimer) return;
    const ws = this.ws;
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      if (this.ws !== ws || !this.wanted) return;
      if (Date.now() - this.lastRx < this.pongTimeoutMs) return;
      this.stats.deadReconnects++;
      this._open();
    }, this.pongTimeoutMs);
  }

  // Cheap check when the page comes back / gets focus.
  check() {
    if (!this.wanted) return;
    if (!this.isOpen()) {
      if (!this.ws || this.ws.readyState !== WebSocket.CONNECTING) this.reconnect();
      return;
    }
    this.ping();
  }

  // V1.06: iOS often leaves a suspended socket looking OPEN but dead. Reopen
  // it (the Worker replays any still-ringing offer on "hello").
  reconnect() {
    if (!this.wanted) return;
    this._open();
  }

  isOpen() {
    return !!(this.ws && this.ws.readyState === WebSocket.OPEN);
  }

  _raw(s) {
    if (this.ws?.__stall) return true; // test: half-open socket swallows everything
    try {
      this.ws.send(s);
      return true;
    } catch {
      return false;
    }
  }

  _flush() {
    const now = Date.now();
    const q = this.outbox.filter((m) => now - m.t < OUTBOX_TTL_MS);
    this.outbox = [];
    for (const m of q) {
      if (this._raw(m.s)) this.stats.flushed++;
    }
  }

  send(msg) {
    const s = JSON.stringify(msg);
    if (this.isOpen() && this._raw(s)) return true;
    // Not connected right now: keep it and send right after the next hello.
    this.outbox.push({ s, t: Date.now() });
    if (this.outbox.length > OUTBOX_MAX) this.outbox.shift();
    this.stats.queued++;
    if (this.wanted && (!this.ws || this.ws.readyState > WebSocket.OPEN)) this.reconnect();
    return false;
  }

  // Test hooks: simulate a half-open socket (still OPEN, nothing gets through),
  // or the device being offline for a while.
  testStall() {
    if (this.ws) this.ws.__stall = true;
  }
  pause() {
    this.wanted = false;
    this._stopHeartbeat();
    clearTimeout(this.reopenTimer);
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;
  }
  resume() {
    if (!this.code || !this.personNr) return;
    this.wanted = true;
    this._open();
  }
  setTiming(heartbeatMs, pongTimeoutMs) {
    this.heartbeatMs = Number(heartbeatMs) || HEARTBEAT_MS;
    this.pongTimeoutMs = Number(pongTimeoutMs) || PONG_TIMEOUT_MS;
    if (this.hbTimer) this._startHeartbeat();
  }

  debug() {
    return {
      open: this.isOpen(),
      readyState: this.ws ? this.ws.readyState : -1,
      outbox: this.outbox.length,
      lastRxAgo: this.lastRx ? Date.now() - this.lastRx : -1,
      ...this.stats,
    };
  }

  close() {
    this.wanted = false;
    this._stopHeartbeat();
    clearTimeout(this.reopenTimer);
    this.outbox = [];
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}
