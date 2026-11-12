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


async function assertHidden(page, sel, why) {
  if (await page.locator(sel).isVisible().catch(() => false)) throw new Error(`${sel} should be hidden: ${why}`);
}

function boxesOverlap(a, b) {
  return !!(a && b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height);
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

const CREAM_RGB = "rgb(246, 239, 227)";

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || "").trim());
  return m ? `rgb(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)})` : null;
}

// V1.05: no dark gradient on the photo; page edge follows the photo.
// V1.06: status bar is solid black ("black" style, theme-color #000000), never photo-tinted.
async function assertTopClean(page, label) {
  if ((await page.locator("#topfade, .topfade").count()) !== 0) {
    throw new Error(label + ": .topfade gradient must be gone");
  }
  const info = await page.evaluate(() => {
    const edge = window.__hannafonTest.edgeColors();
    const meta = document.querySelector('meta[name="theme-color"]')?.getAttribute("content");
    const status = document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.getAttribute("content");
    const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
    // Nothing semi-transparent and dark may sit over the top 160px of the photo.
    const stage = document.getElementById("photo-stage").getBoundingClientRect();
    const overlays = [];
    for (const el of document.querySelectorAll("#screen-photo > *:not(#photo-stage)")) {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || Number(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.top > stage.top + 160 || r.width < stage.width * 0.5) continue;
      if (cs.backgroundImage !== "none" || (cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent")) {
        overlays.push(el.id || el.className);
      }
    }
    return { edge, meta, status, htmlBg, overlays };
  });
  if (info.status !== "black") throw new Error(label + ": status bar style must be black, got " + info.status);
  if (info.overlays.length) throw new Error(label + ": overlay over top of photo: " + info.overlays.join(","));
  if (String(info.meta).toLowerCase() !== "#000000") {
    throw new Error(label + ": theme-color must stay black " + JSON.stringify(info));
  }
  // V1.07: iOS 26+ colours the Home Screen status bar from the page: html/body
  // and the fixed #app must be black, never cream; every theme-color meta black.
  const v107 = await page.evaluate(() => ({
    metas: [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => [m.getAttribute("media") || "", m.getAttribute("content")]),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    appBg: getComputedStyle(document.getElementById("app")).backgroundColor,
  }));
  if (info.htmlBg !== "rgb(0, 0, 0)" || v107.bodyBg !== "rgb(0, 0, 0)" || v107.appBg !== "rgb(0, 0, 0)") {
    throw new Error(label + ": html/body/#app background must be black " + JSON.stringify({ ...info, ...v107 }));
  }
  const medias = v107.metas.map((m) => m[0]);
  if (v107.metas.length < 3 || v107.metas.some((m) => String(m[1]).toLowerCase() !== "#000000") ||
      !medias.includes("(prefers-color-scheme: light)") || !medias.includes("(prefers-color-scheme: dark)")) {
    throw new Error(label + ": theme-color metas (plain/light/dark) must all be #000000 " + JSON.stringify(v107.metas));
  }
}

// V1.07: manifest chrome colours black (iOS uses background_color around the webview / launch).
async function assertManifestBlack(page) {
  const m = await page.evaluate(async () => (await fetch("./manifest.webmanifest", { cache: "no-store" })).json());
  if (String(m.background_color).toLowerCase() !== "#000000" || String(m.theme_color).toLowerCase() !== "#000000") {
    throw new Error("manifest background_color/theme_color must be #000000: " + JSON.stringify([m.background_color, m.theme_color]));
  }
}

// V1.07: black fixed strip at the very top, only in the Home Screen app (iOS 26+ rule:
// >= 6px high, >= 80% wide, within 4px of the top).
async function assertStatusStrip(page, label) {
  const read = () => page.evaluate(() => {
    const el = document.getElementById("statusbar-fill");
    const cs = el && getComputedStyle(el);
    const r = el?.getBoundingClientRect();
    return el ? { display: cs.display, position: cs.position, bg: cs.backgroundColor, top: r.top, h: r.height, w: r.width, innerW: innerWidth, pe: cs.pointerEvents } : null;
  });
  await page.evaluate(() => { delete window.__HANNAFON_VIEWPORT_TEST__; window.__hannafonTest.updateViewportFix(); });
  const off = await read();
  if (!off || off.display !== "none") throw new Error(label + ": status strip must be hidden in a browser tab " + JSON.stringify(off));
  await page.evaluate(() => { window.__HANNAFON_VIEWPORT_TEST__ = { standalone: true }; window.__hannafonTest.updateViewportFix(); });
  const on = await read();
  await page.evaluate(() => { delete window.__HANNAFON_VIEWPORT_TEST__; window.__hannafonTest.updateViewportFix(); });
  if (on.display === "none" || on.position !== "fixed" || on.bg !== "rgb(0, 0, 0)" || on.top > 4 || on.h < 6 ||
      on.w < on.innerW * 0.8 || on.pe !== "none") {
    throw new Error(label + ": standalone status strip wrong " + JSON.stringify(on));
  }
}

// iPad display rounding, TOP corners only (the hardware already rounds the bottom).
// V1.08: the complete quarter circle sits flush under the black status-bar strip
// (--bar-h), never partly hidden under it. Checked in a tab (bar 0), standalone
// with the minimum 6px strip, and standalone with a real-device 24px safe area.
// Outside the curve is black (not cream) and misses the app; bottom stays square;
// the greeting stays clear of the curve. iPhone: no rounding.
async function assertDisplayRounding(page, label, expectTablet) {
  const read = () => page.evaluate(() => {
    const app = document.getElementById("app");
    const cs = getComputedStyle(app);
    const r = app.getBoundingClientRect();
    const strip = document.getElementById("statusbar-fill");
    const ss = getComputedStyle(strip);
    const barH = ss.display === "none" ? 0 : strip.getBoundingClientRect().height;
    const id = (el) => (el ? el.id || el.tagName : null);
    const W = innerWidth;
    const H = Math.min(innerHeight, r.bottom);
    const R = Math.min(26, Math.max(18, 0.027 * Math.min(innerWidth, innerHeight)));
    const outside = (el) => ["HTML", "BODY"].includes(id(el));
    const g = document.getElementById("greeting");
    const gVisible = g && getComputedStyle(g).display !== "none" && !g.hidden;
    const gr = gVisible ? [...g.querySelectorAll("p")].map((p) => p.getBoundingClientRect()).filter((b) => b.width > 0) : [];
    // Points along the expected arc: just outside -> page; just inside -> app.
    const arc = [];
    for (const deg of [10, 30, 45, 60, 80]) {
      const a = (deg * Math.PI) / 180;
      for (const side of ["l", "r"]) {
        const cx = side === "l" ? R : W - R;
        const sx = side === "l" ? -1 : 1;
        const cy = barH + R;
        const ox = cx + sx * (R + 2.5) * Math.cos(a), oy = cy - (R + 2.5) * Math.sin(a);
        const ix = cx + sx * (R - 3) * Math.cos(a), iy = cy - (R - 3) * Math.sin(a);
        const onScreen = ox >= 0.5 && ox <= W - 0.5 && oy >= barH + 0.5;
        arc.push({ deg, side, out: onScreen ? outside(document.elementFromPoint(ox, oy)) : true, in: !outside(document.elementFromPoint(ix, iy)) });
      }
    }
    return {
      tablet: document.documentElement.classList.contains("is-tablet"),
      standalone: document.documentElement.classList.contains("is-standalone"),
      clip: cs.clipPath,
      bodyClip: getComputedStyle(document.body).clipPath,
      strip: { display: ss.display, h: barH, w: strip.getBoundingClientRect().width, radius: ss.borderTopLeftRadius, clip: ss.clipPath, bg: ss.backgroundColor },
      W, H, R, barH,
      // Square bottom corners, and the arc's top/side ends touch the bar / the edge.
      hitBL: outside(document.elementFromPoint(1, H - 1)),
      hitBR: outside(document.elementFromPoint(W - 1, H - 1)),
      topMid: !outside(document.elementFromPoint(W / 2, barH + 1)),
      arcTopL: !outside(document.elementFromPoint(R + 1, barH + 1)),
      arcTopR: !outside(document.elementFromPoint(W - R - 1, barH + 1)),
      arcSideL: !outside(document.elementFromPoint(1, barH + R + 1)),
      arcSideR: !outside(document.elementFromPoint(W - 1, barH + R + 1)),
      cornerL: outside(document.elementFromPoint(1, barH + 1)),
      cornerR: outside(document.elementFromPoint(W - 1, barH + 1)),
      arc,
      greeting: gr.map((b) => ({ top: b.top, right: b.right, left: b.left, bottom: b.bottom })),
    };
  });
  const info = await read();
  if (!expectTablet) {
    if (info.tablet || (info.clip && info.clip !== "none") || (info.bodyClip && info.bodyClip !== "none")) {
      throw new Error(label + ": no simulated rounding expected " + JSON.stringify(info));
    }
    return info;
  }
  const { default: sharp } = await import("sharp");
  const check = async (tag) => {
    const i = await read();
    const bad = [];
    if (!i.tablet || !/round/.test(i.clip)) bad.push("no top clip");
    if (i.bodyClip && i.bodyClip !== "none") bad.push("body must not be clipped (strip stays square)");
    if (i.hitBL || i.hitBR) bad.push("bottom must stay square");
    if (!i.topMid || !i.arcTopL || !i.arcTopR) bad.push("content must start right under the bar");
    if (!i.arcSideL || !i.arcSideR) bad.push("arc must end at the side edge R below the bar");
    if (!i.cornerL || !i.cornerR) bad.push("corner just under the bar must be outside the curve");
    for (const a of i.arc) if (!a.out || !a.in) bad.push(`arc ${a.side}${a.deg}: out=${a.out} in=${a.in}`);
    if (i.strip.display !== "none" && (i.strip.radius !== "0px" || (i.strip.clip && i.strip.clip !== "none") || i.strip.bg !== "rgb(0, 0, 0)" || i.strip.w < i.W - 1)) {
      bad.push("strip must be a full-width black rectangle");
    }
    for (const b of i.greeting) {
      const cx = i.W - i.R, cy = i.barH + i.R;
      if (b.top < i.barH || (b.right > cx && b.top < cy && Math.hypot(b.right - cx, b.top - cy) > i.R - 4)) bad.push("greeting touches bar/curve");
    }
    if (bad.length) throw new Error(`${label} ${tag}: ${bad.join("; ")} ${JSON.stringify(i)}`);
    // Pixels: bar black, corner just below the bar black (outside the full curve), never cream.
    const buf = await page.screenshot({ type: "png" });
    const img = sharp(buf);
    const meta = await img.metadata();
    const { data, info: ri } = await img.raw().toBuffer({ resolveWithObject: true });
    const scale = meta.width / page.viewportSize().width;
    const px = (x, y) => {
      const k = (Math.round(y * scale) * ri.width + Math.round(x * scale)) * ri.channels;
      return [data[k], data[k + 1], data[k + 2]];
    };
    const W = i.W, B = i.barH, d = Math.max(1, Math.floor(i.R * (1 - Math.SQRT1_2)) - 2);
    const pts = [[0.5, B + 0.5], [d, B + d], [1, B + 6], [W - 1, B + 0.5], [W - 1 - d, B + d], [W - 2, B + 6]];
    if (B >= 2) pts.push([W / 2, B - 1.5], [2, B - 1.5], [W - 2, B - 1.5]);
    for (const [x, y] of pts) {
      const [r, g, b] = px(x, y);
      if (r > 40 || g > 40 || b > 40) throw new Error(`${label} ${tag}: pixel (${x},${y}) not black: ${[r, g, b]}`);
    }
    return i;
  };
  await check("tab");
  try {
    await page.evaluate(() => { window.__HANNAFON_VIEWPORT_TEST__ = { standalone: true }; window.__hannafonTest.updateViewportFix(); });
    const s6 = await check("standalone 6px strip");
    if (Math.abs(s6.barH - 6) > 0.5) throw new Error(label + ": standalone strip should be 6px without safe area " + s6.barH);
    // Real iPad (mini) when iOS runs the page under the bar: 24px safe area.
    await page.evaluate(() => document.documentElement.style.setProperty("--safe-t", "24px"));
    await page.waitForTimeout(80);
    const s24 = await check("standalone 24px bar");
    if (Math.abs(s24.barH - 24) > 0.5) throw new Error(label + ": strip must follow the safe area " + s24.barH);
  } finally {
    await page.evaluate(() => {
      document.documentElement.style.removeProperty("--safe-t");
      delete window.__HANNAFON_VIEWPORT_TEST__;
      window.__hannafonTest.updateViewportFix();
    });
  }
  return info;
}

// V1.08: preview crops of the top corners with a 24px bar (no faces: corners only).
async function shotTopCorners(page, name) {
  await page.evaluate(() => {
    window.__HANNAFON_VIEWPORT_TEST__ = { standalone: true };
    window.__hannafonTest.updateViewportFix();
    document.documentElement.style.setProperty("--safe-t", "24px");
  });
  await page.waitForTimeout(120);
  const file = path.join(shots, name);
  await page.screenshot({ path: file, type: "png" });
  await page.evaluate(() => {
    document.documentElement.style.removeProperty("--safe-t");
    delete window.__HANNAFON_VIEWPORT_TEST__;
    window.__hannafonTest.updateViewportFix();
  });
  return file;
}

// V1.08: every live video shows the whole camera frame: object-fit contain, black
// background, self-view box in the real track shape; synthetic portrait/landscape
// frames keep their aspect (upright iPhone stays upright on the iPad).
async function readVideoBoxes(page) {
  return page.evaluate(() => {
    const one = (id) => {
      const v = document.getElementById(id);
      const cs = getComputedStyle(v);
      const r = v.getBoundingClientRect();
      const vw = v.videoWidth, vh = v.videoHeight;
      // Displayed picture rect inside the element (contain or cover maths).
      let pic = null;
      if (vw && vh && r.width && r.height) {
        const k = cs.objectFit === "cover" ? Math.max(r.width / vw, r.height / vh) : Math.min(r.width / vw, r.height / vh);
        pic = { w: vw * k, h: vh * k };
      }
      return { fit: cs.objectFit, bg: cs.backgroundColor, transform: cs.transform, w: r.width, h: r.height, vw, vh, pic, aspect: v.dataset.aspect || null };
    };
    return { remote: one("remote-video"), local: one("local-video") };
  });
}

function assertVideoBoxes(info, label, { local = true, remote = true } = {}) {
  for (const [name, b] of Object.entries(info)) {
    if ((name === "local" && !local) || (name === "remote" && !remote)) continue;
    if (b.fit !== "contain") throw new Error(`${label}: ${name} video must be object-fit contain ${JSON.stringify(b)}`);
    if (b.bg !== "rgb(0, 0, 0)") throw new Error(`${label}: ${name} video background must be black ${JSON.stringify(b)}`);
    if (!b.vw || !b.vh || !b.pic) throw new Error(`${label}: ${name} video has no frame ${JSON.stringify(b)}`);
    // Whole frame visible: the drawn picture fits inside the element.
    if (b.pic.w > b.w + 0.5 || b.pic.h > b.h + 0.5) throw new Error(`${label}: ${name} frame is cropped ${JSON.stringify(b)}`);
    const want = b.vw / b.vh;
    if (Math.abs(b.pic.w / b.pic.h - want) > 0.02 * want) throw new Error(`${label}: ${name} aspect changed ${JSON.stringify(b)}`);
  }
  if (local) {
    const b = info.local;
    const boxAr = b.w / b.h, want = b.vw / b.vh;
    if (Math.abs(boxAr - want) > 0.04 * want) throw new Error(`${label}: self-view box must follow the camera shape ${JSON.stringify(b)}`);
  }
}

// Swap in synthetic colour-bar streams of a given size (no camera, no faces).
async function setSyntheticVideo(page, id, w, h, hue) {
  await page.evaluate(async ({ id, w, h, hue }) => {
    window.__synth = window.__synth || {};
    const v = document.getElementById(id);
    window.__synth[id] = window.__synth[id] || { orig: v.srcObject };
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    const bars = ["#ffffff", "#ffff00", "#00ffff", "#00ff00", "#ff00ff", "#ff0000", "#0000ff"];
    const draw = () => {
      bars.forEach((col, i) => { ctx.fillStyle = col; ctx.fillRect((i * w) / bars.length, 0, w / bars.length + 1, h); });
      ctx.strokeStyle = `hsl(${hue},90%,40%)`; ctx.lineWidth = Math.max(6, w / 60);
      ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth);
      ctx.fillStyle = "#000"; ctx.font = `bold ${Math.round(Math.min(w, h) / 9)}px sans-serif`;
      ctx.textAlign = "center"; ctx.fillText(`${w}x${h}`, w / 2, h / 2);
    };
    draw();
    const stream = c.captureStream(15);
    window.__synth[id].timer && clearInterval(window.__synth[id].timer);
    window.__synth[id].timer = setInterval(draw, 100);
    v.srcObject = stream;
    await v.play().catch(() => {});
    const t0 = performance.now();
    while ((v.videoWidth !== w || v.videoHeight !== h) && performance.now() - t0 < 4000) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 150));
  }, { id, w, h, hue });
}

