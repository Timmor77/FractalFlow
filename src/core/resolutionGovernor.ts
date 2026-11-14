// Adaptive resolution during interaction.
//
// While the view moves we render at a fraction of the full resolution, and
// that fraction follows the measured frame time: lower it when frames arrive
// late, raise it back when they arrive on time.
//
// "On time" depends on the display. requestAnimationFrame never fires faster
// than the screen refreshes, so on a 60 Hz panel a perfect frame takes 16.7 ms:
// fixed thresholds tuned for fast displays (raise below 13 ms) would never see
// a frame good enough to raise the resolution again, and every hiccup would
// lower it for the rest of the session. The thresholds are therefore the fixed
// ones or a multiple of the display's own frame interval, whichever is larger.

import {
  INTERACTIVE_RES_SCALE,
  INTERACTIVE_RES_MIN,
  INTERACTIVE_RES_MAX,
  FRAME_SLOW_MS,
  FRAME_FAST_MS,
  RES_RAISE_AFTER_FRAMES,
} from "./config";

// Longest frame interval accepted as "the display's own": 50 Hz. A GPU that
// misses every frame on a 60 Hz screen delivers a steady 33 ms, which must be
// read as slow, not as a 30 Hz display running perfectly.
const MAX_REFRESH_MS = 20;

export class ResolutionGovernor {
  // Current resolution factor for frames rendered in motion.
  public scale = INTERACTIVE_RES_SCALE;

  // Shortest frame interval seen so far, i.e. the display's refresh interval.
  private refreshMs = MAX_REFRESH_MS;
  private previousDt = 0;

  // Consecutive on-time frames since the last change (late frames reset it).
  private onTimeFrames = 0;

  // Call when the frame loop restarts after a pause: the next interval does
  // not follow the previous one, so they must not be averaged together.
  public restart(): void {
    this.previousDt = 0;
    this.onTimeFrames = 0;
  }

  // Feeds one frame interval (ms) and returns the updated factor.
  public update(dt: number): number {
    // Averaging two consecutive intervals cancels callback jitter (a late
    // frame followed by an early one), which a plain minimum would mistake
    // for a faster display.
    if (this.previousDt > 0) {
      this.refreshMs = Math.min(this.refreshMs, (dt + this.previousDt) / 2);
    }
    this.previousDt = dt;

    const slow = Math.max(FRAME_SLOW_MS, this.refreshMs * 1.5);
    const fast = Math.max(FRAME_FAST_MS, this.refreshMs * 1.25);

    if (dt > slow) {
      this.scale = Math.max(INTERACTIVE_RES_MIN, this.scale * 0.85);
      this.onTimeFrames = 0;
    } else if (dt < fast) {
      // With vsync a frame is either on time or a whole interval late, so
      // there is no in-between reading to hold the level steady. Asking for a
      // short run of good frames before each step up is what keeps sharpness
      // from flickering around the limit.
      this.onTimeFrames += 1;
      if (this.onTimeFrames >= RES_RAISE_AFTER_FRAMES) {
        this.scale = Math.min(INTERACTIVE_RES_MAX, this.scale * 1.06);
        this.onTimeFrames = 0;
      }
    }
    return this.scale;
  }
}
