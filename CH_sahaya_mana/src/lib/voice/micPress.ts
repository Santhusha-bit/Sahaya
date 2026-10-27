/** Distinguishes a normal mic click from an intentional 650ms hold. No audio is started here. */
export function createMicPress(delayMs = 650) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let suppressed = false;
  let origin: { x: number; y: number } | null = null;
  const clear = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  return {
    down(x: number, y: number, onHold: () => void) {
      clear();
      suppressed = false;
      origin = { x, y };
      timer = setTimeout(() => {
        timer = undefined;
        suppressed = true;
        origin = null;
        onHold();
      }, delayMs);
    },
    move(x: number, y: number) {
      if (origin && Math.hypot(x - origin.x, y - origin.y) > 10) {
        clear(); origin = null; suppressed = true;
      }
    },
    up() { clear(); origin = null; },
    cancel() { clear(); origin = null; suppressed = true; },
    consumeClick() {
      const result = suppressed;
      suppressed = false;
      return result;
    },
  };
}
