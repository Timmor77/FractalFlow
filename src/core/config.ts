// Constants shared by the orchestrator (main.ts) and the backends.
// Grouped here to avoid magic numbers scattered around.

// Default c parameter of the Julia set.
export const DEFAULT_C = { x: -0.8, y: 0.156 };

// Base iteration count (zoomed-out view).
export const BASE_MAX_ITER = 300;

// Hard iteration cap. Also bounds the reference orbit size (hence the GPU
// buffer). 4000 is plenty for the targeted zoom depth.
export const MAX_ITER_LIMIT = 4000;

// Iterations added per zoom level (1 level = ×2). The deeper the zoom, the more
// iterations are needed to resolve the structure.
const ITER_PER_ZOOM_LEVEL = 45;

// Computes the iteration count adapted to the current zoom.
export function adaptiveMaxIter(zoomLevel: number): number {
  const extra = Math.floor(zoomLevel * ITER_PER_ZOOM_LEVEL);
  return Math.min(BASE_MAX_ITER + extra, MAX_ITER_LIMIT);
}

// --- Adaptive rendering: stay smooth during interaction ---
// GPU cost grows with (pixels × iterations). During a zoom/pan we reduce the
// RESOLUTION (fewer pixels), but each pixel keeps ALL of its iterations.
// This matters: capping iterations would paint not-yet-escaped areas black.
// By reducing resolution instead, every pixel is computed fully → correct
// colours, just blurrier. A full-resolution pass follows as soon as input stops.

// devicePixelRatio cap (cost grows with the square of the resolution).
export const MAX_DPR = 2;

// Resolution factor during interaction. This is a STARTING value: it then
// adapts to the actual frame rate (see main.ts). Higher = sharper in motion;
// it only drops if the GPU cannot keep up.
export const INTERACTIVE_RES_SCALE = 0.7;

// Bounds for the resolution adaptation during interaction.
export const INTERACTIVE_RES_MIN = 0.4; // floor when the GPU struggles
export const INTERACTIVE_RES_MAX = 1.0; // ceiling (full resolution)

// Per-frame time thresholds (ms) driving the adaptation:
// above SLOW we reduce resolution, below FAST we raise it back.
export const FRAME_SLOW_MS = 20; // < 50 fps -> lighten the load
export const FRAME_FAST_MS = 13; // > ~75 fps -> we can afford sharper

// Idle delay without input before the final sharp render pass (ms).
export const IDLE_DELAY_MS = 110;

// --- Image export ---
// Target longest side (px) for the "full quality" PNG export. The backend then
// clamps it to the GPU's max texture size (preserving aspect).
export const EXPORT_MAX_SIDE = 8192;

// --- Intro animation ---
// On load, the view starts slightly zoomed out then eases into the default
// view. Purely cosmetic; cancelled on the first interaction.
export const INTRO_DURATION_MS = 1500;
export const INTRO_START_SCALE = 4.0; // the default view is 3.0 (max = 4.0)
