// Same constraints for the early permission "prime" and for real calls, so
// one iOS grant covers both camera and microphone.
const MEDIA_CONSTRAINTS = {
  audio: true,
  // V1.08: 4:3, the native shape of iPhone/iPad front cameras. The old 16:9
  // request (1280x720) made iOS crop the sensor top/bottom (tighter, "zoomed"
  // picture). iOS rotates the frame itself (960x1280 when held upright).
  // resizeMode "none": no crop-and-scale by the browser where supported.
  video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 }, resizeMode: { ideal: "none" } },
};

// iOS/iPadOS shows its own system dialog for camera/microphone. A web app can
// neither suppress nor pre-approve it. What we can do: trigger it once, early,
// on a real tap (setup "Das bin ich" or the first tap after launch), stop the
// tracks right away (no camera indicator between calls), and skip it when the
// Permissions API already says "granted" or "denied".
let permState = "unknown"; // "granted" | "denied" | "prompt" | "unknown"
let permWatched = false;
let primeInFlight = null;
let primedThisSession = false;
const primeLog = [];

function combineStates(cam, mic) {
  if (cam === "granted" && mic === "granted") return "granted";
  if (cam === "denied" || mic === "denied") return "denied";
  if (cam === "prompt" || mic === "prompt") return "prompt";
  return "unknown";
}

export async function refreshMediaPermissionState() {
  try {
    if (!navigator.permissions?.query) return permState;
    const [cam, mic] = await Promise.all([
      navigator.permissions.query({ name: "camera" }),
      navigator.permissions.query({ name: "microphone" }),
    ]);
    permState = combineStates(cam.state, mic.state);
    if (!permWatched) {
      permWatched = true;
      const update = () => { permState = combineStates(cam.state, mic.state); };
      try {
        cam.addEventListener?.("change", update);
        mic.addEventListener?.("change", update);
      } catch {
        /* older WebKit */
      }
    }
  } catch {
    // Some WebKit versions reject unknown permission names; keep "unknown".
  }
  return permState;
}

export function mediaPermissionState() {
  return permState;
}

export function mediaPrimeLog() {
  return primeLog.slice();
}

// Call synchronously from a tap handler (no await before it), so the request
// is clearly tied to the user's gesture on iOS.
export function primeMediaPermission(reason = "tap") {
  if (primeInFlight) return primeInFlight;
  if (primedThisSession) return Promise.resolve(permState);
  if (permState === "granted" || permState === "denied") {
    primeLog.push({ reason, skipped: permState });
    return Promise.resolve(permState);
  }
  if (!navigator.mediaDevices?.getUserMedia) return Promise.resolve("unsupported");
  primedThisSession = true;
  primeLog.push({ reason, requested: true });
  primeInFlight = navigator.mediaDevices
    .getUserMedia(MEDIA_CONSTRAINTS)
    .then((stream) => {
      stopStream(stream);
      permState = "granted";
      return "granted";
    })
    .catch((err) => {
      if (err && (err.name === "NotAllowedError" || err.name === "SecurityError")) {
        permState = "denied";
        return "denied";
      }
      return "error";
    })
    .finally(() => {
      primeInFlight = null;
      refreshMediaPermissionState();
    });
  return primeInFlight;
}

export async function getLocalStream() {
  // Never stack a second system prompt on top of a running prime.
  if (primeInFlight) await primeInFlight.catch(() => {});
  const stream = await navigator.mediaDevices.getUserMedia(MEDIA_CONSTRAINTS);
  permState = "granted";
  return stream;
}

export function createPeer(iceServers, localStream, { onIce, onTrack, onState }) {
  const pc = new RTCPeerConnection({ iceServers });
  if (localStream) {
    for (const t of localStream.getTracks()) pc.addTrack(t, localStream);
  }
  const pending = [];
  pc.onicecandidate = (e) => {
    if (e.candidate && onIce) onIce(e.candidate);
  };
  pc.ontrack = (e) => {
    if (onTrack) onTrack(e.streams[0] || new MediaStream([e.track]));
  };
  pc.onconnectionstatechange = () => {
    if (onState) onState(pc.connectionState);
  };
  pc._pendingIce = pending;
  return pc;
}

export async function addIce(pc, candidate) {
  if (!candidate) return;
  if (!pc.remoteDescription) {
    pc._pendingIce = pc._pendingIce || [];
    pc._pendingIce.push(candidate);
    return;
  }
  try {
    await pc.addIceCandidate(candidate);
  } catch {
    /* ignore stale candidates */
  }
}

export async function flushIce(pc) {
  const pending = pc._pendingIce || [];
  pc._pendingIce = [];
  for (const c of pending) {
    try {
      await pc.addIceCandidate(c);
    } catch {
      /* ignore */
    }
  }
}

export function stopStream(stream) {
  if (!stream) return;
  for (const t of stream.getTracks()) t.stop();
}

export function closePeer(pc) {
  if (!pc) return;
  try {
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.close();
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// V1.09: moderate send caps ("ein bisschen runter", Hanna's iPad SIM has
// 10 GB/month). Capture stays 4:3 1280x960 ideal; the encoder scales down by
// itself when the bitrate is capped. Every device caps what it SENDS, so one
// call direction never exceeds these numbers. No user-facing setting.
//   1:1          video 1000 kbps, 24 fps, audio 48 kbps  -> ~1.0 GB/h on each device
//   2 remotes    video  600 kbps per stream (2 streams out, 2 in)  -> ~1.2 GB/h
//   3 remotes    video  450 kbps per stream (3 streams out, 3 in)  -> ~1.4 GB/h
export const SEND_CAPS = Object.freeze({
  audioBps: 48000,
  maxFramerate: 24,
  videoBps: Object.freeze({ 1: 1000000, 2: 600000, 3: 450000 }),
});

export function videoCapFor(remoteCount) {
  const n = Math.max(1, Math.min(3, Number(remoteCount) || 1));
  return SEND_CAPS.videoBps[n];
}

// Safe to call repeatedly (after setLocalDescription, on "connected", and when
// the number of people in a group call changes). Errors are ignored: some
// WebKit versions only accept parameters after negotiation; the "connected"
// retry covers that.
export async function applySendCaps(pc, remoteCount = 1) {
  if (!pc || typeof pc.getSenders !== "function") return null;
  const videoBps = videoCapFor(remoteCount);
  const applied = [];
  for (const sender of pc.getSenders()) {
    const kind = sender.track?.kind;
    if (!kind || typeof sender.getParameters !== "function") continue;
    try {
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      for (const enc of params.encodings) {
        if (kind === "video") {
          enc.maxBitrate = videoBps;
          enc.maxFramerate = SEND_CAPS.maxFramerate;
        } else if (kind === "audio") {
          enc.maxBitrate = SEND_CAPS.audioBps;
        }
      }
      await sender.setParameters(params);
      applied.push(kind);
    } catch {
      /* retried on "connected" */
    }
  }
  pc._sendCap = { remoteCount: Math.max(1, Math.min(3, Number(remoteCount) || 1)), videoBps, applied };
  return pc._sendCap;
}

export function readSendCaps(pc) {
  if (!pc || typeof pc.getSenders !== "function") return [];
  return pc.getSenders().filter((s) => s.track).map((s) => {
    const e = (s.getParameters().encodings || [])[0] || {};
    return { kind: s.track.kind, maxBitrate: e.maxBitrate ?? null, maxFramerate: e.maxFramerate ?? null };
  });
}
