"""Slice Gemini sprite sheets (8x4 grid on #FF00FF) into transparent PNG frames.

Usage: python scripts/slice_sprites.py [src_dir] [out_dir]
Output: out_dir/<character>/<row>-<nn>.png, rows = idle, skill1, skill2, skill3.
"""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

COLS, ROWS = 8, 4
ROW_NAMES = ["idle", "skill1", "skill2", "skill3"]
INSET = 3  # px trimmed inside each cell to drop the black grid lines
FULL_BG = 0.9  # a frame this opaque is a painted background (e.g. a time-stop scene), not a pose


def grid_lines(dark: np.ndarray, axis: int, count: int) -> list[int]:
    """Cell boundaries along one axis. Grid lines are near-fully dark rows/cols;
    fall back to equal division when detection does not find exactly count-1 lines."""
    size = dark.shape[1 - axis]
    ratio = dark.mean(axis=axis)
    hits = np.where(ratio > 0.6)[0]
    centers, group = [], []
    for i in hits:
        if group and i - group[-1] > 1:
            centers.append(int(np.mean(group)))
            group = []
        group.append(i)
    if group:
        centers.append(int(np.mean(group)))
    inner = [c for c in centers if 8 < c < size - 8]
    if len(inner) != count - 1:
        inner = [round(size * k / count) for k in range(1, count)]
    return [0, *inner, size]


def key_magenta(rgb: np.ndarray) -> np.ndarray:
    """Alpha mask: background magenta -> 0. Then one erosion pass removes the
    pinkish fringe that webp compression leaves around sprites."""
    r, g, b = (rgb[..., i].astype(int) for i in range(3))
    tint = np.minimum(r, b) - g
    bg = (tint > 110) & (r > 140) & (b > 140)
    fringe = (tint > 55) & ~bg
    near_bg = np.zeros_like(bg)
    near_bg[1:] |= bg[:-1]; near_bg[:-1] |= bg[1:]
    near_bg[:, 1:] |= bg[:, :-1]; near_bg[:, :-1] |= bg[:, 1:]
    bg |= fringe & near_bg
    return np.where(bg, 0, 255).astype(np.uint8)


def slice_sheet(path: Path, out_dir: Path) -> dict[str, list[int]]:
    img = np.array(Image.open(path).convert("RGB"))
    dark = img.sum(axis=2) < 120
    xs, ys = grid_lines(dark, 0, COLS), grid_lines(dark, 1, ROWS)
    name = path.stem.split("-", 1)[-1]
    dest = out_dir / name
    dest.mkdir(parents=True, exist_ok=True)
    playable: dict[str, list[int]] = {}
    for ri in range(ROWS):
        keep = []
        for ci in range(COLS):
            cell = img[ys[ri] + INSET: ys[ri + 1] - INSET, xs[ci] + INSET: xs[ci + 1] - INSET]
            alpha = key_magenta(cell)
            Image.fromarray(np.dstack([cell, alpha]), "RGBA").save(dest / f"{ROW_NAMES[ri]}-{ci + 1:02d}.png")
            if (alpha > 0).mean() < FULL_BG:
                keep.append(ci)
        playable[ROW_NAMES[ri]] = keep or list(range(COLS))  # never leave a row empty
    return playable


def _self_check() -> None:
    # 2 cells of magenta split by a black line -> line found, magenta keyed out
    sheet = np.zeros((10, 41, 3), np.uint8)
    sheet[...] = (255, 0, 255)
    sheet[:, 20] = (0, 0, 0)
    assert grid_lines(sheet.sum(axis=2) < 120, 0, 2) == [0, 20, 41]
    assert key_magenta(sheet[:, :19]).max() == 0
    assert key_magenta(np.full((3, 3, 3), 90, np.uint8)).min() == 255  # gray stays opaque


if __name__ == "__main__":
    _self_check()
    src = Path(sys.argv[1] if len(sys.argv) > 1 else "prototype/assets/sprites")
    out = Path(sys.argv[2] if len(sys.argv) > 2 else "web/public/sprites")
    manifest = {}
    for sheet in sorted(src.glob("*.webp")):
        rows = slice_sheet(sheet, out)
        manifest[sheet.stem.split("-", 1)[-1]] = rows
        print(f"{sheet.name}: " + ", ".join(f"{r} {len(f)}/{COLS}" for r, f in rows.items()))
    # which frames of each row the app should play (0-based), so painted-background frames are skipped
    (out / "manifest.json").write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
