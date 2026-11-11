import {
  VERSION,
  STORAGE_CODE,
  STORAGE_IDENTITY,
  STORAGE_DEVICE,
  MEDIA_CACHE,
  normalizeCode,
  isHostPerson,
  isTappable,
  getDeviceId,
} from "./config.js";
import {
  auth,
  loadConfig,
  mediaUrl,
  clearMediaCache,
  revokeMedia,
  postSubscribe,
  postUnsubscribe,
  postPushTest,
  urlBase64ToUint8Array,
} from "./api.js";
import { Signaling } from "./signaling.js";
import {
  getLocalStream,
  createPeer,
  addIce,
  flushIce,
  stopStream,
  closePeer,
} from "./webrtc.js";
import {
  startRingtone,
  stopRingtone,
  unlockAudio,
  isAudioUnlocked,
  audioContextState,
  bindAudioUnlock,
} from "./audio.js";

const $ = (id) => document.getElementById(id);

const ui = {
  code: $("screen-code"),
  photo: $("screen-photo"),
  standby: $("screen-standby"),
  incoming: $("screen-incoming"),
  call: $("screen-call"),
  stage: $("photo-stage"),
  stack: $("photo-stack"),
  sharp: $("photo-sharp"),
  blur: $("photo-blur"),
  blurFill: $("photo-blur-fill"),
  topfade: $("topfade"),
  hits: $("hit-layer"),
  greeting: $("greeting"),
  greet1: $("greeting-line1"),
  greet2: $("greeting-line2"),
  setupTitle: $("setup-title"),
  zoomCard: $("zoom-card"),
  zoomName: $("zoom-name"),
  btnConfirm: $("btn-confirm"),
  btnCall: $("btn-call"),
  zoomSoon: $("zoom-soon"),
  wordmark: $("wordmark"),
  resetSheet: $("reset-sheet"),
  codeForm: $("code-form"),
  codeInput: $("code-input"),
  codeError: $("code-error"),
  standbyHello: $("standby-hello"),
  standbySub: $("standby-sub"),
  standbyNote: $("standby-note"),
  btnCallHost: $("btn-call-host"),
  btnCallHostLabel: $("btn-call-host-label"),
  hostFaceWrap: $("host-face-wrap"),
  hostFace: $("host-face"),
  installHint: $("install-hint"),
  btnNotify: $("btn-notify"),
  btnPushTest: $("btn-push-test"),
  pushStatus: $("push-status"),
  incomingTitle: $("incoming-title"),
  ringHint: $("ring-hint"),
  btnAccept: $("btn-accept"),
  btnDecline: $("btn-decline"),
  remoteVideo: $("remote-video"),
  localVideo: $("local-video"),
  callStatus: $("call-status"),
  btnHangup: $("btn-hangup"),
  btnReset: $("btn-reset"),
  btnResetCancel: $("btn-reset-cancel"),
  btnDisconnect: $("btn-disconnect"),
  disconnectSheet: $("disconnect-sheet"),
  disconnectCopy: $("disconnect-copy"),
  btnDisconnectConfirm: $("btn-disconnect-confirm"),
  btnDisconnectCancel: $("btn-disconnect-cancel"),
  takenToast: $("taken-toast"),
};

const state = {
  code: "",
  config: null,
  identity: null,
  mode: null, // "setup" | "host" | "standby"
  zoomed: null,
  layout: null,
  maskUrls: new Map(),
  signaling: new Signaling(),
  pc: null,
  localStream: null,
  remoteStream: null,
  pendingOffer: null,
  pendingFrom: null,
  inCallWith: null,
  outgoing: false,
  nav: { s: 1, x: 0, y: 0 },
  view: { tx: 0, ty: 0, s: 1 },
  navUser: false,
  lastViewportKey: "",
  callId: null,
  peerDevice: null,
  pendingFromDevice: null,
  gestureMoved: false,
};

function showScreen(name) {
  const showPhoto = name === "photo" || name === "incoming";
  for (const key of ["code", "photo", "standby", "incoming", "call"]) {
    const el = ui[key];
    const on = key === name || (key === "photo" && showPhoto);
    el.classList.toggle("hidden", !on);
    el.hidden = !on;
  }
  const app = document.getElementById("app");
  app.classList.toggle("is-photo", showPhoto);
  app.classList.toggle("is-in-call", name === "call");
  if (!showPhoto) app.classList.remove("is-zoomed");
}

function setZoomedClass(on) {
  ui.stage.classList.toggle("is-zoomed", on);
  document.getElementById("app").classList.toggle("is-zoomed", on);
  if (ui.topfade) ui.topfade.classList.toggle("is-hidden", on);
}

function show(el, on) {
  if (!el) return;
  el.classList.toggle("hidden", !on);
  el.hidden = !on;
}

function hostPerson() {
  const cfg = state.config;
  if (!cfg) return null;
  return (cfg.people || []).find((p) => isHostPerson(p, cfg)) || null;
}

function personByNr(nr) {
  return (state.config?.people || []).find((p) => Number(p.nr) === Number(nr)) || null;
}

