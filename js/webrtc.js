// Same constraints for the early permission "prime" and for real calls, so
// one iOS grant covers both camera and microphone.
const MEDIA_CONSTRAINTS = {
  audio: true,
  video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
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
