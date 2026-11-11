#!/usr/bin/env node
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shots = path.join(root, "tests/screenshots");
fs.mkdirSync(shots, { recursive: true });

const familyCode = process.env.HANNAFON_FAMILY_CODE;
if (!familyCode) {
  console.error("HANNAFON_FAMILY_CODE is not set");
  process.exit(1);
}

const APP = "http://127.0.0.1:4173/hannafon/";
const HEALTH = "http://127.0.0.1:8787/api/health";

function waitHealth(url, timeoutMs = 60000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on("error", retry);
      req.setTimeout(2000, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) return reject(new Error("server not ready"));
      setTimeout(tick, 400);
    };
    tick();
  });
}

async function startDev() {
  try {
    await waitHealth(HEALTH, 1500);
    return null;
  } catch {
    /* start our own */
  }
  const child = spawn(process.execPath, [path.join(root, "scripts/dev.mjs")], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => process.stdout.write(b));
  child.stderr.on("data", (b) => process.stderr.write(b));
  await waitHealth(HEALTH, 90000);
  await waitHealth("http://127.0.0.1:4173/hannafon/", 10000);
  return child;
}

async function gotoApp(page) {
  await page.goto(APP, { waitUntil: "load", timeout: 30000 });
}

async function submitCode(page) {
  const input = page.locator("#code-input");
  if (await input.isVisible({ timeout: 4000 }).catch(() => false)) {
    await input.fill(familyCode);
    await page.locator("#code-form button[type=submit]").click();
  }
  await page.waitForFunction(() => {
    const photo = document.getElementById("screen-photo");
    const standby = document.getElementById("screen-standby");
    const code = document.getElementById("screen-code");
    const onPhoto = photo && !photo.hidden;
    const onStandby = standby && !standby.hidden;
    const stillCode = code && !code.hidden;
    const err = document.getElementById("code-error");
    if (stillCode && err && !err.hidden && err.textContent) return "error:" + err.textContent;
    return onPhoto || onStandby;
  }, { timeout: 20000 });
  const errText = await page.locator("#code-error").textContent().catch(() => "");
  if (await page.locator("#screen-code").isVisible().catch(() => false)) {
    throw new Error("still on code screen" + (errText ? ": " + errText : ""));
  }
}

async function enterCode(page) {
  await gotoApp(page);
  await submitCode(page);
}

async function tapPerson(page, nr) {
  await page.waitForFunction(
    (n) => !!document.querySelector(`button.hit[data-nr="${n}"]`),
    nr,
    { timeout: 20000 }
  );
  await page.locator(`button.hit[data-nr="${nr}"]`).evaluate((el) => el.click());
}

async function identify(page, nr) {
  await tapPerson(page, nr);
  await page.locator("#btn-confirm").waitFor({ state: "visible", timeout: 8000 });
  await page.locator("#btn-confirm").click();
}

const waitVideo = (page) =>
  page.waitForFunction(() => {
    const v = document.getElementById("remote-video");
    return v && v.srcObject && v.srcObject.getVideoTracks().some((t) => t.readyState === "live");
  }, { timeout: 20000 });

async function openDisconnectDialog(page) {
  await page.locator("#btn-disconnect").waitFor({ state: "visible", timeout: 8000 });
  await page.locator("#btn-disconnect").click();
  await page.locator("#disconnect-sheet").waitFor({ state: "visible", timeout: 5000 });
  const copy = await page.locator("#disconnect-copy").innerText();
  if (!copy.includes("Dieses Gerät von") || !copy.includes("trennen?")) {
    throw new Error("disconnect copy mismatch: " + copy);
  }
}

async function confirmDisconnect(page) {
  await page.locator("#btn-disconnect-confirm").click();
  await page.locator("#setup-title").waitFor({ state: "visible", timeout: 8000 });
  const title = await page.locator("#setup-title h1").innerText();
  if (!title.includes("Wer bist du? Tippe auf dein Gesicht.")) {
    throw new Error("expected setup title after disconnect");
  }
  if (await page.locator("#screen-standby").isVisible().catch(() => false)) {
    throw new Error("standby should be gone after disconnect");
  }
}

async function shot(page, name) {
  const file = path.join(shots, name);
  await page.screenshot({ path: file, type: "jpeg", quality: 88 });
  return file;
}

function loadPeople() {
  const file = path.join(root, "../private/people.json");
  return JSON.parse(fs.readFileSync(file, "utf8")).people;
}

