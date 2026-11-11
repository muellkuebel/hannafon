let ctx = null;
let timer = null;

export function startRingtone() {
  stopRingtone();
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  const cycle = () => {
    if (!ctx) return;
    const t = ctx.currentTime;
    tone(880, t, 0.32);
    tone(698, t + 0.38, 0.32);
  };
  const tone = (freq, start, dur) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(0.16, start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g);
    g.connect(ctx.destination);
    o.start(start);
    o.stop(start + dur);
  };
  cycle();
  timer = setInterval(cycle, 1400);
}

export function stopRingtone() {
  if (timer) clearInterval(timer);
  timer = null;
  if (ctx) {
    try {
      ctx.close();
    } catch {
      /* ignore */
    }
    ctx = null;
  }
}
