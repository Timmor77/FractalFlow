// Render loop: draw only when something changed.
//
// A fractal frame is expensive and a still view never changes, so there is no
// permanent requestAnimationFrame loop. Instead:
//   - input (or a running animation) starts a loop that draws every display
//     frame at reduced resolution, to stay smooth;
//   - once input has been quiet for a moment and animations have finished, one
//     last frame is drawn at full resolution, and the loop stops.
// The resolution used in motion follows the measured frame time (see
// resolutionGovernor.ts).

import { IDLE_DELAY_MS } from "./config";
import { ResolutionGovernor } from "./resolutionGovernor";

export type FrameLoopHost = {
  // Advances running animations by one frame. Returns true while they are
  // still moving, false once they have reached their target.
  advance(): boolean;

  // Draws one frame. `resolution` is 1 for the sharp pass, below 1 in motion.
  draw(resolution: number): void;

  // Called after the sharp pass: the view has settled.
  settled(): void;
};

// Time sources, injectable so the loop can be tested without a browser.
export type Scheduler = {
  requestFrame(callback: (now: number) => void): number;
  cancelFrame(id: number): void;
  setTimer(callback: () => void, ms: number): number;
  clearTimer(id: number): void;
};

const browserScheduler: Scheduler = {
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (id) => cancelAnimationFrame(id),
  setTimer: (callback, ms) => window.setTimeout(callback, ms),
  clearTimer: (id) => clearTimeout(id),
};

export class FrameLoop {
  // Smoothed frames per second while the loop runs, 0 while unknown.
  public fps = 0;

  private readonly host: FrameLoopHost;
  private readonly scheduler: Scheduler;
  private readonly governor = new ResolutionGovernor();

  private frameId: number | null = null;
  private idleTimer: number | null = null;
  private lastFrameTime = 0;

  // Input arrived recently: keep drawing at reduced resolution.
  private interacting = false;
  // host.advance() still has something to move.
  private animating = false;
  // While paused nothing is drawn (the export has the GPU to itself).
  private paused = false;

  constructor(host: FrameLoopHost, scheduler: Scheduler = browserScheduler) {
    this.host = host;
    this.scheduler = scheduler;
  }

  public get isPaused(): boolean {
    return this.paused;
  }

  // Call on every input that changes the view: draws in motion now, and the
  // sharp pass after a short input-free rest.
  public requestRender(): void {
    this.interacting = true;
    if (this.idleTimer !== null) {
      this.scheduler.clearTimer(this.idleTimer);
    }
    this.idleTimer = this.scheduler.setTimer(() => {
      this.idleTimer = null;
      this.interacting = false;
      this.schedule(); // final sharp pass
    }, IDLE_DELAY_MS);
    this.schedule();
  }

  // Call when an animation starts: the loop then calls host.advance() every
  // frame until it reports it is done.
  public startAnimation(): void {
    this.animating = true;
    this.requestRender();
  }

  // Stops drawing until resume(). A frame already scheduled is cancelled.
  public pause(): void {
    this.paused = true;
    if (this.frameId !== null) {
      this.scheduler.cancelFrame(this.frameId);
      this.frameId = null;
    }
  }

  // Resumes after pause() and redraws, since the view may have changed.
  public resume(): void {
    this.paused = false;
    this.lastFrameTime = 0;
    this.governor.restart();
    this.schedule();
  }

  private schedule(): void {
    if (this.frameId === null && !this.paused) {
      this.frameId = this.scheduler.requestFrame((now) => this.frame(now));
    }
  }

  private frame(now: number): void {
    this.frameId = null;

    if (this.lastFrameTime > 0) {
      const dt = now - this.lastFrameTime;
      if (dt > 0 && dt < 1000) {
        this.fps = this.fps > 0 ? this.fps * 0.8 + (1000 / dt) * 0.2 : 1000 / dt;
        this.governor.update(dt);
      }
    }
    this.lastFrameTime = now;

    if (this.animating) {
      this.animating = this.host.advance();
    }

    const moving = this.interacting || this.animating;
    this.host.draw(moving ? this.governor.scale : 1);

    if (moving) {
      this.schedule();
    } else {
      // The loop stops here: the next interaction starts "cold", so its first
      // interval must not be measured against this frame.
      this.lastFrameTime = 0;
      this.governor.restart();
      this.host.settled();
    }
  }
}
