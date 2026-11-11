// The clock every scripted animation runs on (the wafer, the floor). Time-based: the position
// in a timeline is wall time since start, less the time spent paused, so a slow or uneven frame
// rate changes how smooth a piece looks, never how long it takes or where it ends. Pausing (off
// screen, a hidden tab, the pause button) stops the clock; resuming continues from the same
// moment, with no jump.

export class Clock {
  private base = 0;
  private since: number | null = null;

  get running(): boolean {
    return this.since !== null;
  }

  /** Starts or resumes at wall time `now` (ms). No effect if already running. */
  start(now: number): void {
    if (this.since === null) this.since = now;
  }

  /** Stops at `now`, keeping the elapsed time. */
  pause(now: number): void {
    if (this.since !== null) {
      this.base += Math.max(0, now - this.since);
      this.since = null;
    }
  }

  /** Elapsed timeline time at wall time `now`, ms. */
  elapsed(now: number): number {
    return this.base + (this.since === null ? 0 : Math.max(0, now - this.since));
  }

  /** Jumps to `ms` of timeline time, keeping running or paused as it is. */
  seek(ms: number, now: number): void {
    this.base = ms;
    if (this.since !== null) this.since = now;
  }
}
