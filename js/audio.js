// Shared AudioContext + <audio> elements, unlocked on a user gesture so iOS
// can actually ring when a call arrives (Guided Access / Home Screen).
//
// V1.06: iOS only lets a page start sound after a user gesture, and it
// suspends an idle audio session after a while. An always-on host iPad
// (Hanna) often had no tap for hours, so the ring stayed silent. Now:
//  - the first tap "blesses" a keep-alive <audio> (near-silent loop) and the
//    ringtone <audio>; the keep-alive keeps looping so the session stays open,
//  - an incoming call plays sounds/ringtone.m4a through the blessed element
//    (no fresh tap needed), with the Web Audio chord as fallback,
//  - the keep-alive pauses during a call (WebRTC owns the session) and
//    restarts afterwards, and on pageshow/visibility/next tap if iOS killed it.
// Still impossible: ringing before the very first tap since launch, or with
// the iPad's hardware volume at zero / muted.

const SILENT_WAV =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

let ctx = null;
let master = null;
let timer = null;
let vibeTimer = null;
let ringing = false;
let unlocked = false;
let silentEl = null;
let listenersBound = false;
let keepEl = null;
let ringEl = null;
let mediaBlessed = false; // keep-alive + ringtone elements played once inside a gesture
let callActive = false;
let ringFilePlaying = false;
const log = [];

function note(ev) {
  log.push({ t: Date.now(), ev });
  if (log.length > 60) log.shift();
}

function audioEl(id, src, loop) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("audio");
    el.id = id;
    el.hidden = true;
    el.setAttribute("playsinline", "");
    el.setAttribute("webkit-playsinline", "");
    el.preload = "auto";
    document.body.appendChild(el);
  }
  if (!el.getAttribute("src")) el.src = src;
  el.loop = loop;
  return el;
}

function ensureMediaEls() {
  if (!keepEl || !keepEl.isConnected) keepEl = audioEl("keepalive-audio", "./sounds/keepalive.m4a", true);
  if (!ringEl || !ringEl.isConnected) ringEl = audioEl("ringtone-audio", "./sounds/ringtone.m4a", true);
}

async function tryPlay(el) {
  try {
    const p = el.play();
    if (p && p.then) await p;
    return true;
  } catch {
    return false;
  }
}

// Inside a gesture: start the near-silent loop and prime the ringtone element
// (muted play + pause) so both may play later without another tap. iOS
// ignores el.volume, so the keep-alive file itself is practically silent.
async function blessMedia() {
  ensureMediaEls();
  if (!callActive && keepEl.paused) {
    keepEl.muted = false;
    if (await tryPlay(keepEl)) note("keepalive-play");
  }
  if (!ringing && ringEl.paused && !mediaBlessed) {
    ringEl.muted = true;
    if (await tryPlay(ringEl)) {
      mediaBlessed = true;
      note("ring-primed");
    }
    if (!ringing) {
      ringEl.pause();
      try { ringEl.currentTime = 0; } catch { /* ignore */ }
    }
    ringEl.muted = false;
  }
  if (!keepEl.paused) mediaBlessed = true;
}

function keepAliveRunning() {
  return !!(keepEl && !keepEl.paused && !keepEl.ended);
}

export function setCallActive(on) {
  callActive = !!on;
  ensureMediaEls();
  if (callActive) {
    if (!keepEl.paused) keepEl.pause();
    note("keepalive-pause-call");
  } else if (mediaBlessed && keepEl.paused) {
    // Outside a gesture this may be refused; the next tap restarts it.
    tryPlay(keepEl).then((ok) => note(ok ? "keepalive-resume" : "keepalive-resume-blocked"));
  }
}

async function startRingFile() {
  ensureMediaEls();
  ringEl.muted = false;
  ringEl.loop = true;
  try { ringEl.volume = 0.8; } catch { /* iOS ignores volume */ }
  try { ringEl.currentTime = 0; } catch { /* ignore */ }
  const ok = await tryPlay(ringEl);
  ringFilePlaying = ok && ringing;
  note(ok ? "ring-file-play" : "ring-file-blocked");
  if (ok && !ringing) stopRingFile();
  return ringFilePlaying;
}

function stopRingFile() {
  ringFilePlaying = false;
  if (!ringEl) return;
  try {
    ringEl.pause();
    ringEl.currentTime = 0;
  } catch {
    /* ignore */
  }
}

function getCtx() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!ctx || ctx.state === "closed") {
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }
  return ctx;
}

function ensureSilentEl() {
  if (silentEl && silentEl.isConnected) return silentEl;
  silentEl = document.getElementById("unlock-audio");
  if (!silentEl) {
    silentEl = document.createElement("audio");
    silentEl.id = "unlock-audio";
    silentEl.setAttribute("playsinline", "");
    silentEl.setAttribute("webkit-playsinline", "");
    silentEl.preload = "auto";
    silentEl.loop = false;
    document.body.appendChild(silentEl);
  }
  if (!silentEl.getAttribute("src")) silentEl.src = SILENT_WAV;
  return silentEl;
}

