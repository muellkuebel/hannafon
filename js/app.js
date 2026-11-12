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
  primeMediaPermission,
  refreshMediaPermissionState,
  mediaPermissionState,
  mediaPrimeLog,
  createPeer,
  addIce,
  flushIce,
  stopStream,
  closePeer,
  applySendCaps,
  readSendCaps,
  SEND_CAPS,
} from "./webrtc.js";
import {
  startRingtone,
  stopRingtone,
  unlockAudio,
  isAudioUnlocked,
  audioContextState,
  bindAudioUnlock,
  setCallActive,
  isRingAudible,
  audioDebug,
} from "./audio.js";

const $ = (id) => document.getElementById(id);

// V1.08: local cache of Hanna's missed calls (face numbers + timestamps only).
const STORAGE_MISSED = "hannafon-missed-v1";

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
  incomingHostWrap: $("incoming-host-wrap"),
  incomingHostFace: $("incoming-host-face"),
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
  btnAddressbook: $("btn-addressbook"),
  btnBackPhoto: $("btn-back-photo"),
  addressbook: $("screen-addressbook"),
  abList: $("ab-list"),
  abRowTpl: $("ab-row-tpl"),
  btnAbClose: $("btn-ab-close"),
  btnMissed: $("btn-missed"),
  missedBadge: $("missed-badge"),
  abEmpty: $("ab-empty"),
  abTitle: document.querySelector("#screen-addressbook .ab-title"),
  // V1.09 group calls
  btnAddMore: $("btn-add-more"),
  selectBar: $("select-bar"),
  btnGroupCall: $("btn-group-call"),
  btnGroupCallLabel: $("btn-group-call-label"),
  selectHint: $("select-hint"),
  incomingSub: $("incoming-sub"),
  callGrid: $("call-grid"),
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
  // V1.08: missed calls for Hanna ([{ from, count, last }]), worker is the source of truth.
  missed: loadMissedCache(),
  bookMode: "all", // "all" (Adressbuch) | "missed" (Verpasste Anrufe)
  // V1.08: when Hanna calls, the receiver sees the app-icon portrait, not the family photo.
  incomingShowHostIcon: false,
  // V1.09: group select mode ({ nrs: [face numbers] }) and the running group call.
  select: null,
  group: null,
  pendingGroup: null,
};

function showScreen(name) {
  const incomingUsesIcon = name === "incoming" && !!state.incomingShowHostIcon;
  const showPhoto = name === "photo" || (name === "incoming" && !incomingUsesIcon);
  for (const key of ["code", "photo", "standby", "incoming", "call"]) {
    const el = ui[key];
    const on = key === name || (key === "photo" && showPhoto);
    el.classList.toggle("hidden", !on);
    el.hidden = !on;
  }
  ui.incoming?.classList.toggle("has-host-icon", incomingUsesIcon);
  show(ui.incomingHostWrap, incomingUsesIcon);
  const app = document.getElementById("app");
  app.classList.toggle("is-photo", showPhoto);
  app.classList.toggle("is-in-call", name === "call");
  // V1.06: pause the audio keep-alive while WebRTC owns the audio session.
  setCallActive(name === "call");
  if (!showPhoto) app.classList.remove("is-zoomed");
  if (name !== "photo") closeAddressbook();
  updateCornerButtons();
  state.screen = name;
  requestEdgeColors();
}

// Bottom-right corner (V1.06): "Adressbuch" on the host overview, "Zum Foto"
// while zoomed on a person (same spot as "Zum Foto" in the list). Never both,
// never on incoming/call.
function updateCornerButtons() {
  const onPhoto = !ui.photo.hidden && ui.incoming.hidden && ui.call.hidden;
  const bookOpen = !ui.addressbook.hidden;
  const zoomed = !!state.zoomed;
  const selecting = !!state.select;
  const canBack = onPhoto && !bookOpen && (zoomed || selecting) && (state.mode === "host" || state.mode === "setup");
  const canBook =
    onPhoto && !bookOpen && !zoomed && !selecting && state.mode === "host" &&
    !!state.identity && isHostPerson(state.identity, state.config);
  show(ui.btnBackPhoto, canBack);
  show(ui.btnAddressbook, canBook);
  // V1.08: "Verpasste Anrufe" bottom left, only while calls are waiting.
  const missed = missedPeople();
  show(ui.btnMissed, canBook && missed.length > 0);
  ui.missedBadge.textContent = String(missed.length);
  show(ui.missedBadge, missed.length > 0);
  ui.btnMissed.classList.toggle("has-missed", missed.length > 0);
  ui.btnMissed.setAttribute("aria-label", `Verpasste Anrufe: ${missed.length}`);
  document.getElementById("app").classList.toggle("has-back-pill", canBack);
}

// Everyone Hanna can call: callable, tappable, not the host (so never 7, 12, or 10).
function addressbookPeople() {
  const cfg = state.config;
  if (!cfg) return [];
  return (cfg.people || [])
    .filter((p) => p && p.callable && isTappable(p) && !isHostPerson(p, cfg))
    .slice()
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "de"));
}

const AVATAR_TINTS = ["#6a8f6b", "#3d6b7a", "#8a5a4a", "#7a6a3d", "#5a5f8a", "#8a4a6a", "#4a7a6a"];

function paintAvatar(el, person) {
  const letter = el.querySelector(".ab-letter");
  letter.textContent = String(person.name || "?").trim().charAt(0).toUpperCase();
  el.style.background = AVATAR_TINTS[Number(person.nr) % AVATAR_TINTS.length];
  // Round face crop from the already loaded (code-gated) family photo.
  const photo = state.config?.photo;
  const src = ui.sharp?.currentSrc || ui.sharp?.src;
  if (!photo || !src || !ui.sharp.naturalWidth) return;
  const f = origToPhoto(person, photo);
  if (!(f.r > 0)) return;
  const size = el.getBoundingClientRect().width || 52;
  const k = size / (f.r * 2.5); // face fills most of the circle
  el.style.backgroundImage = `url("${src}")`;
  el.style.backgroundSize = `${photo.width * k}px ${photo.height * k}px`;
  el.style.backgroundPosition = `${size / 2 - f.x * k}px ${size / 2 - f.y * k}px`;
  el.style.backgroundRepeat = "no-repeat";
  el.classList.add("has-photo");
}

// ---- V1.08 missed calls ---------------------------------------------------
function sanitizeMissed(items) {
  return (Array.isArray(items) ? items : [])
    .map((m) => ({ from: Number(m?.from) || 0, count: Math.max(1, Number(m?.count) || 1), last: Number(m?.last) || 0 }))
    .filter((m) => m.from > 0 && m.last > 0);
}

function loadMissedCache() {
  try {
    return sanitizeMissed(JSON.parse(localStorage.getItem(STORAGE_MISSED) || "[]"));
  } catch {
    return [];
  }
}

function saveMissedCache() {
  try {
    if (state.missed.length) localStorage.setItem(STORAGE_MISSED, JSON.stringify(state.missed));
    else localStorage.removeItem(STORAGE_MISSED);
  } catch {
    /* ignore */
  }
}

// Only for Hanna, only people she can call back (never 7, 12, or herself),
// newest first, one row per person.
function missedPeople() {
  const cfg = state.config;
  if (!cfg || state.mode !== "host" || !state.identity || !isHostPerson(state.identity, cfg)) return [];
  const callable = new Set(addressbookPeople().map((p) => Number(p.nr)));
  return state.missed
    .filter((m) => callable.has(m.from))
    .slice()
    .sort((a, b) => b.last - a.last)
    .map((m) => ({ ...m, person: personByNr(m.from) }))
    .filter((m) => m.person);
}

function onMissed(data) {
  state.missed = sanitizeMissed(data?.items);
  saveMissedCache();
  if (!ui.addressbook.hidden && state.bookMode === "missed") renderAddressbook();
  updateCornerButtons();
}

