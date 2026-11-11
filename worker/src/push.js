// Web Push helpers (VAPID + aes128gcm), copied from the money-bot worker
// (read/copy only). TTL and Urgency are Hannafon-specific: ~60s / high.

function b64urlToBytes(s) {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function concatBytes(...parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function textBytes(str) {
  return new TextEncoder().encode(str);
}

async function vapidKeyPair(env) {
  const d = env.VAPID_PRIVATE_KEY;
  const pub = env.VAPID_PUBLIC_KEY;
  const pubBytes = b64urlToBytes(pub);
  if (pubBytes.length !== 65 || pubBytes[0] !== 0x04) throw new Error("bad vapid public");
  const x = bytesToB64url(pubBytes.slice(1, 33));
  const y = bytesToB64url(pubBytes.slice(33, 65));
  const priv = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d, x, y, ext: true },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  return { priv, pub, pubBytes };
}

async function createVapidJwt(env, audience) {
  const { priv, pub } = await vapidKeyPair(env);
  const header = bytesToB64url(textBytes(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const claims = bytesToB64url(
    textBytes(JSON.stringify({ aud: audience, exp, sub: env.VAPID_SUBJECT || "mailto:hannafon-local@localhost" }))
  );
  const data = textBytes(`${header}.${claims}`);
  const sigDer = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, data));
  const sig = derEcdsaToJose(sigDer);
  return { jwt: `${header}.${claims}.${bytesToB64url(sig)}`, pub };
}

function derEcdsaToJose(sig) {
  if (sig.length === 64) return sig;
  let i = 0;
  if (sig[i++] !== 0x30) return sig.slice(0, 64);
  let seqLen = sig[i++];
  if (seqLen & 0x80) {
    const n = seqLen & 0x7f;
    seqLen = 0;
    for (let k = 0; k < n; k++) seqLen = (seqLen << 8) | sig[i++];
  }
  if (sig[i++] !== 0x02) return sig.slice(0, 64);
  let rLen = sig[i++];
  let r = sig.slice(i, i + rLen);
  i += rLen;
  if (sig[i++] !== 0x02) return sig.slice(0, 64);
  let sLen = sig[i++];
  let s = sig.slice(i, i + sLen);
  while (r.length > 32 && r[0] === 0) r = r.slice(1);
  while (s.length > 32 && s[0] === 0) s = s.slice(1);
  const out = new Uint8Array(64);
  out.set(r, 32 - r.length);
  out.set(s, 64 - s.length);
  return out;
}

async function hkdfExtract(salt, ikm) {
  const saltKey = await crypto.subtle.importKey(
    "raw",
    salt,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", saltKey, ikm));
}

async function hkdfExpand(prk, info, length) {
  const key = await crypto.subtle.importKey("raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const out = new Uint8Array(length);
  let t = new Uint8Array(0);
  let offset = 0;
  let counter = 1;
  while (offset < length) {
    const input = concatBytes(t, info, new Uint8Array([counter]));
    t = new Uint8Array(await crypto.subtle.sign("HMAC", key, input));
    const take = Math.min(t.length, length - offset);
    out.set(t.slice(0, take), offset);
    offset += take;
    counter++;
  }
  return out;
}

async function encryptPushPayload(payloadStr, p256dhB64, authB64) {
  const clientPublic = b64urlToBytes(p256dhB64);
  const authSecret = b64urlToBytes(authB64);
  if (clientPublic.length !== 65 || clientPublic[0] !== 0x04) throw new Error("bad p256dh");
  if (authSecret.length !== 16) throw new Error("bad auth");

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const localPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));

  const clientKey = await crypto.subtle.importKey("raw", clientPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: clientKey }, local.privateKey, 256));

  const authInfo = concatBytes(textBytes("WebPush: info\0"), clientPublic, localPubRaw);
  const prk1 = await hkdfExtract(authSecret, shared);
  const ikm = await hkdfExpand(prk1, authInfo, 32);

  const prk2 = await hkdfExtract(salt, ikm);
  const cek = await hkdfExpand(prk2, textBytes("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfExpand(prk2, textBytes("Content-Encoding: nonce\0"), 12);

  const plaintext = concatBytes(textBytes(payloadStr), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintext)
  );

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  const header = concatBytes(salt, rs, new Uint8Array([localPubRaw.length]), localPubRaw);
  return concatBytes(header, encrypted);
}

export async function sendWebPush(env, subscription, payloadObj) {
  const endpoint = subscription.endpoint;
  const keys = subscription.keys || {};
  if (!endpoint || !keys.p256dh || !keys.auth) throw new Error("bad subscription");

  const body = await encryptPushPayload(JSON.stringify(payloadObj), keys.p256dh, keys.auth);
  const aud = new URL(endpoint).origin;
  const { jwt, pub } = await createVapidJwt(env, aud);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${jwt}, k=${pub}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "60",
      Urgency: "high",
    },
    body,
  });
  return res;
}