function slug(name) {
  return String(name)
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function unzoom(page) {
  await page.evaluate(() => {
    const stage = document.getElementById("photo-stage");
    if (stage) stage.click();
  });
  try {
    await page.waitForFunction(() => !document.getElementById("photo-stage")?.classList.contains("is-zoomed"), {
      timeout: 4000,
    });
  } catch {
    await page.locator("#photo-stage").click({ position: { x: 24, y: 24 }, force: true, timeout: 3000 });
    await page.waitForFunction(() => !document.getElementById("photo-stage")?.classList.contains("is-zoomed"), {
      timeout: 4000,
    });
  }
}


async function waitPhotoReady(page) {
  await page.waitForFunction(() => window.__hannafonTest && window.__hannafonTest.ready(), { timeout: 20000 });
}

async function tapFaceCenter(page, nr) {
  await waitPhotoReady(page);
  const pt = await page.evaluate((n) => {
    const hook = window.__hannafonTest;
    return hook.ensureFaceVisible ? hook.ensureFaceVisible(n) : hook.facePoint(n);
  }, nr);
  if (!pt) throw new Error("no face point for #" + nr);
  if (pt.onScreen === false) throw new Error("face #" + nr + " is off-screen after pan");
  await page.mouse.click(pt.x, pt.y);
}

function callablePeople() {
  return loadPeople().filter((p) => p.tappable !== false);
}

async function assertFaceCenters(page, label) {
  await waitPhotoReady(page);
  for (const p of callablePeople()) {
    await tapFaceCenter(page, p.nr);
    await page.locator("#zoom-card").waitFor({ state: "visible", timeout: 8000 });
    const name = (await page.locator("#zoom-name").innerText()).trim();
    if (name !== p.name) {
      throw new Error(`${label} face-center #${p.nr}: expected "${p.name}", got "${name}"`);
    }
    await unzoom(page);
  }
}

async function assertCoverage(page, label) {
  await waitPhotoReady(page);
  await page.waitForTimeout(400);
  const cov = await page.evaluate(() => window.__hannafonTest.photoCoverage());
  if (!cov || !cov.covers) {
    throw new Error(`${label} photo does not cover the stage: ${JSON.stringify(cov)}`);
  }
}

async function zoomTo(page, nr, expectedName) {
  await tapPerson(page, nr);
  await page.locator("#zoom-card").waitFor({ state: "visible", timeout: 8000 });
  await page.waitForTimeout(800);
  if (expectedName) {
    const label = (await page.locator("#zoom-name").innerText()).trim();
    if (label !== expectedName) {
      throw new Error(`zoom name for #${nr}: expected "${expectedName}", got "${label}"`);
    }
  }
}

const ORIGIN = "http://127.0.0.1:4173";

async function phoneContext(browser, viewport) {
  const se = viewport.width === 375;
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: se ? 2 : 3,
    isMobile: true,
    hasTouch: true,
    isLandscape: false,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
    permissions: ["camera", "microphone", "notifications"],
  });
  const safeT = se ? 20 : 47;
  const safeB = se ? 0 : 34;
  await ctx.addInitScript(({ safeT, safeB }) => {
    const apply = () => {
      document.documentElement.style.setProperty("--safe-t", `${safeT}px`);
      document.documentElement.style.setProperty("--safe-b", `${safeB}px`);
    };
    apply();
    document.addEventListener("DOMContentLoaded", apply);
  }, { safeT, safeB });
  await ctx.grantPermissions(["camera", "microphone", "notifications"], { origin: ORIGIN });
  return ctx;
}

async function walkReceiverShots(page, tag) {
  await gotoApp(page);
  await page.locator("#code-input").waitFor({ state: "visible", timeout: 8000 });
  await page.waitForTimeout(200);
  await shot(page, `${tag}-code.jpg`);
  await submitCode(page);
  await page.locator("#setup-title").waitFor({ state: "visible", timeout: 20000 });
  const title = await page.locator("#setup-title h1").innerText();
  if (!title.includes("Wer bist du? Tippe auf dein Gesicht.")) {
    throw new Error("setup title mismatch on " + tag);
  }
  await page.waitForTimeout(400);
  await shot(page, `${tag}-setup.jpg`);
  await zoomTo(page, 22, "Daniel");
  await shot(page, `${tag}-setup-zoom.jpg`);
  await page.locator("#btn-confirm").click();
  await page.locator("#screen-standby").waitFor({ state: "visible", timeout: 8000 });
  await page.locator("#btn-call-host").waitFor({ state: "visible" });
  await page.locator("#btn-disconnect").waitFor({ state: "visible" });
  const iconSrc = (await page.locator("#host-face").getAttribute("src")) || "";
  if (!iconSrc.includes("icon-512")) {
    throw new Error("standby host tile should use the app icon, got " + iconSrc);
  }
  await page.waitForTimeout(400);
  await shot(page, `${tag}-standby.jpg`);
}