function playSilentTick(c) {
  if (!c) return;
  try {
    const n = Math.max(1, Math.floor(c.sampleRate * 0.02));
    const buf = c.createBuffer(1, n, c.sampleRate);
    const src = c.createBufferSource();
    src.buffer = buf;
    const g = c.createGain();
    g.gain.value = 0.0001;
    src.connect(g);
    g.connect(c.destination);
    src.start(0);
  } catch {
    /* ignore */
  }
}

export async function unlockAudio(fromGesture = false) {
  if (fromGesture) await blessMedia();
  ensureSilentEl();
  try {
    silentEl.muted = true;
    silentEl.volume = 0;
    const p = silentEl.play();
    if (p && p.then) await p.catch(() => {});
    silentEl.pause();
    try {
      silentEl.currentTime = 0;
    } catch {
      /* ignore */
    }
    silentEl.muted = false;
  } catch {
    /* ignore */
  }
  const c = getCtx();
  if (c && c.state !== "running") {
    try {
      await c.resume();
    } catch {
      /* ignore */
    }
  }
  if (c && c.state === "running") {
    playSilentTick(c);
    unlocked = true;
  }
  if (ringing && !ringFilePlaying) {
    if (!(await startRingFile()) && unlocked) startToneLoop();
  }
  return unlocked || ringFilePlaying || keepAliveRunning();
}

export function isAudioUnlocked() {
  return !!(ctx && ctx.state === "running") || ringFilePlaying || keepAliveRunning();
}

export function isRingAudible() {
  return ringing && (ringFilePlaying || !!timer);
}

export function audioDebug() {
  ensureMediaEls();
  return {
    ctx: ctx ? ctx.state : "none",
    keepAlive: keepAliveRunning(),
    keepAliveSrc: keepEl.getAttribute("src"),
    ringFilePlaying,
    ringPaused: ringEl.paused,
    ringSrc: ringEl.getAttribute("src"),
    toneLoop: !!timer,
    ringing,
    mediaBlessed,
    callActive,
    log: log.slice(),
  };
}

export function audioContextState() {
  return ctx ? ctx.state : "none";
}

export function bindAudioUnlock() {
  if (listenersBound) return;
  listenersBound = true;
  const kick = () => {
    unlockAudio(true);
  };
  for (const ev of ["pointerdown", "touchstart", "click", "keydown"]) {
    document.addEventListener(ev, kick, { capture: true, passive: true });
  }
  // Coming back from background: try to restart the keep-alive (works if iOS
  // still considers the element blessed); otherwise the next tap does it.
  const revive = () => {
    if (document.visibilityState !== "visible") return;
    ensureMediaEls();
    if (mediaBlessed && !callActive && keepEl.paused) {
      tryPlay(keepEl).then((ok) => note(ok ? "keepalive-revive" : "keepalive-revive-blocked"));
    }
    unlockAudio();
  };
  document.addEventListener("visibilitychange", revive);
  window.addEventListener("pageshow", revive);
  window.addEventListener("focus", revive);
}

function startToneLoop() {
  if (timer) return;
  const c = getCtx();
  if (!c || c.state !== "running" || !master) return;
  const chord = () => {
    if (!ctx || !ringing || ctx.state !== "running") return;
    const t = ctx.currentTime;
    ping(523.25, t, 0.18); // C5
    ping(659.25, t, 0.18); // E5
    ping(783.99, t + 0.22, 0.28); // G5
    ping(659.25, t + 0.22, 0.28);
  };
  const ping = (freq, start, dur) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(0.5, start + 0.018);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g);
    g.connect(master);
    o.start(start);
    o.stop(start + dur + 0.01);
  };
  chord();
  timer = setInterval(chord, 1400);
}

function stopTones() {
  if (timer) clearInterval(timer);
  timer = null;
}

function startVibrate() {
  stopVibrate();
  if (!navigator.vibrate) return;
  const pulse = () => navigator.vibrate?.([280, 120, 280, 720]);
  pulse();
  vibeTimer = setInterval(pulse, 1400);
}

function stopVibrate() {
  if (vibeTimer) clearInterval(vibeTimer);
  vibeTimer = null;
  try {
    navigator.vibrate?.(0);
  } catch {
    /* ignore */
  }
}

export async function startRingtone() {
  ringing = true;
  stopTones();
  startVibrate();
  // Real ringtone first (works without a fresh tap once the element was
  // blessed and the keep-alive held the session); chord as fallback.
  if (!(await startRingFile())) {
    await unlockAudio();
    if (ringing && !ringFilePlaying && ctx && ctx.state === "running") startToneLoop();
  }
  note(ringFilePlaying ? "ring:file" : timer ? "ring:chord" : "ring:silent");
}

export function stopRingtone() {
  ringing = false;
  stopTones();
  stopRingFile();
  stopVibrate();
  // Keep the unlocked AudioContext and the keep-alive loop for the next call.
}
