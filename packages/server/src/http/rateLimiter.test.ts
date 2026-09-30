import { describe, expect, it } from "vitest";
import { RateLimiter, sharedRateLimiter } from "./rateLimiter.js";

/** A clock that only moves when the limiter sleeps. */
function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("RateLimiter", () => {
  it("lets the limit through at once and makes the next request wait for the window", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(3, 60_000, clock.now, clock.sleep);
    for (let i = 0; i < 3; i++) {
      await limiter.acquire();
    }
    expect(clock.sleeps).toEqual([]);
    await limiter.acquire();
    expect(clock.sleeps).toEqual([60_000]);
    expect(limiter.requests).toBe(4);
    expect(limiter.waitedMs).toBe(60_000);
  });

  it("never allows more than the limit in any window", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(5, 1000, clock.now, clock.sleep);
    const times: number[] = [];
    for (let i = 0; i < 23; i++) {
      await limiter.acquire();
      times.push(clock.now());
      clock.advance(37);
    }
    for (const start of times) {
      expect(times.filter((t) => t >= start && t < start + 1000).length).toBeLessThanOrEqual(5);
    }
  });

  it("serves concurrent callers in order", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(2, 1000, clock.now, clock.sleep);
    const order: number[] = [];
    await Promise.all([1, 2, 3, 4].map((n) => limiter.acquire().then(() => order.push(n))));
    expect(order).toEqual([1, 2, 3, 4]);
    expect(clock.now()).toBe(1000);
  });

  it("pauses everyone after a 429", async () => {
    const clock = fakeClock();
    const limiter = new RateLimiter(100, 60_000, clock.now, clock.sleep);
    await limiter.acquire();
    limiter.pauseFor(5000);
    await limiter.acquire();
    expect(clock.sleeps).toEqual([5000]);
  });

  it("is shared per TestRail instance and follows the latest limit", () => {
    const a = sharedRateLimiter("https://shop.testrail.io/", 180);
    const b = sharedRateLimiter("https://SHOP.testrail.io/index.php", 300);
    expect(a).toBe(b);
    expect(a.requestsPerWindow).toBe(300);
    expect(sharedRateLimiter("https://other.testrail.io/", 180)).not.toBe(a);
  });
});
