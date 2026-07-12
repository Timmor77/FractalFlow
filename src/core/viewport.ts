// Viewport = mathematical camera in the complex plane.
// This class knows nothing about the render backends (WebGPU, WebGL2).
//
// Deep-zoom twist: the centre is stored as a double-double (~31 digits).
// That is what allows going far below float64 (~16 digits) and therefore
// placing the perturbation reference orbit correctly.
// The view size (scale) stays a float64: only its EXPONENT matters, not its
// digits, and a float64 easily reaches 1e-100.

import type { Dd } from "./doubleDouble";
import { ddFromNumber, ddToNumber, ddAddNumber } from "./doubleDouble";

export class Viewport {
  // Initial values used by reset().
  private readonly initialCenterX = 0.0;
  private readonly initialCenterY = 0.0;
  private readonly initialScale = 3.0;

  // View centre as a double-double.
  public centerX: Dd = ddFromNumber(this.initialCenterX);
  public centerY: Dd = ddFromNumber(this.initialCenterY);

  // Vertical size visible in the complex plane. The smaller, the deeper the zoom.
  public scale = this.initialScale;

  // Lower zoom bound. Set by the precision of the double-double centre:
  // ~31 mantissa digits for values of order 1 => we keep a comfortable margin
  // down to ~1e-28 before precision visibly degrades. The WebGL2 fallback
  // raises this floor to its own limit via setMinScale (Renderer.minScale).
  private minScale = 1e-28;

  // Upper bound: barely above the default view (3.0). Beyond that the fractal
  // shrinks until it disappears, so we prevent zooming out too far.
  private readonly maxScale = 4.0;

  // Wheel zoom strength (exponential formula, smooth for mouse and trackpad).
  private readonly wheelZoomStrength = 0.002;

  // --- Smooth (inertial) zoom ---
  // The wheel does not change `scale` directly: it moves a TARGET, and `scale`
  // eases toward it frame by frame (see advanceZoom). The anchor is the plane
  // point under the cursor, kept fixed during the whole motion.
  private targetScale = this.initialScale;
  private anchorFx = 0; // normalized cursor position (aspect-corrected)
  private anchorFy = 0;
  private readonly zoomEase = 0.2; // fraction of the gap covered per frame

  // Matches the zoom floor to the active backend's real precision
  // (Renderer.minScale), re-clamping the current state if already deeper.
  public setMinScale(value: number): void {
    this.minScale = value;
    this.scale = Math.max(this.minScale, this.scale);
    this.targetScale = Math.max(this.minScale, this.targetScale);
  }

  // Puts the camera back to its initial state.
  public reset(): void {
    this.centerX = ddFromNumber(this.initialCenterX);
    this.centerY = ddFromNumber(this.initialCenterY);
    this.scale = this.initialScale;
    this.targetScale = this.initialScale;
  }

  // Restores a full view (resuming a state from the URL).
  public setView(centerX: Dd, centerY: Dd, scale: number): void {
    this.centerX = centerX;
    this.centerY = centerY;
    this.scale = Math.max(this.minScale, Math.min(this.maxScale, scale));
    this.targetScale = this.scale;
  }

  // Indicative zoom level: 0 at start, +1 per 2x zoom factor.
  public getZoomLevel(): number {
    return Math.max(0, Math.log2(this.initialScale / this.scale));
  }

  // True when the maximum depth is reached (DD centre precision).
  // Beyond that, zooming changes nothing: no point re-rendering.
  public isAtMaxDepth(): boolean {
    return this.scale <= this.minScale;
  }

  // Updates the zoom TARGET around the cursor from a wheel notch.
  // deltaY < 0 => zoom in (factor < 1), deltaY > 0 => zoom out.
  public nudgeZoom(mouseX: number, mouseY: number, rect: DOMRect, deltaY: number): "zoom" | "blocked" {
    const clampedDeltaY = Math.max(-120, Math.min(120, deltaY));
    const factor = Math.exp(clampedDeltaY * this.wheelZoomStrength);
    return this.nudgeZoomByFactor(mouseX, mouseY, rect, factor);
  }

  // Updates the zoom TARGET around a screen point (the zoom is then animated
  // by advanceZoom). The anchor = plane point under the cursor (or the pinch
  // midpoint), kept fixed. Returns "blocked" if we are already at a bound and
  // pushing further in the same direction (nothing to animate, the image would
  // be identical).
  public nudgeZoomByFactor(mouseX: number, mouseY: number, rect: DOMRect, factor: number): "zoom" | "blocked" {
    // Anchor point position, centred on 0 and corrected for the aspect ratio.
    const localX = mouseX - rect.left;
    const localY = mouseY - rect.top;
    const aspect = rect.width / rect.height;
    this.anchorFx = (localX / rect.width - 0.5) * aspect;
    this.anchorFy = 0.5 - localY / rect.height; // screen y goes down, complex y goes up

    const before = this.targetScale;
    this.targetScale = Math.max(this.minScale, Math.min(this.maxScale, before * factor));

    if (this.targetScale !== before) {
      return "zoom";
    }
    // Target unchanged: blocked only if the scale already sits on the bound.
    return this.scale <= this.minScale || this.scale >= this.maxScale ? "blocked" : "zoom";
  }

  // Advances the zoom animation by one frame. Returns true while still moving.
  // We interpolate in log space (uniform perceived zoom speed).
  public advanceZoom(): boolean {
    const logCur = Math.log(this.scale);
    const logTarget = Math.log(this.targetScale);
    const delta = logTarget - logCur;

    // Close enough: snap to the target and stop.
    if (Math.abs(delta) < 1e-4) {
      if (this.scale !== this.targetScale) {
        this.applyScaleAnchored(this.targetScale);
      }
      return false;
    }
    this.applyScaleAnchored(Math.exp(logCur + delta * this.zoomEase));
    return true;
  }

  // Applies a new scale while keeping the anchor fixed.
  // Centre correction = offset_before - offset_after = anchor * (scaleBefore - scaleAfter).
  // The centre cancels out in the difference: we only add a small float64 delta
  // to the double-double centre.
  private applyScaleAnchored(newScale: number): void {
    const scaleBefore = this.scale;
    this.scale = Math.max(this.minScale, Math.min(this.maxScale, newScale));
    const scaleDelta = scaleBefore - this.scale;
    this.centerX = ddAddNumber(this.centerX, this.anchorFx * scaleDelta);
    this.centerY = ddAddNumber(this.centerY, this.anchorFy * scaleDelta);
  }

  // Pan from a mouse drag.
  public panByPixels(deltaX: number, deltaY: number, width: number, height: number): void {
    const aspect = width / height;

    // Pixels -> complex distance conversion (small float64 delta).
    const complexDeltaX = (deltaX / width) * this.scale * aspect;
    const complexDeltaY = (deltaY / height) * this.scale;

    // Dragging right = camera moves left; screen y is inverted.
    this.centerX = ddAddNumber(this.centerX, -complexDeltaX);
    this.centerY = ddAddNumber(this.centerY, complexDeltaY);
  }

  // Approximate float64 centre, for display and the WebGL2 fallback.
  public getCenterXNumber(): number {
    return ddToNumber(this.centerX);
  }

  public getCenterYNumber(): number {
    return ddToNumber(this.centerY);
  }
}