function photoLayout(viewW, viewH, photoW, photoH) {
  // Portrait (iPhone): contain the whole group so every head is tappable.
  // Landscape (iPad): cover the viewport as in the mockups.
  const contain = viewH > viewW;
  const scale = contain
    ? Math.min(viewW / photoW, viewH / photoH)
    : Math.max(viewW / photoW, viewH / photoH);
  const dw = photoW * scale;
  const dh = photoH * scale;
  const ox = (viewW - dw) / 2;
  const oy = (viewH - dh) / 2;
  return { scale, ox, oy, dw, dh, contain };
}

function origToPhoto(p, photo) {
  const sx = photo.width / photo.original[0];
  const sy = photo.height / photo.original[1];
  return { x: p.cx * sx, y: p.cy * sy, r: p.r * sx };
}

function applyStageLayout() {
  const cfg = state.config;
  if (!cfg?.photo) return;
  const rect = ui.stage.getBoundingClientRect();
  const layout = photoLayout(rect.width, rect.height, cfg.photo.width, cfg.photo.height);
  state.layout = layout;
  ui.stack.style.width = `${layout.dw}px`;
  ui.stack.style.height = `${layout.dh}px`;
  ui.stack.style.left = `${layout.ox}px`;
  ui.stack.style.top = `${layout.oy}px`;
  ui.stage.classList.toggle("is-pannable", !!layout.contain && !state.zoomed);
  if (!layout.contain) {
    state.nav = { s: 1, x: 0, y: 0 };
    state.navUser = false;
  } else if (!state.navUser) {
    // Wide group photo on a tall phone: start height-covering and centered
    // so heads are tappable; pinch out to see everyone.
    const s = Math.min(4, Math.max(1, rect.height / layout.dh));
    state.nav.s = s;
    state.nav.x = (rect.width - layout.dw * s) / 2 - layout.ox;
    state.nav.y = (rect.height - layout.dh * s) / 2 - layout.oy;
  }
  clampNav();
  if (state.zoomed) applyZoom(state.zoomed, false);
  else {
    ui.stack.style.transition = "none";
    applyNavTransform();
    requestAnimationFrame(() => {
      if (!state.zoomed) ui.stack.style.transition = "";
    });
  }
  layoutHits();
}

function applyNavTransform() {
  if (state.zoomed) return;
  const s = state.nav.s || 1;
  const tx = state.nav.x || 0;
  const ty = state.nav.y || 0;
  state.view = { tx, ty, s };
  ui.stack.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
  updateChromeContrast();
}

function currentView() {
  return state.view || { tx: state.nav.x || 0, ty: state.nav.y || 0, s: state.nav.s || 1 };
}

function clientToStack(clientX, clientY) {
  const layout = state.layout;
  if (!layout) return null;
  const rect = ui.stage.getBoundingClientRect();
  const v = currentView();
  return {
    x: (clientX - rect.left - layout.ox - v.tx) / v.s,
    y: (clientY - rect.top - layout.oy - v.ty) / v.s,
  };
}

function stackToClient(x, y) {
  const layout = state.layout;
  if (!layout) return null;
  const rect = ui.stage.getBoundingClientRect();
  const v = currentView();
  return {
    x: rect.left + layout.ox + v.tx + x * v.s,
    y: rect.top + layout.oy + v.ty + y * v.s,
  };
}

function faceStackPoint(person) {
  const layout = state.layout;
  const photo = state.config?.photo;
  if (!layout || !photo || !person) return null;
  const f = origToPhoto(person, photo);
  return { x: f.x * layout.scale, y: f.y * layout.scale, r: f.r * layout.scale };
}