async function restoreVideo(page) {
  await page.evaluate(() => {
    for (const [id, s] of Object.entries(window.__synth || {})) {
      clearInterval(s.timer);
      const v = document.getElementById(id);
      v.srcObject = s.orig;
      v.play().catch(() => {});
    }
    window.__synth = {};
  });
}

// Landscape iPad: photo covers the whole (possibly iOS-gap-extended) app, and every
// tappable head is hittable at the default fit, without panning, and clear of the chrome.
async function assertLandscapeFullBleed(page, viewport, tag, sim) {
  await page.setViewportSize(viewport);
  await page.evaluate((sim) => {
    if (sim) window.__HANNAFON_VIEWPORT_TEST__ = sim;
    else delete window.__HANNAFON_VIEWPORT_TEST__;
  }, sim || null);
  await page.waitForTimeout(450);
  const gap = await page.evaluate(() => window.__hannafonTest.updateViewportFix());
  await page.evaluate(() => window.__hannafonTest.resetNav());
  await page.waitForTimeout(150);
  const expectGap = sim?.expectGap || 0;
  if (gap !== expectGap) throw new Error(`${tag}: iOS gap ${gap}, expected ${expectGap}`);
  const geo = await page.evaluate(() => {
    const app = document.getElementById("app").getBoundingClientRect();
    const stage = document.getElementById("photo-stage").getBoundingClientRect();
    return {
      innerH: window.innerHeight,
      innerW: window.innerWidth,
      app: { top: app.top, bottom: app.bottom, w: app.width },
      stage: { top: stage.top, bottom: stage.bottom, left: stage.left, right: stage.right },
      cov: window.__hannafonTest.photoCoverage(),
    };
  });
  const wantBottom = geo.innerH + expectGap;
  if (Math.abs(geo.app.bottom - wantBottom) > 1 || Math.abs(geo.stage.bottom - wantBottom) > 1 || geo.stage.top > 0.5) {
    throw new Error(`${tag}: app/stage must reach the bottom (${wantBottom}): ${JSON.stringify(geo)}`);
  }
  if (!geo.cov?.covers || geo.cov.contain) throw new Error(`${tag}: photo must cover (no cream strip): ${JSON.stringify(geo.cov)}`);
  if (geo.cov.top + geo.cov.dh < geo.stage.bottom - 0.5) throw new Error(`${tag}: photo ends above the bottom edge`);
  const chrome = [];
  for (const sel of ["#btn-addressbook", "#wordmark"]) {
    if (await page.locator(sel).isVisible().catch(() => false)) chrome.push(await page.locator(sel).boundingBox());
  }
  const visibleH = Math.min(geo.innerH, wantBottom); // Playwright can only click inside its viewport
  for (const p of callablePeople()) {
    const pt = await page.evaluate((n) => window.__hannafonTest.facePoint(n), p.nr);
    const m = 12;
    if (!pt || pt.x < m || pt.x > geo.innerW - m || pt.y < m || pt.y > visibleH - m) {
      throw new Error(`${tag}: head #${p.nr} not on screen at default fit: ${JSON.stringify(pt)}`);
    }
    for (const b of chrome) {
      if (b && pt.x > b.x - 4 && pt.x < b.x + b.width + 4 && pt.y > b.y - 4 && pt.y < b.y + b.height + 4) {
        throw new Error(`${tag}: head #${p.nr} sits under a button`);
      }
    }
    // Not inside the simulated rounded top display corners (worst case: 24px bar).
    const tab = await page.evaluate(() => document.documentElement.classList.contains("is-tablet"));
    const R = tab ? Math.min(26, Math.max(18, 0.027 * Math.min(geo.innerW, geo.innerH))) : 0;
    for (const cx of [R, geo.innerW - R]) {
      const cy = 24 + R;
      if (R && (pt.x < R || pt.x > geo.innerW - R) && pt.y < cy && Math.hypot(pt.x - cx, pt.y - cy) > R - 4) {
        throw new Error(`${tag}: head #${p.nr} sits in a rounded corner`);
      }
      if (R && pt.y < 24 + 4) throw new Error(`${tag}: head #${p.nr} under the status bar`);
    }
    await page.mouse.click(pt.x, pt.y);
    await page.locator("#zoom-card").waitFor({ state: "visible", timeout: 8000 });
    const name = (await page.locator("#zoom-name").innerText()).trim();
    if (name !== p.name) throw new Error(`${tag}: head #${p.nr} expected "${p.name}", got "${name}"`);
    await unzoom(page);
    await page.evaluate(() => window.__hannafonTest.resetNav());
  }
  return geo;
}

// V1.06: every zoomed face lands at the horizontal centre (and 28% height),
// edge faces included (mirrored blurred extension, no cream gap).
async function assertZoomCentered(page, p, tag, logArr) {
  const info = await page.evaluate((nr) => {
    const t = window.__hannafonTest;
    const pt = t.facePoint(nr);
    const st = document.getElementById("photo-stage").getBoundingClientRect();
    const ext = document.getElementById("photo-extend");
    const imgs = [...ext.querySelectorAll("img")];
    return {
      pt, w: st.width, h: st.height, left: st.left, top: st.top,
      cov: t.photoCoverage(),
      extOpacity: getComputedStyle(ext).opacity,
      extReady: imgs.length === 8 && imgs.every((i) => i.complete && i.naturalWidth > 0),
    };
  }, p.nr);
  const cx = info.left + info.w / 2;
  const cy = info.top + info.h * 0.28;
  if (!info.pt || Math.abs(info.pt.x - cx) > 2 || Math.abs(info.pt.y - cy) > 2) {
    throw new Error(`${tag}: #${p.nr} not centred when zoomed ${JSON.stringify({ pt: info.pt, cx, cy })}`);
  }
  if (!info.cov.covers) {
    // Past the real photo edge: the mirrored extension must be there and visible.
    if (!info.extReady || Number(info.extOpacity) < 0.99) {
      throw new Error(`${tag}: #${p.nr} past the photo edge without extension ${JSON.stringify(info)}`);
    }
    logArr?.push(`#${p.nr}`);
  }
}

// V1.06: greeting top-right, right-aligned, clear of the right edge (safe area).
async function assertGreetingRight(page, label) {
  const g = await page.evaluate(() => {
    const el = document.getElementById("greeting");
    const r = el.getBoundingClientRect();
    const l1 = document.getElementById("greeting-line1").getBoundingClientRect();
    const l2 = document.getElementById("greeting-line2").getBoundingClientRect();
    return {
      text: el.innerText,
      align: getComputedStyle(el).textAlign,
      right: r.right, left: r.left, top: r.top,
      l1r: l1.right, l2r: l2.right, w: window.innerWidth,
    };
  });
  if (!/^Hallo Hanna,/.test(g.text) || !g.text.includes("wen willst du anrufen?")) {
    throw new Error(label + ": greeting text " + JSON.stringify(g.text));
  }
  if (g.align !== "right") throw new Error(label + ": greeting must be right-aligned");
  if (g.left < g.w / 2 - 1) throw new Error(label + ": greeting must sit on the right half " + JSON.stringify(g));
  if (g.right > g.w - 10 || g.right < g.w - 60) throw new Error(label + ": greeting right edge " + JSON.stringify(g));
  if (Math.abs(g.l1r - g.l2r) > 2) throw new Error(label + ": greeting lines not right-aligned " + JSON.stringify(g));
}

