import { apiOrigin, normalizeCode } from "./config.js";

export class Signaling {
  constructor() {
    this.ws = null;
    this.handlers = new Map();
    this.personNr = null;
    this.deviceId = null;
    this.code = null;
    this.wanted = false;
  }

  on(type, fn) {
    this.handlers.set(type, fn);
  }

  connect(code, personNr, deviceId) {
    this.code = normalizeCode(code);
    this.personNr = personNr;
    this.deviceId = deviceId || "";
    this.wanted = true;
    this._open();
  }

  _open() {
    if (!this.wanted) return;
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
    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.send({ type: "hello", personNr: this.personNr, deviceId: this.deviceId });
    });
    ws.addEventListener("message", (ev) => {
      if (this.ws !== ws) return;
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
      if (this.ws === ws && this.wanted) setTimeout(() => this._open(), 1500);
    });
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

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close() {
    this.wanted = false;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }
}
