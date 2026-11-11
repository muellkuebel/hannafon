export const VERSION = "V1.02";
export const STORAGE_CODE = "hannafon-family-code";
export const STORAGE_IDENTITY = "hannafon-identity";
export const MEDIA_CACHE = "hannafon-media-v1.01";
export const STORAGE_DEVICE = "hannafon-device-id";

export function apiOrigin() {
  if (typeof window !== "undefined" && window.__HANNAFON_API__) return window.__HANNAFON_API__;
  const { protocol, hostname } = location;
  if (hostname === "127.0.0.1" || hostname === "localhost") {
    return `${protocol}//${hostname}:8787`;
  }
  return "https://hannafon.muellkuebel.workers.dev";
}

export function normalizeCode(code) {
  return String(code || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function isHostPerson(person, config) {
  // Caller role is tied to hostNr (10), never to the display name.
  const nr = typeof person === "object" ? Number(person?.nr) : Number(person);
  return nr === Number(config?.hostNr);
}

export function isTappable(person) {
  if (!person) return false;
  if (person.tappable === false) return false;
  return true;
}

export function getDeviceId() {
  let id = localStorage.getItem(STORAGE_DEVICE);
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) || `d-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(STORAGE_DEVICE, id);
  }
  return id;
}
