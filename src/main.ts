// Application entry point.
//
// Role: create the canvas, pick the render backend (WebGPU if possible, else
// WebGL2) and wire the pieces together — camera, controls, panel, render loop,
// export, shareable URL. Each piece lives in its own module; this file only
// connects them.
//
// Opening the page with `?bench` runs the reproducible benchmark harness and
// `?validate` the WebGPU-vs-reference comparison (src/bench/) instead of the
// interactive app.

import "./style.css";

import { Viewport } from "./core/viewport";
import { FrameLoop } from "./core/frameLoop";
import { serializeState, parseState } from "./core/urlState";
import { downloadBlob } from "./core/download";
import type { Renderer, ViewState } from "./core/types";
import { DEFAULT_C, adaptiveMaxIter, INTRO_DURATION_MS, INTRO_START_SCALE } from "./core/config";
import { attachControls, shouldIgnoreShortcut } from "./controls/controls";
import { exportPng } from "./export/exportImage";
import { exportSize } from "./export/tiles";
import { StatsOverlay } from "./ui/stats";
import { createControlPanel } from "./ui/panel";
import { PALETTES, DEFAULT_PALETTE, buildPaletteLut } from "./ui/palettes";
import { createToast } from "./ui/toast";
import { showFatalMessage } from "./ui/fatal";
import { WebGPURenderer } from "./backends/webgpu/webgpuRenderer";
import { WebGLRenderer } from "./backends/webgl/webglRenderer";

function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.id = "fractal-canvas";
  canvas.setAttribute("role", "img");
  canvas.setAttribute(
    "aria-label",
    "Julia set fractal. Drag or use the arrow keys to pan, scroll or press plus and minus to zoom.",
  );
  return canvas;
}

// A lost GPU device or WebGL context freezes the image for good. The view is
// in the URL hash, so offering a reload brings the user back to it.
function onGpuLost(): void {
  showFatalMessage(
    "The graphics device was lost",
    "The browser or the driver reset the GPU, so the view can no longer be redrawn. " +
      "Reloading restores it where you left off.",
    true,
  );
}

// WebGPU first (modern + perturbation deep zoom); WebGL2 as a fallback.
// Returns the renderer together with the canvas it ended up drawing into.
async function createRenderer(
  app: HTMLElement,
): Promise<{ renderer: Renderer; canvas: HTMLCanvasElement }> {
  const canvas = makeCanvas();
  app.appendChild(canvas);
  try {
    return { renderer: await WebGPURenderer.create(canvas, onGpuLost), canvas };
  } catch (error) {
    console.warn("WebGPU unavailable, falling back to WebGL2:", error);
    // Start from a fresh element: a canvas that already handed out a "webgpu"
    // context returns null for "webgl2", which would turn a recoverable
    // WebGPU failure into "WebGL2 is not supported".
    const fresh = makeCanvas();
    canvas.replaceWith(fresh);
    const renderer = new WebGLRenderer(fresh);
    fresh.addEventListener("webglcontextlost", onGpuLost);
    return { renderer, canvas: fresh };
  }
}