function pickPersonAt(clientX, clientY) {
  const layout = state.layout;
  const photo = state.config?.photo;
  if (!layout || !photo) return null;
  const pt = clientToStack(clientX, clientY);
  if (!pt) return null;
  const s = currentView().s || 1;
  let best = null;
  let bestD = Infinity;
  for (const p of (state.config.people || []).filter(isTappable)) {
    const f = faceStackPoint(p);
    if (!f) continue;
    const d = Math.hypot(pt.x - f.x, pt.y - f.y);
    const radius = Math.max(f.r * 1.35, 22 / s);
    if (d <= radius && d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

function photoCoverage() {
  const layout = state.layout;
  if (!layout) return null;
  const v = currentView();
  const w = ui.stage.clientWidth;
  const h = ui.stage.clientHeight;
  const dw = layout.dw * v.s;
  const dh = layout.dh * v.s;
  const left = layout.ox + v.tx;
  const top = layout.oy + v.ty;
  const coverX = left <= 1.5 && left + dw >= w - 1.5;
  const coverY = top <= 1.5 && top + dh >= h - 1.5;
  return {
    w,
    h,
    dw,
    dh,
    left,
    top,
    contain: !!layout.contain,
    coverX,
    coverY,
    covers: coverX && coverY,
    fits: layout.contain ? dh <= h + 2 && (coverY || dw <= w + 2) : coverX && coverY,
  };
}

function updateChromeContrast() {
  const app = document.getElementById("app");
  const layout = state.layout;
  const letterboxed =
    !!layout?.contain &&
    !state.zoomed &&
    layout.dh * (state.nav.s || 1) < (ui.stage.clientHeight - 8);
  app.classList.toggle("is-letterboxed", letterboxed);
}

function clampNav() {
  const layout = state.layout;
  if (!layout) return;
  const viewW = ui.stage.clientWidth;
  const viewH = ui.stage.clientHeight;
  state.nav.s = Math.min(4, Math.max(1, state.nav.s || 1));
  const s = state.nav.s;
  const minX = viewW - layout.ox - layout.dw * s;
  const maxX = -layout.ox;
  const minY = viewH - layout.oy - layout.dh * s;
  const maxY = -layout.oy;
  if (layout.dw * s <= viewW + 0.5) state.nav.x = (viewW - layout.dw * s) / 2 - layout.ox;
  else state.nav.x = Math.min(maxX, Math.max(minX, state.nav.x));
  if (layout.dh * s <= viewH + 0.5) state.nav.y = (viewH - layout.dh * s) / 2 - layout.oy;
  else state.nav.y = Math.min(maxY, Math.max(minY, state.nav.y));
}

function zoomAtPoint(clientX, clientY, factor) {
  const layout = state.layout;
  if (!layout) return;
  const rect = ui.stage.getBoundingClientRect();
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  const s0 = state.nav.s || 1;
  const lx = (px - layout.ox - state.nav.x) / s0;
  const ly = (py - layout.oy - state.nav.y) / s0;
  state.nav.s = s0 * factor;
  state.navUser = true;
  clampNav();
  state.nav.x = px - layout.ox - lx * state.nav.s;
  state.nav.y = py - layout.oy - ly * state.nav.s;
  clampNav();
  applyNavTransform();
}

function layoutHits() {
  ui.hits.innerHTML = "";
  const layout = state.layout;
  const photo = state.config?.photo;
  if (!layout || !photo) return;
  // No hit targets, halos, or zoom for untappable people (nr 7 and 12).
  const targets = (state.config.people || []).filter(isTappable);
  for (const p of targets) {
    const f = origToPhoto(p, photo);
    const visR = f.r * layout.scale;
    const r = visR;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hit";
    btn.dataset.nr = String(p.nr);
    btn.setAttribute("aria-label", p.name);
    const haloR = visR * 1.6;
    const halo = document.createElement("i");
    halo.className = "halo";
    halo.style.left = `${f.x * layout.scale - haloR}px`;
    halo.style.top = `${f.y * layout.scale - haloR}px`;
    halo.style.width = `${haloR * 2}px`;
    halo.style.height = `${haloR * 2}px`;
    ui.hits.appendChild(halo);

    btn.style.left = `${f.x * layout.scale - r}px`;
    btn.style.top = `${f.y * layout.scale - r}px`;
    const isSel = state.zoomed && Number(state.zoomed.nr) === Number(p.nr);
    btn.style.pointerEvents = state.zoomed && !isSel ? "none" : "auto";
    if (state.zoomed && !isSel) btn.style.pointerEvents = "none";
    btn.style.width = `${r * 2}px`;
    btn.style.height = `${r * 2}px`;
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (state.gestureMoved) return;
      if (state.zoomed && Number(state.zoomed.nr) !== Number(p.nr)) {
        unzoom();
        return;
      }
      onPersonTap(p);
    });
    ui.hits.appendChild(btn);
  }
}

async function applyMask(person) {
  const photo = state.config.photo;
  if (!person?.mask?.file) {
    ui.sharp.style.webkitMaskImage = "";
    ui.sharp.style.maskImage = "";
    ui.sharp.classList.remove("is-masked");
    return;
  }
  let url = state.maskUrls.get(person.nr);
  if (!url) {
    url = await mediaUrl(state.code, person.mask.file);
    state.maskUrls.set(person.nr, url);
  }
  const { scale } = state.layout;
  const size = `${person.mask.w * scale}px ${person.mask.h * scale}px`;
  const pos = `${person.mask.x * scale}px ${person.mask.y * scale}px`;
  ui.sharp.style.webkitMaskImage = `url("${url}")`;
  ui.sharp.style.maskImage = `url("${url}")`;
  ui.sharp.style.webkitMaskSize = size;
  ui.sharp.style.maskSize = size;
  ui.sharp.style.webkitMaskPosition = pos;
  ui.sharp.style.maskPosition = pos;
  ui.sharp.style.webkitMaskRepeat = "no-repeat";
  ui.sharp.style.maskRepeat = "no-repeat";
  ui.sharp.classList.add("is-masked");
}

function clearMask() {
  ui.sharp.style.webkitMaskImage = "";
  ui.sharp.style.maskImage = "";
  ui.sharp.classList.remove("is-masked");
}

async function applyZoom(person, animate = true) {
  const layout = state.layout;
  const photo = state.config.photo;
  if (!layout || !photo) return;
  const viewW = ui.stage.clientWidth;
  const viewH = ui.stage.clientHeight;
  const f = origToPhoto(person, photo);
  const faceX = f.x * layout.scale;
  const faceY = f.y * layout.scale;
  let bw, bh;
  if (person.mask) {
    bw = person.mask.w * layout.scale;
    bh = person.mask.h * layout.scale;
  } else {
    bw = f.r * 5 * layout.scale;
    bh = f.r * 9 * layout.scale;
  }
  const targetH = viewH * 0.62;
  const targetW = viewW * 0.88;
  const zFit = Math.min(targetW / bw, targetH / bh) * 0.92;
  // Always fill the viewport: never zoom out so far that edges show,
  // and clamp the pan at the photo bounds (no black bars).
  const zMin = Math.max(viewW / layout.dw, viewH / layout.dh) * 1.002;
  const z = Math.max(zFit, zMin);
  const lx = faceX;
  const ly = faceY;
  const destX = viewW / 2;
  const destY = viewH * 0.28;
  let tx = destX - layout.ox - lx * z;
  let ty = destY - layout.oy - ly * z;
  const txMin = viewW - layout.ox - layout.dw * z;
  const txMax = -layout.ox;
  const tyMin = viewH - layout.oy - layout.dh * z;
  const tyMax = -layout.oy;
  tx = Math.min(txMax, Math.max(txMin, tx));
  ty = Math.min(tyMax, Math.max(tyMin, ty));
  ui.stack.style.transition = animate ? "" : "none";
  state.view = { tx, ty, s: z };
  ui.stack.style.transform = `translate(${tx}px, ${ty}px) scale(${z})`;
  ui.stage.classList.remove("is-pannable");
  document.getElementById("app").classList.remove("is-letterboxed");
  if (!animate) requestAnimationFrame(() => { ui.stack.style.transition = ""; });
  await applyMask(person);
  setZoomedClass(true);
  layoutHits();
  ui.greeting.classList.add("is-hidden");
  ui.setupTitle.classList.add("is-hidden");
}

function unzoom() {
  state.zoomed = null;
  setZoomedClass(false);
  ui.stack.style.transition = "";
  applyNavTransform();
  ui.stage.classList.toggle("is-pannable", !!state.layout?.contain);
  ui.greeting.classList.remove("is-hidden");
  ui.setupTitle.classList.remove("is-hidden");
  clearMask();
  show(ui.btnConfirm, false);
  show(ui.btnCall, false);
  show(ui.zoomSoon, false);
  show(ui.zoomCard, false);
  layoutHits();
}

async function onPersonTap(person) {
  if (!isTappable(person)) return;
  if (state.zoomed && state.zoomed.nr === person.nr) return;
  state.zoomed = person;
  ui.zoomName.textContent = person.name;
  const setup = state.mode === "setup";
  show(ui.btnConfirm, setup);
  const isSelf = state.identity && Number(state.identity.nr) === Number(person.nr);
  const canCall = !setup && state.mode === "host" && person.callable && !isHostPerson(person, state.config);
  show(ui.btnCall, canCall);
  show(ui.zoomSoon, !setup && state.mode === "host" && !canCall && !isSelf);
  show(ui.zoomCard, true);
  await applyZoom(person);
}

function onStageBackground(ev) {
  if (state.gestureMoved) return;
  if (ev.target.closest(".zoom-card, .pill, .sheet")) return;
  if (state.zoomed) {
    const hit = ev.target.closest(".hit");
    if (hit && Number(hit.dataset.nr) === Number(state.zoomed.nr)) return;
    const picked = Number.isFinite(ev.clientX) ? pickPersonAt(ev.clientX, ev.clientY) : null;
    if (picked && Number(picked.nr) === Number(state.zoomed.nr)) return;
    unzoom();
    return;
  }
  // Prefer exact face-center distance; this also handles clicks that land
  // on the hit-layer rather than the (tight) face button.
  const person = Number.isFinite(ev.clientX) && ev.clientX + ev.clientY > 0
    ? pickPersonAt(ev.clientX, ev.clientY)
    : null;
  if (person) onPersonTap(person);
}

function setGreeting() {
  const me = state.identity;
  const setup = state.mode === "setup";
  show(ui.setupTitle, setup);
  show(ui.greeting, !setup && state.mode === "host");
  if (!setup && me) {
    ui.greet1.textContent = `Hallo ${me.name},`;
    ui.greet2.textContent = "wen willst du anrufen?";
  }
}

async function paintHostPortrait() {
  if (!ui.hostFace || !ui.hostFaceWrap) return;
  const host = hostPerson();
  ui.hostFace.src = "./icons/icon-512.png";
  ui.hostFace.alt = host?.name ? `Hannafon · ${host.name}` : "Hannafon";
  ui.hostFaceWrap.classList.add("app-icon-tile");
  show(ui.hostFaceWrap, true);
}

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function paintStandby() {
  const me = state.identity;
  const host = hostPerson();
  const hostName = host?.name || "";
  ui.standbyHello.textContent = `Hallo ${me.name},`;
  ui.standbySub.textContent = `du bist bereit für Anrufe von ${hostName}.`;
  ui.btnCallHostLabel.textContent = `${hostName} anrufen`;
  if (ui.standbyNote) {
    ui.standbyNote.textContent = `Bitte Mitteilungen erlauben, damit du hörst, wenn ${hostName} anruft.`;
  }
  show(ui.installHint, !isStandalone());
  show(ui.btnDisconnect, true);
  refreshPushUi();
}

async function subscribePushIfPossible() {
  if (!("Notification" in window) || !navigator.serviceWorker || !("PushManager" in window)) {
    return { ok: false, reason: "unsupported" };
  }
  if (Notification.permission !== "granted") {
    return { ok: false, reason: Notification.permission };
  }
  const vapid = state.config?.vapidPublicKey;
  if (!vapid || !state.identity) return { ok: false, reason: "no-vapid" };
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapid),
    });
  }
  const posted = await postSubscribe(state.code, state.identity.nr, sub.toJSON(), getDeviceId());
  return { ok: !!posted, reason: posted ? "active" : "post-failed" };
}

