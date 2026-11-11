import { HannafonRoom } from "./room.js";
import { sendWebPush } from "./push.js";

export { HannafonRoom };

const VERSION = "V1.02";

function normalizeCode(code) {
  return String(code || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

async function sha256Hex(str) {
  const dig = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function codeOk(env, code) {
  const expected = (env.FAMILY_CODE_HASH || "").trim().toLowerCase();
  if (!expected) return false;
  const hash = await sha256Hex(normalizeCode(code));
  if (hash.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function corsHeaders(env, request) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const headers = {
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Family-Code",
    "Access-Control-Max-Age": "86400",
  };
  if (origin && allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  return { allowed: !origin || allowed.includes(origin), headers };
}

function codeFrom(request) {
  const h = request.headers.get("X-Family-Code") || "";
  if (h) return h;
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  const url = new URL(request.url);
  return url.searchParams.get("code") || "";
}

async function getAsset(env, key) {
  const clean = String(key || "").replace(/^\/+/, "").replace(/\.\./g, "");
  if (!clean || clean.endsWith("/")) return null;

  if (env.ASSETS) {
    try {
      const res = await env.ASSETS.fetch(new Request(new URL("/" + clean, "https://hannafon-assets.local")));
      if (res.ok) return res;
    } catch {
      /* fall through */
    }
  }
  if (env.LOCAL_MEDIA_ORIGIN) {
    try {
      const res = await fetch(`${env.LOCAL_MEDIA_ORIGIN.replace(/\/$/, "")}/${clean}`);
      if (res.ok) return res;
    } catch {
      /* fall through */
    }
  }
  return null;
}

function iceServers(env) {
  const servers = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun.cloudflare.com:3478" }];
  if (env.TURN_URL) {
    const turn = { urls: env.TURN_URL };
    if (env.TURN_USER) turn.username = env.TURN_USER;
    if (env.TURN_PASS) turn.credential = env.TURN_PASS;
    servers.push(turn);
  }
  return servers;
}

async function configPayload(env) {
  const asset = await getAsset(env, "people.json");
  if (!asset) return { ok: false, error: "config unavailable" };
  const data = await asset.json();
  return {
    ok: true,
    version: data.version || VERSION,
    vapidPublicKey: env.VAPID_PUBLIC_KEY || "",
    iceServers: iceServers(env),
    photo: data.photo,
    hostNr: data.hostNr,
    people: data.people,
  };
}

function roomStub(env) {
  const id = env.ROOM.idFromName("family");
  return env.ROOM.get(id);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { allowed, headers } = corsHeaders(env, request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: allowed ? 204 : 403, headers });
    }
    if (!allowed) return new Response("origin not allowed", { status: 403, headers });

    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        return Response.json({ ok: true, version: VERSION }, { headers });
      }

      if (url.pathname === "/api/auth" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        if (!(await codeOk(env, body.code))) {
          return Response.json({ ok: false, error: "ungültiger Code" }, { status: 401, headers });
        }
        const cfg = await configPayload(env);
        if (!cfg.ok) return Response.json(cfg, { status: 503, headers });
        return Response.json(cfg, { headers });
      }

      // Everything else under /api requires a valid family code.
      const code = codeFrom(request);
      if (!(await codeOk(env, code))) {
        if (url.pathname.startsWith("/api/")) {
          return Response.json({ ok: false, error: "Code erforderlich" }, { status: 401, headers });
        }
        return new Response("not found", { status: 404, headers });
      }

      if (url.pathname === "/api/config" && request.method === "GET") {
        const cfg = await configPayload(env);
        return Response.json(cfg, { status: cfg.ok ? 200 : 503, headers });
      }

      if (url.pathname.startsWith("/api/media/") && request.method === "GET") {
        const key = url.pathname.slice("/api/media/".length);
        // Never serve people.json as a raw media file via a guessable listing —
        // config goes through /api/config. Still allow explicit names/masks.
        if (!key || key.endsWith("people.json")) {
          return new Response("not found", { status: 404, headers });
        }
        const asset = await getAsset(env, key);
        if (!asset) return new Response("not found", { status: 404, headers });
        const type = asset.headers.get("Content-Type") || guessType(key);
        const body = await asset.arrayBuffer();
        return new Response(body, {
          status: 200,
          headers: {
            ...headers,
            "Content-Type": type,
            "Cache-Control": "private, max-age=31536000, immutable",
          },
        });
      }

      if (url.pathname === "/api/subscribe" && request.method === "POST") {
        const body = await request.json();
        const stub = roomStub(env);
        const res = await stub.fetch("https://room/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        return Response.json(json, { status: res.status, headers });
      }

      if (url.pathname === "/api/unsubscribe" && request.method === "POST") {
        const body = await request.json();
        const stub = roomStub(env);
        const res = await stub.fetch("https://room/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        return Response.json(json, { status: res.status, headers });
      }

      if (url.pathname === "/api/push-test" && request.method === "POST") {
        // Structural / local test helper: encrypt and (attempt to) send one payload.
        const body = await request.json();
        if (!body.subscription) {
          return Response.json({ ok: false, error: "subscription required" }, { status: 400, headers });
        }
        const res = await sendWebPush(thisEnv(env), body.subscription, {
          title: "Hannafon",
          body: body.body || "Hanna ruft an",
          data: { url: "./?incoming=10" },
        });
        return Response.json({ ok: res.ok, status: res.status }, { headers });
      }

      if (url.pathname === "/api/ws") {
        const person = url.searchParams.get("person") || "";
        const stub = roomStub(env);
        return stub.fetch(`https://room/ws?person=${encodeURIComponent(person)}`, request);
      }

      return new Response("not found", { status: 404, headers });
    } catch (err) {
      return Response.json({ ok: false, error: "server error" }, { status: 500, headers });
    }
  },
};

function thisEnv(env) {
  return env;
}

function guessType(key) {
  if (key.endsWith(".webp")) return "image/webp";
  if (key.endsWith(".jpg") || key.endsWith(".jpeg")) return "image/jpeg";
  if (key.endsWith(".png")) return "image/png";
  if (key.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}