const BERLIN = "Europe/Berlin";
function berlinDay(ts) {
  return new Date(ts).toLocaleDateString("de-DE", { timeZone: BERLIN });
}
function berlinTime(ts) {
  return new Date(ts).toLocaleTimeString("de-DE", { timeZone: BERLIN, hour: "2-digit", minute: "2-digit" });
}
// "gerade eben", "vor 5 Minuten", "heute 14:30", "gestern 9:05", "Mo., 10.11., 14:30"
function missedWhen(ts, now = Date.now()) {
  const min = Math.floor((now - ts) / 60000);
  if (min < 1) return "gerade eben";
  if (min < 60) return min === 1 ? "vor 1 Minute" : `vor ${min} Minuten`;
  if (berlinDay(ts) === berlinDay(now)) return `heute ${berlinTime(ts)}`;
  if (berlinDay(ts) === berlinDay(now - 86400000)) return `gestern ${berlinTime(ts)}`;
  const day = new Date(ts).toLocaleDateString("de-DE", { timeZone: BERLIN, weekday: "short", day: "numeric", month: "numeric" });
  return `${day}, ${berlinTime(ts)}`;
}

function missedLine(m) {
  const when = missedWhen(m.last);
  return m.count > 1 ? `${m.count} Anrufe · ${when}` : when;
}

let missedTicker = null;

function renderAddressbook() {
  ui.abList.innerHTML = "";
  const missedMode = state.bookMode === "missed";
  ui.abTitle.textContent = missedMode ? "Verpasste Anrufe" : "Adressbuch";
  ui.addressbook.setAttribute("aria-label", missedMode ? "Verpasste Anrufe" : "Adressbuch");
  ui.addressbook.classList.toggle("is-missed", missedMode);
  const rows = missedMode ? missedPeople() : addressbookPeople().map((p) => ({ person: p }));
  show(ui.abEmpty, missedMode && rows.length === 0);
  for (const entry of rows) {
    const p = entry.person;
    const row = ui.abRowTpl.content.firstElementChild.cloneNode(true);
    row.dataset.nr = String(p.nr);
    row.querySelector(".ab-name").textContent = p.name;
    const meta = row.querySelector(".ab-meta");
    if (missedMode) {
      meta.textContent = missedLine(entry);
      row.dataset.count = String(entry.count);
      show(meta, true);
    }
    const btn = row.querySelector(".ab-call");
    btn.dataset.nr = String(p.nr);
    btn.setAttribute("aria-label", `${p.name} anrufen`);
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      callFromAddressbook(p);
    });
    ui.abList.appendChild(row);
  }
  for (const row of ui.abList.querySelectorAll(".ab-row")) {
    paintAvatar(row.querySelector(".ab-avatar"), personByNr(row.dataset.nr));
  }
}

function openAddressbook(mode = "all") {
  if (state.mode !== "host" || !isHostPerson(state.identity, state.config)) return;
  if (state.zoomed) unzoom();
  state.bookMode = mode === "missed" ? "missed" : "all";
  show(ui.addressbook, true);
  renderAddressbook();
  clearInterval(missedTicker);
  if (state.bookMode === "missed") missedTicker = setInterval(() => {
    if (!ui.addressbook.hidden && state.bookMode === "missed") renderAddressbook();
  }, 30000);
  ui.abList.scrollTop = 0;
  document.getElementById("app").classList.add("is-addressbook");
  updateCornerButtons();
  requestEdgeColors();
}

// V1.08: leaving "Verpasste Anrufe" on purpose (Zum Foto or Anrufen) means
// Hanna has seen them: clear them here and on the worker, so the button goes
// away and does not come back after a reload. An incoming call that pushes the
// list away does not count as leaving.
function closeAddressbook({ ack = false } = {}) {
  if (!ui.addressbook || ui.addressbook.hidden) return;
  if (ack && state.bookMode === "missed") acknowledgeMissed();
  clearInterval(missedTicker);
  state.bookMode = "all";
  show(ui.addressbook, false);
  document.getElementById("app").classList.remove("is-addressbook");
  updateCornerButtons();
  requestEdgeColors();
}

function acknowledgeMissed() {
  state.missed = [];
  saveMissedCache();
  state.signaling.send({ type: "missed-clear", nr: 0 });
}

function callFromAddressbook(person) {
  // Same path as choosing the person on the photo and tapping "Anrufen".
  closeAddressbook({ ack: true });
  startCall(person);
}

function setZoomedClass(on) {
  ui.stage.classList.toggle("is-zoomed", on);
  document.getElementById("app").classList.toggle("is-zoomed", on);
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

// V1.06: pinch/pan of the family photo only on phones in portrait (receivers,
// contain layout, so every head can be reached). iPad and iPad mini (any
// orientation, host Hanna) get no pinch: the photo always shows as laid out;
// tapping a face still zooms to that person.
function pinchAllowed() {
  const layout = state.layout;
  if (!layout?.contain) return false;
  const w = ui.stage.clientWidth || window.innerWidth;
  const h = ui.stage.clientHeight || window.innerHeight;
  return Math.min(w, h) < 600;
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
  const canPinch = pinchAllowed();
  ui.stage.classList.toggle("is-pannable", canPinch && !state.zoomed);
  if (!canPinch) {
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
  requestEdgeColors();
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
      if (state.select) {
        toggleSelect(p);
        return;
      }
      if (state.zoomed && Number(state.zoomed.nr) !== Number(p.nr)) {
        unzoom();
        return;
      }
      onPersonTap(p);
    });
    ui.hits.appendChild(btn);
  }
  // V1.09: chosen people in select mode: green ring + check on the face.
  for (const nr of state.select?.nrs || []) {
    const p = personByNr(nr);
    if (!p) continue;
    const f = origToPhoto(p, photo);
    const rr = f.r * layout.scale * 1.3;
    const ring = document.createElement("div");
    ring.className = "sel-ring";
    ring.dataset.nr = String(p.nr);
    ring.style.left = `${f.x * layout.scale - rr}px`;
    ring.style.top = `${f.y * layout.scale - rr}px`;
    ring.style.width = `${rr * 2}px`;
    ring.style.height = `${rr * 2}px`;
    ring.innerHTML =
      '<span class="sel-check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>';
    ui.hits.appendChild(ring);
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

// V1.06: eight mirrored copies of the blurred photo around the stack. Mirroring
// makes every seam continuous, so a zoomed edge face can sit in the centre and
// the photo simply seems to go on (blurred) beyond its real edge.
const EXTEND_TILES = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];
function paintPhotoExtend(src) {
  const box = document.getElementById("photo-extend");
  if (!box || !src) return;
  if (!box.childElementCount) {
    for (const [cx, cy] of EXTEND_TILES) {
      const img = document.createElement("img");
      img.alt = "";
      img.draggable = false;
      // 1px overlap towards the photo hides any hairline seam.
      img.style.left = `calc(${cx * 100}% - ${cx}px)`;
      img.style.top = `calc(${cy * 100}% - ${cy}px)`;
      img.style.transform = `scale(${cx ? -1 : 1}, ${cy ? -1 : 1})`;
      box.appendChild(img);
    }
  }
  for (const img of box.children) img.src = src;
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
  // Never zoom out below "photo covers the viewport". One mirrored tile on
  // each side is then always enough to centre any face (see paintPhotoExtend).
  const zMin = Math.max(viewW / layout.dw, viewH / layout.dh) * 1.002;
  const z = Math.max(zFit, zMin);
  const lx = faceX;
  const ly = faceY;
  // V1.06: the chosen face always lands at the horizontal centre (and the
  // usual height above name + Anrufen), no clamping at the photo bounds:
  // beyond the real edge the mirrored blurred extension shows.
  const destX = viewW / 2;
  const destY = viewH * 0.28;
  const tx = destX - layout.ox - lx * z;
  const ty = destY - layout.oy - ly * z;
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
  updateCornerButtons();
  requestEdgeColors();
}

