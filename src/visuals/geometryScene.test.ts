import { describe, it, expect } from "vitest";
import { sceneBufferSize } from "./phaseSurface";
describe("scene resolution", () => {
  it.each(["auto", "high", "economy"] as const)(
    "preserves a wide and tall viewport at DPR 2 in %s",
    (quality) => {
      const budget =
        quality === "high" ? 4000000 : quality === "auto" ? 1800000 : 650000;
      for (const [w, h] of [
        [1600, 700],
        [700, 1600],
      ]) {
        const b = sceneBufferSize(w, h, 2, quality);
        expect(b.width / b.height).toBeCloseTo(w / h, 2);
        expect(b.width * b.height).toBeLessThan(budget + 5000);
        expect(b.width).toBeGreaterThan(500);
        expect(b.height).toBeGreaterThan(500);
      }
    },
  );
});
