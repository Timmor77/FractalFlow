// Tiled export: the tile layout, and the assembly of tiles into one image.

import { describe, it, expect } from "vitest";
import { planBands, exportSize } from "../src/export/tiles";
import { exportPng } from "../src/export/exportImage";
import type { Renderer, ViewState, ImageSize, Tile } from "../src/core/types";

describe("planBands", () => {
  it.each([
    [1, 1, 512],
    [512, 512, 512],
    [513, 511, 512],
    [1000, 700, 256],
    [7680, 4320, 512],
    [15360, 8640, 512],
  ])("covers a %ix%i image exactly once with %i-pixel tiles", (width, height, tileSize) => {
    const bands = planBands(width, height, tileSize);

    let area = 0;
    let nextY = 0;
    for (const band of bands) {
      expect(band.y).toBe(nextY); // bands stack with no gap and no overlap
      nextY += band.height;
      let nextX = 0;
      for (const tile of band.tiles) {
        expect(tile.x).toBe(nextX); // so do the tiles inside a band
        expect(tile.y).toBe(band.y);
        expect(tile.height).toBe(band.height);
        expect(tile.width).toBeGreaterThan(0);
        expect(tile.width).toBeLessThanOrEqual(tileSize);
        expect(tile.height).toBeLessThanOrEqual(tileSize);
        nextX += tile.width;
        area += tile.width * tile.height;
      }
      expect(nextX).toBe(width);
    }
    expect(nextY).toBe(height);
    expect(area).toBe(width * height);
  });

  it("rejects sizes it cannot tile", () => {
    expect(() => planBands(0, 10, 512)).toThrow(RangeError);
    expect(() => planBands(10, 10.5, 512)).toThrow(RangeError);
    expect(() => planBands(10, 10, 0)).toThrow(RangeError);
  });
});

describe("exportSize", () => {
  it("puts the requested side on the longest edge", () => {
    expect(exportSize(7680, 16 / 9)).toEqual({ width: 7680, height: 4320 });
    expect(exportSize(7680, 9 / 16)).toEqual({ width: 4320, height: 7680 });
    expect(exportSize(3840, 1)).toEqual({ width: 3840, height: 3840 });
  });

  it("never returns an empty image, however extreme the window", () => {
    expect(exportSize(3840, 100000).height).toBe(1);
    expect(() => exportSize(3840, 0)).toThrow(RangeError);
    expect(() => exportSize(3840, Number.NaN)).toThrow(RangeError);
  });
});

// A renderer whose pixels encode their own image coordinates: any tile placed
// at the wrong offset, flipped or truncated shows up in the decoded image.
function colourAt(x: number, y: number): [number, number, number] {
  return [x & 0xff, y & 0xff, (x * 7 + y * 13) & 0xff];
}

function makeFakeRenderer(log: Tile[]): Renderer {
  return {
    name: "fake",
    minScale: 1e-20,
    render: () => ({ cpuMs: 0, refLength: 0 }),
    resize: () => undefined,
    renderTile(_view: ViewState, _image: ImageSize, tile: Tile): Promise<Uint8Array> {
      log.push(tile);
      const pixels = new Uint8Array(tile.width * tile.height * 4);
      for (let y = 0; y < tile.height; y++) {
        for (let x = 0; x < tile.width; x++) {
          const [r, g, b] = colourAt(tile.x + x, tile.y + y);
          pixels.set([r, g, b, 255], (y * tile.width + x) * 4);
        }
      }
      return Promise.resolve(pixels);
    },
  };
}

const VIEW = {} as ViewState; // the fake renderer ignores it

// Minimal decode for the pixels only (the encoder has its own exhaustive test).
async function decodeRgb(blob: Blob, width: number, height: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const idat: Uint8Array<ArrayBuffer>[] = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = view.getUint32(offset);
    if (String.fromCharCode(...bytes.subarray(offset + 4, offset + 8)) === "IDAT") {
      idat.push(bytes.slice(offset + 8, offset + 8 + length));
    }
    offset += 12 + length;
  }
  const inflated = new Uint8Array(
    await new Response(
      new Blob(idat).stream().pipeThrough(new DecompressionStream("deflate")),
    ).arrayBuffer(),
  );
  const rowBytes = width * 3;
  const rgb = new Uint8Array(height * rowBytes);
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * (rowBytes + 1)];
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= 3 ? rgb[y * rowBytes + i - 3] : 0;
      const b = y > 0 ? rgb[(y - 1) * rowBytes + i] : 0;
      const c = i >= 3 && y > 0 ? rgb[(y - 1) * rowBytes + i - 3] : 0;
      const p = a + b - c;
      const paeth =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c;
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter];
      rgb[y * rowBytes + i] = (inflated[y * (rowBytes + 1) + 1 + i] + predictor) & 0xff;
    }
  }
  return rgb;
}

describe("exportPng", () => {
  it("assembles every tile at its place, including the narrower edge tiles", async () => {
    const [width, height, tileSize] = [70, 45, 32];
    const tiles: Tile[] = [];
    const progress: number[] = [];
    const blob = await exportPng(makeFakeRenderer(tiles), VIEW, width, height, {
      tileSize,
      onProgress: (fraction) => progress.push(fraction),
    });

    expect(tiles.length).toBe(3 * 2); // 70 -> 32+32+6 columns, 45 -> 32+13 rows
    expect(progress.length).toBe(tiles.length);
    expect(progress[progress.length - 1]).toBe(1);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress); // monotonic

    const rgb = await decodeRgb(blob, width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3;
        expect([rgb[i], rgb[i + 1], rgb[i + 2]]).toEqual(colourAt(x, y));
      }
    }
  });

  it("gives the same image whatever the tile size", async () => {
    const [width, height] = [61, 37];
    const single = await exportPng(makeFakeRenderer([]), VIEW, width, height, { tileSize: 4096 });
    const tiled = await exportPng(makeFakeRenderer([]), VIEW, width, height, { tileSize: 8 });
    expect(await decodeRgb(tiled, width, height)).toEqual(await decodeRgb(single, width, height));
  });

  it("stops at the next tile when aborted", async () => {
    const controller = new AbortController();
    const tiles: Tile[] = [];
    const pending = exportPng(makeFakeRenderer(tiles), VIEW, 64, 64, {
      tileSize: 16,
      signal: controller.signal,
      onProgress: (fraction) => {
        if (fraction >= 0.25) {
          controller.abort();
        }
      },
    });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(tiles.length).toBe(4); // a quarter of the 16 tiles, then nothing
  });
});