function unzoom() {
  state.zoomed = null;
  setZoomedClass(false);
  ui.stack.style.transition = "";
  applyNavTransform();
  ui.stage.classList.toggle("is-pannable", pinchAllowed());
  ui.greeting.classList.remove("is-hidden");
  ui.setupTitle.classList.remove("is-hidden");
  clearMask();
  show(ui.btnConfirm, false);
  show(ui.btnCall, false);
  show(ui.btnAddMore, false);
  document.getElementById("app").classList.remove("has-add-more");
  show(ui.zoomSoon, false);
  show(ui.zoomCard, false);
  layoutHits();
  updateCornerButtons();
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
  // V1.09: "Noch jemanden dazu" next to Anrufen (group call from the photo).
  show(ui.btnAddMore, canCall);
  document.getElementById("app").classList.toggle("has-add-more", canCall);
  show(ui.zoomSoon, !setup && state.mode === "host" && !canCall && !isSelf);
  show(ui.zoomCard, true);
  await applyZoom(person);
}

function onStageBackground(ev) {
  if (state.gestureMoved) return;
  if (ev.target.closest(".zoom-card, .pill, .sheet")) return;
  if (state.select) {
    const picked = Number.isFinite(ev.clientX) && ev.clientX + ev.clientY > 0
      ? pickPersonAt(ev.clientX, ev.clientY)
      : null;
    if (picked) toggleSelect(picked);
    return;
  }
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
  if (!setup && me && state.select) {
    ui.greet1.textContent = "Wen noch?";
    ui.greet2.textContent = "Tippe auf alle, die mit dabei sein sollen.";
  } else if (!setup && me) {
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

function paintIncomingHostPortrait(from) {
  if (!ui.incomingHostFace || !ui.incomingHostWrap) return;
  const host = from || hostPerson();
  ui.incomingHostFace.src = "./icons/icon-512.png";
  ui.incomingHostFace.alt = host?.name || "Hannafon";
  ui.incomingHostWrap.classList.add("app-icon-tile");
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
  closeAddressbook();
  state.incomingShowHostIcon = false;
  clearSelectMode();
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
  paintPhotoExtend(blurUrl);
  ui.sharp.alt = "Familienfoto";
  await ui.sharp.decode().catch(() => {});
  await ui.blur.decode().catch(() => {});
  buildEdgeSamplers();
  requestEdgeColors();
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
    // Push click opened the app (cold start). The Worker replays the
    // still-ringing offer on connect; until then don't let "Anrufen" place a
    // callback, and if nothing arrives the call is over.
    expectIncoming(incoming);
  }
}

// ---------------------------------------------------------------------------
// V1.06: opened from a call notification
const EXPECT_INCOMING_MS = 8000;
function expectIncoming(fromNr) {
  const nr = Number(fromNr) || 0;
  if (!nr || !state.identity) return;
  if (state.pendingFrom && Number(state.pendingFrom.nr) === nr) return; // already showing
  if (state.inCallWith && !state.outgoing) return;
  state.expectIncoming = { from: nr, until: Date.now() + EXPECT_INCOMING_MS };
  document.getElementById("app").classList.add("is-expecting-call");
  // Fresh socket: replay arrives on "hello". (Also covers a dead iOS socket.)
  state.signaling.reconnect();
  clearTimeout(state.expectTimer);
  state.expectTimer = setTimeout(() => {
    if (!state.expectIncoming) return;
    endExpectIncoming();
    if (!state.pendingFrom && !state.inCallWith) {
      ui.takenToast.textContent = "Anruf vorbei";
      show(ui.takenToast, true);
      setTimeout(() => {
        show(ui.takenToast, false);
        ui.takenToast.textContent = "Anderswo angenommen";
      }, 2600);
    }
  }, EXPECT_INCOMING_MS);
}

function endExpectIncoming() {
  state.expectIncoming = null;
  clearTimeout(state.expectTimer);
  document.getElementById("app").classList.remove("is-expecting-call");
}

function expectingFrom(nr) {
  const e = state.expectIncoming;
  return !!(e && Date.now() < e.until && Number(e.from) === Number(nr));
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
  // Ask iOS for camera + microphone now, on this tap, instead of at the first
  // call. Tracks are stopped immediately; nothing keeps the camera running.
  primeMediaPermission("setup");
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

ui.btnBackPhoto.addEventListener("click", (ev) => {
  ev.stopPropagation();
  // V1.09: in select mode "Zum Foto" cancels the group and clears the choice.
  if (state.select) exitSelectMode();
  else if (state.zoomed) unzoom();
});
ui.btnAddMore.addEventListener("click", (ev) => {
  ev.stopPropagation();
  if (state.zoomed) enterSelectMode(state.zoomed);
});
ui.btnGroupCall.addEventListener("click", (ev) => {
  ev.stopPropagation();
  startFromSelection();
});
ui.btnAddressbook.addEventListener("click", (ev) => {
  ev.stopPropagation();
  openAddressbook();
});
ui.btnAbClose.addEventListener("click", (ev) => {
  ev.stopPropagation();
  closeAddressbook({ ack: true });
});
ui.btnMissed.addEventListener("click", (ev) => {
  ev.stopPropagation();
  openAddressbook("missed");
});

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

// ---------------------------------------------------------------------------
// iOS home-screen viewport (V1.05)
//
// WebKit bug (iOS/iPadOS 17–26, home-screen web apps installed with
// black-translucent or a manifest): the page is drawn from the physical top of
// the screen but sized as if the status bar still took its slice. The missing
// height falls off the bottom as an unpaintable strip (the "weißer Streifen").
// Signature: screen height − innerHeight === safe-area-inset-top, at full
// screen width. When that matches, grow html/body/#app by exactly that gap so
// the photo and the bottom controls reach the real bottom edge. In every other
// situation (Safari tab, Split View, a correctly inset web view) the gap is 0.
function computeIosBottomGap({ standalone, screenW, screenH, innerW, innerH, safeTop }) {
  if (!standalone) return 0;
  if (!(screenW > 0 && screenH > 0 && innerW > 0 && innerH > 0)) return 0;
  const long = Math.max(screenW, screenH);
  const short = Math.min(screenW, screenH);
  const landscape = innerW > innerH;
  const fullW = landscape ? long : short;
  const fullH = landscape ? short : long;
  if (Math.abs(innerW - fullW) > 2) return 0; // Split View / Stage Manager window
  const gap = Math.round(fullH - innerH);
  if (gap < 8 || gap > 80) return 0;
  if (!(safeTop >= 8) || Math.abs(gap - safeTop) > 3) return 0;
  return gap;
}

// V1.07: iPad / iPad mini (any orientation): touch screen whose short side is
// at least 600pt. iPhones (short side <= 440pt) and desktops (no touch) are not.
function isTabletScreen(t = {}) {
  if (typeof t.tablet === "boolean") return t.tablet;
  const touch = (navigator.maxTouchPoints || 0) > 0 || window.matchMedia("(any-pointer: coarse)").matches;
  if (!touch) return false;
  const sw = t.screenW ?? window.screen?.width ?? window.innerWidth;
  const sh = t.screenH ?? window.screen?.height ?? window.innerHeight;
  return Math.min(sw || 0, sh || 0) >= 600;
}

let safeProbe = null;
function readSafeTop() {
  if (!safeProbe) {
    safeProbe = document.createElement("div");
    safeProbe.setAttribute("aria-hidden", "true");
    safeProbe.style.cssText =
      "position:fixed;left:0;top:0;width:0;visibility:hidden;pointer-events:none;height:env(safe-area-inset-top,0px)";
    document.body.appendChild(safeProbe);
  }
  return safeProbe.getBoundingClientRect().height || 0;
}

function updateViewportFix() {
  const t = window.__HANNAFON_VIEWPORT_TEST__ || {};
  const gap = computeIosBottomGap({
    standalone: t.standalone ?? isStandalone(),
    screenW: t.screenW ?? window.screen?.width,
    screenH: t.screenH ?? window.screen?.height,
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    safeTop: t.safeTop ?? readSafeTop(),
  });
  const root = document.documentElement;
  // V1.07: black status-bar strip only in the Home Screen app; simulated
  // bottom display rounding only on iPad-sized touch screens.
  root.classList.toggle("is-standalone", Boolean(t.standalone ?? isStandalone()));
  root.classList.toggle("is-tablet", isTabletScreen(t));
  const prev = root.style.getPropertyValue("--ios-gap");
  const next = `${gap}px`;
  if (prev !== next) {
    root.style.setProperty("--ios-gap", next);
    state.iosGap = gap;
    return true;
  }
  return false;
}

function onViewportChange() {
  if (updateViewportFix()) requestStageLayout();
}
updateViewportFix();
window.addEventListener("resize", onViewportChange);
window.addEventListener("orientationchange", () => setTimeout(onViewportChange, 350));
window.addEventListener("pageshow", onViewportChange);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) onViewportChange();
});
window.visualViewport?.addEventListener("resize", onViewportChange);

