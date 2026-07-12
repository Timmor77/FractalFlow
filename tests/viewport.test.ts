// Viewport (camera) tests.
//
// The headline property is the zoom-at-cursor invariant: the complex-plane
// point under the cursor must stay fixed through an entire animated zoom.

import { describe, it, expect } from "vitest";
import { Viewport } from "../src/core/viewport";
import { ddFromNumber, ddToNumber } from "../src/core/doubleDouble";

// Minimal DOMRect stand-in (Viewport only reads left/top/width/height).
function makeRect(width: number, height: number): DOMRect {
  return { left: 0, top: 0, width, height } as DOMRect;
}

// Complex-plane point under a screen pixel, using the same mapping as the
// shaders: centre + (px/w - 0.5) * aspect * scale (x), centre + (0.5 - py/h) * scale (y).
function pointUnderCursor(vp: Viewport, px: number, py: number, w: number, h: number) {
  const aspect = w / h;
  return {
    x: ddToNumber(vp.centerX) + (px / w - 0.5) * aspect * vp.scale,
    y: ddToNumber(vp.centerY) + (0.5 - py / h) * vp.scale,
  };
}

// Runs the zoom animation to completion (advanceZoom returns false when done).
function settleZoom(vp: Viewport): void {
  for (let i = 0; i < 1000 && vp.advanceZoom(); i++) {
    // advance until the scale reaches its target
  }
}

describe("zoom-at-cursor invariant", () => {
  it("keeps the point under the cursor fixed while zooming in", () => {
    const vp = new Viewport();
    const [w, h] = [800, 600];
    const [px, py] = [600, 150]; // off-centre cursor

    const before = pointUnderCursor(vp, px, py, w, h);
    expect(vp.nudgeZoomByFactor(px, py, makeRect(w, h), 0.5)).toBe("zoom");
    settleZoom(vp);
    const after = pointUnderCursor(vp, px, py, w, h);

    expect(after.x).toBeCloseTo(before.x, 12);
    expect(after.y).toBeCloseTo(before.y, 12);
    expect(vp.scale).toBeCloseTo(1.5, 12); // 3.0 * 0.5
  });

  it("keeps the point fixed while zooming back out", () => {
    const vp = new Viewport();
    const [w, h] = [1024, 768];
    const [px, py] = [100, 700];

    vp.nudgeZoomByFactor(px, py, makeRect(w, h), 0.25);
    settleZoom(vp);
    const before = pointUnderCursor(vp, px, py, w, h);
    vp.nudgeZoomByFactor(px, py, makeRect(w, h), 2.0);
    settleZoom(vp);
    const after = pointUnderCursor(vp, px, py, w, h);

    expect(after.x).toBeCloseTo(before.x, 12);
    expect(after.y).toBeCloseTo(before.y, 12);
  });
});

describe("zoom bounds", () => {
  it("clamps setView scale into [1e-28, 4]", () => {
    const vp = new Viewport();
    vp.setView(ddFromNumber(0), ddFromNumber(0), 1e-40);
    expect(vp.scale).toBe(1e-28);
    expect(vp.isAtMaxDepth()).toBe(true);
    vp.setView(ddFromNumber(0), ddFromNumber(0), 100);
    expect(vp.scale).toBe(4.0);
  });

  it("reports 'blocked' only when pinned at a bound", () => {
    const vp = new Viewport();
    const rect = makeRect(800, 600);
    vp.setView(ddFromNumber(0), ddFromNumber(0), 1e-28); // at the min bound
    expect(vp.nudgeZoomByFactor(400, 300, rect, 0.5)).toBe("blocked"); // pushing deeper
    expect(vp.nudgeZoomByFactor(400, 300, rect, 2.0)).toBe("zoom"); // backing off works
  });

  it("never reports a negative zoom level", () => {
    const vp = new Viewport();
    expect(vp.getZoomLevel()).toBe(0);
    vp.setView(ddFromNumber(0), ddFromNumber(0), 4.0); // zoomed OUT past the default
    expect(vp.getZoomLevel()).toBe(0);
    vp.setView(ddFromNumber(0), ddFromNumber(0), 1.5);
    expect(vp.getZoomLevel()).toBeCloseTo(1, 12); // one 2x factor
  });
});

describe("pan", () => {
  it("moves the centre by exactly the dragged complex distance", () => {
    const vp = new Viewport();
    const [w, h] = [800, 600];
    const aspect = w / h;

    // Dragging a full canvas width to the right moves the camera left by
    // scale * aspect; screen y is inverted.
    vp.panByPixels(w, 0, w, h);
    expect(ddToNumber(vp.centerX)).toBeCloseTo(-3.0 * aspect, 12);
    expect(ddToNumber(vp.centerY)).toBe(0);

    vp.panByPixels(0, h, w, h);
    expect(ddToNumber(vp.centerY)).toBeCloseTo(3.0, 12);
  });
});

describe("state restore and reset", () => {
  it("round-trips a full view through setView, including DD lo parts", () => {
    const vp = new Viewport();
    const cx = { hi: 0.25, lo: 1.9e-25 };
    const cy = { hi: -0.5, lo: -3.2e-26 };
    vp.setView(cx, cy, 1e-20);
    expect(vp.centerX.hi).toBe(0.25);
    expect(vp.centerX.lo).toBe(1.9e-25);
    expect(vp.centerY.hi).toBe(-0.5);
    expect(vp.centerY.lo).toBe(-3.2e-26);
    expect(vp.scale).toBe(1e-20);
  });

  it("reset() restores the initial view, including the zoom target", () => {
    const vp = new Viewport();
    vp.nudgeZoomByFactor(100, 100, makeRect(800, 600), 0.1);
    settleZoom(vp);
    vp.panByPixels(50, 80, 800, 600);

    vp.reset();
    expect(ddToNumber(vp.centerX)).toBe(0);
    expect(ddToNumber(vp.centerY)).toBe(0);
    expect(vp.scale).toBe(3.0);
    // The zoom target was reset too: nothing left to animate.
    expect(vp.advanceZoom()).toBe(false);
    expect(vp.scale).toBe(3.0);
  });
});
