import { apiOrigin, MEDIA_CACHE, normalizeCode } from "./config.js";

export function codeHeaders(code, json = true) {
  const headers = { "X-Family-Code": normalizeCode(code) };
  if (json) headers["Content-Type"] = "application/json";
  return headers;
}

export async function auth(code) {
  const res = await fetch(`${apiOrigin()}/api/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: normalizeCode(code) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || "ungültiger Code");
  return data;
}

export async function loadConfig(code) {
  const res = await fetch(`${apiOrigin()}/api/config`, { headers: codeHeaders(code, false) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || "keine Verbindung");
  return data;
}

const objectUrls = new Map();

export async function mediaUrl(code, path) {
  if (objectUrls.has(path)) return objectUrls.get(path);
  const cache = await caches.open(MEDIA_CACHE);
  const key = new Request(`${apiOrigin()}/api/media/${path}`);
  let res = await cache.match(key);
  if (!res) {
    res = await fetch(key, { headers: { "X-Family-Code": normalizeCode(code) } });
    if (!res.ok) throw new Error("Bild fehlt");
    await cache.put(key, res.clone());
  }
  const url = URL.createObjectURL(await res.blob());
  objectUrls.set(path, url);
  return url;
}

export function revokeMedia() {
  for (const u of objectUrls.values()) URL.revokeObjectURL(u);
  objectUrls.clear();
}

export async function clearMediaCache() {
  revokeMedia();
  await caches.delete(MEDIA_CACHE);
}

export async function postSubscribe(code, personNr, subscription, deviceId) {
  const res = await fetch(`${apiOrigin()}/api/subscribe`, {
    method: "POST",
    headers: codeHeaders(code),
    body: JSON.stringify({ personNr, subscription, deviceId }),
  });
  return res.ok;
}

export async function postUnsubscribe(code, { endpoint, deviceId } = {}) {
  await fetch(`${apiOrigin()}/api/unsubscribe`, {
    method: "POST",
    headers: codeHeaders(code),
    body: JSON.stringify({ endpoint, deviceId }),
  }).catch(() => {});
}

export function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function postPushTest(code, { deviceId, personNr } = {}) {
  const res = await fetch(`${apiOrigin()}/api/push-test`, {
    method: "POST",
    headers: codeHeaders(code),
    body: JSON.stringify({ deviceId, personNr }),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && data.ok, status: res.status, data };
}

export async function getPushStatus(code) {
  const res = await fetch(`${apiOrigin()}/api/push-status`, { headers: codeHeaders(code, false) });
  return res.json().catch(() => ({ ok: false }));
}