// V1.08: the self-view box takes the real shape of the camera frame (portrait
// or landscape, it changes when the device rotates), so contain shows the whole
// frame without bars inside the small tile.
function syncLocalAspect() {
  const v = ui.localVideo;
  if (!v?.videoWidth || !v?.videoHeight) return;
  v.style.setProperty("--local-ar", String(v.videoWidth / v.videoHeight));
  v.dataset.aspect = v.videoWidth > v.videoHeight ? "landscape" : v.videoWidth < v.videoHeight ? "portrait" : "square";
}
for (const ev of ["loadedmetadata", "resize"]) ui.localVideo.addEventListener(ev, syncLocalAspect);
function syncRemoteAspect() {
  const v = ui.remoteVideo;
  if (!v?.videoWidth || !v?.videoHeight) return;
  v.dataset.aspect = v.videoWidth > v.videoHeight ? "landscape" : v.videoWidth < v.videoHeight ? "portrait" : "square";
}
for (const ev of ["loadedmetadata", "resize"]) ui.remoteVideo.addEventListener(ev, syncRemoteAspect);

// ---------------------------------------------------------------------------
// Status bar + page edge colours (V1.05, V1.06)
//
// V1.06: the status bar is always solid black ("black" status-bar style,
// theme-color #000000). It is no longer tinted from the photo or cream.
// The opaque style keeps iOS 26's Liquid Glass blur off the photo (the
// translucent style put the photo under the bar). We still sample the photo's
// bottom edge for the html/page background, so any area iOS paints outside
// the page blends into the photo instead of showing cream/white.
const STATUS_BAR = "#000000";
const CREAM = "#F6EFE3";
const CALL_BG = "#111111";
const edgeSamplers = { sharp: null, blur: null };

function buildSampler(img) {
  try {
    if (!img?.naturalWidth) return null;
    const w = 96;
    const h = Math.max(8, Math.round((w * img.naturalHeight) / img.naturalWidth));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    return { w, h, data: ctx.getImageData(0, 0, w, h).data };
  } catch {
    return null; // tainted or unsupported: keep the fallback colours
  }
}

function buildEdgeSamplers() {
  edgeSamplers.sharp = buildSampler(ui.sharp);
  edgeSamplers.blur = buildSampler(ui.blur) || edgeSamplers.sharp;
}

function toHex(r, g, b) {
  const h = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

// Average colour of a band of the photo, in fractions of the photo (0..1).
function sampleBand(sampler, fx0, fx1, fy0, fy1) {
  if (!sampler) return null;
  const { w, h, data } = sampler;
  const x0 = Math.max(0, Math.min(w - 1, Math.floor(Math.min(fx0, fx1) * w)));
  const x1 = Math.max(x0 + 1, Math.min(w, Math.ceil(Math.max(fx0, fx1) * w)));
  const y0 = Math.max(0, Math.min(h - 1, Math.floor(Math.min(fy0, fy1) * h)));
  const y1 = Math.max(y0 + 1, Math.min(h, Math.ceil(Math.max(fy0, fy1) * h)));
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      n++;
    }
  }
  return n ? toHex(r / n, g / n, b / n) : null;
}

// Which part of the photo touches the top and bottom edge of the screen right now.
function visibleEdgeColors() {
  const layout = state.layout;
  if (!layout || !layout.dw || !layout.dh) return null;
  const sampler = state.zoomed ? edgeSamplers.blur : edgeSamplers.sharp;
  if (!sampler) return null;
  const v = currentView();
  const W = ui.stage.clientWidth;
  const H = ui.stage.clientHeight;
  const toFx = (cx) => (cx - layout.ox - v.tx) / v.s / layout.dw;
  const toFy = (cy) => (cy - layout.oy - v.ty) / v.s / layout.dh;
  let fx0 = Math.max(0, toFx(0));
  let fx1 = Math.min(1, toFx(W));
  if (fx1 - fx0 < 0.02) { fx0 = Math.max(0, Math.min(fx0, 0.98)); fx1 = Math.min(1, fx0 + 0.02); }
  const band = 0.025;
  let fyTop = toFy(0);
  let fyBot = toFy(H);
  if (state.zoomed) {
    // Zoomed views may extend past the photo (mirrored): use the nearest real row.
    fyTop = Math.min(1 - band, Math.max(0, fyTop));
    fyBot = Math.min(1, Math.max(band, fyBot));
  }
  const top = fyTop < -0.002 ? null : sampleBand(sampler, fx0, fx1, fyTop, fyTop + band);
  const bottom = fyBot > 1.002 ? null : sampleBand(sampler, fx0, fx1, fyBot - band, fyBot);
  return { top, bottom };
}

function setEdgeColors(top, bottom) {
  // V1.07: every theme-color meta (plain, light, dark) stays black.
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    if (meta.getAttribute("content") !== STATUS_BAR) meta.setAttribute("content", STATUS_BAR);
  }
  const root = document.documentElement;
  root.style.setProperty("--edge-top", top);
  root.style.setProperty("--edge-bottom", bottom);
  state.edge = { top, bottom };
}

function updateEdgeColors() {
  const screen = state.screen;
  if (screen === "call") return setEdgeColors(CALL_BG, CALL_BG);
  const onPhoto = (screen === "photo" || screen === "incoming") && !ui.photo.hidden;
  if (!onPhoto || !ui.addressbook.hidden) return setEdgeColors(CREAM, CREAM);
  const c = visibleEdgeColors();
  setEdgeColors(c?.top || CREAM, c?.bottom || CREAM);
}

let edgeRaf = 0;
function requestEdgeColors() {
  if (edgeRaf) return;
  edgeRaf = requestAnimationFrame(() => {
    edgeRaf = 0;
    updateEdgeColors();
  });
}

