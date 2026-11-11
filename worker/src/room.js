import { sendWebPush } from "./push.js";

export class HannafonRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.byPerson = new Map();

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS pushes (
        endpoint TEXT PRIMARY KEY,
        person_nr INTEGER NOT NULL,
        subscription TEXT NOT NULL,
        created INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        person_nr INTEGER NOT NULL,
        endpoint TEXT,
        subscription TEXT,
        created INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS devices_person ON devices(person_nr)`);

    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() || {};
      this.add(ws, Number(att.personNr) || 0, att.deviceId || "");
    }
  }

  add(ws, personNr, deviceId) {
    let set = this.byPerson.get(personNr);
    if (!set) {
      set = new Set();
      this.byPerson.set(personNr, set);
    }
    set.add(ws);
  }

  remove(ws) {
    for (const [nr, set] of this.byPerson) {
      if (set.delete(ws) && set.size === 0) this.byPerson.delete(nr);
    }
  }

  att(ws) {
    return ws.deserializeAttachment() || {};
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      const personNr = Number(url.searchParams.get("person") || "0");
      const deviceId = String(url.searchParams.get("device") || "");
      if (!personNr) return new Response("person required", { status: 400 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ personNr, deviceId });
      this.add(pair[1], personNr, deviceId);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname === "/subscribe" && request.method === "POST") {
      const body = await request.json();
      const sub = body.subscription;
      const personNr = Number(body.personNr);
      const deviceId = String(body.deviceId || "");
      if (!sub?.endpoint || !personNr || !deviceId) {
        return Response.json({ ok: false }, { status: 400 });
      }
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO devices (device_id, person_nr, endpoint, subscription, created) VALUES (?, ?, ?, ?, ?)`,
        deviceId,
        personNr,
        sub.endpoint,
        JSON.stringify(sub),
        Date.now()
      );
      // Also keep endpoint row so two devices never share one slot.
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO pushes (endpoint, person_nr, subscription, created) VALUES (?, ?, ?, ?)`,
        sub.endpoint,
        personNr,
        JSON.stringify(sub),
        Date.now()
      );
      return Response.json({ ok: true });
    }

    if (url.pathname === "/unsubscribe" && request.method === "POST") {
      const body = await request.json();
      if (body.deviceId) {
        const rows = this.ctx.storage.sql.exec(
          `SELECT endpoint FROM devices WHERE device_id = ?`,
          String(body.deviceId)
        );
        for (const row of rows) {
          if (row.endpoint) {
            this.ctx.storage.sql.exec(`DELETE FROM pushes WHERE endpoint = ?`, row.endpoint);
          }
        }
        this.ctx.storage.sql.exec(`DELETE FROM devices WHERE device_id = ?`, String(body.deviceId));
      }
      if (body.endpoint) {
        this.ctx.storage.sql.exec(`DELETE FROM pushes WHERE endpoint = ?`, body.endpoint);
        this.ctx.storage.sql.exec(`DELETE FROM devices WHERE endpoint = ?`, body.endpoint);
      }
      return Response.json({ ok: true });
    }

    if (url.pathname === "/push-status" && request.method === "GET") {
      return Response.json(this.pushStatus());
    }

    if (url.pathname === "/push-test" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const result = await this.sendTestPush(body);
      return Response.json(result, { status: result.ok ? 200 : 502 });
    }

    return new Response("not found", { status: 404 });
  }

  async webSocketMessage(ws, message) {
    let data;
    try {
      data = JSON.parse(typeof message === "string" ? message : new TextDecoder().decode(message));
    } catch {
      return;
    }
    const att = this.att(ws);
    const from = Number(att.personNr) || Number(data.from) || 0;
    const fromDevice = att.deviceId || data.fromDevice || "";
    if (data.type === "hello") {
      if (data.deviceId && data.deviceId !== att.deviceId) {
        ws.serializeAttachment({ personNr: from, deviceId: String(data.deviceId) });
      }
      return;
    }

    const payload = { ...data, from, fromDevice };

    if (data.type === "call") {
      const to = Number(data.to);
      if (!to) return;
      this.forwardToPerson(to, payload);
      await this.notifyPush(from, to, data.fromName || "");
      return;
    }

    if (data.type === "answer") {
      const to = Number(data.to);
      if (!to) return;
      if (data.toDevice) this.forwardToDevice(to, data.toDevice, payload);
      else this.forwardToPerson(to, payload);
      // First acceptor wins: tell the person's other devices to stop ringing.
      this.forwardToPerson(from, { type: "taken", from, callId: data.callId || null }, { exceptWs: ws });
      return;
    }

    if (data.type === "ice") {
      const to = Number(data.to);
      if (!to) return;
      if (data.toDevice) this.forwardToDevice(to, data.toDevice, payload);
      else this.forwardToPerson(to, payload);
      return;
    }

    if (data.type === "hangup") {
      const to = Number(data.to);
      if (!to) return;
      this.forwardToPerson(to, payload);
      return;
    }

    // reject / local-decline stay on this device only — other devices keep ringing.
  }

  async webSocketClose(ws) {
    this.remove(ws);
  }

  async webSocketError(ws) {
    this.remove(ws);
  }

  forwardToPerson(to, msg, { exceptWs, exceptDevice } = {}) {
    const set = this.byPerson.get(to);
    if (!set || set.size === 0) return false;
    const s = JSON.stringify(msg);
    let sent = false;
    for (const sock of set) {
      if (exceptWs && sock === exceptWs) continue;
      const id = this.att(sock).deviceId || "";
      if (exceptDevice && id && id === exceptDevice) continue;
      try {
        sock.send(s);
        sent = true;
      } catch {
        /* ignore */
      }
    }
    return sent;
  }

  forwardToDevice(personNr, deviceId, msg) {
    const set = this.byPerson.get(personNr);
    if (!set || !deviceId) return false;
    const s = JSON.stringify(msg);
    let sent = false;
    for (const sock of set) {
      if ((this.att(sock).deviceId || "") !== deviceId) continue;
      try {
        sock.send(s);
        sent = true;
      } catch {
        /* ignore */
      }
    }
    return sent;
  }

  async notifyPush(from, to, fromName) {
    const seen = new Set();
    const queue = [];
    for (const row of this.ctx.storage.sql.exec(
      `SELECT endpoint, subscription FROM devices WHERE person_nr = ? AND subscription IS NOT NULL`,
      to
    )) {
      if (row.endpoint && !seen.has(row.endpoint)) {
        seen.add(row.endpoint);
        queue.push(row);
      }
    }
    for (const row of this.ctx.storage.sql.exec(
      `SELECT endpoint, subscription FROM pushes WHERE person_nr = ?`,
      to
    )) {
      if (row.endpoint && !seen.has(row.endpoint)) {
        seen.add(row.endpoint);
        queue.push(row);
      }
    }

    const body = fromName ? `${fromName} ruft an` : "Eingehender Anruf";
    const payload = {
      title: "Hannafon",
      body,
      data: { url: `/hannafon/?incoming=${from}`, from, fromName },
    };
    const stale = [];
    const results = [];
    for (const row of queue) {
      try {
        const sub = JSON.parse(row.subscription);
        const res = await sendWebPush(this.env, sub, payload);
        results.push({ host: res.host, status: res.status, ok: res.ok });
        if (res.status === 404 || res.status === 410) stale.push(row.endpoint);
      } catch (err) {
        results.push({ ok: false, error: "send_failed" });
        console.log("hannafon push exception", String(err && err.message ? err.message : err).slice(0, 180));
      }
    }
    console.log("hannafon push batch", JSON.stringify({ to, from, count: queue.length, results }));
    for (const endpoint of stale) {
      this.ctx.storage.sql.exec(`DELETE FROM pushes WHERE endpoint = ?`, endpoint);
      this.ctx.storage.sql.exec(`DELETE FROM devices WHERE endpoint = ?`, endpoint);
    }
    return { ok: true, count: queue.length, results };
  }

  pushStatus() {
    const devices = [];
    for (const row of this.ctx.storage.sql.exec(
      `SELECT device_id, person_nr, endpoint, subscription, created FROM devices`
    )) {
      let host = "";
      let hasKeys = false;
      try {
        if (row.endpoint) host = new URL(row.endpoint).host;
        const sub = row.subscription ? JSON.parse(row.subscription) : null;
        hasKeys = !!(sub && sub.keys && sub.keys.p256dh && sub.keys.auth);
      } catch {
        /* ignore */
      }
      devices.push({
        personNr: row.person_nr,
        hasDeviceId: !!row.device_id,
        endpointHost: host,
        hasKeys,
        created: row.created,
      });
    }
    return { ok: true, count: devices.length, devices };
  }

  async sendTestPush(body = {}) {
    const deviceId = body.deviceId ? String(body.deviceId) : "";
    const personNr = Number(body.personNr || 0);
    const rows = [];
    if (deviceId) {
      for (const row of this.ctx.storage.sql.exec(
        `SELECT endpoint, subscription, person_nr FROM devices WHERE device_id = ?`,
        deviceId
      )) rows.push(row);
    } else if (personNr) {
      for (const row of this.ctx.storage.sql.exec(
        `SELECT endpoint, subscription, person_nr FROM devices WHERE person_nr = ? AND subscription IS NOT NULL`,
        personNr
      )) rows.push(row);
    }
    if (!rows.length) return { ok: false, error: "no_subscription", sent: 0 };
    const payload = {
      title: "Hannafon",
      body: "Test-Mitteilung · so siehst du, wenn Hanna anruft",
      data: { url: "/hannafon/", test: true },
    };
    const results = [];
    const stale = [];
    for (const row of rows) {
      try {
        const sub = JSON.parse(row.subscription);
        const res = await sendWebPush(this.env, sub, payload);
        results.push({ host: res.host, status: res.status, ok: res.ok });
        if (res.status === 404 || res.status === 410) stale.push(row.endpoint);
      } catch (err) {
        results.push({ ok: false, error: "send_failed" });
        console.log("hannafon push exception", String(err && err.message ? err.message : err).slice(0, 180));
      }
    }
    for (const endpoint of stale) {
      this.ctx.storage.sql.exec(`DELETE FROM pushes WHERE endpoint = ?`, endpoint);
      this.ctx.storage.sql.exec(`DELETE FROM devices WHERE endpoint = ?`, endpoint);
    }
    const ok = results.some((r) => r.ok);
    console.log("hannafon push test", JSON.stringify({ sent: results.length, results }));
    return { ok, sent: results.length, results };
  }
}