async function refreshPushUi() {
  const pushOk = "Notification" in window && "serviceWorker" in navigator && "PushManager" in window;
  let label = "Mitteilungen nicht verfügbar";
  let kind = "is-off";
  let subscribed = false;
  let perm = pushOk ? Notification.permission : "unsupported";
  if (pushOk && perm === "granted") {
    try {
      const res = await subscribePushIfPossible();
      subscribed = !!res.ok;
    } catch {
      subscribed = false;
    }
  }
  if (!pushOk) {
    label = "Mitteilungen nicht verfügbar";
  } else if (subscribed) {
    label = "Mitteilungen aktiv";
    kind = "is-on";
  } else {
    label = "Mitteilungen nicht aktiv";
  }
  if (ui.pushStatus) {
    ui.pushStatus.textContent = label;
    ui.pushStatus.className = `push-status ${kind}`;
  }
  show(ui.btnNotify, pushOk && perm !== "denied" && !subscribed);
  show(ui.btnPushTest, subscribed);
}

function goHome() {
  unzoom();
  if (!state.identity) {
    state.mode = "setup";
    setGreeting();
    showScreen("photo");
    applyStageLayout();
    return;
  }
  if (isHostPerson(state.identity, state.config)) {
    state.mode = "host";
    setGreeting();
    showScreen("photo");
    applyStageLayout();
  } else {
    state.mode = "standby";
    paintStandby();
    showScreen("standby");
  }
}