// ---------------------------------------------------------------------------
// Camera/microphone permission (V1.05)
// Already set up? Then the first tap after launch asks iOS for camera and
// microphone (only if the Permissions API does not already say granted or
// denied). This moves the system prompt away from the moment of a call.
refreshMediaPermissionState();
document.getElementById("app").addEventListener(
  "pointerdown",
  () => {
    if (!state.identity || !state.config) return;
    if (state.mode !== "host" && state.mode !== "standby" && ui.incoming.hidden) return;
    primeMediaPermission("first-tap");
  },
  { capture: true }
);

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
  localStorage.removeItem(STORAGE_MISSED);
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
  state.signaling.on("hangup", onRemoteHangup);
  state.signaling.on("declined", onRemoteDeclined);
  state.signaling.on("peer-join", onPeerJoin);
  state.signaling.on("peer-offer", onPeerOffer);
  state.signaling.on("peer-answer", onPeerAnswer);
  state.signaling.on("peer-ice", onPeerIce);
  state.signaling.on("peer-leave", onPeerLeave);
  state.signaling.on("group-state", onGroupState);
  state.signaling.on("reject", () => hangup(true));
  state.signaling.on("taken", onCallTakenElsewhere);
  state.signaling.on("missed", onMissed);
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
      if (s === "connected") {
        ui.callStatus.textContent = "";
        // V1.09: (re)apply the 1:1 send cap once negotiated (WebKit).
        if (state.pc && !state.group) applySendCaps(state.pc, 1);
      }
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
  // V1.06: that person is calling us right now: answer instead of calling back.
  if (state.pendingFrom && Number(state.pendingFrom.nr) === Number(person.nr) && state.pendingOffer) {
    acceptIncoming();
    return;
  }
  // Opened from their call notification and the offer is still on its way:
  // fetch it again instead of ringing them back.
  if (expectingFrom(person.nr)) {
    state.signaling.reconnect();
    return;
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
    applySendCaps(state.pc, 1);
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
  // V1.09: nothing interrupts a running group call.
  if (state.group) return;
  if (state.inCallWith && !state.outgoing) return;
  if (!data?.sdp) return;
  const from = personByNr(data.from);
  // Same offer again (replay after reconnect): keep the screen, add any ICE.
  if (state.pendingFrom && from && Number(state.pendingFrom.nr) === Number(from.nr) &&
      data.callId && data.callId === state.pendingCallId && !ui.incoming.hidden) {
    for (const c of data.ice || []) queuePendingIce(c);
    endExpectIncoming();
    return;
  }
  // We were calling them ourselves (glare / callback): drop our own outgoing
  // attempt silently (no hangup to them) and take their call instead.
  if (state.outgoing && state.inCallWith && from && Number(state.inCallWith.nr) === Number(from.nr)) {
    dropLocalCall();
  }
  endExpectIncoming();
  state.pendingOffer = data.sdp;
  state.pendingFrom = from;
  state.pendingFromDevice = data.fromDevice || null;
  state.pendingCallId = data.callId || null;
  state.pendingIce = [];
  for (const c of data.ice || []) queuePendingIce(c);
  ui.incomingTitle.textContent = `${from?.name || "Jemand"} ruft an`;
  // V1.09: group call: remember the group and name the other invitees.
  state.pendingGroup = data.group && data.group.id ? data.group : null;
  const others = (state.pendingGroup?.members || [])
    .map(Number)
    .filter((nr) => nr && nr !== Number(state.identity?.nr) && nr !== Number(from?.nr))
    .map((nr) => personByNr(nr)?.name)
    .filter(Boolean);
  ui.incomingSub.textContent = others.length ? `mit ${joinNames(others)}` : "";
  show(ui.incomingSub, others.length > 0);
  show(ui.zoomCard, false);
  // When Hanna calls, show her app-icon portrait on cream — never a zoom of the family photo.
  const fromHost = !!(from && isHostPerson(from, state.config));
  state.incomingShowHostIcon = fromHost;
  if (fromHost) {
    if (state.zoomed) unzoom();
    paintIncomingHostPortrait(from);
    showScreen("incoming");
  } else {
    showScreen("incoming");
    applyStageLayout();
    if (from) {
      state.zoomed = from;
      applyZoom(from);
    }
  }
  beginIncomingRing();
}

function updateRingHint() {
  // Hint only when nothing is audible (iOS refused both the ringtone file and
  // the Web Audio fallback, e.g. no tap since launch).
  const locked = !isRingAudible();
  ui.incoming?.classList.toggle("is-waiting-audio", locked && !ui.incoming.hidden);
  show(ui.ringHint, locked && !ui.incoming.hidden);
}

async function beginIncomingRing() {
  await startRingtone();
  updateRingHint();
}

async function onRemoteAnswer(data) {
  if (state.group) {
    await onGroupAnswer(data);
    return;
  }
  if (!state.pc || !data.sdp) return;
  await state.pc.setRemoteDescription(data.sdp);
  await flushIce(state.pc);
}

function queuePendingIce(c) {
  if (!c) return;
  state.pendingIce = state.pendingIce || [];
  if (state.pendingIce.length < 60) state.pendingIce.push(c);
}

// Tear down our own outgoing attempt without telling the other side.
function dropLocalCall() {
  stopRingtone();
  closePeer(state.pc);
  state.pc = null;
  stopStream(state.localStream);
  state.localStream = null;
  ui.localVideo.srcObject = null;
  state.inCallWith = null;
  state.outgoing = false;
  state.callId = null;
  state.peerDevice = null;
}

async function onRemoteIce(data) {
  if (state.group) {
    const p = groupPeer(data.from);
    if (p?.pc && data.candidate) await addIce(p.pc, data.candidate);
    return;
  }
  // V1.06: before Annehmen there is no peer yet; keep the caller's candidates.
  if (!state.pc && data.candidate && state.pendingFrom && Number(data.from) === Number(state.pendingFrom.nr)) {
    queuePendingIce(data.candidate);
    return;
  }
  if (state.pc && data.candidate) await addIce(state.pc, data.candidate);
}

ui.btnAccept.addEventListener("click", () => acceptIncoming());

async function acceptIncoming() {
  stopRingtone();
  show(ui.ringHint, false);
  ui.incoming?.classList.remove("is-waiting-audio");
  const from = state.pendingFrom;
  const offer = state.pendingOffer;
  if (!from || !offer) return;
  state.inCallWith = from;
  state.outgoing = false;
  state.incomingShowHostIcon = false;
  // V1.09: joining a group call (Hanna plus others, mesh).
  const grp = state.pendingGroup;
  state.pendingGroup = null;
  if (grp) {
    state.group = {
      id: grp.id,
      isHost: false,
      hostNr: Number(from.nr),
      peers: new Map(),
      ready: false,
      waiters: [],
      iceWait: new Map(),
    };
    ensureGroupPeer(from.nr, { status: "joined", device: state.pendingFromDevice || null });
  }
  showScreen("call");
  renderGrid();
  ui.callStatus.textContent = "Verbinden…";
  try {
    state.localStream = await getLocalStream();
    ui.localVideo.srcObject = state.localStream;
    const g = state.group && grp && state.group.id === grp.id ? state.group : null;
    state.pc = createPeer(
      state.config.iceServers,
      state.localStream,
      g ? groupPeerHandlers(from.nr) : peerHandlers(from.nr)
    );
    if (g) groupPeer(from.nr).pc = state.pc;
    await state.pc.setRemoteDescription(offer);
    for (const c of state.pendingIce || []) await addIce(state.pc, c);
    state.pendingIce = [];
    await flushIce(state.pc);
    const answer = await state.pc.createAnswer();
    await state.pc.setLocalDescription(answer);
    applySendCaps(state.pc, g ? groupRemoteCount() : 1);
    state.signaling.send({
      type: "answer",
      to: from.nr,
      toDevice: state.pendingFromDevice,
      fromDevice: getDeviceId(),
      callId: state.pendingCallId || undefined,
      sdp: state.pc.localDescription,
    });
    state.peerDevice = state.pendingFromDevice;
    if (g && state.group === g) {
      g.ready = true;
      const waiting = g.waiters.splice(0);
      for (const fn of waiting) fn();
    }
  } catch {
    ui.callStatus.textContent = "Kamera oder Mikrofon nicht verfügbar";
  }
}

ui.btnDecline.addEventListener("click", () => {
  stopRingtone();
  show(ui.ringHint, false);
  ui.incoming?.classList.remove("is-waiting-audio");
  if (state.pendingFrom) {
    state.signaling.send({ type: "reject", to: state.pendingFrom.nr, callId: state.pendingCallId || undefined });
  }
  state.pendingGroup = null;
  state.pendingFrom = null;
  state.pendingOffer = null;
  state.pendingCallId = null;
  state.pendingIce = [];
  goHome();
});

ui.btnHangup.addEventListener("click", () => hangup(false));

function hangup(remote) {
  stopRingtone();
  const g = state.group;
  if (!remote && g) {
    // V1.09: Hanna ends the whole group call (ringing ones get a hangup too,
    // which the Worker records as missed). A guest only leaves: hangup to
    // Hanna, peer-leave to everyone else.
    if (g.isHost) {
      for (const p of g.peers.values()) {
        state.signaling.send({ type: "hangup", to: p.nr, fromDevice: getDeviceId(), callId: g.id });
      }
    } else {
      state.signaling.send({ type: "hangup", to: g.hostNr, fromDevice: getDeviceId(), callId: g.id });
      for (const p of g.peers.values()) {
        if (p.nr === g.hostNr) continue;
        state.signaling.send({ type: "peer-leave", to: p.nr, toDevice: p.device || undefined, groupId: g.id });
      }
    }
  } else if (!remote && state.inCallWith) {
    state.signaling.send({ type: "hangup", to: state.inCallWith.nr, fromDevice: getDeviceId() });
  }
  if (g) {
    for (const p of g.peers.values()) {
      clearTimeout(p.ring);
      if (p.pc !== state.pc) closePeer(p.pc);
    }
  }
  state.group = null;
  state.pendingGroup = null;
  renderGrid();
  show(ui.incomingSub, false);
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
  state.pendingCallId = null;
  state.pendingIce = [];
  state.peerDevice = null;
  state.callId = null;
  if (state.identity && state.config) goHome();
}

