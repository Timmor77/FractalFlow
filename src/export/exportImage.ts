// Full-quality PNG export, rendered in tiles and encoded as a stream.
//
// The picture is never held whole anywhere. The GPU draws one small tile at a
// time (short draw calls: no driver watchdog, and the page stays responsive);
// tiles are gathered into a horizontal band, the band is handed to the PNG
// encoder and then dropped. Peak memory is one band plus the compressed
// output, so the export size is bounded by patience rather than by the GPU's
// largest texture or the browser's largest canvas.

import type { Renderer, ViewState } from "../core/types";
import { EXPORT_TILE_SIZE } from "../core/config";
import { planBands } from "./tiles";
import { PngStreamEncoder } from "./pngEncoder";

export type ExportOptions = {
  // Called after every tile with the fraction done, in (0, 1].
  onProgress?: (fraction: number) => void;
  // Abort to abandon the export; exportPng then rejects with an AbortError.
  signal?: AbortSignal;
  // Tile side in pixels (tests use small tiles on small images).
  tileSize?: number;
};

// Lets pending input events and repaints run between two tiles.
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function exportPng(
  renderer: Renderer,
  view: ViewState,
  width: number,
  height: number,
  options: ExportOptions = {},
): Promise<Blob> {
  const { onProgress, signal, tileSize = EXPORT_TILE_SIZE } = options;
  const image = { width, height };
  const bands = planBands(width, height, tileSize);
  const tileCount = bands.reduce((count, band) => count + band.tiles.length, 0);
  const encoder = new PngStreamEncoder(width, height);

  try {
    let done = 0;
    for (const band of bands) {
      const rgb = new Uint8Array(width * band.height * 3);
      for (const tile of band.tiles) {
        signal?.throwIfAborted();
        const rgba = await renderer.renderTile(view, image, tile);

        // Drop alpha and place the tile at its column inside the band.
        for (let y = 0; y < tile.height; y++) {
          let from = y * tile.width * 4;
          let to = (y * width + tile.x) * 3;
          for (let x = 0; x < tile.width; x++) {
            rgb[to] = rgba[from];
            rgb[to + 1] = rgba[from + 1];
            rgb[to + 2] = rgba[from + 2];
            from += 4;
            to += 3;
          }
        }

        done += 1;
        onProgress?.(done / tileCount);
        await yieldToBrowser();
      }
      await encoder.writeRows(rgb);
    }
    return await encoder.finish();
  } catch (error) {
    await encoder.abort();
    throw error;
  }
}