async function loadMedia() {
  const files = state.config.photo.files || {};
  const sharp = files.webp || files.jpg;
  const blur = files.blurWebp || files.blurJpg;
  const sharpUrl = await mediaUrl(state.code, sharp);
  const blurUrl = await mediaUrl(state.code, blur);
  ui.sharp.src = sharpUrl;
  ui.blur.src = blurUrl;
  if (ui.blurFill) ui.blurFill.src = blurUrl;
  ui.sharp.alt = "Familienfoto";
  await ui.sharp.decode().catch(() => {});
  await paintHostPortrait();
  // Prefetch masks in the background into Cache Storage.
  for (const p of state.config.people || []) {
    if (p.mask?.file) mediaUrl(state.code, p.mask.file).catch(() => {});
  }
}

function consumeInviteCode() {
  const url = new URL(location.href);
  const raw = url.searchParams.get("code") || url.searchParams.get("familie") || "";
  if (raw) {
    url.searchParams.delete("code");
    url.searchParams.delete("familie");
    history.replaceState({}, "", url.pathname + url.search + url.hash);
  }
  return raw;
}

function incomingFromUrl() {
  const url = new URL(location.href);
  const inc = url.searchParams.get("incoming");
  if (inc) {
    url.searchParams.delete("incoming");
    history.replaceState({}, "", url.pathname + url.search + url.hash);
  }
  return inc ? Number(inc) : null;
}

async function afterAuth(cfg, code) {
  state.config = cfg;
  state.code = normalizeCode(code);
  localStorage.setItem(STORAGE_CODE, state.code);
  await loadMedia();
  const idNr = Number(localStorage.getItem(STORAGE_IDENTITY) || 0);
  state.identity = idNr ? personByNr(idNr) : null;
  if (state.identity) connectSignaling();
  const incoming = incomingFromUrl();
  goHome();
  if (incoming && state.identity) {
    // Push click opened the app; wait for the live signaling offer if any.
  }
}

async function tryStoredCode() {
  const stored = localStorage.getItem(STORAGE_CODE) || "";
  const invite = consumeInviteCode();
  const code = invite || stored;
  if (!code) {
    showScreen("code");
    return;
  }
  try {
    const cfg = stored && !invite ? await loadConfig(code) : await auth(code);
    await afterAuth(cfg, code);
  } catch {
    localStorage.removeItem(STORAGE_CODE);
    showScreen("code");
    if (invite) {
      ui.codeError.textContent = "Der Link-Code war ungültig.";
      show(ui.codeError, true);
    }
  }
}

ui.codeForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  show(ui.codeError, false);
  const raw = ui.codeInput.value;
  try {
    const cfg = await auth(raw);
    await afterAuth(cfg, raw);
  } catch (err) {
    ui.codeError.textContent = err.message || "ungültiger Code";
    show(ui.codeError, true);
  }
});

ui.btnConfirm.addEventListener("click", () => {
  if (!state.zoomed) return;
  state.identity = state.zoomed;
  localStorage.setItem(STORAGE_IDENTITY, String(state.identity.nr));
  connectSignaling();
  goHome();
});

ui.btnCall.addEventListener("click", () => {
  if (state.zoomed) startCall(state.zoomed);
});

ui.btnCallHost.addEventListener("click", () => {
  const host = hostPerson();
  if (host) startCall(host);
});

ui.stage.addEventListener("click", onStageBackground);

