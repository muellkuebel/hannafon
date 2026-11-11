// Shared AudioContext + silent <audio>, unlocked on a user gesture so iOS
// can actually ring when a call arrives (Guided Access / Home Screen).

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

export async function unlockAudio() {
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
  if (ringing && unlocked) startToneLoop();
  return unlocked;
}

export function isAudioUnlocked() {
  return !!(ctx && ctx.state === "running");
}

export function audioContextState() {
  return ctx ? ctx.state : "none";
}

export function bindAudioUnlock() {
  if (listenersBound) return;
  listenersBound = true;
  const kick = () => {
    unlockAudio();
  };
  for (const ev of ["pointerdown", "touchstart", "click", "keydown"]) {
    document.addEventListener(ev, kick, { capture: true, passive: true });
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") unlockAudio();
  });
  window.addEventListener("pageshow", () => unlockAudio());
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
  await unlockAudio();
  if (ctx && ctx.state === "running") startToneLoop();
  startVibrate();
}

export function stopRingtone() {
  ringing = false;
  stopTones();
  stopVibrate();
  // Keep the unlocked AudioContext alive for the next call.
}
