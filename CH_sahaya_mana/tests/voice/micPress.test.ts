import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMicPress } from "@/lib/voice/micPress";

describe("mic hold gesture", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("leaves a normal tap to the existing recording click handler", () => {
    const start = vi.fn(); const p = createMicPress();
    p.down(0, 0, start); vi.advanceTimersByTime(200); p.up();
    expect(p.consumeClick()).toBe(false);
    vi.runAllTimers(); expect(start).not.toHaveBeenCalled();
  });
  it("starts hands-free once, suppressing the following click", () => {
    const start = vi.fn(); const p = createMicPress();
    p.down(0, 0, start); vi.advanceTimersByTime(650); vi.advanceTimersByTime(2000); p.up();
    expect(start).toHaveBeenCalledTimes(1);
    expect(p.consumeClick()).toBe(true);
    expect(p.consumeClick()).toBe(false);
  });
  it("cancels on scrolling/movement without starting recording on release", () => {
    const start = vi.fn(); const p = createMicPress();
    p.down(0, 0, start); p.move(0, 20); vi.runAllTimers(); p.up();
    expect(start).not.toHaveBeenCalled(); expect(p.consumeClick()).toBe(true);
  });
  it("cancels on pointer cancellation or unmount", () => {
    const start = vi.fn(); const p = createMicPress();
    p.down(0, 0, start); p.cancel(); vi.runAllTimers();
    expect(start).not.toHaveBeenCalled(); expect(p.consumeClick()).toBe(true);
  });
  it("allows a fresh tap after a hold or cancellation", () => {
    const start = vi.fn(); const p = createMicPress();
    p.down(0, 0, start); p.cancel(); p.down(0, 0, start); p.up();
    expect(p.consumeClick()).toBe(false);
  });
});