async function run() {
  const dev = await startDev();
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  const ipad = {
    viewport: { width: 1180, height: 820 },
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: true,
    permissions: ["camera", "microphone", "notifications"],
  };

  const iphone14 = { width: 393, height: 852 };
  const iphoneSE = { width: 375, height: 667 };

  const hannaCtx = await browser.newContext(ipad);
  await hannaCtx.grantPermissions(["camera", "microphone", "notifications"], { origin: ORIGIN });
  const danielACtx = await phoneContext(browser, iphone14);
  const danielBCtx = await phoneContext(browser, iphone14);
  const danielSECtx = await phoneContext(browser, iphoneSE);
  const hanna = await hannaCtx.newPage();
  const daniel = await danielACtx.newPage();
  const danielB = await danielBCtx.newPage();
  const danielSE = await danielSECtx.newPage();

  const results = [];
  try {
    await enterCode(hanna);

    // First-run title
    const title = await hanna.locator("#setup-title h1").innerText();
    if (!title.includes("Wer bist du? Tippe auf dein Gesicht.")) {
      throw new Error("setup title mismatch");
    }

    // Untappable: 7 and 12 must have no hit target
    if ((await hanna.locator("button.hit[data-nr='7']").count()) !== 0) {
      throw new Error("nr 7 should not have a hit target");
    }
    if ((await hanna.locator("button.hit[data-nr='12']").count()) !== 0) {
      throw new Error("nr 12 should not have a hit target");
    }
    if ((await hanna.locator("button.hit[data-nr='10']").count()) !== 1) {
      throw new Error("host nr 10 should be tappable");
    }
    if ((await hanna.locator("button.hit[data-nr='21']").count()) !== 1) {
      throw new Error("nr 21 should be tappable and distinct from the host");
    }

    await shot(hanna, "setup-title.jpg");

    await walkReceiverShots(daniel, "iphone14");
    for (const [src, dest] of [
      ["iphone14-setup.jpg", "daniel-setup.jpg"],
      ["iphone14-setup-zoom.jpg", "daniel-setup-zoom.jpg"],
      ["iphone14-standby.jpg", "daniel-standby.jpg"],
    ]) {
      fs.copyFileSync(path.join(shots, src), path.join(shots, dest));
    }
    await walkReceiverShots(danielB, "iphone14-b");
    results.push("iphone 393x852 receiver screens");

    await identify(hanna, 10);
    await hanna.locator("#greeting").waitFor({ state: "visible", timeout: 8000 });
    await hanna.waitForTimeout(400);
    await shot(hanna, "hanna-home.jpg");

    if ((await hanna.locator("i.halo").count()) < 20) {
      throw new Error("expected discreet halos on tappable people");
    }

    // Zoom every tappable person and screenshot (no black edges, soft silhouette).
    const people = loadPeople().filter((p) => p.tappable !== false);
    for (const p of people) {
      await zoomTo(hanna, p.nr, p.name);
      const file = `zoom-${p.nr}-${slug(p.name)}.jpg`;
      await shot(hanna, file);
      if (p.nr === 22) await shot(hanna, "hanna-zoom-call.jpg");
      if (p.nr === 23) await shot(hanna, "zoom-melanie.jpg");
      if (p.nr === 10) await shot(hanna, "zoom-hanna.jpg");
      await unzoom(hanna);
      process.stdout.write(`zoomed ${p.nr} ${p.name}\n`);
    }
    results.push("zoom gallery " + people.length);

    // Let both Daniel devices finish connecting before the call.
    await daniel.waitForTimeout(800);
    await danielB.waitForTimeout(200);

    // Host calls Daniel — both of Daniel's devices must ring.
    await tapPerson(hanna, 22);
    await hanna.locator("#btn-call").waitFor({ state: "visible", timeout: 8000 });
    await hanna.waitForTimeout(800);
    await hanna.locator("#btn-call").click();
    await hanna.locator("#screen-call").waitFor({ state: "visible", timeout: 10000 });

    await daniel.locator("#screen-incoming").waitFor({ state: "visible", timeout: 15000 });
    await danielB.locator("#screen-incoming").waitFor({ state: "visible", timeout: 15000 });
    const ringState = await daniel.evaluate(() => window.__hannafonTest.audioState());
    if (ringState !== "running") {
      throw new Error("ringtone AudioContext should be running after a prior tap, got " + ringState);
    }
    await daniel.waitForTimeout(800);
    await shot(daniel, "daniel-incoming.jpg");
    await shot(daniel, "incoming-hanna.jpg");
    await shot(daniel, "iphone14-incoming.jpg");
    await shot(danielB, "iphone14-b-incoming.jpg");

    // First accept wins; the other device stops ringing.
    await daniel.locator("#btn-accept").click();
    await daniel.locator("#screen-call").waitFor({ state: "visible", timeout: 10000 });
    await danielB.locator("#taken-toast").waitFor({ state: "visible", timeout: 8000 });
    const taken = (await danielB.locator("#taken-toast").innerText()).trim();
    if (!/anderswo angenommen/i.test(taken)) {
      throw new Error("taken toast mismatch: " + taken);
    }
    await shot(danielB, "iphone14-b-taken.jpg");
    await danielB.locator("#screen-standby").waitFor({ state: "visible", timeout: 8000 });
    if (await danielB.locator("#screen-incoming").isVisible().catch(() => false)) {
      throw new Error("second device still showing incoming after taken");
    }
    results.push("multi-device first-accept / taken");

    await waitVideo(hanna);
    await waitVideo(daniel);
    await hanna.waitForTimeout(600);
    await shot(hanna, "in-call-hanna.jpg");
    await shot(daniel, "in-call-daniel.jpg");
    await shot(daniel, "iphone14-incall.jpg");
    results.push("video connected");

    await hanna.locator("#btn-hangup").click();
    await hanna.locator("#screen-photo").waitFor({ state: "visible", timeout: 10000 });
    await daniel.locator("#screen-standby").waitFor({ state: "visible", timeout: 10000 });
    await shot(hanna, "after-hangup-hanna.jpg");
    await shot(daniel, "after-hangup-daniel.jpg");
    results.push("hangup ok");

    await openDisconnectDialog(daniel);
    await shot(daniel, "iphone14-disconnect.jpg");
    await shot(daniel, "daniel-disconnect.jpg");
    await confirmDisconnect(daniel);
    results.push("disconnect returns to setup");

    // iPhone SE 375x667 receiver screens, including a live incoming/in-call.
    await walkReceiverShots(danielSE, "iphone-se");
    await danielSE.waitForTimeout(600);
    await tapPerson(hanna, 22);
    await hanna.locator("#btn-call").waitFor({ state: "visible", timeout: 8000 });
    await hanna.waitForTimeout(400);
    await hanna.locator("#btn-call").click();
    await danielSE.locator("#screen-incoming").waitFor({ state: "visible", timeout: 15000 });
    await danielSE.waitForTimeout(800);
    await shot(danielSE, "iphone-se-incoming.jpg");
    await danielSE.locator("#btn-accept").click();
    await danielSE.locator("#screen-call").waitFor({ state: "visible", timeout: 10000 });
    await waitVideo(hanna);
    await waitVideo(danielSE);
    await danielSE.waitForTimeout(500);
    await shot(danielSE, "iphone-se-incall.jpg");
    await danielSE.locator("#btn-hangup").click();
    await danielSE.locator("#screen-standby").waitFor({ state: "visible", timeout: 10000 });
    await openDisconnectDialog(danielSE);
    await shot(danielSE, "iphone-se-disconnect.jpg");
    await confirmDisconnect(danielSE);
    results.push("iphone 375x667 receiver screens");

    // Face-center hit testing on iPhone 393×852 and 375×667, after render and after pan/pinch.
    await assertFaceCenters(daniel, "iphone14 initial");
    await daniel.evaluate(() => window.__hannafonTest.pinchPan(-48, 36, 1.55));
    await daniel.waitForTimeout(200);
    await assertFaceCenters(daniel, "iphone14 after pan/pinch");
    await daniel.evaluate(() => window.__hannafonTest.resetNav());
    results.push("iphone 393x852 face-center hits");

    await assertFaceCenters(danielSE, "iphoneSE initial");
    await danielSE.evaluate(() => window.__hannafonTest.pinchPan(-40, 28, 1.45));
    await danielSE.waitForTimeout(200);
    await assertFaceCenters(danielSE, "iphoneSE after pan/pinch");
    await danielSE.evaluate(() => window.__hannafonTest.resetNav());
    results.push("iphone 375x667 face-center hits");

    // Zoomed: a tap outside the selected silhouette zooms out, it does not pick a neighbor.
    await waitPhotoReady(hanna);
    await unzoom(hanna).catch(() => {});
    await tapFaceCenter(hanna, 22);
    await hanna.locator("#zoom-name").waitFor({ state: "visible", timeout: 8000 });
    if ((await hanna.locator("#zoom-name").innerText()).trim() !== "Daniel") {
      throw new Error("expected Daniel zoomed before outside-tap test");
    }
    await tapFaceCenter(hanna, 23);
    await hanna.waitForFunction(() => !document.getElementById("photo-stage")?.classList.contains("is-zoomed"), {
      timeout: 5000,
    });
    if (await hanna.locator("#zoom-card").isVisible().catch(() => false)) {
      const got = (await hanna.locator("#zoom-name").innerText()).trim();
      throw new Error("tap on a neighbor while zoomed should zoom out, got " + got);
    }
    await tapFaceCenter(hanna, 22);
    await hanna.locator("#btn-call").waitFor({ state: "visible", timeout: 8000 });
    const stillDaniel = (await hanna.locator("#zoom-name").innerText()).trim();
    if (stillDaniel !== "Daniel") throw new Error("selected person should stay interactive");
    await unzoom(hanna);
    results.push("zoomed outside tap unzooms");

    // iPad orientation: photo must refit after portrait and back, and hits stay correct.
    async function cyclePad(page, land, port, tag) {
      await page.setViewportSize(land);
      await page.evaluate(() => window.__hannafonTest.resetNav());
      await assertCoverage(page, tag + " landscape-1");
      await tapFaceCenter(page, 22);
      await page.locator("#zoom-name").waitFor({ state: "visible", timeout: 8000 });
      if ((await page.locator("#zoom-name").innerText()).trim() !== "Daniel") {
        throw new Error(tag + " landscape Daniel miss");
      }
      await unzoom(page);
      await page.setViewportSize(port);
      await page.waitForTimeout(400);
      await assertCoverage(page, tag + " portrait");
      await tapFaceCenter(page, 23);
      await page.locator("#zoom-name").waitFor({ state: "visible", timeout: 8000 });
      if ((await page.locator("#zoom-name").innerText()).trim() !== "Melanie") {
        throw new Error(tag + " portrait Melanie miss");
      }
      await unzoom(page);
      await page.setViewportSize(land);
      await page.waitForTimeout(400);
      await assertCoverage(page, tag + " landscape-2");
      await tapFaceCenter(page, 22);
      await page.locator("#zoom-name").waitFor({ state: "visible", timeout: 8000 });
      if ((await page.locator("#zoom-name").innerText()).trim() !== "Daniel") {
        throw new Error(tag + " rotated-back Daniel miss");
      }
      await unzoom(page);
    }

    await cyclePad(hanna, { width: 1180, height: 820 }, { width: 820, height: 1180 }, "ipad-10");
    results.push("ipad 1180 orientation");

    const miniCtx = await browser.newContext({
      viewport: { width: 1133, height: 744 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      permissions: ["camera", "microphone", "notifications"],
    });
    await miniCtx.grantPermissions(["camera", "microphone", "notifications"], { origin: ORIGIN });
    const mini = await miniCtx.newPage();
    await enterCode(mini);
    await mini.locator("#setup-title").waitFor({ state: "visible", timeout: 20000 });
    await waitPhotoReady(mini);
    await cyclePad(mini, { width: 1133, height: 744 }, { width: 744, height: 1133 }, "ipad-mini");
    await mini.close();
    await miniCtx.close();
    results.push("ipad mini 1133 orientation");

    // Shared AudioContext is running when ringing after one prior tap.
    await hanna.mouse.click(24, 24);
    await hanna.evaluate(async () => {
      await window.__hannafonTest.unlockAudio();
      await window.__hannafonTest.startRingtone();
    });
    const audioState = await hanna.evaluate(() => window.__hannafonTest.audioState());
    if (audioState !== "running") {
      throw new Error("AudioContext should be running when ringing after a tap, got " + audioState);
    }
    await hanna.evaluate(() => window.__hannafonTest.stopRingtone());
    results.push("ringtone context running after tap");

    // Structural push endpoint (no delivery assertion locally)
    const health = await fetch(HEALTH).then((r) => r.json());
    if (!health.ok || health.version !== "V1.03") throw new Error("health/version");
    results.push("worker health V1.03");

    console.log("E2E OK:", results.join(", "));
    console.log("screenshots:", fs.readdirSync(shots).join(", "));
  } catch (err) {
    console.error("E2E failed at results so far:", results.join(", ") || "(none)");
    throw err;
  } finally {
    await browser.close();
    if (dev) {
      dev.kill("SIGTERM");
    }
  }
}

run().catch((err) => {
  console.error("E2E failed:", err.message || err);
  if (err && err.stack) console.error(err.stack);
  process.exit(1);
});