async function startApp(): Promise<void> {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) {
    throw new Error("#app element not found");
  }
  app.innerHTML = "";

  const { renderer, canvas } = await createRenderer(app);
  const viewport = new Viewport();
  const stats = new StatsOverlay();
  const toast = createToast();

  // Zoom floor matched to the backend's real precision: the WebGL2 fallback
  // pixelates around 1e-13 — or as early as 1e-4 when its start-up probe finds
  // the compensated arithmetic optimised away — so letting the camera reach the
  // perturbation floor there would only zoom into mush.
  viewport.setMinScale(renderer.minScale);

  // UI-driven state (the renderer knows nothing about it, it receives a ViewState).
  const currentC = { x: DEFAULT_C.x, y: DEFAULT_C.y }; // c parameter (picked on the map)
  let paletteIndex = DEFAULT_PALETTE; // selected colour palette

  // LUT of each palette, built once (stable references: the backend only
  // re-uploads the texture when the palette changes).
  const paletteLuts = PALETTES.map((palette) => buildPaletteLut(palette));

  // Builds the frame's view state from the camera + UI state.
  // Iterations stay complete even during interaction (otherwise black areas).
  function buildView(): ViewState {
    return {
      centerX: viewport.centerX,
      centerY: viewport.centerY,
      scale: viewport.scale,
      cx: currentC.x,
      cy: currentC.y,
      maxIter: adaptiveMaxIter(viewport.getZoomLevel()),
      paletteLut: paletteLuts[paletteIndex],
    };
  }

  // --- Rendering ---
  let renderCount = 0;

  // Draws one frame at the given fraction of the full resolution.
  function drawFrame(resolution: number): void {
    renderer.resize(resolution);
    const view = buildView();
    const info = renderer.render(view);

    renderCount += 1;
    stats.update({
      backend: renderer.name,
      renderCount,
      lastRenderMs: info.cpuMs,
      fps: loop.fps,
      refLength: info.refLength,
      centerX: viewport.getCenterXNumber(),
      centerY: viewport.getCenterYNumber(),
      scale: viewport.scale,
      zoomLevel: viewport.getZoomLevel(),
      maxIter: view.maxIter,
      atMaxDepth: viewport.isAtMaxDepth(),
    });
  }

  const loop = new FrameLoop({
    advance: () => viewport.advanceZoom(),
    draw: drawFrame,
    settled: updateHash, // store the location in the URL once everything settles
  });
  const requestRender = (): void => loop.requestRender();

  // --- Shareable state via the URL (#...) ---
  // Centre (double-double, exact in deep zoom), scale, c and palette: see
  // core/urlState.ts. Reloading = same view; "Copy link" shares it.
  function updateHash(): void {
    const state = serializeState({
      centerX: viewport.centerX,
      centerY: viewport.centerY,
      scale: viewport.scale,
      cx: currentC.x,
      cy: currentC.y,
      palette: paletteIndex,
    });
    // replaceState: updates the URL without pushing history or scrolling.
    history.replaceState(null, "", `#${state}`);
  }

  function loadStateFromHash(): boolean {
    const state = parseState(location.hash.slice(1), PALETTES.length);
    if (state === null) {
      return false;
    }
    viewport.setView(state.centerX, state.centerY, state.scale);
    // c and the palette are optional in a link: absent, the current ones stay.
    if (state.c !== null) {
      currentC.x = state.c.x;
      currentC.y = state.c.y;
    }
    if (state.palette !== null) {
      paletteIndex = state.palette;
    }
    return true;
  }

  async function copyLink(): Promise<void> {
    updateHash(); // make sure the URL reflects the current view before copying
    try {
      await navigator.clipboard.writeText(location.href);
      panel.flashCopied();
    } catch {
      // clipboard unavailable: the URL is in the address bar anyway.
    }
  }

  // --- Full-quality PNG export (tiled: see export/exportImage.ts) ---
  // The interactive loop is paused meanwhile: the export has the GPU to itself
  // and the view it captured cannot change under it.
  let exportAbort: AbortController | null = null;

  async function saveImage(): Promise<void> {
    if (exportAbort !== null) {
      return;
    }
    exportAbort = new AbortController();
    loop.pause();
    panel.setSaving(true);

    try {
      const aspect = canvas.clientWidth / canvas.clientHeight;
      const { width, height } = exportSize(panel.getExportSide(), aspect);
      const blob = await exportPng(renderer, buildView(), width, height, {
        onProgress: (fraction) => panel.setSaveProgress(fraction),
        signal: exportAbort.signal,
      });
      downloadBlob(blob, `fractalflow-${width}x${height}-${Date.now()}.png`);
    } catch (error) {
      const cancelled = error instanceof DOMException && error.name === "AbortError";
      if (!cancelled) {
        console.error("Image export failed:", error);
        toast.show("Image export failed — try a smaller size", 4000);
      }
    } finally {
      exportAbort = null;
      panel.setSaving(false);
      loop.resume();
    }
  }

  // --- Smooth zoom: wheel / pinch / keys move a target, the loop animates ---
  // On the WebGL2 fallback the limit is the backend's, not the algorithm's:
  // say so, and point at browsers that can go deeper.
  const zoomLimitMessage =
    renderer.name === "WebGPU"
      ? "Maximum depth reached"
      : "WebGL2 fallback limit — a WebGPU browser (Chrome, Edge) zooms much deeper";

  // The message is only shown when hitting the limit while zooming IN: blocked
  // at max zoom-out, we say nothing (it would be misleading).
  function applyZoomResult(result: "zoom" | "blocked", zoomingIn: boolean): void {
    if (result === "blocked") {
      if (zoomingIn) {
        toast.show(zoomLimitMessage);
      }
      return;
    }
    loop.startAnimation();
  }

  function onWheel(mouseX: number, mouseY: number, rect: DOMRect, deltaY: number): void {
    applyZoomResult(viewport.nudgeZoom(mouseX, mouseY, rect, deltaY), deltaY < 0);
  }

  // Zoom by a factor around a screen point: touch pinch (two fingers spreading
  // => factor < 1 => zoom in) and the keyboard's plus / minus keys.
  function onZoomBy(midX: number, midY: number, rect: DOMRect, factor: number): void {
    applyZoomResult(viewport.nudgeZoomByFactor(midX, midY, rect, factor), factor < 1);
  }

  // Possibly resume a location from the URL (before building the panel).
  const restored = loadStateFromHash();

  // --- Control panel (palettes, c map, export, reset, link) ---
  const panel = createControlPanel({
    initialPalette: paletteIndex,
    initialC: currentC,
    onSelectPalette: (index) => {
      paletteIndex = index;
      requestRender();
    },
    onPickC: (cx, cy) => {
      currentC.x = cx;
      currentC.y = cy;
      requestRender();
    },
    onSave: () => void saveImage(),
    onCancelSave: () => exportAbort?.abort(),
    onReset: () => {
      viewport.reset();
      requestRender();
    },
    onCopyLink: () => void copyLink(),
  });
  document.body.appendChild(panel.element);
  document.body.appendChild(panel.toggleElement);

  // --- Intro animation: the view gently eases into the default zoom ---
  function runIntro(): void {
    const targetScale = viewport.scale; // default view (3.0)
    const t0 = performance.now();
    let cancelled = false;

    // Any interaction ends the intro. The inertial zoom takes over from the
    // scale the intro had reached and eases to the camera's own target: the
    // default view, or wherever the user's first wheel notch pointed.
    const cancel = (): void => {
      cancelled = true;
      loop.startAnimation();
    };
    window.addEventListener("pointerdown", cancel, { once: true });
    window.addEventListener("wheel", cancel, { once: true, passive: true });
    window.addEventListener("keydown", cancel, { once: true });

    const step = (now: number): void => {
      if (cancelled || loop.isPaused) {
        return; // the render loop (or an export) owns the camera from here
      }
      const p = Math.min(1, (now - t0) / INTRO_DURATION_MS);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      viewport.scale = INTRO_START_SCALE + (targetScale - INTRO_START_SCALE) * eased;
      drawFrame(1);
      if (p < 1) {
        requestAnimationFrame(step);
      } else {
        updateHash();
      }
    };
    requestAnimationFrame(step);
  }

  // --- Final wiring ---
  attachControls(canvas, viewport, requestRender, onWheel, onZoomBy);
  window.addEventListener("resize", requestRender);

  // Shortcuts: S saves the image, Escape cancels a save in progress (ignored
  // while typing or with Ctrl/Alt).
  window.addEventListener("keydown", (event) => {
    if (shouldIgnoreShortcut(event)) {
      return;
    }
    if (event.key === "s" || event.key === "S") {
      void saveImage();
    } else if (event.key === "Escape") {
      exportAbort?.abort();
    }
  });

  // Pasting a shared link into the address bar (or navigating history) reloads
  // the corresponding view without a page reload.
  window.addEventListener("hashchange", () => {
    if (loadStateFromHash()) {
      panel.setC(currentC.x, currentC.y);
      panel.setPalette(paletteIndex);
      requestRender();
    }
  });

  // If resuming a shared location, show it directly; otherwise play the intro
  // (skipped for users who asked their system to reduce motion).
  if (restored || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    drawFrame(1);
  } else {
    runIntro();
  }
}

// The dynamic imports keep the benchmark and validation pages out of the main
// chunk.
const params = new URLSearchParams(location.search);
const benchMode = params.get("bench");
if (benchMode !== null) {
  const { runBench } = await import("./bench/bench");
  await runBench(benchMode);
} else if (params.has("validate")) {
  const { runValidation } = await import("./bench/validate");
  await runValidation();
} else {
  try {
    await startApp();
  } catch (error) {
    // Neither backend could start: say so instead of leaving a black page.
    console.error(error);
    showFatalMessage(
      "FractalFlow cannot start in this browser",
      "It needs WebGPU or WebGL2, and neither could be initialised. " +
        "Try a recent Chrome, Edge, Firefox or Safari with hardware acceleration enabled.",
    );
  }
}