// ---------------------------------------------------------------------------
// V1.09 group calls (Hanna + up to three others, mesh, STUN only)
//
// Signalling:
// - Hanna sends a normal "call" (with group: { id, members }) to every
//   invitee, one RTCPeerConnection each. Ringing, push, replay, taken and
//   missed work exactly like a 1:1 call, per person.
// - When an invitee answers, Hanna tells every guest already in the call
//   ("peer-join"). The EXISTING guest offers to the newcomer ("peer-offer" →
//   "peer-answer", "peer-ice"), so each pair negotiates once, no glare.
// - Hanna broadcasts the roster ("group-state": ringing / joined) so every
//   guest shows the same tiles. A guest leaving sends "hangup" to Hanna and
//   "peer-leave" to the others; Hanna's Auflegen hangs up on everyone.
const GROUP_MAX_OTHERS = 3;
let groupRingMs = 60000; // unanswered invitee: tile goes, Worker counts a missed call

function joinNames(names) {
  const n = (names || []).filter(Boolean);
  if (n.length <= 1) return n[0] || "";
  return `${n.slice(0, -1).join(", ")} und ${n[n.length - 1]}`;
}

function canSelect(person) {
  return !!(person && isTappable(person) && person.callable && !isHostPerson(person, state.config));
}

// ---- select mode on the photo ----------------------------------------------
function enterSelectMode(first) {
  if (state.mode !== "host" || !canSelect(first)) return;
  state.select = { nrs: [Number(first.nr)] };
  document.getElementById("app").classList.add("is-selecting");
  unzoom();
  setGreeting();
  renderSelection();
}

function renderSelection() {
  const sel = state.select;
  show(ui.selectBar, !!sel);
  if (!sel) return;
  const names = sel.nrs.map((nr) => personByNr(nr)?.name || "");
  ui.btnGroupCallLabel.textContent = `${joinNames(names)} anrufen`;
  ui.btnGroupCall.dataset.nrs = sel.nrs.join(",");
  layoutHits();
  updateCornerButtons();
}

function toggleSelect(person) {
  const sel = state.select;
  if (!sel || !canSelect(person)) return;
  const nr = Number(person.nr);
  const i = sel.nrs.indexOf(nr);
  if (i >= 0) {
    if (sel.nrs.length > 1) sel.nrs.splice(i, 1); // at least one stays chosen
  } else if (sel.nrs.length >= GROUP_MAX_OTHERS) {
    showSelectHint("Höchstens drei Personen auf einmal.");
    return;
  } else {
    sel.nrs.push(nr);
  }
  show(ui.selectHint, false);
  renderSelection();
}

let selectHintTimer = null;
function showSelectHint(text) {
  ui.selectHint.textContent = text;
  show(ui.selectHint, true);
  clearTimeout(selectHintTimer);
  selectHintTimer = setTimeout(() => show(ui.selectHint, false), 2600);
}

// Leave select mode without touching the rest of the screen.
function clearSelectMode() {
  if (!state.select) return false;
  state.select = null;
  document.getElementById("app").classList.remove("is-selecting");
  show(ui.selectBar, false);
  show(ui.selectHint, false);
  return true;
}

function exitSelectMode() {
  if (!clearSelectMode()) return;
  setGreeting();
  layoutHits();
  updateCornerButtons();
}

function startFromSelection() {
  const sel = state.select;
  if (!sel || !sel.nrs.length) return;
  const people = sel.nrs.map(personByNr).filter(canSelect);
  exitSelectMode();
  if (people.length === 1) startCall(people[0]); // one person: the familiar 1:1 call
  else if (people.length > 1) startGroupCall(people);
}

// ---- call state ----------------------------------------------------------------
function groupPeer(nr) {
  return state.group?.peers.get(Number(nr)) || null;
}

function ensureGroupPeer(nr, { status = "joined", device = null } = {}) {
  const g = state.group;
  if (!g) return null;
  const key = Number(nr);
  let p = g.peers.get(key);
  if (!p) {
    p = { nr: key, status, device, pc: null, stream: null, ring: null, conn: "" };
    g.peers.set(key, p);
  } else if (device && !p.device) {
    p.device = device;
  }
  return p;
}

// Everyone else in the call (ringing included): sets the per-stream cap.
function groupRemoteCount() {
  return state.group ? Math.max(1, state.group.peers.size) : 1;
}

function applyGroupCaps() {
  const g = state.group;
  if (!g) return;
  const n = groupRemoteCount();
  for (const p of g.peers.values()) if (p.pc) applySendCaps(p.pc, n);
}

function groupPeerHandlers(nr) {
  const peerNr = Number(nr);
  return {
    onIce: (candidate) => {
      const g = state.group;
      if (!g) return;
      const p = groupPeer(peerNr);
      // Hanna <-> guest ICE uses the normal "ice" (kept with the ringing offer
      // for push replay); guest <-> guest uses "peer-ice".
      const viaCall = g.isHost || peerNr === Number(g.hostNr);
      state.signaling.send({
        type: viaCall ? "ice" : "peer-ice",
        to: peerNr,
        toDevice: p?.device || undefined,
        fromDevice: getDeviceId(),
        groupId: g.id,
        candidate,
      });
    },
    onTrack: (stream) => {
      const p = groupPeer(peerNr);
      if (!p) return;
      p.stream = stream;
      renderGrid();
    },
    onState: (s) => {
      const p = groupPeer(peerNr);
      if (!p) return;
      p.conn = s;
      if (s === "connected") {
        ui.callStatus.textContent = "";
        applySendCaps(p.pc, groupRemoteCount());
      }
    },
  };
}

async function startGroupCall(people) {
  if (!state.identity || !isHostPerson(state.identity, state.config)) return;
  const list = (people || []).filter(canSelect).slice(0, GROUP_MAX_OTHERS);
  if (list.length < 2) {
    if (list[0]) startCall(list[0]);
    return;
  }
  hangup(false);
  const id = (crypto.randomUUID && crypto.randomUUID()) || `g-${Date.now()}`;
  const members = list.map((p) => Number(p.nr));
  const g = {
    id,
    isHost: true,
    hostNr: Number(state.identity.nr),
    peers: new Map(),
    ready: true,
    waiters: [],
    iceWait: new Map(),
  };
  state.group = g;
  state.callId = id;
  state.inCallWith = list[0];
  state.outgoing = true;
  state.peerDevice = null;
  for (const nr of members) ensureGroupPeer(nr, { status: "ringing" });
  showScreen("call");
  ui.callStatus.textContent = "";
  renderGrid();
  try {
    const stream = await getLocalStream();
    if (state.group !== g) {
      stopStream(stream);
      return;
    }
    state.localStream = stream;
    ui.localVideo.srcObject = stream;
    for (const nr of members) {
      const p = groupPeer(nr);
      if (!p || state.group !== g) continue;
      p.pc = createPeer(state.config.iceServers, stream, groupPeerHandlers(nr));
      const offer = await p.pc.createOffer();
      await p.pc.setLocalDescription(offer);
      applySendCaps(p.pc, members.length);
      state.signaling.send({
        type: "call",
        to: nr,
        fromDevice: getDeviceId(),
        fromName: state.identity.name,
        callId: id,
        group: { id, members },
        sdp: p.pc.localDescription,
      });
      p.ring = setTimeout(() => onGroupRingTimeout(g, nr), groupRingMs);
    }
  } catch {
    ui.callStatus.textContent = "Kamera oder Mikrofon nicht verfügbar";
  }
}

function onGroupRingTimeout(g, nr) {
  if (state.group !== g) return;
  const p = groupPeer(nr);
  if (!p || p.status !== "ringing") return;
  // The hangup ends the ring on all of that person's devices; the Worker
  // records it as missed (nobody declined).
  groupDropPeer(nr, { sendHangup: true });
}

