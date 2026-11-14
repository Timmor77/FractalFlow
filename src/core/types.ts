// Types shared between the core (camera, math) and the render backends.
// Goal: a backend (WebGPU, WebGL2) only depends on these types, never on the
// other backend nor on camera internals.

import type { Dd } from "./doubleDouble";

// Snapshot of the camera + parameters for ONE frame.
// Pure data: each backend derives what it needs from it (WebGPU computes a
// reference orbit, WebGL2 splits the centre into hi/lo).
export type ViewState = {
  // View centre in the complex plane, as double-double (deep zoom).
  centerX: Dd;
  centerY: Dd;

  // Vertical size visible in the complex plane (float64).
  // The smaller the scale, the deeper the zoom.
  scale: number;

  // c parameter of the Julia set (constant across the whole image).
  cx: number;
  cy: number;

  // Maximum iteration count for this frame.
  maxIter: number;

  // Colour lookup table (256×1 RGBA LUT) built by main.ts from the selected
  // palette. The backend uploads it as a texture; the reference only changes
  // when the palette changes (lazy upload).
  paletteLut: Uint8Array;
};

// Size of a whole image, in pixels.
export type ImageSize = {
  width: number;
  height: number;
};

// A rectangle of a larger image: top-left corner and size, in pixels, with y
// growing downwards (image convention).
export type Tile = {
  x: number;
  y: number;
  width: number;
  height: number;
};

// What a render returns, for the stats overlay.
export type RenderInfo = {
  // CPU time spent preparing/submitting the frame, in milliseconds.
  cpuMs: number;

  // Reference orbit length actually used.
  // 0 if the backend does not use perturbation (e.g. WebGL2 fallback).
  refLength: number;
};

// Interface common to all render backends.
// main.ts picks an implementation and only talks to this interface.
export interface Renderer {
  // Human-readable name shown in the overlay (e.g. "WebGPU", "WebGL2").
  readonly name: string;

  // Deepest scale this backend can render without visible precision loss.
  // The viewport uses it as its zoom floor: pushing past it would only
  // produce pixelated mush, so we stop and tell the user instead.
  readonly minScale: number;

  // Draws one frame for the given view state.
  render(view: ViewState): RenderInfo;

  // Adjusts the canvas's internal size. qualityScale < 1 reduces resolution
  // (fast render during interaction); 1 = full resolution.
  resize(qualityScale?: number): void;

  // Renders one tile of a `image`-sized picture of the view, off-screen, and
  // returns its pixels: tightly packed RGBA, rows from the top. The result is
  // exactly what those pixels would be in a single draw of the whole image, so
  // tiles can be assembled into pictures far larger than the screen — or than
  // the GPU's biggest texture (see export/exportImage.ts). The promise resolves
  // once the GPU has finished the tile.
  renderTile(view: ViewState, image: ImageSize, tile: Tile): Promise<Uint8Array>;
}
