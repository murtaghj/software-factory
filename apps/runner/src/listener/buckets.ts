// Token buckets and a bounded table of them (W-019, "The listener"). Tables are bounded and evict the least recently used entry when full;
// they never refuse a new source or pod. Keys are never logged and never become a counter name.
// A rate or a burst that is not a finite number above zero would make a bucket that never empties (NaN) or never fills (0): both refused here.
function assertRate(perSecond: number, burst: number): void {
  if (typeof perSecond !== 'number' || typeof burst !== 'number' || !Number.isFinite(perSecond) || !Number.isFinite(burst) || perSecond <= 0 || burst <= 0) throw new RangeError('a token bucket needs a finite rate and burst above zero');
}

export class TokenBucket {
  #tokens: number;
  #at: number;
  #perSecond: number;
  #burst: number;
  constructor(perSecond: number, burst: number, now: number) {
    assertRate(perSecond, burst);
    this.#perSecond = perSecond; this.#burst = burst; this.#tokens = burst; this.#at = now;
  }
  // A new rate with the tokens carried over (never above the new burst): a resize is not a refill.
  resize(perSecond: number, burst: number, now: number): void {
    assertRate(perSecond, burst);
    this.#tokens = Math.min(burst, Math.min(this.#burst, this.#tokens + ((now - this.#at) / 1000) * this.#perSecond));
    this.#at = now; this.#perSecond = perSecond; this.#burst = burst;
  }
  take(now: number): boolean {
    this.#tokens = Math.min(this.#burst, this.#tokens + ((now - this.#at) / 1000) * this.#perSecond);
    this.#at = now;
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}

export class BucketTable {
  readonly #map = new Map<string, TokenBucket>();
  readonly #max: number;
  readonly #perSecond: number;
  readonly #burst: number;
  constructor(max: number, perSecond: number, burst: number) { assertRate(perSecond, burst); this.#max = max; this.#perSecond = perSecond; this.#burst = burst; }
  get size(): number { return this.#map.size; }
  take(key: string, now: number): boolean {
    let b = this.#map.get(key);
    if (b) this.#map.delete(key); // most recently used goes last
    else {
      b = new TokenBucket(this.#perSecond, this.#burst, now);
      if (this.#map.size >= this.#max) { const oldest = this.#map.keys().next().value; if (oldest !== undefined) this.#map.delete(oldest); }
    }
    this.#map.set(key, b);
    return b.take(now);
  }
}

// An insertion-ordered memory with a size cap: a new entry evicts the oldest. No scan, ever.
export class FailureMemory {
  readonly #map = new Map<string, number>();
  readonly #max: number;
  constructor(max: number) { this.#max = max; }
  get size(): number { return this.#map.size; }
  remembered(key: string, now: number): boolean {
    const until = this.#map.get(key);
    if (until === undefined) return false;
    if (until <= now) { this.#map.delete(key); return false; }
    return true;
  }
  remember(key: string, until: number): void {
    if (this.#map.has(key)) this.#map.delete(key);
    else if (this.#map.size >= this.#max) { const oldest = this.#map.keys().next().value; if (oldest !== undefined) this.#map.delete(oldest); }
    this.#map.set(key, until);
  }
}
