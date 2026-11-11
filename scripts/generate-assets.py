#!/usr/bin/env python3
"""Generate Hannafon family photo derivatives into a private directory.

Reads the source photo, face coordinates, and names from paths outside the
public app repo. Output (photo, masks, crops, people.json with names) must
never be committed. Served only by the Worker after a valid family code.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]  # /workspace/videotelefon
PRIVATE = Path(os.environ.get("HANNAFON_PRIVATE", ROOT / "private"))
PHOTO = Path(
    os.environ.get(
        "HANNAFON_PHOTO",
        "/home/box/sand-data/agents/d645c60c-5e43-4053-a20e-3c6d10061db7/attachments/0e510a6a1ad21f4df1f59e6f8112544b3128b8855abb8de0fcb579dd85e18c2e.jpg",
    )
)
FACES_PATH = Path(os.environ.get("HANNAFON_FACES", PRIVATE / "faces.json"))
NAMES_PATH = Path(os.environ.get("HANNAFON_NAMES", PRIVATE / "names.json"))

ORIG_W, ORIG_H = 7360, 4912
# Working resolution for rembg / masks (half of original).
WORK_W, WORK_H = 3680, 2456
# Served photo size (quarter of original): sharp enough for iPad 1180 CSS @2x.
OUT_W, OUT_H = 1840, 1228
CREAM = np.array([246, 239, 227], dtype=np.float32)
FEATHER_WORK = 110  # soft v3-like falloff at zoomed display size


def load_inputs():
    if not PHOTO.exists():
        # fallback to the already-resized local copy from design work
        alt = ROOT / "designs/hannafon/shared/family-photo.jpg"
        if not alt.exists():
            sys.exit(f"source photo not found: {PHOTO}")
        photo_path = alt
    else:
        photo_path = PHOTO
    faces = json.loads(FACES_PATH.read_text())
    names_cfg = json.loads(NAMES_PATH.read_text()) if NAMES_PATH.exists() else {}
    return photo_path, faces, names_cfg


def person_meta(faces, names_cfg):
    host = int(names_cfg.get("host", -1))
    callable_nrs = {int(n) for n in names_cfg.get("callable", [])}
    untappable = {int(n) for n in names_cfg.get("untappable", [])}
    name_map = {int(k): v for k, v in names_cfg.get("names", {}).items()}
    people = []
    for f in faces:
        nr = int(f["nr"])
        name = name_map.get(nr, f"Person {nr}")
        tappable = nr not in untappable
        people.append(
            {
                "nr": nr,
                "name": name,
                "cx": float(f["cx"]),
                "cy": float(f["cy"]),
                "r": float(f["r"]),
                "isHost": nr == host,
                "callable": (nr in callable_nrs) and tappable,
                "tappable": tappable,
            }
        )
    people.sort(key=lambda p: p["nr"])
    return people, host


def is_sitting(p):
    # Front-row sitters sit lower in the frame (higher cy in original coords).
    return p["cy"] > 2280


def crop_box(p, W, H, S):
    cx, cy, r = p["cx"] * S, p["cy"] * S, p["r"] * S
    side = 3.3 * r
    down = (7.2 if is_sitting(p) else 10.2) * r
    up = 2.4 * r
    L = max(0, int(cx - side))
    R = min(W, int(cx + side))
    T = max(0, int(cy - up))
    B = min(H, int(cy + down))
    return cx, cy, r, (L, T, R, B)


def ellipse_mask(h, w, cx, cy, rx, ry):
    m = np.zeros((h, w), np.uint8)
    cv2.ellipse(m, (int(cx), int(cy)), (max(1, int(rx)), max(1, int(ry))), 0, 0, 360, 255, -1)
    return m


def isolate(alpha, box, target, all_people, S):
    """Keep the target person: component on the head, soft body prior, soft Voronoi vs neighbors."""
    L, T, R, B = box
    h, w = alpha.shape
    hx, hy, hr = target["cx"] * S - L, target["cy"] * S - T, target["r"] * S

    binary = (alpha > 80).astype(np.uint8) * 255
    nlab, labels, stats, _ = cv2.connectedComponentsWithStats(binary, 8)
    head = ellipse_mask(h, w, hx, hy, hr * 1.25, hr * 1.45)
    keep = np.zeros((h, w), np.uint8)
    for i in range(1, nlab):
        comp = labels == i
        if int((comp & (head > 0)).sum()) > 20:
            keep[comp] = 255
    if keep.max() == 0:
        keep = binary

    prior = np.zeros((h, w), np.uint8)
    prior = cv2.bitwise_or(prior, ellipse_mask(h, w, hx, hy, hr * 1.45, hr * 1.65))
    if is_sitting(target):
        body_cx, body_cy = hx, hy + hr * 2.15
        body_rx, body_ry = hr * 2.45, hr * 5.2
    else:
        body_cx, body_cy = hx, hy + hr * 3.05
        body_rx, body_ry = hr * 2.15, hr * 6.8
    prior = cv2.bitwise_or(prior, ellipse_mask(h, w, body_cx, body_cy, body_rx, body_ry))
    x1, x2 = int(max(0, hx - body_rx * 1.0)), int(min(w, hx + body_rx * 1.0))
    y1, y2 = int(max(0, hy + hr * 0.6)), int(min(h, hy + hr * 2.4))
    cv2.rectangle(prior, (x1, y1), (x2, y2), 255, -1)
    prior = cv2.GaussianBlur(prior, (0, 0), max(2.0, hr * 0.4))

    masked = keep.astype(np.float32) * (prior.astype(np.float32) / 255.0)

    # Soft Voronoi: neighbors fade out instead of a hard diagonal cut.
    # Other face *cores* are forced out so they never stay half-sharp.
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    d_head = np.hypot((xx - hx) / max(1.0, hr * 1.25), (yy - hy) / max(1.0, hr * 1.5))
    d_body = np.hypot((xx - body_cx) / max(1.0, body_rx), (yy - body_cy) / max(1.0, body_ry))
    d_tgt = np.minimum(d_head, d_body)

    d_oth = np.full((h, w), 8.0, np.float32)
    d_oth_head = np.full((h, w), 8.0, np.float32)
    for p in all_people:
        if p["nr"] == target["nr"]:
            continue
        ox, oy, o_r = p["cx"] * S - L, p["cy"] * S - T, p["r"] * S
        if ox < -3 * o_r or oy < -3 * o_r or ox > w + 3 * o_r or oy > h + 3 * o_r:
            continue
        dh = np.hypot((xx - ox) / max(1.0, o_r * 1.2), (yy - oy) / max(1.0, o_r * 1.4))
        d_oth_head = np.minimum(d_oth_head, dh)
        if is_sitting(p):
            oby, obrx, obry = oy + o_r * 2.0, o_r * 2.15, o_r * 4.8
        else:
            oby, obrx, obry = oy + o_r * 2.8, o_r * 1.9, o_r * 6.4
        db = np.hypot((xx - ox) / max(1.0, obrx), (yy - oby) / max(1.0, obry))
        d_oth = np.minimum(d_oth, np.minimum(dh, db))

    w_v = np.clip((d_oth - d_tgt + 0.45) / 1.05, 0, 1)
    w_v *= np.clip((d_oth_head - 0.8) / 0.55, 0, 1)
    return (masked * w_v).astype(np.uint8)


def oval_fallback(box, target, S):
    L, T, R, B = box
    h, w = B - T, R - L
    hx, hy, hr = target["cx"] * S - L, target["cy"] * S - T, target["r"] * S
    if is_sitting(target):
        body_cy, body_rx, body_ry = hy + hr * 2.0, hr * 2.3, hr * 5.0
    else:
        body_cy, body_rx, body_ry = hy + hr * 2.8, hr * 2.05, hr * 6.4
    m = ellipse_mask(h, w, hx, hy, hr * 1.35, hr * 1.55)
    m = cv2.bitwise_or(m, ellipse_mask(h, w, hx, body_cy, body_rx, body_ry))
    return m


def feather(mask, sigma_core=28, feather=FEATHER_WORK):
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11))
    closed = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k)
    core = cv2.dilate(closed, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (21, 21)))
    soft = cv2.GaussianBlur(closed, (0, 0), feather / 3)
    soft = np.maximum(soft, cv2.GaussianBlur(core, (0, 0), sigma_core))
    return np.clip(soft, 0, 255).astype(np.uint8)


def save_webp(im: Image.Image, path: Path, quality=82, method=4):
    path.parent.mkdir(parents=True, exist_ok=True)
    kw = dict(quality=quality, method=method)
    if im.mode in ("RGBA", "LA"):
        kw["lossless"] = False
    im.save(path, "WEBP", **kw)


def main():
    photo_path, faces, names_cfg = load_inputs()
    people, host = person_meta(faces, names_cfg)
    PRIVATE.mkdir(parents=True, exist_ok=True)
    (PRIVATE / "masks").mkdir(exist_ok=True)

    print(f"loading photo {photo_path}")
    orig = Image.open(photo_path).convert("RGB")
    if orig.size != (ORIG_W, ORIG_H):
        print(f"note: source is {orig.size}, resizing as if cover of {ORIG_W}x{ORIG_H}")
        # If we only have the half-res design copy (3680x2456), treat it as work size.
    work = orig.resize((WORK_W, WORK_H), Image.Resampling.LANCZOS)
    served = orig.resize((OUT_W, OUT_H), Image.Resampling.LANCZOS)
    S_work = WORK_W / ORIG_W

    session = None
    try:
        from rembg import new_session, remove

        print("loading u2net_human_seg …")
        session = new_session("u2net_human_seg")
        print("session ready")
    except Exception as e:
        print("rembg unavailable, oval fallback only:", type(e).__name__, e)

    full_masks = {}  # nr -> WORK_H x WORK_W uint8
    for p in people:
        cx, cy, r, box = crop_box(p, WORK_W, WORK_H, S_work)
        L, T, R, B = box
        crop = work.crop(box)
        alpha = None
        if session is not None:
            out = remove(crop, session=session)
            if out.mode != "RGBA":
                out = out.convert("RGBA")
            alpha = np.array(out)[:, :, 3]
            if int(alpha.max()) < 20:
                print(f"  #{p['nr']} rembg empty, oval fallback")
                alpha = None
            else:
                isolated = isolate(alpha, box, p, people, S_work)
                if isolated.max() < 20:
                    print(f"  #{p['nr']} isolate empty, oval fallback")
                    alpha = None
                else:
                    alpha = isolated
                    print(f"  #{p['nr']} rembg+isolate mean={alpha.mean():.1f}")
        if alpha is None:
            alpha = oval_fallback(box, p, S_work)
            print(f"  #{p['nr']} oval fallback mean={alpha.mean():.1f}")

        full = np.zeros((WORK_H, WORK_W), np.uint8)
        full[T:B, L:R] = alpha
        full_masks[p["nr"]] = feather(full)

    # Prefer the mockup-tuned silhouette masks where they exist (same 3680 work size).
    design_masks = {
        10: ROOT / "designs/hannafon/shared/masks/hanna-mask-sil.png",
        22: ROOT / "designs/hannafon/shared/masks/daniel-mask-sil.png",
        23: ROOT / "designs/hannafon/shared/masks/melanie-mask-sil.png",
    }
    for nr, path in design_masks.items():
        if path.exists():
            im = Image.open(path)
            if im.mode != "L":
                im = im.convert("L")
            if im.size != (WORK_W, WORK_H):
                im = im.resize((WORK_W, WORK_H), Image.Resampling.LANCZOS)
            full_masks[nr] = np.array(im)
            print(f"  #{nr} using design silhouette mask")

    # Served photo + warm cream-washed blur (v3 look).
    save_webp(served, PRIVATE / "family.webp", quality=84)
    served.save(PRIVATE / "family.jpg", "JPEG", quality=88, optimize=True, progressive=True)
    # Mid / heavy stagger baked into one layer: stronger blur + cream lerp.
    arr = np.array(served, dtype=np.float32)
    # Approximate sigma ~22 mid then heavier; PIL radius is related but we use cv2.
    mid = cv2.GaussianBlur(arr, (0, 0), 18)
    heavy = cv2.GaussianBlur(arr, (0, 0), 36)
    mixed = 0.4 * mid + 0.6 * heavy
    # Warm lift, no dark vignette — matches v3 "warm aufgehellt".
    cream = np.clip(mixed * (1 - 0.32) + CREAM * 0.32, 0, 255).astype(np.uint8)
    save_webp(Image.fromarray(cream), PRIVATE / "family-blur.webp", quality=80)
    Image.fromarray(cream).save(PRIVATE / "family-blur.jpg", "JPEG", quality=85, optimize=True)

    # Scale masks to served size, crop to bbox, record metadata.
    out_people = []
    for p in people:
        m = cv2.resize(full_masks[p["nr"]], (OUT_W, OUT_H), interpolation=cv2.INTER_AREA)
        ys, xs = np.where(m > 18)
        rec = dict(p)
        if len(xs) == 0:
            rec["mask"] = None
            out_people.append(rec)
            continue
        pad = 24
        x0, y0 = max(0, int(xs.min()) - pad), max(0, int(ys.min()) - pad)
        x1, y1 = min(OUT_W, int(xs.max()) + pad + 1), min(OUT_H, int(ys.max()) + pad + 1)
        crop = m[y0:y1, x0:x1]
        # Store as lossless-ish alpha webp (single channel → RGBA)
        rgba = np.zeros((crop.shape[0], crop.shape[1], 4), np.uint8)
        rgba[:, :, 3] = crop
        fname = f"masks/{p['nr']}.webp"
        save_webp(Image.fromarray(rgba), PRIVATE / fname, quality=90)
        rec["mask"] = {"file": fname, "x": x0, "y": y0, "w": int(x1 - x0), "h": int(y1 - y0)}
        out_people.append(rec)
        print(f"  mask #{p['nr']} {x1-x0}x{y1-y0} at {x0},{y0}")

    people_json = {
        "version": "V1.01",
        "photo": {
            "original": [ORIG_W, ORIG_H],
            "width": OUT_W,
            "height": OUT_H,
            "files": {
                "webp": "family.webp",
                "jpg": "family.jpg",
                "blurWebp": "family-blur.webp",
                "blurJpg": "family-blur.jpg",
            },
        },
        "hostNr": host,
        "people": out_people,
    }
    (PRIVATE / "people.json").write_text(json.dumps(people_json, indent=2) + "\n")
    print("wrote", PRIVATE / "people.json")
    print("done")


if __name__ == "__main__":
    main()
