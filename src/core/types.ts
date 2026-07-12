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

  // Draws one frame for the given view state.
  render(view: ViewState): RenderInfo;

  // Adjusts the canvas's internal size. qualityScale < 1 reduces resolution
  // (fast render during interaction); 1 = full resolution.
  resize(qualityScale?: number): void;

  // Renders the view off-screen at the requested size (full quality) and
  // returns the image as PNG. Used by "save image": we can target much larger
  // than the screen. The canvas is restored to its display size right after.
  capture(view: ViewState, width: number, height: number): Promise<Blob>;
}