function viewportKey() {
  const vv = window.visualViewport;
  const w = vv?.width || window.innerWidth;
  const h = vv?.height || window.innerHeight;
  return `${Math.round(w)}x${Math.round(h)}:${w > h ? "L" : "P"}`;
}

let layoutTimer = null;
let layoutTimerLate = null;

function requestStageLayout() {
  if (ui.photo.hidden) return;
  const key = viewportKey();
  const prev = state.lastViewportKey;
  const flipped = !!(prev && prev.split(":")[1] !== key.split(":")[1]);
  state.lastViewportKey = key;
  if (flipped && !state.zoomed) {
    state.navUser = false;
  }
  const run = () => {
    if (!ui.photo.hidden) applyStageLayout();
  };
  if (layoutTimer) clearTimeout(layoutTimer);
  layoutTimer = setTimeout(run, 50);
  if (layoutTimerLate) clearTimeout(layoutTimerLate);
  // iOS often reports stale sizes until after the rotation animation.
  layoutTimerLate = setTimeout(run, 300);
}

window.addEventListener("resize", requestStageLayout);
window.addEventListener("orientationchange", requestStageLayout);
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", requestStageLayout);
}

let pressTimer = null;
ui.wordmark.addEventListener("pointerdown", () => {
  pressTimer = setTimeout(() => show(ui.resetSheet, true), 5000);
});
for (const ev of ["pointerup", "pointerleave", "pointercancel"]) {
  ui.wordmark.addEventListener(ev, () => {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
  });
}
ui.btnResetCancel.addEventListener("click", () => show(ui.resetSheet, false));
ui.btnReset.addEventListener("click", async () => {
  await fullReset();
});

async function fullReset() {
  stopRingtone();
  hangup(false);
  state.signaling.close();
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager?.getSubscription();
    if (sub) {
      await postUnsubscribe(state.code, { endpoint: sub.endpoint, deviceId: getDeviceId() });
      await sub.unsubscribe();
    } else if (state.code) {
      await postUnsubscribe(state.code, { deviceId: getDeviceId() });
    }
  } catch {
    /* ignore */
  }
  localStorage.removeItem(STORAGE_CODE);
  localStorage.removeItem(STORAGE_IDENTITY);
  localStorage.removeItem(STORAGE_DEVICE);
  await clearMediaCache();
  revokeMedia();
  location.reload();
}

function connectSignaling() {
  if (!state.identity) return;
  state.signaling.connect(state.code, state.identity.nr, getDeviceId());
  state.signaling.on("call", onRemoteCall);
  state.signaling.on("offer", onRemoteCall);
  state.signaling.on("answer", onRemoteAnswer);
  state.signaling.on("ice", onRemoteIce);
  state.signaling.on("hangup", () => hangup(true));
  state.signaling.on("reject", () => hangup(true));
  state.signaling.on("taken", onCallTakenElsewhere);
}

function onCallTakenElsewhere() {
  if (state.outgoing || state.pc) return;
  stopRingtone();
  state.pendingFrom = null;
  state.pendingFromDevice = null;
  state.pendingOffer = null;
  show(ui.incoming, false);
  goHome();
  show(ui.takenToast, true);
  setTimeout(() => show(ui.takenToast, false), 2400);
}

function peerHandlers(peerNr) {
  return {
    onIce: (candidate) =>
      state.signaling.send({
        type: "ice",
        to: peerNr,
        toDevice: state.peerDevice,
        fromDevice: getDeviceId(),
        candidate,
      }),
    onTrack: (stream) => {
      state.remoteStream = stream;
      ui.remoteVideo.srcObject = stream;
      ui.remoteVideo.play().catch(() => {});
    },
    onState: (s) => {
      if (s === "connected") ui.callStatus.textContent = "";
      if (s === "failed" || s === "disconnected") {
        ui.callStatus.textContent = "Verbindung unterbrochen";
      }
    },
  };
}

async function startCall(person) {
  if (!state.identity || !person) return;
  if (isHostPerson(state.identity, state.config)) {
    if (!person.callable || isHostPerson(person, state.config)) return;
  } else if (!isHostPerson(person, state.config)) {
    return; // receivers only call the host
  }
  hangup(false);
  state.inCallWith = person;
  state.outgoing = true;
  state.callId = (crypto.randomUUID && crypto.randomUUID()) || `c-${Date.now()}`;
  state.peerDevice = null;
  showScreen("call");
  ui.callStatus.textContent = `Warten auf ${person.name}…`;
  try {
    state.localStream = await getLocalStream();
    ui.localVideo.srcObject = state.localStream;
    state.pc = createPeer(state.config.iceServers, state.localStream, peerHandlers(person.nr));
    const offer = await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);
    state.signaling.send({
      type: "call",
      to: person.nr,
      fromDevice: getDeviceId(),
      fromName: state.identity.name,
      callId: state.callId,
      sdp: state.pc.localDescription,
    });
  } catch {
    ui.callStatus.textContent = "Kamera oder Mikrofon nicht verfügbar";
  }
}

function onRemoteCall(data) {
  if (state.inCallWith && !state.outgoing) return;
  const from = personByNr(data.from);
  state.pendingOffer = data.sdp;
  state.pendingFrom = from;
  state.pendingFromDevice = data.fromDevice || null;
  ui.incomingTitle.textContent = `${from?.name || "Jemand"} ruft an`;
  show(ui.zoomCard, false);
  showScreen("incoming");
  applyStageLayout();
  if (from) {
    state.zoomed = from;
    applyZoom(from);
  }
  beginIncomingRing();
}