// V1.06: host corner pill bottom-right (Adressbuch; Zum Foto shares the spot).
async function assertCornerRight(page, sel, label) {
  const b = await page.locator(sel).boundingBox();
  const vp = page.viewportSize();
  if (!b || b.x < vp.width / 2 || Math.abs(b.x + b.width - (vp.width - 22)) > 2 || b.y + b.height < vp.height - 120) {
    throw new Error(`${label}: ${sel} must sit bottom-right ${JSON.stringify(b)}`);
  }
}

// V1.06: no pinch on iPad. Synthetic two-finger pointer pinch + ctrl-wheel on the
// stage must not change the photo scale. (Headless Chromium cannot reproduce iOS
// Safari's native page pinch; viewport meta / gesturestart handling is checked by
// attribute and listener presence only.)
async function assertNoPinch(page, label) {
  if (await page.evaluate(() => window.__hannafonTest.pinchAllowed())) {
    throw new Error(label + ": pinch must be off on iPad");
  }
  const before = await page.evaluate(() => window.__hannafonTest.photoScale());
  await page.evaluate(() => {
    const st = document.getElementById("photo-stage");
    const r = st.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const ev = (type, id, x, y) =>
      st.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, pointerType: "touch", isPrimary: id === 1 }));
    ev("pointerdown", 1, cx - 40, cy);
    ev("pointerdown", 2, cx + 40, cy);
    for (let i = 1; i <= 8; i++) {
      ev("pointermove", 1, cx - 40 - i * 25, cy);
      ev("pointermove", 2, cx + 40 + i * 25, cy);
    }
    ev("pointerup", 1, cx - 240, cy);
    ev("pointerup", 2, cx + 240, cy);
    for (let i = 0; i < 6; i++) {
      st.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, clientX: cx, clientY: cy, bubbles: true, cancelable: true }));
    }
  });
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => window.__hannafonTest.photoScale());
  if (Math.abs(after.s - before.s) > 1e-6 || Math.abs(after.tx - before.tx) > 0.5 || Math.abs(after.ty - before.ty) > 0.5 || after.navUser) {
    throw new Error(label + ": pinch changed the photo " + JSON.stringify({ before, after }));
  }
  const vp = await page.evaluate(() => document.querySelector('meta[name="viewport"]').content);
  if (!/maximum-scale=1/.test(vp) || !/user-scalable=no/.test(vp)) throw new Error(label + ": viewport must block page zoom");
  const ta = await page.evaluate(() => getComputedStyle(document.documentElement).touchAction);
  if (ta !== "pan-x pan-y") throw new Error(label + ": html touch-action " + ta);
}

async function mediaContext(browser, { grant = false, permState = null, denyGum = false } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 393, height: 852 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  });
  if (grant) await ctx.grantPermissions(["camera", "microphone"], { origin: ORIGIN });
  await ctx.addInitScript(({ permState, denyGum }) => {
    window.__gum = { calls: 0, streams: [] };
    const md = navigator.mediaDevices;
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async (c) => {
      window.__gum.calls++;
      if (denyGum) throw new DOMException("Permission denied", "NotAllowedError");
      const s = await orig(c);
      window.__gum.streams.push(s);
      return s;
    };
    if (permState && navigator.permissions?.query) {
      const oq = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = async (d) =>
        d && (d.name === "camera" || d.name === "microphone")
          ? { state: permState, onchange: null, addEventListener() {}, removeEventListener() {} }
          : oq(d);
    }
  }, { permState, denyGum });
  return ctx;
}

