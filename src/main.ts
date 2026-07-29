// Application entry point.
//
// Role: create the canvas, pick the render backend (WebGPU if possible, else
// WebGL2), wire the controls and the panel (palettes / c picker / export),
// play a short intro, and redraw only when the view changes.
//
// Opening the page with `?bench` runs the reproducible benchmark harness
// (src/bench/) instead of the interactive app.

import "./style.css";

import { Viewport } from "./core/viewport";
import { attachControls, shouldIgnoreShortcut } from "./controls/controls";
import { StatsOverlay } from "./ui/stats";
import { createControlPanel } from "./ui/panel";
import { PALETTES, DEFAULT_PALETTE, buildPaletteLut } from "./ui/palettes";
import type { Renderer, ViewState } from "./core/types";
import {
  DEFAULT_C,
  adaptiveMaxIter,
  INTERACTIVE_RES_SCALE,
  INTERACTIVE_RES_MIN,
  INTERACTIVE_RES_MAX,
  FRAME_SLOW_MS,
  FRAME_FAST_MS,
  IDLE_DELAY_MS,
  EXPORT_MAX_SIDE,
  INTRO_DURATION_MS,
  INTRO_START_SCALE,
} from "./core/config";
import { WebGPURenderer } from "./backends/webgpu/webgpuRenderer";
import { WebGLRenderer } from "./backends/webgl/webglRenderer";

