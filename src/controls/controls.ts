// User controls: wheel (zoom), drag / touch (pan, pinch), keyboard (reset).
//
// This module translates pointer/keyboard events into Viewport operations,
// then requests a new render. Backend-independent: it works identically with
// WebGPU or WebGL2. Pointer Events cover both mouse and touch:
// 1 pointer = pan, 2 pointers = pinch (zoom + pan).

import type { Viewport } from "../core/viewport";

// True when a keyboard shortcut should be ignored: the user is typing into a
// field, or it is a browser combination (Ctrl+S, Ctrl+R...).
export function shouldIgnoreShortcut(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return true;
  }
  const target = event.target;
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
  );
}

// Attaches all event listeners to the canvas and the window.
// `requestRender` is called when the view changes (pan/reset). `onWheel`
// receives each wheel notch and `onPinch` each two-finger spread change:
// main drives the smooth zoom (see viewport.nudgeZoom / nudgeZoomByFactor).
export function attachControls(
  canvas: HTMLCanvasElement,
  viewport: Viewport,
  requestRender: () => void,
  onWheel: (mouseX: number, mouseY: number, rect: DOMRect, deltaY: number) => void,
  onPinch: (midX: number, midY: number, rect: DOMRect, factor: number) => void,
): void {
  // Wheel zoom, centred on the cursor (delegated to main for inertia).
  canvas.addEventListener("wheel", (event: WheelEvent) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    onWheel(event.clientX, event.clientY, rect, event.deltaY);
  });

  // Active pointers on the canvas (left mouse button, fingers, stylus).
  const pointers = new Map<number, { x: number; y: number }>();

  // Midpoint and spread of the two pointers (state of the ongoing pinch).
  const pinchInfo = (): { midX: number; midY: number; dist: number } => {
    const [a, b] = [...pointers.values()];
    return {
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
      dist: Math.hypot(a.x - b.x, a.y - b.y),
    };
  };

  canvas.addEventListener("pointerdown", (event: PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return; // mouse pan: left button only
    }
    if (pointers.size >= 2) {
      return; // beyond two fingers, extra pointers are ignored
    }
    // Capturing guarantees the drag continues even when leaving the canvas.
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  });

  canvas.addEventListener("pointermove", (event: PointerEvent) => {
    if (!pointers.has(event.pointerId)) {
      return;
    }

    if (pointers.size === 2) {
      // Pinch: the two-finger midpoint pans the view, their spread zooms.
      const before = pinchInfo();
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const after = pinchInfo();

      viewport.panByPixels(
        after.midX - before.midX,
        after.midY - before.midY,
        canvas.clientWidth,
        canvas.clientHeight,
      );
      if (before.dist > 0 && after.dist > 0) {
        // Fingers spreading => factor < 1 => zoom in.
        onPinch(after.midX, after.midY, canvas.getBoundingClientRect(), before.dist / after.dist);
      }
      requestRender();
      return;
    }

    // Single pointer: classic pan.
    const prev = pointers.get(event.pointerId)!;
    viewport.panByPixels(
      event.clientX - prev.x,
      event.clientY - prev.y,
      canvas.clientWidth,
      canvas.clientHeight,
    );
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    requestRender();
  });

  // End of drag / pinch (the browser releases the capture on its own).
  const endPointer = (event: PointerEvent): void => {
    pointers.delete(event.pointerId);
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);

  // If the window loses focus, cancel any ongoing gesture.
  window.addEventListener("blur", () => {
    pointers.clear();
  });

  // R key: reset the view.
  window.addEventListener("keydown", (event: KeyboardEvent) => {
    if (shouldIgnoreShortcut(event)) {
      return;
    }
    if (event.key === "r" || event.key === "R") {
      viewport.reset();
      requestRender();
    }
  });
}