const gumInfo = (page) =>
  page.evaluate(() => ({
    calls: window.__gum.calls,
    live: window.__gum.streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === "live").length,
    log: window.__hannafonTest?.mediaPrimeLog?.() || [],
  }));

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
  await assertHidden(page, "#btn-addressbook", tag + " setup is not the host");
  await assertHidden(page, "#btn-back-photo", tag + " setup not zoomed");
  await shot(page, `${tag}-setup.jpg`);
  await zoomTo(page, 22, "Daniel");
  await assertHidden(page, "#btn-addressbook", tag + " setup zoom");
  await page.locator("#btn-back-photo").waitFor({ state: "visible", timeout: 4000 });
  await shot(page, `${tag}-setup-zoom.jpg`);
  await page.locator("#btn-confirm").click();
  await page.locator("#screen-standby").waitFor({ state: "visible", timeout: 8000 });
  await page.locator("#btn-call-host").waitFor({ state: "visible" });
  await page.locator("#btn-disconnect").waitFor({ state: "visible" });
  const iconSrc = (await page.locator("#host-face").getAttribute("src")) || "";
  if (!iconSrc.includes("icon-512")) {
    throw new Error("standby host tile should use the app icon, got " + iconSrc);
  }
  await assertHidden(page, "#btn-addressbook", tag + " receiver standby");
  await assertHidden(page, "#screen-addressbook", tag + " receiver standby");
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
    await assertTopClean(hanna, "hanna home 1180x820");
    await assertGreetingRight(hanna, "hanna home 1180x820");
    await assertCornerRight(hanna, "#btn-addressbook", "hanna home 1180x820");
    await assertNoPinch(hanna, "ipad-10 landscape");
    results.push("no topfade, black status bar, greeting right, Adressbuch bottom-right, no pinch");
    await assertManifestBlack(hanna);
    await assertStatusStrip(hanna, "ipad-10");
    await assertDisplayRounding(hanna, "ipad-10 1180x820", true);
    await shotTopCorners(hanna, "v108-ipad10-top-bar24.png");
    await assertCornerRight(hanna, "#btn-addressbook", "ipad-10 rounded");
    await shot(hanna, "v107-ipad10-home.jpg");
    await assertDisplayRounding(daniel, "iphone14 393x852", false);
    await assertStatusStrip(daniel, "iphone14");
    results.push("V1.07 black page/app/theme-color/manifest, standalone status strip, iPad top-corner rounding only (bottom square, not iPhone)");

    if ((await hanna.locator("i.halo").count()) < 20) {
      throw new Error("expected discreet halos on tappable people");
    }

    // Zoom every tappable person and screenshot (no black edges, soft silhouette).
    const people = loadPeople().filter((p) => p.tappable !== false);
    const centerLog = [];
    for (const p of people) {
      await zoomTo(hanna, p.nr, p.name);
      await assertZoomCentered(hanna, p, "ipad-10", centerLog);
      const file = `zoom-${p.nr}-${slug(p.name)}.jpg`;
      await shot(hanna, file);
      if (p.nr === 22) await shot(hanna, "hanna-zoom-call.jpg");
      if (p.nr === 23) await shot(hanna, "zoom-melanie.jpg");
      if (p.nr === 10) await shot(hanna, "zoom-hanna.jpg");
      await unzoom(hanna);
      process.stdout.write(`zoomed ${p.nr} ${p.name}\n`);
    }
    results.push("zoom gallery " + people.length + " (every face centred; edges " + centerLog.join(" ") + ")");

    // Adressbuch: host only, overview only, callable people only.
    await hanna.locator("#btn-addressbook").waitFor({ state: "visible", timeout: 8000 });
    await assertHidden(hanna, "#btn-back-photo", "host overview is not zoomed");
    const bookLabel = (await hanna.locator("#btn-addressbook").innerText()).trim();
    if (bookLabel !== "Adressbuch") throw new Error("addressbook label: " + bookLabel);
    await shot(hanna, "hanna-overview-adressbuch.jpg");
    const bookBox = await hanna.locator("#btn-addressbook").boundingBox();
    await hanna.locator("#btn-addressbook").click();
    await hanna.locator("#screen-addressbook").waitFor({ state: "visible", timeout: 5000 });
    await assertHidden(hanna, "#btn-addressbook", "list is open");
    const listNrs = await hanna.$$eval("#ab-list .ab-row", (rows) => rows.map((r) => Number(r.dataset.nr)));
    const expectNrs = loadPeople()
      .filter((p) => p.callable && p.tappable !== false && p.nr !== 10)
      .map((p) => p.nr)
      .sort((a, b) => a - b);
    for (const bad of [7, 12, 10]) {
      if (listNrs.includes(bad)) throw new Error(`addressbook must not list #${bad}`);
    }
    if (JSON.stringify([...listNrs].sort((a, b) => a - b)) !== JSON.stringify(expectNrs)) {
      throw new Error("addressbook people mismatch: " + listNrs.join(","));
    }
    if (!listNrs.includes(21)) throw new Error("Hannah (#21) must be in the addressbook");
    const rowName = (await hanna.locator('#ab-list .ab-row[data-nr="22"] .ab-name').innerText()).trim();
    if (rowName !== "Daniel") throw new Error("addressbook row #22 name: " + rowName);
    await hanna.waitForTimeout(300);
    await shot(hanna, "hanna-adressbuch.jpg");
    // "Zum Foto" closes the list and brings the Adressbuch button back.
    {
      const a = await hanna.locator("#btn-ab-close").boundingBox();
      const vp = hanna.viewportSize();
      if (!a || Math.abs(a.x + a.width - (vp.width - 22)) > 2 || a.y + a.height < vp.height - 140) {
        throw new Error("Zum Foto must sit bottom-right: " + JSON.stringify(a));
      }
      // Same spot as the Adressbuch pill (right edge and bottom edge).
      if (bookBox && (Math.abs(bookBox.x + bookBox.width - (a.x + a.width)) > 2 || Math.abs(bookBox.y + bookBox.height - (a.y + a.height)) > 2)) {
        throw new Error("Zum Foto and Adressbuch must share the corner " + JSON.stringify({ a, bookBox }));
      }
      // Scrolled to the end, the last row is not hidden under the pill.
      await hanna.$eval("#ab-list", (el) => { el.scrollTop = el.scrollHeight; });
      await hanna.waitForTimeout(150);
      const overlap = await hanna.evaluate(() => {
        const pill = document.getElementById("btn-ab-close").getBoundingClientRect();
        return [...document.querySelectorAll("#ab-list .ab-row .ab-call")].some((b) => {
          const r = b.getBoundingClientRect();
          return r.right > pill.left && r.left < pill.right && r.bottom > pill.top && r.top < pill.bottom;
        });
      });
      if (overlap) throw new Error("Zum Foto overlaps an Anrufen button at the end of the list");
      await hanna.$eval("#ab-list", (el) => { el.scrollTop = 0; });
    }
    await hanna.locator("#btn-ab-close").click();
    await hanna.locator("#screen-addressbook").waitFor({ state: "hidden", timeout: 5000 });
    await hanna.locator("#btn-addressbook").waitFor({ state: "visible", timeout: 5000 });
    results.push("addressbook host-only list (" + listNrs.length + " callable, no 7/12/10)");

    // Let both Daniel devices finish connecting before the call.
    await daniel.waitForTimeout(800);
    await danielB.waitForTimeout(200);

    // Anrufen from the address book rings Daniel exactly like a call from the photo.
    await hanna.locator("#btn-addressbook").click();
    await hanna.locator('#ab-list .ab-call[data-nr="22"]').click();
    await hanna.locator("#screen-call").waitFor({ state: "visible", timeout: 10000 });
    await assertHidden(hanna, "#screen-addressbook", "call started");
    const waitText = (await hanna.locator("#call-status").innerText()).trim();
    if (!waitText.includes("Daniel")) throw new Error("call status should name Daniel: " + waitText);
    await daniel.locator("#screen-incoming").waitFor({ state: "visible", timeout: 15000 });
    await danielB.locator("#screen-incoming").waitFor({ state: "visible", timeout: 15000 });
    await hanna.locator("#btn-hangup").click();
    await hanna.locator("#screen-photo").waitFor({ state: "visible", timeout: 10000 });
    await daniel.locator("#screen-standby").waitFor({ state: "visible", timeout: 10000 });
    await danielB.locator("#screen-standby").waitFor({ state: "visible", timeout: 10000 });
    await hanna.locator("#btn-addressbook").waitFor({ state: "visible", timeout: 5000 });
    results.push("addressbook Anrufen rings both Daniel devices");
    await daniel.waitForTimeout(600);

    // Host calls Daniel — both of Daniel's devices must ring.
    await tapPerson(hanna, 22);
    await hanna.locator("#btn-call").waitFor({ state: "visible", timeout: 8000 });
    await hanna.waitForTimeout(800);
    await hanna.locator("#btn-call").click();
    await hanna.locator("#screen-call").waitFor({ state: "visible", timeout: 10000 });

    await daniel.locator("#screen-incoming").waitFor({ state: "visible", timeout: 15000 });
    await danielB.locator("#screen-incoming").waitFor({ state: "visible", timeout: 15000 });
    // V1.08: Hanna calling → app-icon portrait, family photo hidden.
    const incIcon = (await daniel.locator("#incoming-host-face").getAttribute("src")) || "";
    if (!incIcon.includes("icon-512")) throw new Error("incoming host tile should use the app icon, got " + incIcon);
    if (await daniel.locator("#incoming-host-wrap").isHidden()) throw new Error("incoming host portrait should be visible when Hanna calls");
    const incSt = await daniel.evaluate(() => window.__hannafonTest.incomingState());
    if (!incSt.showHostIcon) throw new Error("incomingState.showHostIcon should be true when Hanna calls " + JSON.stringify(incSt));
    if (!(await daniel.locator("#screen-photo").isHidden())) throw new Error("family photo should be hidden when Hanna calls");
    if (!(await daniel.locator("#screen-incoming").evaluate((el) => el.classList.contains("has-host-icon")))) {
      throw new Error("incoming screen should have has-host-icon when Hanna calls");
    }
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
    {
      // V1.09: moderate 1:1 send cap on both sides.
      for (const [p, n] of [[hanna, "hanna"], [daniel, "daniel"]]) {
        await p.waitForFunction(() => {
          const c = window.__hannafonTest.sendCaps().oneToOne || [];
          const v = c.find((s) => s.kind === "video");
          const a = c.find((s) => s.kind === "audio");
          return v && v.maxBitrate === 1000000 && v.maxFramerate === 24 && a && a.maxBitrate === 48000;
        }, null, { timeout: 8000 }).catch(async () => {
          throw new Error(n + " 1:1 send caps " + JSON.stringify(await p.evaluate(() => window.__hannafonTest.sendCaps())));
        });
      }
      results.push("V1.09 1:1 send cap 1000 kbps / 24 fps / audio 48 kbps (both sides)");
    }

    // V1.08: whole camera frame everywhere, real aspect, no crop.
    {
      const constraints = await hanna.evaluate(() => {
        const t = window.__hannafonTest?.localStream?.()?.getVideoTracks?.()[0];
        return t ? t.getSettings() : null;
      }).catch(() => null);
      assertVideoBoxes(await readVideoBoxes(hanna), "hanna in call");
      assertVideoBoxes(await readVideoBoxes(daniel), "daniel in call");
      // Upright iPhone (9:16) on Hanna's iPad landscape: stays upright, pillarboxed.
      await setSyntheticVideo(hanna, "remote-video", 540, 960, 210);
      await setSyntheticVideo(hanna, "local-video", 1280, 960, 30);
      let hb = await readVideoBoxes(hanna);
      assertVideoBoxes(hb, "hanna synthetic portrait remote / 4:3 self");
      if (hb.remote.aspect !== "portrait" || !(hb.remote.pic.h > hb.remote.pic.w) || Math.abs(hb.remote.pic.h - hb.remote.h) > 1) {
        throw new Error("upright phone must fill the iPad height in portrait shape " + JSON.stringify(hb.remote));
      }
      if (hb.local.aspect !== "landscape") throw new Error("self-view 4:3 must be landscape " + JSON.stringify(hb.local));
      await shot(hanna, "v108-hanna-synthetic-portrait-remote.jpg");
      // Rotated self camera (portrait) -> self-view box turns portrait.
      await setSyntheticVideo(hanna, "local-video", 960, 1280, 30);
      hb = await readVideoBoxes(hanna);
      assertVideoBoxes(hb, "hanna synthetic portrait self");
      if (hb.local.aspect !== "portrait" || !(hb.local.h > hb.local.w)) throw new Error("self-view must turn portrait " + JSON.stringify(hb.local));
      // Landscape caller (16:9) also complete, letterboxed on a 4:3-ish iPad.
      await setSyntheticVideo(hanna, "remote-video", 1280, 720, 120);
      assertVideoBoxes(await readVideoBoxes(hanna), "hanna synthetic 16:9 remote");
      await restoreVideo(hanna);
      // Phone side: Hanna's 4:3 landscape iPad on an upright iPhone, letterboxed, complete.
      await setSyntheticVideo(daniel, "remote-video", 1280, 960, 300);
      await setSyntheticVideo(daniel, "local-video", 960, 1280, 30);
      const db = await readVideoBoxes(daniel);
      assertVideoBoxes(db, "daniel synthetic");
      if (Math.abs(db.remote.pic.w - db.remote.w) > 1) throw new Error("iPad picture must span the phone width " + JSON.stringify(db.remote));
      await shot(daniel, "v108-daniel-synthetic-landscape-remote.jpg");
      await restoreVideo(daniel);
      results.push("V1.08 video: contain everywhere, self-view follows camera shape, portrait/landscape uncropped" + (constraints ? ` (cam ${constraints.width}x${constraints.height})` : ""));
    }

    await hanna.locator("#btn-hangup").click();
    await hanna.locator("#screen-photo").waitFor({ state: "visible", timeout: 10000 });
    await daniel.locator("#screen-standby").waitFor({ state: "visible", timeout: 10000 });
    await shot(hanna, "after-hangup-hanna.jpg");
    await shot(daniel, "after-hangup-daniel.jpg");
    results.push("hangup ok");

    // ---------------------------------------------------------------------
    // V1.09 group calls (Hanna + Maria #1 + Daniel #22 on two devices)
    {
      const mariaCtx = await phoneContext(browser, iphone14);
      const maria = await mariaCtx.newPage();
      await enterCode(maria);
      await identify(maria, 1);
      await maria.locator("#screen-standby").waitFor({ state: "visible", timeout: 8000 });
      await maria.locator("body").click({ position: { x: 20, y: 400 } }).catch(() => {});
      await maria.waitForTimeout(600);

      // joinNames unit cases
      const jn = await hanna.evaluate(() => [
        window.__hannafonTest.joinNames(["Maria"]),
        window.__hannafonTest.joinNames(["Maria", "Daniel"]),
        window.__hannafonTest.joinNames(["Maria", "Daniel", "Anna"]),
      ]);
      if (JSON.stringify(jn) !== JSON.stringify(["Maria", "Maria und Daniel", "Maria, Daniel und Anna"])) {
        throw new Error("joinNames " + JSON.stringify(jn));
      }

      // a) zoom card: green Anrufen + cream "Noch jemanden dazu" side by side, row centred.
      await zoomTo(hanna, 1, "Maria");
      await hanna.locator("#btn-add-more").waitFor({ state: "visible", timeout: 5000 });
      const addTxt = (await hanna.locator("#btn-add-more").innerText()).replace(/\s+/g, " ").trim();
      if (addTxt !== "Noch jemanden dazu") throw new Error("add-more label: " + addTxt);
      {
        const c = await hanna.locator("#btn-call").boundingBox();
        const a = await hanna.locator("#btn-add-more").boundingBox();
        const row = await hanna.locator("#zoom-actions").boundingBox();
        const back = await hanna.locator("#btn-back-photo").boundingBox();
        if (Math.abs((c.y + c.height / 2) - (a.y + a.height / 2)) > 6 || !(a.x > c.x + c.width - 1)) {
          throw new Error("Noch jemanden dazu must sit next to Anrufen " + JSON.stringify({ c, a }));
        }
        if (Math.abs(row.x + row.width / 2 - hanna.viewportSize().width / 2) > 3) throw new Error("zoom actions must be centred");
        if (boxesOverlap(back, a) || boxesOverlap(back, c)) throw new Error("Zum Foto overlaps the zoom actions");
        const bg = await hanna.locator("#btn-add-more").evaluate((el) => getComputedStyle(el).backgroundColor);
        if (bg !== CREAM_RGB) throw new Error("Noch jemanden dazu must be cream, got " + bg);
      }
      await shot(hanna, "v109-zoom-add-more.jpg");
      // Not for Hanna herself (no Anrufen, no group).
      await unzoom(hanna);
      await zoomTo(hanna, 10, "Hanna");
      await assertHidden(hanna, "#btn-add-more", "zoomed on Hanna herself");
      await unzoom(hanna);

      // b) select mode
      await zoomTo(hanna, 1, "Maria");
      await hanna.locator("#btn-add-more").click();
      await hanna.locator("#select-bar").waitFor({ state: "visible", timeout: 5000 });
      const label = async () => (await hanna.locator("#btn-group-call-label").innerText()).trim();
      const sel = async () => (await hanna.evaluate(() => window.__hannafonTest.selectState()))?.nrs || null;
      if ((await label()) !== "Maria anrufen") throw new Error("select start label: " + (await label()));
      if (JSON.stringify(await sel()) !== "[1]") throw new Error("first person preselected");
      const g1 = (await hanna.locator("#greeting-line1").innerText()).trim();
      const g2 = (await hanna.locator("#greeting-line2").innerText()).trim();
      if (g1 !== "Wen noch?" || g2 !== "Tippe auf alle, die mit dabei sein sollen.") throw new Error("select instruction: " + g1 + " / " + g2);
      await hanna.waitForFunction(() => Number(getComputedStyle(document.getElementById("greeting")).opacity) > 0.99, null, { timeout: 3000 }).catch(() => {});
      {
        const g = await hanna.evaluate(() => {
          const el = document.getElementById("greeting");
          const r = el.getBoundingClientRect();
          return { align: getComputedStyle(el).textAlign, left: r.left, right: r.right, w: window.innerWidth, vis: getComputedStyle(el).opacity };
        });
        if (g.align !== "right" || g.left < g.w / 2 - 1 || g.right < g.w - 60 || Number(g.vis) < 0.99) {
          throw new Error("select instruction must sit top-right like the greeting " + JSON.stringify(g));
        }
      }
      await hanna.locator("#btn-back-photo").waitFor({ state: "visible", timeout: 3000 });
      await assertHidden(hanna, "#btn-addressbook", "select mode");
      await assertHidden(hanna, "#btn-missed", "select mode");
      await assertHidden(hanna, "#zoom-card", "select mode");
      // The only chosen person stays chosen.
      await tapPerson(hanna, 1);
      if (JSON.stringify(await sel()) !== "[1]") throw new Error("last chosen person must stay");
      await tapPerson(hanna, 22);
      if ((await label()) !== "Maria und Daniel anrufen") throw new Error("two names: " + (await label()));
      await tapPerson(hanna, 23);
      if ((await label()) !== "Maria, Daniel und Melanie anrufen") throw new Error("three names: " + (await label()));
      if ((await hanna.locator(".sel-ring").count()) !== 3) throw new Error("three green rings expected");
      if ((await hanna.locator(".sel-ring .sel-check").count()) !== 3) throw new Error("three checks expected");
      await tapPerson(hanna, 9); // 4th: refused, calm hint
      if (JSON.stringify(await sel()) !== "[1,22,23]") throw new Error("max 3 others: " + JSON.stringify(await sel()));
      await hanna.locator("#select-hint").waitFor({ state: "visible", timeout: 2000 });
      await shot(hanna, "v109-select-max.jpg");
      await tapPerson(hanna, 10); // Hanna herself: not selectable
      if (JSON.stringify(await sel()) !== "[1,22,23]") throw new Error("Hanna must not be selectable");
      await tapPerson(hanna, 23); // deselect
      if ((await label()) !== "Maria und Daniel anrufen") throw new Error("deselect: " + (await label()));
      if ((await hanna.locator(".sel-ring").count()) !== 2) throw new Error("two rings after deselect");
      {
        const bar = await hanna.locator("#btn-group-call").boundingBox();
        if (Math.abs(bar.x + bar.width / 2 - hanna.viewportSize().width / 2) > 3) throw new Error("group pill must be centred");
        const back = await hanna.locator("#btn-back-photo").boundingBox();
        if (boxesOverlap(back, bar)) throw new Error("Zum Foto overlaps the group pill");
      }
      await shot(hanna, "v109-select.jpg");
      // Zum Foto cancels and clears the choice.
      await hanna.locator("#btn-back-photo").click();
      await assertHidden(hanna, "#select-bar", "select cancelled");
      if ((await sel()) !== null) throw new Error("selection must be cleared");
      if ((await hanna.locator(".sel-ring").count()) !== 0) throw new Error("rings must be gone");
      if (!(await hanna.locator("#greeting-line1").innerText()).startsWith("Hallo")) throw new Error("greeting back");
      await hanna.locator("#btn-addressbook").waitFor({ state: "visible", timeout: 3000 });
      results.push("V1.09 zoom card Noch jemanden dazu, select mode toggle/max 3/names/Zum Foto cancel");

      async function startGroup(nrs) {
        await zoomTo(hanna, nrs[0], null);
        await hanna.locator("#btn-add-more").click();
        for (const nr of nrs.slice(1)) await tapPerson(hanna, nr);
        await hanna.locator("#btn-group-call").click();
        await hanna.locator("#screen-call").waitFor({ state: "visible", timeout: 10000 });
      }
      const gs = (page) => page.evaluate(() => window.__hannafonTest.groupState());
      async function waitPeers(page, want, label, timeout = 25000) {
        try {
          await page.waitForFunction((want) => {
            const g = window.__hannafonTest.groupState();
            if (!g) return false;
            const got = g.peers.map((p) => `${p.nr}:${p.status}${p.status === "joined" ? (p.live ? "+" : "-") : ""}`).sort().join(",");
            return got === want.split(",").sort().join(",");
          }, want, { timeout });
        } catch {
          throw new Error(label + ": expected peers " + want + " got " + JSON.stringify(await gs(page)));
        }
      }
      const backHome = async () => {
        await hanna.locator("#screen-photo").waitFor({ state: "visible", timeout: 10000 });
        for (const p of [maria, daniel, danielB]) {
          await p.locator("#screen-standby").waitFor({ state: "visible", timeout: 12000 });
        }
        await hanna.waitForTimeout(500);
      };

      // c) Starting a group rings both people (Daniel on two devices).
      await startGroup([1, 22]);
      await waitPeers(hanna, "1:ringing,22:ringing", "hanna ringing");
      if ((await hanna.locator("#call-grid .tile.is-ringing").count()) !== 2) throw new Error("two ringing tiles");
      const ringTxt = await hanna.locator("#call-grid .tile.is-ringing .tile-ring").first().innerText();
      if (!ringTxt.includes("klingelt")) throw new Error("ringing tile text: " + ringTxt);
      for (const p of [maria, daniel, danielB]) await p.locator("#screen-incoming").waitFor({ state: "visible", timeout: 15000 });
      for (const [p, sub] of [[maria, "mit Daniel"], [daniel, "mit Maria"]]) {
        const st = await p.evaluate(() => window.__hannafonTest.incomingState());
        if (!st.showHostIcon) throw new Error("group incoming must show the host icon");
        if (!(await p.locator("#screen-photo").isHidden())) throw new Error("group incoming: family photo must be hidden");
        const src = (await p.locator("#incoming-host-face").getAttribute("src")) || "";
        if (!src.includes("icon-512")) throw new Error("group incoming icon: " + src);
        const title = (await p.locator("#incoming-title").innerText()).trim();
        if (title !== "Hanna ruft an") throw new Error("group incoming title: " + title);
        const s = (await p.locator("#incoming-sub").innerText()).trim();
        if (s !== sub) throw new Error("group incoming subtitle: " + s);
      }
      await shot(hanna, "v109-hanna-group-ringing.jpg");
      await shot(maria, "v109-maria-incoming-group.jpg");

      // d) Daniel accepts on device A: B gets "Anderswo angenommen", Maria keeps ringing.
      await daniel.locator("#btn-accept").click();
      await daniel.locator("#screen-call").waitFor({ state: "visible", timeout: 10000 });
      await danielB.locator("#taken-toast").waitFor({ state: "visible", timeout: 8000 });
      await danielB.locator("#screen-standby").waitFor({ state: "visible", timeout: 8000 });
      await maria.waitForTimeout(1200);
      if (!(await maria.locator("#screen-incoming").isVisible())) throw new Error("Maria must keep ringing after Daniel accepts");
      await waitPeers(hanna, "1:ringing,22:joined+", "hanna after daniel");
      await waitPeers(daniel, "1:ringing,10:joined+", "daniel sees hanna + maria ringing");
      results.push("V1.09 group rings two people, incoming shows icon + mit …, one accept keeps the other ringing, taken per person");

      // e) Maria accepts: full mesh (Maria sees Daniel too).
      await maria.locator("#btn-accept").click();
      await maria.locator("#screen-call").waitFor({ state: "visible", timeout: 10000 });
      await waitPeers(hanna, "1:joined+,22:joined+", "hanna mesh");
      await waitPeers(maria, "10:joined+,22:joined+", "maria mesh");
      await waitPeers(daniel, "1:joined+,10:joined+", "daniel mesh");
      for (const [p, n] of [[hanna, "hanna"], [maria, "maria"], [daniel, "daniel"]]) {
        const tiles = await p.$$eval("#call-grid .tile video", (vs) => vs.map((v) => ({ fit: getComputedStyle(v).objectFit, bg: getComputedStyle(v).backgroundColor })));
        if (tiles.length !== 2 || tiles.some((t) => t.fit !== "contain" || t.bg !== "rgb(0, 0, 0)")) {
          throw new Error(n + " group tiles must be contain on black " + JSON.stringify(tiles));
        }
        if (await p.locator("#remote-video").isVisible()) throw new Error(n + ": 1:1 remote video hidden in group");
        const lv = await p.locator("#local-video").evaluate((v) => getComputedStyle(v).objectFit);
        if (lv !== "contain") throw new Error(n + " self-view contain");
      }
      {
        const caps = await hanna.evaluate(() => window.__hannafonTest.sendCaps());
        for (const peer of caps.group) {
          const v = peer.senders.find((s) => s.kind === "video");
          const a = peer.senders.find((s) => s.kind === "audio");
          if (!v || v.maxBitrate !== 600000 || v.maxFramerate !== 24 || !a || a.maxBitrate !== 48000) {
            throw new Error("group send caps (2 remotes) " + JSON.stringify(caps));
          }
        }
        const mcaps = await maria.evaluate(() => window.__hannafonTest.sendCaps());
        if (mcaps.group.length !== 2 || mcaps.group.some((p) => p.senders.find((s) => s.kind === "video")?.maxBitrate !== 600000)) {
          throw new Error("guest send caps " + JSON.stringify(mcaps));
        }
      }
      await hanna.waitForTimeout(500);
      await shot(hanna, "v109-hanna-group-incall.jpg");
      await shot(maria, "v109-maria-group-incall.jpg");
      results.push("V1.09 mesh: everyone sees everyone, contain on black, caps 600 kbps/24 fps/48 kbps");

      // f) Maria leaves: Hanna and Daniel continue; collapse to one tile, 1:1 cap.
      await maria.locator("#btn-hangup").click();
      await maria.locator("#screen-standby").waitFor({ state: "visible", timeout: 10000 });
      await waitPeers(hanna, "22:joined+", "hanna after maria left");
      await waitPeers(daniel, "10:joined+", "daniel after maria left");
      if (!(await daniel.locator("#screen-call").isVisible())) throw new Error("Daniel must stay in the call");
      await hanna.waitForFunction(() => {
        const c = window.__hannafonTest.sendCaps();
        return c.group.length === 1 && c.group[0].senders.find((s) => s.kind === "video")?.maxBitrate === 1000000;
      }, null, { timeout: 5000 });
      results.push("V1.09 guest Auflegen leaves only themselves (call continues, back to 1:1 cap)");

      // g) Hanna ends the call for everyone.
      await hanna.locator("#btn-hangup").click();
      await backHome();
      results.push("V1.09 Hanna Auflegen ends the group call");

      // h) Both in, Hanna hangs up: both leave.
      await startGroup([1, 22]);
      for (const p of [maria, daniel]) await p.locator("#screen-incoming").waitFor({ state: "visible", timeout: 15000 });
      await maria.locator("#btn-accept").click();
      await daniel.locator("#btn-accept").click();
      await waitPeers(hanna, "1:joined+,22:joined+", "hanna both in");
      await waitPeers(maria, "10:joined+,22:joined+", "maria both in");
      await hanna.locator("#btn-hangup").click();
      await backHome();
      results.push("V1.09 Hanna Auflegen with two guests ends it for both");

      // i) Missed (timeout) and decline inside a group.
      const mariaMissed = () => maria.evaluate(() => (window.__hannafonTest.missedRaw() || []).filter((m) => m.from === 10).reduce((n, m) => n + m.count, 0));
      await maria.evaluate(() => window.__hannafonTest.clearMissedAll());
      await maria.waitForTimeout(400);
      const before = await mariaMissed();
      await hanna.evaluate(() => window.__hannafonTest.setGroupRingMs(6000));
      await startGroup([1, 22]);
      await daniel.locator("#screen-incoming").waitFor({ state: "visible", timeout: 15000 });
      await maria.locator("#screen-incoming").waitFor({ state: "visible", timeout: 15000 });
      await daniel.locator("#btn-accept").click();
      await waitPeers(hanna, "22:joined+", "maria timed out", 20000);
      await maria.locator("#screen-standby").waitFor({ state: "visible", timeout: 10000 });
      if (!(await daniel.locator("#screen-call").isVisible())) throw new Error("Daniel must stay after Maria timed out");
      await maria.waitForFunction((b) => (window.__hannafonTest.missedRaw() || []).filter((m) => m.from === 10).reduce((n, m) => n + m.count, 0) === b + 1, before, { timeout: 8000 })
        .catch(async () => { throw new Error("missed for Maria after group timeout " + JSON.stringify(await maria.evaluate(() => window.__hannafonTest.missedRaw()))); });
      await hanna.locator("#btn-hangup").click();
      await backHome();
      await hanna.evaluate(() => window.__hannafonTest.setGroupRingMs(60000));

      const before2 = await mariaMissed();
      await startGroup([1, 22]);
      await daniel.locator("#screen-incoming").waitFor({ state: "visible", timeout: 15000 });
      await maria.locator("#screen-incoming").waitFor({ state: "visible", timeout: 15000 });
      await daniel.locator("#btn-accept").click();
      await waitPeers(hanna, "1:ringing,22:joined+", "before decline");
      await maria.locator("#btn-decline").click();
      await waitPeers(hanna, "22:joined+", "maria declined");
      if (!(await daniel.locator("#screen-call").isVisible())) throw new Error("Daniel must stay after Maria declined");
      await maria.waitForTimeout(1200);
      if ((await mariaMissed()) !== before2) throw new Error("decline must not count as missed");
      await hanna.locator("#btn-hangup").click();
      await backHome();
      await maria.evaluate(() => window.__hannafonTest.clearMissedAll());
      results.push("V1.09 group: unanswered → missed for that person, decline not counted, rest continues");

      // j) Hanna's missed list unaffected; 1:1 from the photo still a 1:1 call.
      await zoomTo(hanna, 1, "Maria");
      await hanna.locator("#btn-call").click();
      await maria.locator("#screen-incoming").waitFor({ state: "visible", timeout: 15000 });
      await assertHidden(maria, "#incoming-sub", "1:1 incoming has no group line");
      await maria.locator("#btn-accept").click();
      await waitVideo(hanna);
      if (await hanna.evaluate(() => !!window.__hannafonTest.groupState())) throw new Error("1:1 must not be a group");
      if (!(await hanna.locator("#remote-video").isVisible())) throw new Error("1:1 remote video visible");
      await hanna.locator("#btn-hangup").click();
      await hanna.locator("#screen-photo").waitFor({ state: "visible", timeout: 10000 });
      await maria.locator("#screen-standby").waitFor({ state: "visible", timeout: 10000 });
      results.push("V1.09 1:1 from the photo unchanged");

      await openDisconnectDialog(maria);
      await confirmDisconnect(maria);
      await maria.close();
      await mariaCtx.close();
    }

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

    // "Zum Foto" (V1.06): visible only while zoomed, bottom-right (same spot as
    // Adressbuch), name + Anrufen centred, no overlap.
    await assertHidden(hanna, "#btn-back-photo", "not zoomed");
    await hanna.locator("#btn-addressbook").waitFor({ state: "visible", timeout: 5000 });
    await zoomTo(hanna, 22, "Daniel");
    await hanna.locator("#btn-back-photo").waitFor({ state: "visible", timeout: 5000 });
    await assertHidden(hanna, "#btn-addressbook", "zoomed");
    const backText = (await hanna.locator("#btn-back-photo").innerText()).replace(/\s+/g, " ").trim();
    if (backText !== "Zum Foto") throw new Error("back label: " + backText);
    await assertCornerRight(hanna, "#btn-back-photo", "zoomed");
    const backBox = await hanna.locator("#btn-back-photo").boundingBox();
    if (bookBox && (Math.abs(bookBox.x + bookBox.width - (backBox.x + backBox.width)) > 2 || Math.abs(bookBox.y + bookBox.height - (backBox.y + backBox.height)) > 2)) {
      throw new Error("Zum Foto (zoom) must share the Adressbuch corner");
    }
    const vpW = hanna.viewportSize().width;
    // V1.09: Anrufen sits next to "Noch jemanden dazu"; the row is centred.
    for (const sel of ["#zoom-actions", "#zoom-name"]) {
      const b = await hanna.locator(sel).boundingBox();
      if (boxesOverlap(backBox, b)) throw new Error(`Zum Foto overlaps ${sel}`);
      if (Math.abs(b.x + b.width / 2 - vpW / 2) > 3) throw new Error(`${sel} must be centred: ${JSON.stringify(b)}`);
    }
    await shot(hanna, "hanna-zoom-zurueck.jpg");
    await hanna.locator("#btn-back-photo").click();
    await hanna.waitForFunction(() => !document.getElementById("photo-stage")?.classList.contains("is-zoomed"), {
      timeout: 5000,
    });
    await assertHidden(hanna, "#zoom-card", "after Zum Foto");
    await assertHidden(hanna, "#btn-back-photo", "after Zum Foto");
    await assertCoverage(hanna, "after Zum Foto: full-bleed again");
    await hanna.locator("#btn-addressbook").waitFor({ state: "visible", timeout: 5000 });
    // Outside tap still works as the second path.
    await zoomTo(hanna, 23, "Melanie");
    await hanna.locator("#photo-stage").click({ position: { x: 60, y: 300 }, force: true });
    await hanna.waitForFunction(() => !document.getElementById("photo-stage")?.classList.contains("is-zoomed"), {
      timeout: 5000,
    });
    await assertHidden(hanna, "#btn-back-photo", "after outside tap");
    results.push("Zum Foto bottom-right unzooms (button + outside tap), name+Anrufen centred");

    // iPad orientation: photo must refit after portrait and back, and hits stay correct.
    async function cyclePad(page, land, port, tag) {
      await page.setViewportSize(land);
      await page.evaluate(() => window.__hannafonTest.resetNav());
      await assertCoverage(page, tag + " landscape-1");
      await assertNoPinch(page, tag + " landscape");
      await tapFaceCenter(page, 22);
      await page.locator("#zoom-name").waitFor({ state: "visible", timeout: 8000 });
      if ((await page.locator("#zoom-name").innerText()).trim() !== "Daniel") {
        throw new Error(tag + " landscape Daniel miss");
      }
      await unzoom(page);
      await page.setViewportSize(port);
      await page.waitForTimeout(400);
      await assertNoPinch(page, tag + " portrait");
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
    await mini.setViewportSize({ width: 1133, height: 744 });
    await mini.waitForTimeout(300);
    await assertDisplayRounding(mini, "ipad-mini 1133x744", true);
    await shotTopCorners(mini, "v108-ipad-mini-top-bar24.png");
    await mini.setViewportSize({ width: 744, height: 1133 });
    await mini.waitForTimeout(300);
    await assertDisplayRounding(mini, "ipad-mini portrait 744x1133", true);
    await mini.setViewportSize({ width: 1133, height: 744 });
    await mini.waitForTimeout(300);
    await shot(mini, "v107-ipad-mini-setup.jpg");
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
    {
      const dbg = await hanna.evaluate(() => window.__hannafonTest.audioDebug());
      if (!dbg.ringSrc.includes("sounds/ringtone.m4a")) throw new Error("ringtone element src " + dbg.ringSrc);
      if (!dbg.log.some((l) => l.ev === "ring-file-play" || l.ev === "ring-file-blocked")) {
        throw new Error("startRingtone must attempt the ringtone <audio>: " + JSON.stringify(dbg.log));
      }
      if (!dbg.ringFilePlaying || dbg.ringPaused) throw new Error("ringtone file should play after a tap " + JSON.stringify(dbg));
      if (!dbg.keepAlive) throw new Error("keep-alive should run after a tap " + JSON.stringify(dbg));
      if (dbg.toneLoop) throw new Error("chord fallback should not run while the file plays");
    }
    await hanna.evaluate(() => window.__hannafonTest.stopRingtone());
    {
      const dbg = await hanna.evaluate(() => window.__hannafonTest.audioDebug());
      if (dbg.ringFilePlaying || !dbg.ringPaused || dbg.toneLoop || dbg.ringing) {
        throw new Error("stopRingtone must stop the ringtone file and chord " + JSON.stringify(dbg));
      }
      if (!dbg.keepAlive) throw new Error("keep-alive should survive stopRingtone");
    }
    // Later call without a fresh tap: rings through the kept-alive session.
    await hanna.waitForTimeout(1500);
    await hanna.evaluate(() => window.__hannafonTest.startRingtone());
    {
      const dbg = await hanna.evaluate(() => window.__hannafonTest.audioDebug());
      if (!dbg.ringFilePlaying) throw new Error("ring without a new tap should play the file " + JSON.stringify(dbg));
    }
    await hanna.evaluate(() => window.__hannafonTest.stopRingtone());
    results.push("ringtone: file plays after tap, keep-alive runs, stop stops, re-ring without tap");

    // Host incoming path: Daniel calls Hanna; Hanna rings via startRingtone
    // (file through the kept-alive session, no tap on the incoming screen).
    {
      const callerCtx = await phoneContext(browser, iphone14);
      const caller = await callerCtx.newPage();
      await enterCode(caller);
      await identify(caller, 22);
      await caller.locator("#screen-standby").waitFor({ state: "visible", timeout: 10000 });
      await caller.waitForTimeout(800);
      await caller.locator("#btn-call-host").click();
      try {
        await hanna.locator("#screen-incoming").waitFor({ state: "visible", timeout: 15000 });
      } catch (e) {
        const dbgH = await hanna.evaluate(() => ({ screens: [...document.querySelectorAll("section")].filter((x) => !x.hidden).map((x) => x.id) }));
        const dbgC = await caller.evaluate(() => ({ screens: [...document.querySelectorAll("section")].filter((x) => !x.hidden).map((x) => x.id), status: document.getElementById("call-status")?.textContent }));
        console.log("DEBUG", JSON.stringify({ dbgH, dbgC }));
        throw e;
      }
      await hanna.waitForTimeout(500);
      // When someone calls Hanna, she still sees the family photo — not her own app icon.
      if (!(await hanna.locator("#incoming-host-wrap").isHidden())) {
        throw new Error("Hanna's incoming screen must not show her app-icon portrait");
      }
      const hostInc = await hanna.evaluate(() => window.__hannafonTest.incomingState());
      if (hostInc.showHostIcon) throw new Error("showHostIcon must be false when Hanna is called " + JSON.stringify(hostInc));
      if (await hanna.locator("#screen-photo").isHidden()) throw new Error("family photo should stay visible when Hanna is called");
      const dbg = await hanna.evaluate(() => window.__hannafonTest.audioDebug());
      if (!dbg.ringing || !dbg.log.some((l) => /^ring:/.test(l.ev))) throw new Error("host incoming must call startRingtone " + JSON.stringify(dbg));
      if (!dbg.ringFilePlaying) throw new Error("host should hear the ringtone file without a new tap " + JSON.stringify(dbg));
      await assertHidden(hanna, "#ring-hint", "ring audible, no hint");
      await hanna.locator("#btn-decline").click();
      await hanna.locator("#screen-photo").waitFor({ state: "visible", timeout: 10000 });
      const after = await hanna.evaluate(() => window.__hannafonTest.audioDebug());
      if (after.ringing || after.ringFilePlaying) throw new Error("decline must stop the ring " + JSON.stringify(after));
      if (await caller.locator("#btn-hangup").isVisible().catch(() => false)) await caller.locator("#btn-hangup").click();
      await caller.locator("#screen-standby").waitFor({ state: "visible", timeout: 15000 });
      await openDisconnectDialog(caller);
      await confirmDisconnect(caller);
      await caller.close();
      await callerCtx.close();
      results.push("host incoming rings (file), decline stops it");
    }

    // V1.08 missed calls for Hanna: button bottom left only while calls wait,
    // list like the Adressbuch, cleared when she leaves it, persisted on the worker.
    {
      const missedOf = (page) => page.evaluate(() => window.__hannafonTest.missedRaw());
      const btnVisible = (page) => page.locator("#btn-missed").isVisible().catch(() => false);
      const waitMissed = async (pred, why) => {
        const t0 = Date.now();
        while (Date.now() - t0 < 10000) {
          const m = await missedOf(hanna);
          if (pred(m)) return m;
          await hanna.waitForTimeout(150);
        }
        throw new Error("missed: " + why + " " + JSON.stringify(await missedOf(hanna)));
      };
      await hanna.evaluate(() => window.__hannafonTest.clearMissedAll());
      await hanna.waitForTimeout(400);
      if (await btnVisible(hanna)) throw new Error("missed button must be hidden with no missed calls");

      // Unit: German times in Europe/Berlin.
      const when = await hanna.evaluate(() => {
        const f = window.__hannafonTest.missedWhen;
        const now = Date.UTC(2026, 10, 12, 13, 30); // 14:30 Berlin
        return [f(now - 20000, now), f(now - 60000, now), f(now - 5 * 60000, now), f(now - 3 * 3600000, now), f(now - 24 * 3600000, now)];
      });
      if (JSON.stringify(when) !== JSON.stringify(["gerade eben", "vor 1 Minute", "vor 5 Minuten", "heute 11:30", "gestern 14:30"])) {
        throw new Error("missedWhen: " + JSON.stringify(when));
      }

      const callerCtx = await phoneContext(browser, iphone14);
      const caller = await callerCtx.newPage();
      await enterCode(caller);
      await identify(caller, 22);
      await caller.locator("#screen-standby").waitFor({ state: "visible", timeout: 10000 });
      await caller.waitForTimeout(800);
      const ringHanna = async () => {
        await caller.locator("#btn-call-host").click();
        await hanna.locator("#screen-incoming").waitFor({ state: "visible", timeout: 15000 });
        await hanna.waitForTimeout(400);
      };
      const callerHangsUp = async () => {
        await caller.locator("#btn-hangup").click();
        await caller.locator("#screen-standby").waitFor({ state: "visible", timeout: 10000 });
        await hanna.locator("#screen-incoming").waitFor({ state: "hidden", timeout: 10000 });
      };

      // a) Accepted call: not missed.
      await ringHanna();
      await hanna.locator("#btn-accept").click();
      await hanna.locator("#screen-call").waitFor({ state: "visible", timeout: 10000 });
      await caller.waitForTimeout(1200);
      await caller.locator("#btn-hangup").click();
      await hanna.locator("#screen-photo").waitFor({ state: "visible", timeout: 10000 });
      await caller.locator("#screen-standby").waitFor({ state: "visible", timeout: 10000 });
      await hanna.waitForTimeout(600);
      if ((await missedOf(hanna)).length || (await btnVisible(hanna))) throw new Error("accepted call must not be missed");

      // b) Two unanswered rings from Daniel: one row, count 2, badge 1.
      await ringHanna();
      await callerHangsUp();
      await waitMissed((m) => m.length === 1 && m[0].from === 22 && m[0].count === 1, "first ring");
      await ringHanna();
      await callerHangsUp();
      const m2 = await waitMissed((m) => m.length === 1 && m[0].count === 2, "second ring");
      await hanna.locator("#btn-missed").waitFor({ state: "visible", timeout: 5000 });
      if ((await hanna.locator("#missed-badge").innerText()).trim() !== "1") throw new Error("badge should count people (1)");
      const mb = await hanna.locator("#btn-missed").boundingBox();
      const ab = await hanna.locator("#btn-addressbook").boundingBox();
      const vp = hanna.viewportSize();
      if (!mb || Math.abs(mb.x - 22) > 2 || mb.y + mb.height < vp.height - 120 || Math.abs(mb.height - ab.height) > 2) {
        throw new Error("missed button must sit bottom-left, same size as Adressbuch " + JSON.stringify({ mb, ab }));
      }
      const iconColor = await hanna.evaluate(() => getComputedStyle(document.querySelector("#btn-missed .icon-missed")).color);
      if (iconColor !== "rgb(232, 113, 26)") throw new Error("missed icon should be orange: " + iconColor);
      if (await caller.locator("#btn-missed").isVisible().catch(() => false)) throw new Error("caller must not see the missed button");
      await shot(hanna, "v108-missed-button.jpg");

      // c) Persisted on the worker: drop the local cache, reconnect, it comes back.
      await hanna.evaluate(() => window.__hannafonTest.resyncMissed());
      await waitMissed((m) => m.length === 1 && m[0].from === 22 && m[0].count === 2, "resync from worker");
      if (!(m2[0].last > Date.now() - 120000)) throw new Error("missed timestamp " + JSON.stringify(m2));

      // d) Faces 7, 12 and Hanna herself are never listed.
      const filtered = await hanna.evaluate(() => {
        const now = Date.now();
        window.__hannafonTest.injectMissed([
          { from: 7, count: 1, last: now }, { from: 12, count: 1, last: now }, { from: 10, count: 1, last: now },
          { from: 22, count: 2, last: now - 300000 }, { from: 23, count: 1, last: now - 60000 },
        ]);
        return window.__hannafonTest.missed().map((m) => m.from);
      });
      if (JSON.stringify(filtered) !== "[23,22]") throw new Error("missed filter/order: " + JSON.stringify(filtered));
      await hanna.evaluate(() => window.__hannafonTest.resyncMissed());
      await waitMissed((m) => m.length === 1 && m[0].from === 22, "back to worker list");

      // e) The list looks like the Adressbuch; only Daniel, "2× angerufen".
      await hanna.locator("#btn-missed").waitFor({ state: "visible", timeout: 5000 });
      await hanna.locator("#btn-missed").click();
      await hanna.locator("#screen-addressbook").waitFor({ state: "visible", timeout: 5000 });
      const list = await hanna.evaluate(() => ({
        title: document.querySelector("#screen-addressbook .ab-title").textContent,
        rows: [...document.querySelectorAll("#ab-list .ab-row")].map((r) => ({
          nr: Number(r.dataset.nr),
          meta: r.querySelector(".ab-meta").textContent,
          metaVisible: !r.querySelector(".ab-meta").hidden,
          avatar: r.querySelector(".ab-avatar").getBoundingClientRect().width,
          call: !!r.querySelector(".ab-call"),
        })),
        empty: !document.getElementById("ab-empty").hidden,
        cols: getComputedStyle(document.getElementById("ab-list")).gridTemplateColumns.split(" ").length,
      }));
      if (list.title !== "Verpasste Anrufe" || list.rows.length !== 1 || list.rows[0].nr !== 22 || !/^2 Anrufe · (gerade eben|vor \d+ Minuten?)$/.test(list.rows[0].meta) ||
          !list.rows[0].metaVisible || list.rows[0].avatar !== 50 || !list.rows[0].call || list.empty || list.cols !== 3) {
        throw new Error("missed list wrong " + JSON.stringify(list));
      }
      await assertCornerRight(hanna, "#btn-ab-close", "missed list Zum Foto");
      if (await btnVisible(hanna)) throw new Error("missed button hidden while the list is open");
      // Preview without real photos: plain letter avatars.
      await hanna.evaluate(() => {
        for (const a of document.querySelectorAll("#ab-list .ab-avatar")) { a.style.backgroundImage = "none"; a.classList.remove("has-photo"); }
      });
      await shot(hanna, "v108-missed-list.jpg");

      // f) Leaving with "Zum Foto" clears them (also on the worker): button gone.
      await hanna.locator("#btn-ab-close").click();
      await hanna.locator("#screen-addressbook").waitFor({ state: "hidden", timeout: 5000 });
      if (await btnVisible(hanna)) throw new Error("missed button must be gone after leaving the list");
      await hanna.waitForTimeout(500);
      await hanna.evaluate(() => window.__hannafonTest.resyncMissed());
      await hanna.waitForTimeout(1500);
      if ((await missedOf(hanna)).length || (await btnVisible(hanna))) throw new Error("cleared missed calls came back from the worker");

      // g) Adressbuch unchanged after the missed view.
      await hanna.locator("#btn-addressbook").click();
      await hanna.locator("#screen-addressbook").waitFor({ state: "visible", timeout: 5000 });
      const book = await hanna.evaluate(() => ({
        title: document.querySelector("#screen-addressbook .ab-title").textContent,
        n: document.querySelectorAll("#ab-list .ab-row").length,
        metas: [...document.querySelectorAll("#ab-list .ab-meta")].filter((m) => !m.hidden).length,
        empty: !document.getElementById("ab-empty").hidden,
      }));
      if (book.title !== "Adressbuch" || book.n !== 20 || book.metas || book.empty) throw new Error("Adressbuch changed " + JSON.stringify(book));
      await hanna.locator("#btn-ab-close").click();
      await hanna.locator("#screen-addressbook").waitFor({ state: "hidden", timeout: 5000 });

      // h) Call back from the list: Hanna calls Daniel, he answers; list gone.
      await ringHanna();
      await callerHangsUp();
      await waitMissed((m) => m.length === 1, "ring for callback");
      await hanna.locator("#btn-missed").click();
      await hanna.locator("#screen-addressbook").waitFor({ state: "visible", timeout: 5000 });
      await hanna.locator('#ab-list .ab-row[data-nr="22"] .ab-call').click();
      await hanna.locator("#screen-call").waitFor({ state: "visible", timeout: 8000 });
      await caller.locator("#btn-accept").waitFor({ state: "visible", timeout: 15000 });
      await caller.locator("#btn-accept").click();
      await caller.locator("#screen-call").waitFor({ state: "visible", timeout: 10000 });
      await hanna.waitForTimeout(1200);
      await hanna.locator("#btn-hangup").click();
      await hanna.locator("#screen-photo").waitFor({ state: "visible", timeout: 10000 });
      await caller.locator("#screen-standby").waitFor({ state: "visible", timeout: 10000 });
      await hanna.waitForTimeout(500);
      if ((await missedOf(hanna)).length || (await btnVisible(hanna))) throw new Error("callback must leave no missed entry");

      // i) Empty state (only reachable if the list empties while open).
      await hanna.evaluate(() => window.__hannafonTest.openMissed());
      await hanna.locator("#ab-empty").waitFor({ state: "visible", timeout: 3000 });
      if ((await hanna.locator("#ab-empty").innerText()).trim() !== "Keine verpassten Anrufe") throw new Error("empty text");
      await hanna.locator("#btn-ab-close").click();
      await hanna.locator("#screen-addressbook").waitFor({ state: "hidden", timeout: 5000 });
      if (await btnVisible(hanna)) throw new Error("no button after empty list");

      // j) Caller's device goes away while ringing: missed.
      await ringHanna();
      await caller.close();
      await callerCtx.close();
      await waitMissed((m) => m.length === 1 && m[0].from === 22, "caller vanished while ringing");
      await hanna.locator("#screen-incoming").waitFor({ state: "hidden", timeout: 15000 }).catch(() => {});
      await hanna.evaluate(() => window.__hannafonTest.clearMissedAll());
      await hanna.waitForTimeout(400);
      if (await hanna.locator("#screen-incoming").isVisible().catch(() => false)) {
        await hanna.locator("#btn-decline").click();
      }
      await hanna.locator("#screen-photo").waitFor({ state: "visible", timeout: 10000 });
      results.push("V1.08 missed calls: hidden when none, bottom-left orange + badge, accepted not missed, count per person, worker-persisted, 7/12/Hanna filtered, list like Adressbuch, Zum Foto clears (worker too), callback, empty state, caller-vanished counts");
    }

    // Hidden reset: no visible label, but holding the top-right corner 5 s opens the sheet.
    {
      const wm = hanna.locator("#wordmark");
      const txt = (await wm.innerText()).trim();
      if (txt) throw new Error("wordmark must have no visible text: " + txt);
      const box = await wm.boundingBox();
      const vp = hanna.viewportSize();
      if (!box || box.width < 60 || box.height < 44 || box.x + box.width < vp.width - 40 || box.y > 30) {
        throw new Error("reset hit area must stay in the top-right corner " + JSON.stringify(box));
      }
      const op = await wm.evaluate((el) => getComputedStyle(el).opacity);
      if (Number(op) !== 0) throw new Error("reset hit area must be invisible");
      await hanna.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await hanna.mouse.down();
      await hanna.waitForTimeout(5300);
      await hanna.mouse.up();
      await hanna.locator("#reset-sheet").waitFor({ state: "visible", timeout: 2000 });
      await hanna.locator("#btn-reset-cancel").click();
      await hanna.locator("#reset-sheet").waitFor({ state: "hidden", timeout: 2000 });
      // With the address book open, the hold target is gone (safety).
      await hanna.locator("#btn-addressbook").click();
      await hanna.locator("#screen-addressbook").waitFor({ state: "visible", timeout: 5000 });
      await assertHidden(hanna, "#wordmark", "address book open");
      await hanna.locator("#btn-ab-close").click();
      await hanna.locator("#screen-addressbook").waitFor({ state: "hidden", timeout: 5000 });
      results.push("hidden 5 s reset still works on invisible corner");
    }

    // V1.06 bug fix: Hanna calls, the receiver opens the app from the push.
    {
      const rxCtx = await phoneContext(browser, iphone14);
      const rx = await rxCtx.newPage();
      await enterCode(rx);
      await identify(rx, 22);
      await rx.locator("#screen-standby").waitFor({ state: "visible", timeout: 10000 });
      await rx.waitForTimeout(800);
      const hannaCallsDaniel = async () => {
        await tapPerson(hanna, 22);
        await hanna.locator("#btn-call").waitFor({ state: "visible", timeout: 8000 });
        await hanna.waitForTimeout(600);
        await hanna.locator("#btn-call").click();
        await hanna.locator("#screen-call").waitFor({ state: "visible", timeout: 10000 });
        await hanna.waitForTimeout(1200); // offer + ICE sent while the phone is "away"
      };
      const hannaHangsUp = async () => {
        await hanna.locator("#btn-hangup").click();
        await hanna.locator("#screen-photo").waitFor({ state: "visible", timeout: 10000 });
      };

      // a) Cold start from the notification: the phone's socket was gone when
      //    Hanna's offer went out; the app opens at ?incoming=10.
      await rx.evaluate(() => window.__hannafonTest.dropSocket());
      await hannaCallsDaniel();
      await rx.goto(APP + "?incoming=10", { waitUntil: "load" });
      await rx.locator("#screen-incoming").waitFor({ state: "visible", timeout: 12000 });
      await rx.locator("#btn-accept").waitFor({ state: "visible", timeout: 2000 });
      if ((await rx.locator("#incoming-title").innerText()).trim() !== "Hanna ruft an") throw new Error("incoming title after push");
      let st = await rx.evaluate(() => window.__hannafonTest.incomingState());
      if (!st.hasOffer || st.pendingFrom !== 10) throw new Error("replayed offer missing " + JSON.stringify(st));
      const ring = await rx.evaluate(() => window.__hannafonTest.audioDebug());
      if (!ring.ringing) throw new Error("ringtone should start on the replayed incoming screen");
      await rx.locator("#btn-accept").click();
      await waitVideo(hanna);
      await waitVideo(rx);
      await hannaHangsUp();
      await rx.locator("#screen-standby").waitFor({ state: "visible", timeout: 10000 });
      results.push("push cold start: replayed offer, Annehmen, video connected (ICE " + st.pendingIce + ")");

      // b) App in memory, socket killed by iOS; notification tap -> SW message.
      await rx.waitForTimeout(800);
      await rx.evaluate(() => window.__hannafonTest.dropSocket());
      await hannaCallsDaniel();
      await rx.evaluate(() => { window.__hannafonTest.restoreSocket(); });
      await rx.evaluate(() => window.__hannafonTest.expectIncoming(10));
      await rx.locator("#screen-incoming").waitFor({ state: "visible", timeout: 12000 });
      await rx.locator("#btn-accept").click();
      await waitVideo(hanna);
      await waitVideo(rx);
      await hannaHangsUp();
      await rx.locator("#screen-standby").waitFor({ state: "visible", timeout: 10000 });
      results.push("push warm start: socket revived, Annehmen, connected");

      // c) Offer never reached the page and Daniel taps "Hanna anrufen":
      //    no reverse call to Hanna; Daniel gets her ringing offer instead.
      await rx.waitForTimeout(800);
      await rx.evaluate(() => window.__hannafonTest.muteCalls(true));
      await hannaCallsDaniel();
      await rx.evaluate(() => window.__hannafonTest.muteCalls(false));
      await rx.locator("#btn-call-host").click();
      await rx.locator("#screen-incoming").waitFor({ state: "visible", timeout: 10000 });
      const hs = await hanna.evaluate(() => window.__hannafonTest.incomingState());
      if (hs.screen !== "call" || !hs.outgoing || hs.pendingFrom) {
        throw new Error("Hanna must keep calling, no reverse incoming " + JSON.stringify(hs));
      }
      if (await hanna.locator("#screen-incoming").isVisible()) throw new Error("Hanna got a reverse call");
      // And with the offer showing, Anrufen-path answers (startCall -> accept).
      await rx.locator("#btn-accept").click();
      await waitVideo(hanna);
      await waitVideo(rx);
      await hannaHangsUp();
      await rx.locator("#screen-standby").waitFor({ state: "visible", timeout: 10000 });
      results.push("callback while Hanna rings: no reverse call, answered instead");

      // d) Hanna already hung up: opening from the old notification shows no stale call.
      await rx.waitForTimeout(800);
      await rx.evaluate(() => window.__hannafonTest.dropSocket());
      await hannaCallsDaniel();
      await hannaHangsUp();
      await rx.goto(APP + "?incoming=10", { waitUntil: "load" });
      await rx.locator("#screen-standby").waitFor({ state: "visible", timeout: 12000 });
      await rx.waitForTimeout(2500);
      await assertHidden(rx, "#screen-incoming", "stale offer after hangup");
      await rx.waitForFunction(() => !document.getElementById("app").classList.contains("is-expecting-call"), null, { timeout: 12000 });
      await assertHidden(rx, "#screen-incoming", "stale offer after timeout");
      results.push("expired call: no stale incoming screen");

      await openDisconnectDialog(rx);
      await confirmDisconnect(rx);
      await rx.close();
      await rxCtx.close();
    }

    // V1.05 landscape full-bleed: iPad 10 and iPad mini, with and without the
    // iOS standalone "one status bar short" bug, all heads hittable at default fit.
    {
      const unit = await hanna.evaluate(() => {
        const f = window.__hannafonTest.computeIosBottomGap;
        return [
          f({ standalone: true, screenW: 820, screenH: 1180, innerW: 1180, innerH: 796, safeTop: 24 }),
          f({ standalone: true, screenW: 820, screenH: 1180, innerW: 1180, innerH: 796, safeTop: 0 }),
          f({ standalone: false, screenW: 820, screenH: 1180, innerW: 1180, innerH: 796, safeTop: 24 }),
          f({ standalone: true, screenW: 820, screenH: 1180, innerW: 678, innerH: 796, safeTop: 24 }),
          f({ standalone: true, screenW: 744, screenH: 1133, innerW: 1133, innerH: 720, safeTop: 24 }),
          f({ standalone: true, screenW: 402, screenH: 874, innerW: 402, innerH: 812, safeTop: 62 }),
          f({ standalone: true, screenW: 820, screenH: 1180, innerW: 1180, innerH: 820, safeTop: 24 }),
        ];
      });
      if (JSON.stringify(unit) !== JSON.stringify([24, 0, 0, 0, 24, 62, 0])) {
        throw new Error("computeIosBottomGap: " + JSON.stringify(unit));
      }
      results.push("iOS bottom-gap detection unit cases");
      const pad = [
        [{ width: 1180, height: 820 }, null, "ipad-10 1180x820"],
        [{ width: 1180, height: 796 }, { standalone: true, screenW: 820, screenH: 1180, safeTop: 0, expectGap: 0 }, "ipad-10 opaque bar 1180x796"],
        [{ width: 1180, height: 796 }, { standalone: true, screenW: 820, screenH: 1180, safeTop: 24, expectGap: 24 }, "ipad-10 iOS-gap 1180x796+24"],
      ];
      for (const [vp, sim, tag] of pad) {
        await assertLandscapeFullBleed(hanna, vp, tag, sim);
      }
      await shot(hanna, "v105-ipad10-iosgap.jpg");
      await assertLandscapeFullBleed(hanna, { width: 1180, height: 820 }, "ipad-10 reset", null);
      await assertTopClean(hanna, "hanna after full-bleed checks");
      results.push("ipad 10 landscape full-bleed, all heads hittable (820 / 796 / 796+gap)");

      const fbCtx = await browser.newContext({
        viewport: { width: 1133, height: 744 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      });
      await fbCtx.grantPermissions(["camera", "microphone", "notifications"], { origin: ORIGIN });
      const fb = await fbCtx.newPage();
      await enterCode(fb);
      await fb.locator("#setup-title").waitFor({ state: "visible", timeout: 20000 });
      await waitPhotoReady(fb);
      for (const [vp, sim, tag] of [
        [{ width: 1133, height: 744 }, null, "ipad-mini 1133x744"],
        [{ width: 1133, height: 720 }, { standalone: true, screenW: 744, screenH: 1133, safeTop: 0, expectGap: 0 }, "ipad-mini opaque bar 1133x720"],
        [{ width: 1133, height: 720 }, { standalone: true, screenW: 744, screenH: 1133, safeTop: 24, expectGap: 24 }, "ipad-mini iOS-gap 1133x720+24"],
      ]) {
        await assertLandscapeFullBleed(fb, vp, tag, sim);
      }
      await shot(fb, "v105-ipad-mini-iosgap.jpg");
      await fb.close();
      await fbCtx.close();
      results.push("ipad mini landscape full-bleed, all heads hittable (744 / 720 / 720+gap)");
    }

    // V1.05 camera/microphone: one early prompt on a tap, tracks stopped, no repeats.
    {
      // a) Fresh device, permission not decided: "Das bin ich" primes exactly once.
      const aCtx = await mediaContext(browser, { permState: "prompt" });
      const a = await aCtx.newPage();
      await enterCode(a);
      await a.locator("#setup-title").waitFor({ state: "visible", timeout: 20000 });
      await a.waitForTimeout(600);
      let g = await gumInfo(a);
      if (g.calls !== 0) throw new Error("no camera request before any tap, got " + g.calls);
      await identify(a, 22);
      await a.locator("#screen-standby").waitFor({ state: "visible", timeout: 8000 });
      await a.waitForTimeout(800);
      g = await gumInfo(a);
      if (g.calls !== 1 || g.live !== 0) throw new Error("setup prime: " + JSON.stringify(g));
      await a.locator("#standby-hello").click();
      await a.waitForTimeout(400);
      g = await gumInfo(a);
      if (g.calls !== 1) throw new Error("prime must run once per launch: " + JSON.stringify(g));
      // b) Already set up, new launch: nothing on load, one prime on the first tap.
      await a.reload({ waitUntil: "load" });
      await a.locator("#screen-standby").waitFor({ state: "visible", timeout: 20000 });
      await a.waitForTimeout(800);
      g = await gumInfo(a);
      if (g.calls !== 0) throw new Error("no camera request on launch without a tap: " + JSON.stringify(g));
      await a.locator("#standby-hello").click();
      await a.waitForTimeout(800);
      g = await gumInfo(a);
      if (g.calls !== 1 || g.live !== 0) throw new Error("first-tap prime: " + JSON.stringify(g));
      await a.locator("#standby-sub").click();
      await a.waitForTimeout(300);
      if ((await gumInfo(a)).calls !== 1) throw new Error("second tap must not prompt again");
      await openDisconnectDialog(a);
      await confirmDisconnect(a);
      await a.close();
      await aCtx.close();
      results.push("camera/mic primed once on tap (setup + first tap), tracks stopped");

      // c) Already granted: no extra request at all.
      const cCtx = await mediaContext(browser, { grant: true, permState: "granted" });
      const c = await cCtx.newPage();
      await enterCode(c);
      await identify(c, 22);
      await c.locator("#screen-standby").waitFor({ state: "visible", timeout: 8000 });
      await c.locator("#standby-hello").click();
      await c.waitForTimeout(600);
      g = await gumInfo(c);
      if (g.calls !== 0) throw new Error("granted: no prime expected: " + JSON.stringify(g));
      await openDisconnectDialog(c);
      await confirmDisconnect(c);
      await c.close();
      await cCtx.close();
      results.push("camera/mic granted: no prime");

      // d) Denied: setup still works, a call shows the existing message.
      const dCtx = await mediaContext(browser, { permState: "prompt", denyGum: true });
      const d = await dCtx.newPage();
      await enterCode(d);
      await identify(d, 22);
      await d.locator("#screen-standby").waitFor({ state: "visible", timeout: 8000 });
      await d.locator("#btn-call-host").click();
      await d.locator("#screen-call").waitFor({ state: "visible", timeout: 8000 });
      await d.waitForFunction(
        () => document.getElementById("call-status")?.textContent.includes("Kamera oder Mikrofon nicht verfügbar"),
        null,
        { timeout: 8000 }
      );
      await d.locator("#btn-hangup").click();
      await d.locator("#screen-standby").waitFor({ state: "visible", timeout: 8000 });
      await openDisconnectDialog(d);
      await confirmDisconnect(d);
      await d.close();
      await dCtx.close();
      results.push("camera/mic denied handled");
    }

    // Structural push endpoint (no delivery assertion locally)
    const health = await fetch(HEALTH).then((r) => r.json());
    if (!health.ok || health.version !== "V1.09") throw new Error("health/version");
    results.push("worker health V1.09");

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
