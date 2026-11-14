// Tile layout for the image export.
//
// A large picture is rendered as a grid of small tiles so that no single draw
// call keeps the GPU busy for long: a multi-second draw trips the driver's
// watchdog on weak hardware (about two seconds on Windows) and resets the
// device. Tiles are grouped into horizontal bands, which is the order a PNG
// is written in: one band is rendered, encoded and dropped before the next.

import type { Tile } from "../core/types";

// One row of tiles: every tile shares the band's y and height, and together
// they cover the full image width.
export type Band = {
  y: number;
  height: number;
  tiles: Tile[];
};

// Splits a width×height image into bands of tiles at most tileSize on a side.
// The tiles cover every pixel exactly once; the last column and the last band
// are narrower when the size is not a multiple of tileSize.
export function planBands(width: number, height: number, tileSize: number): Band[] {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError(`invalid image size ${width}x${height}`);
  }
  if (!Number.isInteger(tileSize) || tileSize < 1) {
    throw new RangeError(`invalid tile size ${tileSize}`);
  }

  const bands: Band[] = [];
  for (let y = 0; y < height; y += tileSize) {
    const bandHeight = Math.min(tileSize, height - y);
    const tiles: Tile[] = [];
    for (let x = 0; x < width; x += tileSize) {
      tiles.push({ x, y, width: Math.min(tileSize, width - x), height: bandHeight });
    }
    bands.push({ y, height: bandHeight, tiles });
  }
  return bands;
}

// Export size for a given longest side, keeping the screen's aspect ratio.
export function exportSize(longestSide: number, aspect: number): { width: number; height: number } {
  if (!(aspect > 0) || !Number.isFinite(aspect)) {
    throw new RangeError(`invalid aspect ratio ${aspect}`);
  }
  return aspect >= 1
    ? { width: longestSide, height: Math.max(1, Math.round(longestSide / aspect)) }
    : { width: Math.max(1, Math.round(longestSide * aspect)), height: longestSide };
}