// Remove one person from the call (declined, timed out, left).
function groupDropPeer(nr, { sendHangup = false } = {}) {
  const g = state.group;
  if (!g) return;
  const key = Number(nr);
  const p = g.peers.get(key);
  if (!p) return;
  clearTimeout(p.ring);
  if (sendHangup) {
    state.signaling.send({ type: "hangup", to: key, fromDevice: getDeviceId(), callId: g.id });
  }
  if (p.pc !== state.pc || g.isHost) closePeer(p.pc);
  g.peers.delete(key);
  g.iceWait.delete(key);
  if (g.isHost) {
    if (!g.peers.size) {
      hangup(true); // nobody left
      return;
    }
    broadcastGroupState();
  } else if (key === Number(g.hostNr)) {
    hangup(true);
    return;
  }
  applyGroupCaps();
  renderGrid();
}

function groupRoster() {
  return [...(state.group?.peers.values() || [])].map((p) => ({ nr: p.nr, state: p.status }));
}

function broadcastGroupState() {
  const g = state.group;
  if (!g?.isHost) return;
  const members = groupRoster();
  for (const p of g.peers.values()) {
    if (p.status !== "joined") continue;
    state.signaling.send({ type: "group-state", to: p.nr, toDevice: p.device || undefined, groupId: g.id, members });
  }
}

// Hanna: an invitee answered.
async function onGroupAnswer(data) {
  const g = state.group;
  if (!g?.isHost || !data?.sdp) return;
  const p = groupPeer(data.from);
  if (!p || !p.pc || p.status === "joined") return;
  clearTimeout(p.ring);
  p.status = "joined";
  p.device = data.fromDevice || null;
  const before = [...g.peers.values()].filter((q) => q.status === "joined" && q.nr !== p.nr);
  try {
    await p.pc.setRemoteDescription(data.sdp);
    await flushIce(p.pc);
  } catch {
    /* connection state shows it */
  }
  if (state.group !== g) return;
  // Mesh: guests already in the call connect to the newcomer.
  for (const q of before) {
    state.signaling.send({
      type: "peer-join",
      to: q.nr,
      toDevice: q.device || undefined,
      groupId: g.id,
      nr: p.nr,
      device: p.device || undefined,
    });
  }
  broadcastGroupState();
  applyGroupCaps();
  renderGrid();
}

function onRemoteHangup(data) {
  const g = state.group;
  if (!g) {
    hangup(true);
    return;
  }
  const from = Number(data?.from);
  if (!g.isHost && from === Number(g.hostNr)) {
    hangup(true); // Hanna ended the group call
    return;
  }
  if (g.peers.has(from)) groupDropPeer(from);
}

// Worker: every device of that person declined. Group: drop the tile and end
// the ring (no missed call, she noticed). 1:1 keeps waiting as before.
function onRemoteDeclined(data) {
  const g = state.group;
  if (!g?.isHost) return;
  const p = groupPeer(data?.from);
  if (p && p.status === "ringing") groupDropPeer(p.nr, { sendHangup: true });
}

function groupMsgOk(data) {
  const g = state.group;
  return !!(g && !g.isHost && data && data.groupId === g.id && Number(data.from) !== Number(state.identity?.nr));
}

function drainGroupIce(nr) {
  const g = state.group;
  const p = groupPeer(nr);
  if (!g || !p?.pc) return;
  const list = g.iceWait.get(Number(nr)) || [];
  g.iceWait.delete(Number(nr));
  for (const c of list) addIce(p.pc, c);
}

// Existing guest: Hanna says someone new joined → offer to them.
async function onPeerJoin(data) {
  if (!groupMsgOk(data)) return;
  const g = state.group;
  if (Number(data.from) !== Number(g.hostNr)) return;
  if (!g.ready) {
    g.waiters.push(() => onPeerJoin(data));
    return;
  }
  const nr = Number(data.nr);
  if (!nr || nr === Number(state.identity?.nr) || nr === Number(g.hostNr)) return;
  const p = ensureGroupPeer(nr, { status: "joined", device: data.device || null });
  if (data.device) p.device = data.device;
  p.status = "joined";
  if (p.pc) return;
  p.pc = createPeer(state.config.iceServers, state.localStream, groupPeerHandlers(nr));
  drainGroupIce(nr);
  renderGrid();
  try {
    const offer = await p.pc.createOffer();
    await p.pc.setLocalDescription(offer);
    applyGroupCaps();
    state.signaling.send({
      type: "peer-offer",
      to: nr,
      toDevice: p.device || undefined,
      fromDevice: getDeviceId(),
      groupId: g.id,
      sdp: p.pc.localDescription,
    });
  } catch {
    /* tile stays black with the name */
  }
}

// Newcomer: an existing guest offers.
async function onPeerOffer(data) {
  if (!groupMsgOk(data) || !data.sdp) return;
  const g = state.group;
  if (!g.ready) {
    g.waiters.push(() => onPeerOffer(data));
    return;
  }
  const nr = Number(data.from);
  if (nr === Number(g.hostNr)) return;
  const p = ensureGroupPeer(nr, { status: "joined", device: data.fromDevice || null });
  if (data.fromDevice) p.device = data.fromDevice;
  p.status = "joined";
  if (p.pc) closePeer(p.pc);
  p.pc = createPeer(state.config.iceServers, state.localStream, groupPeerHandlers(nr));
  renderGrid();
  try {
    await p.pc.setRemoteDescription(data.sdp);
    drainGroupIce(nr);
    await flushIce(p.pc);
    const answer = await p.pc.createAnswer();
    await p.pc.setLocalDescription(answer);
    applyGroupCaps();
    state.signaling.send({
      type: "peer-answer",
      to: nr,
      toDevice: p.device || undefined,
      fromDevice: getDeviceId(),
      groupId: g.id,
      sdp: p.pc.localDescription,
    });
  } catch {
    /* tile stays black with the name */
  }
}

async function onPeerAnswer(data) {
  if (!groupMsgOk(data) || !data.sdp) return;
  const p = groupPeer(data.from);
  if (!p?.pc || p.pc.signalingState !== "have-local-offer") return;
  try {
    await p.pc.setRemoteDescription(data.sdp);
    await flushIce(p.pc);
  } catch {
    /* ignore */
  }
}

function onPeerIce(data) {
  if (!groupMsgOk(data) || !data.candidate) return;
  const g = state.group;
  const p = groupPeer(data.from);
  if (p?.pc) {
    addIce(p.pc, data.candidate);
    return;
  }
  const key = Number(data.from);
  const list = g.iceWait.get(key) || [];
  if (list.length < 60) list.push(data.candidate);
  g.iceWait.set(key, list);
}

function onPeerLeave(data) {
  if (!groupMsgOk(data)) return;
  const nr = Number(data.from);
  if (nr === Number(state.group.hostNr)) return;
  groupDropPeer(nr);
}

// Guests: Hanna's roster (who rings, who is in). Anyone missing is gone.
function onGroupState(data) {
  if (!groupMsgOk(data)) return;
  const g = state.group;
  if (Number(data.from) !== Number(g.hostNr)) return;
  const me = Number(state.identity?.nr);
  const listed = new Set();
  for (const m of data.members || []) {
    const nr = Number(m.nr);
    if (!nr || nr === me || nr === Number(g.hostNr)) continue;
    listed.add(nr);
    const p = ensureGroupPeer(nr, { status: m.state === "joined" ? "joined" : "ringing" });
    if (m.state === "joined") p.status = "joined";
  }
  for (const p of [...g.peers.values()]) {
    if (p.nr !== Number(g.hostNr) && !listed.has(p.nr)) groupDropPeer(p.nr);
  }
  if (state.group !== g) return;
  applyGroupCaps();
  renderGrid();
}

