import { describe, it, expect } from "vitest";
import { advanceNewtonTravel, newtonCoefficients } from "./newtonNavigation";
import { deriveFractalFlightParameters } from "./fractalFlightModel";

describe("Newton navigation", () => {
  it("integrates ten minutes past the old five-octave limit in both directions without a single reset", () => {
    for (const mode of ["approach", "recede"] as const) {
      let state = { logZoom: 1.6, phase: 0, direction: 1 as 1 | -1 };
      for (let frame = 0; frame < 36_000; frame++) {
        const next = advanceNewtonTravel(state, mode, 1 / 60, 1.2);
        expect(next.logZoom - state.logZoom).toBeCloseTo(
          mode === "approach" ? 0.02 : -0.02,
          10,
        );
        state = next;
      }
      expect(state.logZoom).toBeCloseTo(
        1.6 + (mode === "approach" ? 720 : -720),
        7,
      );
    }
  });
  it("changes direction at the current position and rejects elapsed hidden time", () => {
    const start = { logZoom: 99.4, phase: 10, direction: 1 as const };
    expect(advanceNewtonTravel(start, "recede", 0, 1).logZoom).toBe(
      start.logZoom,
    );
    expect(advanceNewtonTravel(start, "approach", 300, 1).logZoom).toBeCloseTo(
      99.5,
    );
    expect(advanceNewtonTravel(start, "approach", 0.02, 0).logZoom).toBe(
      start.logZoom,
    );
  });
  it("changes polynomial geometry for different notes and intensity, with sound-off remaining independent", () => {
    const note = (pitchClass: number, amplitude: number) =>
      deriveFractalFlightParameters(
        [
          {
            pitchClass,
            amplitude,
            frequency: 261.63 * 2 ** (pitchClass / 12),
            confidence: 1,
          },
        ],
        amplitude,
      );
    const c = newtonCoefficients(note(0, 0.8), 1, 0.5, 1);
    const fs = newtonCoefficients(note(6, 0.8), 1, 0.5, 1);
    const quiet = newtonCoefficients(note(0, 0.1), 1, 0.5, 1);
    expect(
      Math.hypot(
        c.p.x - fs.p.x,
        c.p.y - fs.p.y,
        c.q.x - fs.q.x,
        c.q.y - fs.q.y,
      ),
    ).toBeGreaterThan(0.1);
    expect(c).not.toEqual(quiet);
    expect(newtonCoefficients(note(0, 0.8), 1, 0.5, 0)).toEqual(
      newtonCoefficients(note(6, 0.1), 1, 0.5, 0),
    );
    // The selected derivative pole actually solves 3c²+p=0.
    for (let pitchClass = 0; pitchClass < 12; pitchClass++) {
      const { p, focus: f } = newtonCoefficients(
        note(pitchClass, 0.8),
        1,
        1,
        2,
      );
      expect(3 * (f.x * f.x - f.y * f.y) + p.x).toBeCloseTo(0, 12);
      expect(6 * f.x * f.y + p.y).toBeCloseTo(0, 12);
      expect(f.x).toBeGreaterThan(0.1);
    }
  });
});
