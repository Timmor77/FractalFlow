// Render loop: draws in motion at reduced resolution, then exactly one sharp
// frame, then nothing. Driven by a fake clock so no browser is needed.

import { describe, it, expect } from "vitest";
import { FrameLoop } from "../src/core/frameLoop";
import type { Scheduler } from "../src/core/frameLoop";
import { IDLE_DELAY_MS } from "../src/core/config";

const FRAME_MS = 1000 / 120;

// Deterministic stand-in for requestAnimationFrame + setTimeout.
class FakeClock implements Scheduler {
  public now = 0;
  private nextId = 1;
  private frames = new Map<number, (now: number) => void>();
  private timers = new Map<number, { at: number; callback: () => void }>();

  requestFrame(callback: (now: number) => void): number {
    this.frames.set(this.nextId, callback);
    return this.nextId++;
  }
  cancelFrame(id: number): void {
    this.frames.delete(id);
  }
  setTimer(callback: () => void, ms: number): number {
    this.timers.set(this.nextId, { at: this.now + ms, callback });
    return this.nextId++;
  }
  clearTimer(id: number): void {
    this.timers.delete(id);
  }

  get pendingFrames(): number {
    return this.frames.size;
  }

  // Advances one display frame: due timers fire, then the frame callbacks.
  tick(): void {
    this.now += FRAME_MS;
    for (const [id, timer] of [...this.timers]) {
      if (timer.at <= this.now) {
        this.timers.delete(id);
        timer.callback();
      }
    }
    const due = [...this.frames.values()];
    this.frames.clear();
    for (const callback of due) {
      callback(this.now);
    }
  }

  // Runs until nothing is scheduled any more (bounded, to fail instead of hang).
  runUntilIdle(): void {
    for (let i = 0; i < 10000 && (this.frames.size > 0 || this.timers.size > 0); i++) {
      this.tick();
    }
    expect(this.frames.size + this.timers.size).toBe(0);
  }
}

function setup(animationFrames = 0) {
  const clock = new FakeClock();
  const draws: number[] = [];
  let settled = 0;
  let remaining = animationFrames;
  const loop = new FrameLoop(
    {
      advance: () => --remaining > 0,
      draw: (resolution) => draws.push(resolution),
      settled: () => settled++,
    },
    clock,
  );
  return { clock, loop, draws, settledCount: () => settled };
}

describe("FrameLoop", () => {
  it("draws nothing until asked", () => {
    const { clock, draws } = setup();
    clock.tick();
    expect(draws).toEqual([]);
    expect(clock.pendingFrames).toBe(0);
  });

  it("draws in motion, then one sharp frame, then stops", () => {
    const { clock, loop, draws, settledCount } = setup();
    loop.requestRender();
    clock.runUntilIdle();

    const sharp = draws[draws.length - 1];
    const moving = draws.slice(0, -1);
    expect(sharp).toBe(1);
    expect(moving.length).toBeGreaterThanOrEqual(Math.floor(IDLE_DELAY_MS / FRAME_MS) - 1);
    expect(moving.every((resolution) => resolution <= 1)).toBe(true);
    expect(moving[0]).toBeLessThan(1); // the first frames are the reduced ones
    expect(settledCount()).toBe(1);

    const count = draws.length;
    clock.tick();
    expect(draws.length).toBe(count); // nothing more once settled
  });

  it("postpones the sharp frame while input keeps coming", () => {
    const { clock, loop, draws, settledCount } = setup();
    for (let i = 0; i < 60; i++) {
      loop.requestRender(); // an event every frame, well past the idle delay
      clock.tick();
    }
    expect(settledCount()).toBe(0);
    expect(draws.length).toBe(60);
    clock.runUntilIdle();
    expect(settledCount()).toBe(1);
  });

  it("keeps animating after input stops, until the animation is done", () => {
    const frames = 100; // far longer than the idle delay
    const { clock, loop, draws, settledCount } = setup(frames);
    loop.startAnimation();
    clock.runUntilIdle();
    // One draw per animation step; the step that reaches the target is the
    // sharp frame itself (no extra frame for an identical view).
    expect(draws.length).toBe(frames);
    expect(draws[draws.length - 1]).toBe(1);
    expect(settledCount()).toBe(1);
  });

  it("draws nothing while paused, and redraws on resume", () => {
    const { clock, loop, draws } = setup();
    loop.requestRender();
    clock.tick();
    const before = draws.length;
    expect(before).toBeGreaterThan(0);

    loop.pause();
    expect(loop.isPaused).toBe(true);
    for (let i = 0; i < 40; i++) {
      loop.requestRender(); // input during an export is ignored, not queued up
      clock.tick();
    }
    expect(draws.length).toBe(before);

    loop.resume();
    clock.runUntilIdle();
    expect(draws.length).toBeGreaterThan(before);
    expect(draws[draws.length - 1]).toBe(1);
  });

  it("reports a frame rate while running", () => {
    const { clock, loop } = setup();
    for (let i = 0; i < 30; i++) {
      loop.requestRender();
      clock.tick();
    }
    expect(loop.fps).toBeCloseTo(120, 0);
  });
});