async function startApp(): Promise<void> {
  const app = document.querySelector<HTMLDivElement>("#app");
  if (!app) {
    throw new Error("#app element not found");
  }
  app.innerHTML = "";

  const canvas = document.createElement("canvas");
  canvas.id = "fractal-canvas";
  app.appendChild(canvas);

  const viewport = new Viewport();
  const stats = new StatsOverlay();

  // UI-driven state (the renderer knows nothing about it, it receives a ViewState).
  const currentC = { x: DEFAULT_C.x, y: DEFAULT_C.y }; // c parameter (picked on the map)
  let paletteIndex = DEFAULT_PALETTE; // selected colour palette

  // LUT of each palette, built once (stable references: the backend only
  // re-uploads the texture when the palette changes).
  const paletteLuts = PALETTES.map((palette) => buildPaletteLut(palette));

  // WebGPU first (modern + perturbation deep zoom); WebGL2 as a fallback.
  async function createRenderer(): Promise<Renderer> {
    try {
      return await WebGPURenderer.create(canvas);
    } catch (error) {
      console.warn("WebGPU unavailable, falling back to WebGL2:", error);
      return new WebGLRenderer(canvas);
    }
  }

  const renderer = await createRenderer();

  // Zoom floor matched to the backend's real precision: the WebGL2 fallback
  // pixelates around 1e-13 — or as early as 1e-4 when its start-up probe finds
  // the compensated arithmetic optimised away — so letting the camera reach the
  // perturbation floor there would only zoom into mush.
  viewport.setMinScale(renderer.minScale);

  let rafId: number | null = null;
  let idleTimer: number | null = null;
  let renderCount = 0;

  // During an interaction (zoom/pan) we render at reduced resolution to stay
  // smooth; a full-resolution pass follows as soon as input stops.
  let interacting = false;

  // Smooth zoom in progress: the loop keeps animating scale toward its target.
  let zooming = false;

  // During a PNG export the canvas is temporarily resized much larger: we freeze
  // other renders so we never read back a canvas at the wrong size.
  let capturing = false;

  // Adaptive interaction resolution (starts from the base, adapts to frame rate).
  let interactiveScale = INTERACTIVE_RES_SCALE;

  // Frame pacing: last frame timestamp + smoothed FPS for the overlay.
  let lastFrameTime = 0;
  let fps = 0;

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

  function render(): void {
    if (capturing) {
      return; // the export drives rendering itself at that point
    }
    // In motion (interaction OR inertial zoom): reduced resolution; else sharp.
    const moving = interacting || zooming;
    renderer.resize(moving ? interactiveScale : 1);
    const view = buildView();
    const info = renderer.render(view);

    renderCount += 1;
    stats.update({
      backend: renderer.name,
      renderCount,
      lastRenderMs: info.cpuMs,
      fps,
      refLength: info.refLength,
      centerX: viewport.getCenterXNumber(),
      centerY: viewport.getCenterYNumber(),
      scale: viewport.scale,
      zoomLevel: viewport.getZoomLevel(),
      maxIter: view.maxIter,
      atMaxDepth: viewport.isAtMaxDepth(),
    });
  }

  // Adjusts the interaction resolution from the real per-frame time: lower it if
  // the GPU cannot keep up (long frames), raise it back when there is headroom.
  // The dead zone between the two thresholds avoids sharpness "flickering".
  function adaptResolution(dt: number): void {
    if (dt > FRAME_SLOW_MS) {
      interactiveScale = Math.max(INTERACTIVE_RES_MIN, interactiveScale * 0.85);
    } else if (dt < FRAME_FAST_MS) {
      interactiveScale = Math.min(INTERACTIVE_RES_MAX, interactiveScale * 1.06);
    }
  }

  // Render loop: during interaction it runs every display frame (smoother
  // pan/zoom and measurable frame rate); otherwise it renders once (the sharp
  // pass) then stops.
  function frame(now: number): void {
    rafId = null;

    if (lastFrameTime > 0) {
      const dt = now - lastFrameTime;
      if (dt > 0 && dt < 1000) {
        fps = fps > 0 ? fps * 0.8 + (1000 / dt) * 0.2 : 1000 / dt;
        if (interacting || zooming) {
          adaptResolution(dt);
        }
      }
    }
    lastFrameTime = now;

    // Advance the inertial zoom: once it reaches its target, zooming goes false.
    if (zooming) {
      zooming = viewport.advanceZoom();
    }

    render();

    if ((interacting || zooming) && !capturing) {
      rafId = requestAnimationFrame(frame);
    } else {
      lastFrameTime = 0; // restart "cold" on the next interaction
      updateHash(); // store the location in the URL once everything settles
    }
  }

  // Ensures a frame is scheduled (starts/restarts the loop).
  function scheduleFrame(): void {
    if (rafId === null && !capturing) {
      rafId = requestAnimationFrame(frame);
    }
  }

  // Called on every input: starts the interaction loop, then schedules the sharp
  // (full-resolution) pass after a short input-free rest.
  function requestRender(): void {
    interacting = true;
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
    }
    idleTimer = window.setTimeout(() => {
      idleTimer = null;
      interacting = false;
      scheduleFrame(); // final sharp pass, full resolution + complete iterations
    }, IDLE_DELAY_MS);
    scheduleFrame();
  }

  // --- Full-quality PNG export ---
  function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function saveImage(): Promise<void> {
    if (capturing) {
      return;
    }
    capturing = true;
    panel.setSaving(true);

    // Cancel any pending render: the canvas is about to be resized for export.
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }

    try {
      // Target size: longest side = EXPORT_MAX_SIDE, keeping the screen aspect.
      const aspect = canvas.clientWidth / canvas.clientHeight;
      let width = EXPORT_MAX_SIDE;
      let height = EXPORT_MAX_SIDE;
      if (aspect >= 1) {
        height = Math.round(EXPORT_MAX_SIDE / aspect);
      } else {
        width = Math.round(EXPORT_MAX_SIDE * aspect);
      }

      const blob = await renderer.capture(buildView(), width, height);
      downloadBlob(blob, `fractalflow-${Date.now()}.png`);
    } catch (error) {
      console.error("Image export failed:", error);
    } finally {
      capturing = false;
      panel.setSaving(false);
    }
  }

  // --- Shareable state via the URL (#...) ---
  // We encode the centre (double-double hi_lo, to stay exact in deep zoom), the
  // scale, c and the palette. Reloading = same view; "Copy link" shares it.
  function serializeState(): string {
    const params = new URLSearchParams();
    params.set("x", `${viewport.centerX.hi}_${viewport.centerX.lo}`);
    params.set("y", `${viewport.centerY.hi}_${viewport.centerY.lo}`);
    params.set("s", String(viewport.scale));
    params.set("cx", String(currentC.x));
    params.set("cy", String(currentC.y));
    params.set("p", String(paletteIndex));
    return params.toString();
  }

  function updateHash(): void {
    // replaceState: updates the URL without pushing history or scrolling.
    history.replaceState(null, "", `#${serializeState()}`);
  }

  function loadStateFromHash(): boolean {
    const raw = location.hash.slice(1);
    if (!raw) {
      return false;
    }
    const p = new URLSearchParams(raw);
    const xs = (p.get("x") ?? "").split("_").map(Number);
    const ys = (p.get("y") ?? "").split("_").map(Number);
    const s = Number(p.get("s"));
    if (
      xs.length !== 2 || ys.length !== 2 ||
      !xs.every(Number.isFinite) || !ys.every(Number.isFinite) || !Number.isFinite(s)
    ) {
      return false;
    }
    viewport.setView({ hi: xs[0], lo: xs[1] }, { hi: ys[0], lo: ys[1] }, s);
    const cx = Number(p.get("cx"));
    const cy = Number(p.get("cy"));
    if (Number.isFinite(cx) && Number.isFinite(cy)) {
      currentC.x = cx;
      currentC.y = cy;
    }
    const pi = Number(p.get("p"));
    if (Number.isFinite(pi) && pi >= 0 && pi < PALETTES.length) {
      paletteIndex = Math.floor(pi);
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

  // --- Smooth zoom: wheel / pinch move a target, the loop animates the rest ---
  // The "maximum depth" toast is only shown when hitting the limit while zooming
  // IN: blocked at max zoom-out, we say nothing (the message would be misleading).
  function applyZoomResult(result: "zoom" | "blocked", zoomingIn: boolean): void {
    if (result === "blocked") {
      if (zoomingIn) {
        showZoomLimit();
      }
      return;
    }
    zooming = true;
    requestRender();
  }

  function onWheel(mouseX: number, mouseY: number, rect: DOMRect, deltaY: number): void {
    applyZoomResult(viewport.nudgeZoom(mouseX, mouseY, rect, deltaY), deltaY < 0);
  }

  // Touch pinch: two fingers spreading => factor < 1 => zoom in.
  function onPinch(midX: number, midY: number, rect: DOMRect, factor: number): void {
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
    onSave: () => {
      void saveImage();
    },
    onReset: () => {
      viewport.reset();
      requestRender();
    },
    onCopyLink: () => {
      void copyLink();
    },
  });
  document.body.appendChild(panel.element);
  document.body.appendChild(panel.toggleElement);

  // --- Intro animation: the view gently eases into the default zoom ---
  function runIntro(): void {
    const targetScale = viewport.scale; // default view (3.0)
    const startScale = INTRO_START_SCALE;
    const t0 = performance.now();
    let cancelled = false;

    // Any interaction jumps straight to the final view.
    const cancel = (): void => {
      cancelled = true;
    };
    window.addEventListener("pointerdown", cancel, { once: true });
    window.addEventListener("wheel", cancel, { once: true, passive: true });
    window.addEventListener("keydown", cancel, { once: true });

    const step = (now: number): void => {
      if (cancelled) {
        viewport.scale = targetScale;
        render();
        return;
      }
      const p = Math.min(1, (now - t0) / INTRO_DURATION_MS);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      viewport.scale = startScale + (targetScale - startScale) * eased;
      render();
      if (p < 1) {
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  }

  // --- "Zoom limit reached" indicator ---
  // When pushing the zoom past the maximum depth, the image no longer changes:
  // nothing is recomputed (see controls) and a short message is shown.
  const zoomToast = document.createElement("div");
  zoomToast.className = "zoom-toast";
  // On the WebGL2 fallback the limit is the backend's, not the algorithm's:
  // say so, and point at browsers that can go deeper.
  zoomToast.textContent =
    renderer.name === "WebGPU"
      ? "Maximum depth reached"
      : "WebGL2 fallback limit — a WebGPU browser (Chrome, Edge) zooms much deeper";
  document.body.appendChild(zoomToast);
  let toastTimer: number | null = null;
  function showZoomLimit(): void {
    zoomToast.classList.add("visible");
    if (toastTimer !== null) {
      clearTimeout(toastTimer);
    }
    toastTimer = window.setTimeout(() => {
      zoomToast.classList.remove("visible");
      toastTimer = null;
    }, 1400);
  }

  // --- Final wiring ---
  attachControls(canvas, viewport, requestRender, onWheel, onPinch);
  window.addEventListener("resize", requestRender);

  // Shortcut: S to save the image (ignored while typing or with Ctrl/Alt).
  window.addEventListener("keydown", (event) => {
    if (shouldIgnoreShortcut(event)) {
      return;
    }
    if (event.key === "s" || event.key === "S") {
      void saveImage();
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

  // If resuming a shared location, show it directly; otherwise play the intro.
  if (restored) {
    render();
  } else {
    runIntro();
  }
}

// `?bench` runs the benchmark harness and `?validate` the WebGPU-vs-reference
// comparison, instead of the app. The dynamic imports keep both out of the main
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
  await startApp();
}