function updateRingHint() {
  const locked = !isAudioUnlocked();
  ui.incoming?.classList.toggle("is-waiting-audio", locked && !ui.incoming.hidden);
  show(ui.ringHint, locked && !ui.incoming.hidden);
}

async function beginIncomingRing() {
  await startRingtone();
  updateRingHint();
}

async function onRemoteAnswer(data) {
  if (!state.pc || !data.sdp) return;
  await state.pc.setRemoteDescription(data.sdp);
  await flushIce(state.pc);
}

async function onRemoteIce(data) {
  if (state.pc && data.candidate) await addIce(state.pc, data.candidate);
}

ui.btnAccept.addEventListener("click", async () => {
  stopRingtone();
  show(ui.ringHint, false);
  ui.incoming?.classList.remove("is-waiting-audio");
  const from = state.pendingFrom;
  const offer = state.pendingOffer;
  if (!from || !offer) return;
  state.inCallWith = from;
  state.outgoing = false;
  showScreen("call");
  ui.callStatus.textContent = "Verbinden…";
  try {
    state.localStream = await getLocalStream();
    ui.localVideo.srcObject = state.localStream;
    state.pc = createPeer(state.config.iceServers, state.localStream, peerHandlers(from.nr));
    await state.pc.setRemoteDescription(offer);
    await flushIce(state.pc);
    const answer = await state.pc.createAnswer();
    await state.pc.setLocalDescription(answer);
    state.signaling.send({
      type: "answer",
      to: from.nr,
      toDevice: state.pendingFromDevice,
      fromDevice: getDeviceId(),
      sdp: state.pc.localDescription,
    });
    state.peerDevice = state.pendingFromDevice;
  } catch {
    ui.callStatus.textContent = "Kamera oder Mikrofon nicht verfügbar";
  }
});

ui.btnDecline.addEventListener("click", () => {
  stopRingtone();
  show(ui.ringHint, false);
  ui.incoming?.classList.remove("is-waiting-audio");
  if (state.pendingFrom) {
    state.signaling.send({ type: "reject", to: state.pendingFrom.nr });
  }
  state.pendingFrom = null;
  state.pendingOffer = null;
  goHome();
});

ui.btnHangup.addEventListener("click", () => hangup(false));

function hangup(remote) {
  stopRingtone();
  if (!remote && state.inCallWith) {
    state.signaling.send({ type: "hangup", to: state.inCallWith.nr, fromDevice: getDeviceId() });
  }
  closePeer(state.pc);
  state.pc = null;
  stopStream(state.localStream);
  state.localStream = null;
  state.remoteStream = null;
  ui.localVideo.srcObject = null;
  ui.remoteVideo.srcObject = null;
  state.inCallWith = null;
  state.outgoing = false;
  state.pendingFrom = null;
  state.pendingFromDevice = null;
  state.pendingOffer = null;
  state.peerDevice = null;
  state.callId = null;
  if (state.identity && state.config) goHome();
}

ui.btnNotify.addEventListener("click", async () => {
  // Permission + subscribe only inside this tap handler (iOS requirement).
  try {
    if (!("Notification" in window) || !navigator.serviceWorker) return;
    await Notification.requestPermission();
    await subscribePushIfPossible();
    await refreshPushUi();
  } catch {
    await refreshPushUi();
  }
});

ui.btnPushTest?.addEventListener("click", async () => {
  if (!state.code || !state.identity) return;
  try {
    const res = await postPushTest(state.code, {
      deviceId: getDeviceId(),
      personNr: state.identity.nr,
    });
    if (ui.pushStatus) {
      ui.pushStatus.textContent = res.ok ? "Test-Mitteilung gesendet" : "Test-Mitteilung fehlgeschlagen";
      ui.pushStatus.className = `push-status ${res.ok ? "is-on" : "is-off"}`;
    }
  } catch {
    if (ui.pushStatus) {
      ui.pushStatus.textContent = "Test-Mitteilung fehlgeschlagen";
      ui.pushStatus.className = "push-status is-off";
    }
  }
});

ui.incoming?.addEventListener("pointerdown", async (ev) => {
  if (ev.target.closest("#btn-accept, #btn-decline")) return;
  await unlockAudio();
  if (state.pendingFrom) await startRingtone();
  updateRingHint();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {});
  navigator.serviceWorker.addEventListener("message", (ev) => {
    if (ev.data?.type === "incoming" && ev.data.data?.from) {
      // If we already have a live call offer, the UI is showing; otherwise just hint.
    }
  });
}

if (ui.btnDisconnect) {
  ui.btnDisconnect.addEventListener("click", () => {
    const name = state.identity?.name || "dir";
    ui.disconnectCopy.textContent =
      `Dieses Gerät von ${name} trennen? Du bekommst dann keine Anrufe von Hanna mehr auf diesem Gerät.`;
    show(ui.disconnectSheet, true);
  });
}
ui.btnDisconnectCancel?.addEventListener("click", () => show(ui.disconnectSheet, false));
ui.btnDisconnectConfirm?.addEventListener("click", () => disconnectThisDevice());

