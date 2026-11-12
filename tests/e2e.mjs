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

// V1.07: iPad display rounding, TOP corners only (the hardware already rounds the
// bottom): body and #app top radii ~18-26px, bottom square in CSS; outside the top
// curve is black (not cream), also with the standalone black strip shown; hit-testing
// there misses the app; the greeting stays clear of the curve. iPhone: no rounding.
async function assertDisplayRounding(page, label, expectTablet) {
  const read = () => page.evaluate(() => {
    const app = document.getElementById("app");
    const cs = getComputedStyle(app);
    const bs = getComputedStyle(document.body);
    const r = app.getBoundingClientRect();
    const id = (el) => (el ? el.id || el.tagName : null);
    const g = document.getElementById("greeting");
    const gVisible = g && getComputedStyle(g).display !== "none" && !g.hidden;
    const gr = gVisible ? [...g.querySelectorAll("p")].map((p) => p.getBoundingClientRect()).filter((b) => b.width > 0) : [];
    return {
      tablet: document.documentElement.classList.contains("is-tablet"),
      tl: parseFloat(cs.borderTopLeftRadius) || 0,
      tr: parseFloat(cs.borderTopRightRadius) || 0,
      bl: parseFloat(cs.borderBottomLeftRadius) || 0,
      br: parseFloat(cs.borderBottomRightRadius) || 0,
      bodyTl: parseFloat(bs.borderTopLeftRadius) || 0,
      bodyBl: parseFloat(bs.borderBottomLeftRadius) || 0,
      clip: cs.clipPath,
      bodyClip: bs.clipPath,
      W: innerWidth,
      H: Math.min(innerHeight, r.bottom),
      hitTL: id(document.elementFromPoint(1, 1)),
      hitTR: id(document.elementFromPoint(innerWidth - 1, 1)),
      hitBL: id(document.elementFromPoint(1, Math.min(innerHeight, r.bottom) - 1)),
      hitBR: id(document.elementFromPoint(innerWidth - 1, Math.min(innerHeight, r.bottom) - 1)),
      greeting: gr.map((b) => ({ top: b.top, right: b.right, left: b.left, bottom: b.bottom })),
    };
  });
  const info = await read();
  if (!expectTablet) {
    if (info.tablet || info.tl || info.tr || info.bl || info.br || info.bodyTl) {
      throw new Error(label + ": no simulated rounding expected " + JSON.stringify(info));
    }
    return info;
  }
  const R = info.tl;
  if (!info.tablet || R < 18 || R > 26 || info.tr !== R || info.bodyTl !== R || info.bl || info.br || info.bodyBl ||
      !/round/.test(info.clip) || !/round/.test(info.bodyClip)) {
    throw new Error(label + ": iPad top-only rounding wrong " + JSON.stringify(info));
  }
  if (!["HTML", "BODY"].includes(info.hitTL) || !["HTML", "BODY"].includes(info.hitTR)) {
    throw new Error(label + ": top corners outside the curve must not hit the app " + JSON.stringify(info));
  }
  if (["HTML", "BODY"].includes(info.hitBL) || ["HTML", "BODY"].includes(info.hitBR)) {
    throw new Error(label + ": bottom corners must stay square (no software cut-out) " + JSON.stringify(info));
  }
  // Greeting text clear of the top-right curve (with a few px to spare).
  for (const b of info.greeting) {
    const cx = info.W - R, cy = R;
    if (b.right > cx && b.top < cy && Math.hypot(b.right - cx, b.top - cy) > R - 4) {
      throw new Error(label + ": greeting touches the rounded corner " + JSON.stringify(b));
    }
  }
  // Pixels: top corners black (bezel), never cream; in a tab and with the
  // standalone black strip (which must not square the corners off into cream).
  const { default: sharp } = await import("sharp");
  const pixels = async (tag) => {
    const buf = await page.screenshot({ type: "png" });
    const img = sharp(buf);
    const meta = await img.metadata();
    const { data, info: ri } = await img.raw().toBuffer({ resolveWithObject: true });
    const scale = meta.width / page.viewportSize().width;
    const px = (x, y) => {
      const i = (Math.round(y * scale) * ri.width + Math.round(x * scale)) * ri.channels;
      return [data[i], data[i + 1], data[i + 2]];
    };
    const W = page.viewportSize().width;
    // Diagonal points just outside the arc (corner distance > R).
    const d = Math.max(1, Math.floor(R * (1 - Math.SQRT1_2)) - 2);
    for (const [x, y] of [[0.5, 0.5], [d, d], [1, 8], [W - 1, 0.5], [W - 1 - d, d], [W - 2, 8]]) {
      const [r, g, b] = px(x, y);
      if (r > 40 || g > 40 || b > 40) throw new Error(`${label} ${tag}: top corner pixel (${x},${y}) not black: ${[r, g, b]}`);
    }
  };
  await pixels("tab");
  await page.evaluate(() => { window.__HANNAFON_VIEWPORT_TEST__ = { standalone: true }; window.__hannafonTest.updateViewportFix(); });
  try {
    const sa = await read();
    if (!sa.tablet || sa.bodyTl !== R) throw new Error(label + ": standalone lost the rounding " + JSON.stringify(sa));
    await pixels("standalone");
  } finally {
    await page.evaluate(() => { delete window.__HANNAFON_VIEWPORT_TEST__; window.__hannafonTest.updateViewportFix(); });
  }
  return info;
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
    // V1.07: not inside the simulated rounded top display corners.
    const R = await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById("app")).borderTopLeftRadius) || 0);
    for (const cx of [R, geo.innerW - R]) {
      const cy = R;
      if (R && (pt.x < R || pt.x > geo.innerW - R) && pt.y < cy && Math.hypot(pt.x - cx, pt.y - cy) > R - 4) {
        throw new Error(`${tag}: head #${p.nr} sits in a rounded corner`);
      }
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
    for (const sel of ["#btn-call", "#zoom-name"]) {
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
    if (!health.ok || health.version !== "V1.07") throw new Error("health/version");
    results.push("worker health V1.07");

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
