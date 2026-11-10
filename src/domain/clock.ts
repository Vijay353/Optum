/**
 * Clock seam (V3 CH-0B). Business code asks a Clock for the time instead of
 * reading the wall clock, so scenarios and tests are deterministic.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock that only moves when told to. Used by tests. */
export class ManualClock implements Clock {
  private t: number;
  constructor(start: Date | string) {
    this.t = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.t);
  }
  set(to: Date | string): void {
    this.t = new Date(to).getTime();
  }
  advance(ms: number): void {
    this.t += ms;
  }
}
