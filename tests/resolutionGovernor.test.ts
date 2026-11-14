// Adaptive interaction resolution.
//
// The regression these tests pin down: with fixed thresholds (raise below
// 13 ms, lower above 20 ms) a 60 Hz display, whose best possible frame takes
// 16.7 ms, could lower the resolution but never raise it again.

import { describe, it, expect } from "vitest";
import { ResolutionGovernor } from "../src/core/resolutionGovernor";
import {
  INTERACTIVE_RES_SCALE,
  INTERACTIVE_RES_MIN,
  INTERACTIVE_RES_MAX,
} from "../src/core/config";

const HZ60 = 1000 / 60;
const HZ120 = 1000 / 120;

function feed(governor: ResolutionGovernor, dt: number, frames: number): void {
  for (let i = 0; i < frames; i++) {
    governor.update(dt);
  }
}

describe("60 Hz display", () => {
  it("recovers full resolution after a slow spell", () => {
    const governor = new ResolutionGovernor();
    feed(governor, 2 * HZ60, 20); // every frame misses a refresh
    expect(governor.scale).toBe(INTERACTIVE_RES_MIN);

    feed(governor, HZ60, 200); // back on time
    expect(governor.scale).toBe(INTERACTIVE_RES_MAX);
  });

  it("lowers the resolution when frames miss a refresh", () => {
    const governor = new ResolutionGovernor();
    feed(governor, HZ60, 30);
    const before = governor.scale;
    governor.update(2 * HZ60);
    expect(governor.scale).toBeLessThan(before);
  });

  it("reads a GPU that misses every frame from the start as slow", () => {
    // A steady 33 ms must not be mistaken for a 30 Hz display running fine.
    const governor = new ResolutionGovernor();
    feed(governor, 2 * HZ60, 5);
    expect(governor.scale).toBeLessThan(INTERACTIVE_RES_SCALE);
  });

  it("tolerates callback jitter around the refresh interval", () => {
    const governor = new ResolutionGovernor();
    feed(governor, 2 * HZ60, 20);
    for (let i = 0; i < 200; i++) {
      governor.update(i % 2 === 0 ? HZ60 - 2 : HZ60 + 2);
    }
    expect(governor.scale).toBe(INTERACTIVE_RES_MAX);
  });
});

describe("fast display", () => {
  it("keeps the fixed thresholds: 60 fps on a 120 Hz panel changes nothing", () => {
    const governor = new ResolutionGovernor();
    feed(governor, HZ120, 10); // the display shows what it can do
    const settled = governor.scale;
    feed(governor, HZ60, 100); // 16.7 ms: between 13 and 20, the dead zone
    expect(governor.scale).toBe(settled);
  });

  it("raises on time frames and lowers past 20 ms", () => {
    const governor = new ResolutionGovernor();
    feed(governor, HZ120, 100);
    expect(governor.scale).toBe(INTERACTIVE_RES_MAX);
    governor.update(25);
    expect(governor.scale).toBeLessThan(INTERACTIVE_RES_MAX);
  });
});

describe("steps", () => {
  it("needs a run of on-time frames before each step up", () => {
    const governor = new ResolutionGovernor();
    feed(governor, HZ60, 3);
    expect(governor.scale).toBe(INTERACTIVE_RES_SCALE); // not yet
    governor.update(HZ60);
    expect(governor.scale).toBeGreaterThan(INTERACTIVE_RES_SCALE);
  });

  it("stays within its bounds", () => {
    const governor = new ResolutionGovernor();
    feed(governor, 100, 100);
    expect(governor.scale).toBe(INTERACTIVE_RES_MIN);
    feed(governor, HZ120, 1000);
    expect(governor.scale).toBe(INTERACTIVE_RES_MAX);
  });
});
