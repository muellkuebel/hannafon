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
    // V1.06: still-ringing offers, so a device that connects late (opened from
    // the push notification, woke from background) still gets the call.
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS pending_calls (
        from_nr INTEGER NOT NULL,
        to_nr INTEGER NOT NULL,
        from_device TEXT,
        call_id TEXT,
        payload TEXT NOT NULL,
        ice TEXT NOT NULL DEFAULT '[]',
        declined TEXT NOT NULL DEFAULT '[]',
        created INTEGER NOT NULL,
        PRIMARY KEY (from_nr, to_nr)
      )
    `);

    // V1.08: missed calls per callee (only numeric face ids + timestamps).
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS missed_calls (
        to_nr INTEGER NOT NULL,
        from_nr INTEGER NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        first_ts INTEGER NOT NULL,
        last_ts INTEGER NOT NULL,
        seen INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (to_nr, from_nr)
      )
    `);

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
      this.replayPending(ws, from, String(data.deviceId || att.deviceId || ""));
      this.sendMissed(from, ws);
      return;
    }

    if (data.type === "sync") {
      this.replayPending(ws, from, fromDevice);
      this.sendMissed(from, ws);
      return;
    }

    // V1.08: the callee opened the list (badge off on all her devices).
    if (data.type === "missed-seen") {
      this.ctx.storage.sql.exec(`UPDATE missed_calls SET seen = 1 WHERE to_nr = ?`, from);
      this.sendMissed(from);
      return;
    }

    // V1.08: drop one entry (or all with nr 0) without calling back.
    if (data.type === "missed-clear") {
      const nr = Number(data.nr) || 0;
      if (nr) this.ctx.storage.sql.exec(`DELETE FROM missed_calls WHERE to_nr = ? AND from_nr = ?`, from, nr);
      else this.ctx.storage.sql.exec(`DELETE FROM missed_calls WHERE to_nr = ?`, from);
      this.sendMissed(from);
      return;
    }

    const payload = { ...data, from, fromDevice };

    if (data.type === "call") {
      const to = Number(data.to);
      if (!to) return;
      // Glare / callback: the callee is already being called by `to`. Do not
      // ring `to` back; hand the caller that ringing offer instead.
      const reverse = this.getPending(to, from);
      if (reverse) {
        this.replayPending(ws, from, fromDevice, { onlyFrom: to, force: true });
        return;
      }
      this.savePending(from, to, fromDevice, data.callId || null, payload);
      this.forwardToPerson(to, payload);
      await this.notifyPush(from, to, data.fromName || "");
      return;
    }

    if (data.type === "answer") {
      const to = Number(data.to);
      if (!to) return;
      this.clearPending(to, from);
      // V1.08: they talked. The answerer's missed entry for the caller goes
      // (accepted call), and so does the caller's entry for the answerer
      // (successful callback).
      this.clearMissed(from, to);
      this.clearMissed(to, from);
      if (data.toDevice) this.forwardToDevice(to, data.toDevice, payload);
      else this.forwardToPerson(to, payload);
      // First acceptor wins: tell the person's other devices to stop ringing.
      this.forwardToPerson(from, { type: "taken", from, callId: data.callId || null }, { exceptWs: ws });
      return;
    }

    if (data.type === "ice") {
      const to = Number(data.to);
      if (!to) return;
      if (data.candidate) this.addPendingIce(from, to, data.candidate);
      if (data.toDevice) this.forwardToDevice(to, data.toDevice, payload);
      else this.forwardToPerson(to, payload);
      return;
    }

    if (data.type === "hangup") {
      const to = Number(data.to);
      if (!to) return;
      // V1.08: caller gave up while it was still ringing -> missed.
      this.endPending(from, to);
      this.forwardToPerson(to, payload);
      return;
    }

    if (data.type === "reject") {
      // Local decline stays on this device — other devices keep ringing — but
      // this device must not get the offer replayed again.
      const caller = Number(data.to);
      if (caller && fromDevice) {
        this.declinePending(caller, from, fromDevice);
        // V1.09: once every connected device of this person declined, tell the
        // caller (a group call drops that tile; 1:1 ignores it and keeps
        // waiting as before). Nothing is cleared here: the caller's hangup
        // ends the ring, and a declined ring never counts as missed.
        if (this.allDeclined(caller, from)) {
          this.forwardToPerson(caller, { type: "declined", from, callId: data.callId || null });
        }
      }
      return;
    }

    // V1.09 group calls (mesh): pure relays between participants. No pending
    // rows, no push, no missed calls — those stay with the host's "call".
    if (HannafonRoom.GROUP_RELAY.has(data.type)) {
      const to = Number(data.to);
      if (!to || to === from) return;
      if (data.toDevice) this.forwardToDevice(to, data.toDevice, payload);
      else this.forwardToPerson(to, payload);
      return;
    }
  }

  static GROUP_RELAY = new Set(["peer-join", "peer-offer", "peer-answer", "peer-ice", "peer-leave", "group-state"]);

  // Every currently connected device of `toNr` declined the ring from `fromNr`.
  allDeclined(fromNr, toNr) {
    const row = this.getPending(fromNr, toNr);
    if (!row) return false;
    let declined = [];
    try { declined = JSON.parse(row.declined) || []; } catch { declined = []; }
    if (!declined.length) return false;
    const set = this.byPerson.get(toNr);
    if (!set) return true;
    for (const sock of set) {
      const id = this.att(sock).deviceId || "";
      if (id && !declined.includes(id)) return false;
    }
    return true;
  }

  async webSocketClose(ws) {
    this.dropPendingFromSocket(ws);
    this.remove(ws);
  }

  async webSocketError(ws) {
    this.dropPendingFromSocket(ws);
    this.remove(ws);
  }

  // ---- V1.06 pending (still ringing) calls -------------------------------

  static PENDING_TTL_MS = 300000; // caller must also still be connected

  getPending(fromNr, toNr) {
    this.sweepExpired();
    for (const row of this.ctx.storage.sql.exec(
      `SELECT * FROM pending_calls WHERE from_nr = ? AND to_nr = ?`,
      fromNr,
      toNr
    )) return row;
    return null;
  }

  savePending(fromNr, toNr, fromDevice, callId, payload) {
    const { candidate, ...clean } = payload;
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO pending_calls (from_nr, to_nr, from_device, call_id, payload, ice, declined, created)
       VALUES (?, ?, ?, ?, ?, '[]', '[]', ?)`,
      fromNr,
      toNr,
      fromDevice || "",
      callId || "",
      JSON.stringify(clean),
      Date.now()
    );
    // V1.08: wake up when the ring expires, so an unanswered call becomes
    // "missed" even if nobody touches the room again.
    Promise.resolve(this.ctx.storage.setAlarm(Date.now() + HannafonRoom.PENDING_TTL_MS + 2000)).catch(() => {});
  }

  clearPending(fromNr, toNr) {
    this.ctx.storage.sql.exec(`DELETE FROM pending_calls WHERE from_nr = ? AND to_nr = ?`, fromNr, toNr);
  }

  addPendingIce(fromNr, toNr, candidate) {
    const row = this.getPending(fromNr, toNr);
    if (!row) return;
    let ice = [];
    try { ice = JSON.parse(row.ice) || []; } catch { ice = []; }
    if (ice.length >= 40) return;
    ice.push(candidate);
    this.ctx.storage.sql.exec(
      `UPDATE pending_calls SET ice = ? WHERE from_nr = ? AND to_nr = ?`,
      JSON.stringify(ice),
      fromNr,
      toNr
    );
  }

  declinePending(fromNr, toNr, deviceId) {
    const row = this.getPending(fromNr, toNr);
    if (!row) return;
    let declined = [];
    try { declined = JSON.parse(row.declined) || []; } catch { declined = []; }
    if (!declined.includes(deviceId)) declined.push(deviceId);
    this.ctx.storage.sql.exec(
      `UPDATE pending_calls SET declined = ? WHERE from_nr = ? AND to_nr = ?`,
      JSON.stringify(declined),
      fromNr,
      toNr
    );
  }

  // The caller's device went away: its offer can no longer be answered.
  dropPendingFromSocket(ws) {
    const att = this.att(ws);
    const nr = Number(att.personNr) || 0;
    const dev = att.deviceId || "";
    if (!nr || !dev) return;
    const others = [...(this.byPerson.get(nr) || [])].some((s) => s !== ws && (this.att(s).deviceId || "") === dev);
    if (others) return;
    const ended = [];
    for (const row of this.ctx.storage.sql.exec(
      `SELECT from_nr, to_nr FROM pending_calls WHERE from_nr = ? AND from_device = ?`, nr, dev
    )) ended.push([row.from_nr, row.to_nr]);
    for (const [f, t] of ended) this.endPending(f, t);
  }

  // ---- V1.08 missed calls ------------------------------------------------

  static MISSED_KEEP_MS = 14 * 24 * 3600 * 1000;

  async alarm() {
    this.sweepExpired();
  }

  // Expired ringing offers are missed calls (unless the callee declined).
  sweepExpired() {
    const cutoff = Date.now() - HannafonRoom.PENDING_TTL_MS;
    const ended = [];
    for (const row of this.ctx.storage.sql.exec(
      `SELECT from_nr, to_nr FROM pending_calls WHERE created < ?`, cutoff
    )) ended.push([row.from_nr, row.to_nr]);
    for (const [f, t] of ended) this.endPending(f, t);
  }

  // A ringing offer ends without an answer: record a missed call for the
  // callee, unless one of her devices declined it (then she noticed).
  endPending(fromNr, toNr) {
    let row = null;
    for (const r of this.ctx.storage.sql.exec(
      `SELECT declined, created FROM pending_calls WHERE from_nr = ? AND to_nr = ?`, fromNr, toNr
    )) row = r;
    if (!row) return false;
    this.clearPending(fromNr, toNr);
    let declined = [];
    try { declined = JSON.parse(row.declined) || []; } catch { declined = []; }
    if (declined.length) return false;
    this.recordMissed(fromNr, toNr, Number(row.created) || Date.now());
    return true;
  }

  recordMissed(fromNr, toNr, ts = Date.now()) {
    if (!fromNr || !toNr || fromNr === toNr) return;
    this.ctx.storage.sql.exec(
      `INSERT INTO missed_calls (to_nr, from_nr, count, first_ts, last_ts, seen) VALUES (?, ?, 1, ?, ?, 0)
       ON CONFLICT(to_nr, from_nr) DO UPDATE SET count = count + 1, last_ts = excluded.last_ts, seen = 0`,
      toNr, fromNr, ts, ts
    );
    this.sendMissed(toNr);
  }

  clearMissed(toNr, fromNr) {
    let had = false;
    for (const _ of this.ctx.storage.sql.exec(
      `SELECT 1 FROM missed_calls WHERE to_nr = ? AND from_nr = ?`, toNr, fromNr
    )) had = true;
    if (!had) return;
    this.ctx.storage.sql.exec(`DELETE FROM missed_calls WHERE to_nr = ? AND from_nr = ?`, toNr, fromNr);
    this.sendMissed(toNr);
  }

  missedFor(toNr) {
    this.ctx.storage.sql.exec(`DELETE FROM missed_calls WHERE last_ts < ?`, Date.now() - HannafonRoom.MISSED_KEEP_MS);
    const items = [];
    for (const r of this.ctx.storage.sql.exec(
      `SELECT from_nr, count, last_ts, seen FROM missed_calls WHERE to_nr = ? ORDER BY last_ts DESC`, toNr
    )) items.push({ from: r.from_nr, count: r.count, last: r.last_ts, seen: !!r.seen });
    return items;
  }

  // To one socket (on hello/sync) or to all of the person's devices.
  sendMissed(toNr, ws = null) {
    if (!toNr) return;
    const msg = { type: "missed", items: this.missedFor(toNr), now: Date.now() };
    if (ws) {
      try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
    } else {
      this.forwardToPerson(toNr, msg);
    }
  }

  replayPending(ws, personNr, deviceId, { onlyFrom = 0, force = false } = {}) {
    if (!personNr) return 0;
    this.sweepExpired();
    let n = 0;
    for (const row of this.ctx.storage.sql.exec(`SELECT * FROM pending_calls WHERE to_nr = ?`, personNr)) {
      if (onlyFrom && row.from_nr !== onlyFrom) continue;
      let declined = [];
      try { declined = JSON.parse(row.declined) || []; } catch { declined = []; }
      if (!force && deviceId && declined.includes(deviceId)) continue;
      let msg;
      let ice = [];
      try {
        msg = JSON.parse(row.payload);
        ice = JSON.parse(row.ice) || [];
      } catch {
        continue;
      }
      try {
        ws.send(JSON.stringify({ ...msg, type: "call", replay: true, ice, age: Date.now() - row.created }));
        n++;
      } catch {
        /* ignore */
      }
    }
    return n;
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