// ---- in-call grid ------------------------------------------------------------
function makeTile(p) {
  const person = personByNr(p.nr);
  const name = person?.name || "";
  const tile = document.createElement("div");
  tile.className = "tile";
  tile.dataset.nr = String(p.nr);
  const label = document.createElement("p");
  label.className = "tile-name";
  label.textContent = name;
  if (p.status === "ringing") {
    tile.dataset.kind = "ringing";
    tile.classList.add("is-ringing");
    const av = document.createElement("span");
    av.className = "tile-avatar";
    av.textContent = String(name || "?").trim().charAt(0).toUpperCase();
    av.style.background = AVATAR_TINTS[Number(p.nr) % AVATAR_TINTS.length];
    const ring = document.createElement("p");
    ring.className = "tile-ring";
    ring.textContent = "klingelt…";
    tile.append(av, label, ring);
  } else {
    tile.dataset.kind = "video";
    const v = document.createElement("video");
    v.autoplay = true;
    v.playsInline = true;
    v.setAttribute("playsinline", "");
    v.setAttribute("webkit-playsinline", "");
    tile.append(v, label);
  }
  return tile;
}

function renderGrid() {
  const grid = ui.callGrid;
  if (!grid) return;
  const g = state.group;
  if (!g) {
    for (const v of grid.querySelectorAll("video")) v.srcObject = null;
    grid.innerHTML = "";
    show(grid, false);
    ui.call.classList.remove("is-group");
    return;
  }
  ui.call.classList.add("is-group");
  show(grid, true);
  const peers = [...g.peers.values()];
  const want = new Set(peers.map((p) => String(p.nr)));
  for (const t of [...grid.children]) {
    if (!want.has(t.dataset.nr)) {
      const v = t.querySelector("video");
      if (v) v.srcObject = null;
      t.remove();
    }
  }
  peers.forEach((p, i) => {
    let tile = grid.querySelector(`.tile[data-nr="${p.nr}"]`);
    const kind = p.status === "ringing" ? "ringing" : "video";
    if (tile && tile.dataset.kind !== kind) {
      tile.remove();
      tile = null;
    }
    if (!tile) tile = makeTile(p);
    if (grid.children[i] !== tile) grid.insertBefore(tile, grid.children[i] || null);
    if (kind === "video") {
      const v = tile.querySelector("video");
      if (p.stream && v.srcObject !== p.stream) {
        v.srcObject = p.stream;
        v.play().catch(() => {});
      }
    }
  });
  grid.dataset.count = String(peers.length);
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
  await unlockAudio(true);
  if (state.pendingFrom && !isRingAudible()) await startRingtone();
  updateRingHint();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {});
  navigator.serviceWorker.addEventListener("message", (ev) => {
    // V1.06: notification tapped while the app was in memory: reconnect so the
    // Worker replays the ringing offer and Annehmen appears.
    if (ev.data?.type === "incoming" && ev.data.data?.from) expectIncoming(ev.data.data.from);
  });
  navigator.serviceWorker.startMessages?.();
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
  localStorage.removeItem(STORAGE_MISSED);
  state.missed = [];
  state.identity = null;
  state.mode = "setup";
  show(ui.disconnectSheet, false);
  goHome();
}

(function bindPhotoGestures() {
  const pointers = new Map();
  let lastDist = 0;

  function active() {
    return !state.zoomed && pinchAllowed();
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

// V1.06: no page zoom (Safari pinch, double-tap, trackpad ctrl+wheel). The
// viewport meta and touch-action already ask for this; iOS honours these
// events more reliably in Home Screen apps. Two-finger moves on the photo stay
// allowed only where the app's own phone pinch is active.
(function blockPageZoom() {
  const block = (ev) => ev.preventDefault();
  for (const ev of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(ev, block, { passive: false });
  }
  document.addEventListener(
    "touchmove",
    (ev) => {
      if (ev.touches && ev.touches.length > 1) {
        if (pinchAllowed() && !state.zoomed && ui.stage.contains(ev.target)) return;
        ev.preventDefault();
      }
    },
    { passive: false }
  );
  document.addEventListener(
    "wheel",
    (ev) => {
      if (ev.ctrlKey && !(pinchAllowed() && ui.stage.contains(ev.target))) ev.preventDefault();
    },
    { passive: false }
  );
})();

// V1.06: back from background (iOS suspends sockets): reconnect when idle so a
// call that started meanwhile is replayed by the Worker.
function reviveSignaling() {
  if (document.visibilityState !== "visible") return;
  if (!state.identity || !state.config || state.inCallWith) return;
  state.signaling.reconnect();
}
document.addEventListener("visibilitychange", reviveSignaling);
window.addEventListener("pageshow", (ev) => { if (ev.persisted) reviveSignaling(); });

bindAudioUnlock();
tryStoredCode();

window.__hannafonTest = {
  ready: () => !!(state.config && state.layout && ui.sharp?.naturalWidth),
  localStream: () => state.localStream,
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
  addressbookNrs: () => addressbookPeople().map((p) => p.nr),
  missed: () => missedPeople().map((m) => ({ from: m.from, count: m.count, last: m.last })),
  missedRaw: () => state.missed.slice(),
  injectMissed: (items) => onMissed({ items }),
  openMissed: () => openAddressbook("missed"),
  resyncMissed: () => { state.missed = []; saveMissedCache(); updateCornerButtons(); state.signaling.reconnect(); },
  missedWhen: (ts, now) => missedWhen(ts, now),
  clearMissedAll: () => { state.missed = []; saveMissedCache(); state.signaling.send({ type: "missed-clear", nr: 0 }); updateCornerButtons(); },
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
  computeIosBottomGap,
  updateViewportFix: () => {
    updateViewportFix();
    applyStageLayout();
    return state.iosGap || 0;
  },
  iosGap: () => state.iosGap || 0,
  edgeColors: () => {
    updateEdgeColors();
    return { ...(state.edge || {}) };
  },
  mediaPermissionState,
  mediaPrimeLog,
  audioState: () => audioContextState(),
  isAudioUnlocked,
  unlockAudio,
  startRingtone,
  stopRingtone,
  audioDebug,
  isRingAudible,
  pinchAllowed: () => pinchAllowed(),
  incomingState: () => ({
    screen: state.screen,
    pendingFrom: state.pendingFrom?.nr || null,
    hasOffer: !!state.pendingOffer,
    pendingIce: (state.pendingIce || []).length,
    expecting: state.expectIncoming ? state.expectIncoming.from : null,
    inCallWith: state.inCallWith?.nr || null,
    outgoing: !!state.outgoing,
    showHostIcon: !!state.incomingShowHostIcon,
  }),
  expectIncoming: (nr) => expectIncoming(nr),
  dropSocket: () => {
    // Simulate iOS killing the socket while backgrounded (no reconnect).
    state.signaling.wanted = false;
    try { state.signaling.ws?.close(); } catch { /* ignore */ }
    state.signaling.ws = null;
  },
  muteCalls: (on) => {
    // Simulate "offer never reached this page" while the socket stays up.
    if (on) state.signaling.handlers.delete("call");
    else state.signaling.on("call", onRemoteCall);
  },
  restoreSocket: () => {
    state.signaling.wanted = true;
    state.signaling.reconnect();
  },
  photoScale: () => ({ ...currentView(), navUser: !!state.navUser }),
  // V1.09 group calls + send caps
  joinNames: (names) => joinNames(names),
  selectState: () => (state.select ? { nrs: state.select.nrs.slice() } : null),
  setGroupRingMs: (ms) => { groupRingMs = Number(ms) || 60000; },
  groupState: () => {
    const g = state.group;
    if (!g) return null;
    return {
      id: g.id,
      isHost: g.isHost,
      hostNr: g.hostNr,
      peers: [...g.peers.values()].map((p) => ({
        nr: p.nr,
        status: p.status,
        hasPc: !!p.pc,
        conn: p.pc ? p.pc.connectionState : "",
        live: !!p.stream && p.stream.getVideoTracks().some((t) => t.readyState === "live"),
      })),
    };
  },
  sendCaps: () => {
    const g = state.group;
    const peers = g ? [...g.peers.values()].filter((p) => p.pc) : [];
    return {
      config: { audioBps: SEND_CAPS.audioBps, maxFramerate: SEND_CAPS.maxFramerate, videoBps: { ...SEND_CAPS.videoBps } },
      oneToOne: !g && state.pc ? readSendCaps(state.pc) : null,
      group: peers.map((p) => ({ nr: p.nr, senders: readSendCaps(p.pc) })),
    };
  },
};
