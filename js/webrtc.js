export async function getLocalStream() {
  return navigator.mediaDevices.getUserMedia({
    audio: true,
    video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
  });
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