async function disconnectThisDevice() {
  const code = state.code;
  const deviceId = getDeviceId();
  stopRingtone();
  hangup(false);
  state.signaling.close();
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager?.getSubscription();
    await postUnsubscribe(code, { endpoint: sub?.endpoint, deviceId });
    if (sub) await sub.unsubscribe();
  } catch {
    /* ignore */
  }
  localStorage.removeItem(STORAGE_IDENTITY);
  state.identity = null;
  state.mode = "setup";
  show(ui.disconnectSheet, false);
  goHome();
}

(function bindPhotoGestures() {
  const pointers = new Map();
  let lastDist = 0;

  function active() {
    return !state.zoomed && !!state.layout?.contain;
  }

  ui.stage.addEventListener("pointerdown", (ev) => {
    if (!active()) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    state.gestureMoved = false;
    ui.stack.style.transition = "none";
    if (pointers.size === 2) {
      const pts = [...pointers.values()];
      lastDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }
    try { ui.stage.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
  });

  ui.stage.addEventListener("pointermove", (ev) => {
    if (!pointers.has(ev.pointerId)) return;
    const prev = pointers.get(ev.pointerId);
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (!active()) return;
    if (pointers.size === 2) {
      const pts = [...pointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (lastDist > 0 && dist > 0) {
        const midX = (pts[0].x + pts[1].x) / 2;
        const midY = (pts[0].y + pts[1].y) / 2;
        zoomAtPoint(midX, midY, dist / lastDist);
        state.gestureMoved = true;
      }
      lastDist = dist;
      ev.preventDefault();
      return;
    }
    const dx = ev.clientX - prev.x;
    const dy = ev.clientY - prev.y;
    if (Math.hypot(dx, dy) > 6) state.gestureMoved = true;
    if ((state.nav.s || 1) > 1.01) {
      state.nav.x += dx;
      state.nav.y += dy;
      clampNav();
      applyNavTransform();
    }
  });

  const endPtr = (ev) => {
    pointers.delete(ev.pointerId);
    lastDist = 0;
  };
  ui.stage.addEventListener("pointerup", endPtr);
  ui.stage.addEventListener("pointercancel", endPtr);

  ui.stage.addEventListener(
    "wheel",
    (ev) => {
      if (!active()) return;
      ev.preventDefault();
      ui.stack.style.transition = "none";
      zoomAtPoint(ev.clientX, ev.clientY, ev.deltaY < 0 ? 1.08 : 1 / 1.08);
    },
    { passive: false }
  );
})();

bindAudioUnlock();
tryStoredCode();

window.__hannafonTest = {
  ready: () => !!(state.config && state.layout && ui.sharp?.naturalWidth),
  facePoint(nr) {
    const p = personByNr(nr);
    const f = faceStackPoint(p);
    if (!f) return null;
    const pt = stackToClient(f.x, f.y);
    return pt ? { x: pt.x, y: pt.y, r: f.r * (currentView().s || 1), nr: p.nr, name: p.name } : null;
  },
  ensureFaceVisible(nr) {
    if (state.zoomed) return this.facePoint(nr);
    const p = personByNr(nr);
    const f = faceStackPoint(p);
    if (!f || !state.layout) return null;
    const rect = ui.stage.getBoundingClientRect();
    const margin = 36;
    const pt0 = stackToClient(f.x, f.y);
    let dx = 0;
    let dy = 0;
    if (pt0.x < rect.left + margin) dx = rect.left + margin - pt0.x;
    if (pt0.x > rect.right - margin) dx = rect.right - margin - pt0.x;
    if (pt0.y < rect.top + margin) dy = rect.top + margin - pt0.y;
    if (pt0.y > rect.bottom - margin) dy = rect.bottom - margin - pt0.y;
    if (dx || dy) {
      state.nav.x += dx;
      state.nav.y += dy;
      state.navUser = true;
      clampNav();
      applyNavTransform();
    }
    const pt = stackToClient(f.x, f.y);
    const on =
      pt &&
      pt.x >= rect.left &&
      pt.x <= rect.right &&
      pt.y >= rect.top &&
      pt.y <= rect.bottom;
    return pt ? { x: pt.x, y: pt.y, r: f.r * (currentView().s || 1), nr: p.nr, name: p.name, onScreen: !!on } : null;
  },
  pickAt(x, y) {
    const p = pickPersonAt(x, y);
    return p ? { nr: p.nr, name: p.name } : null;
  },
  photoCoverage,
  layout: () => ({ ...state.layout, view: { ...currentView() }, nav: { ...state.nav } }),
  pinchPan(dx, dy, factor) {
    if (factor && factor !== 1) {
      const rect = ui.stage.getBoundingClientRect();
      zoomAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
    }
    if (dx || dy) {
      state.nav.x += dx || 0;
      state.nav.y += dy || 0;
      state.navUser = true;
      clampNav();
      applyNavTransform();
    }
  },
  resetNav() {
    state.navUser = false;
    applyStageLayout();
  },
  applyLayout: () => applyStageLayout(),
  audioState: () => audioContextState(),
  isAudioUnlocked,
  unlockAudio,
  startRingtone,
  stopRingtone,
};
