import { describe, expect, it } from "vitest";
import {
  admitFlightGate,
  advanceFlightGateDepth,
  advanceFlightGateEcho,
  canLaunchFlightGate,
  deriveFractalFlightParameters,
  findCyclicTraceOffset,
  flightGateCoastAlpha,
  flightGateHandoffProgress,
  flightGateHandoffWeights,
  flightGateMorphAlpha,
  flightGateMorphStrength,
  flightGateOpacity,
  morphTracePointsInPlace,
  repellingJuliaFixedPoint,
  resampleCyclicTraceInto,
  writeFlightGateEchoTarget,
  FLIGHT_GATE_COAST_DEPTH,
  FLIGHT_GATE_EXIT_DEPTH,
  FLIGHT_GATE_FULL_LIVE_DEPTH,
  FLIGHT_GATE_MIN_DEPTH_GAP,
  FLIGHT_GATE_MIN_SPAWN_INTERVAL_MS,
  FLIGHT_GATE_NEAR_MORPH_FLOOR,
  FLIGHT_GATE_START_DEPTH,
  projectGatePoint,
  type FractalControlNote,
  type GatePose,
} from "./fractalFlightModel";

function note(
  pitchClass: number,
  frequency: number,
  confidence = 0.9,
  amplitude = 0.7,
): FractalControlNote {
  return { pitchClass, frequency, confidence, amplitude };
}

const identityPose: GatePose = {
  depth: 4,
  offsetX: 0,
  offsetY: 0,
  yaw: 0,
  pitch: 0,
  roll: 0,
  scale: 2,
};

describe("fractal flight controls", () => {
  it("returns deterministic neutral controls for an empty frame", () => {
    const first = deriveFractalFlightParameters([], Number.NaN);
    const second = deriveFractalFlightParameters([], Number.NaN);

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      cX: -0.74543,
      cY: 0.11301,
      hue: 210,
      warp: 0.08,
      speed: 0.13,
      energy: 0,
      noteCount: 0,
      family: 0.28,
      zoomDirection: 0.14,
    });
  });

  it("is input-order independent and keeps every output bounded", () => {
    const notes = [
      note(0, 261.63, 0.93, 0.8),
      note(4, 329.63, 0.88, 0.65),
      note(7, 392, 0.9, 0.72),
    ];
    const forward = deriveFractalFlightParameters(notes, 0.36);
    const reverse = deriveFractalFlightParameters([...notes].reverse(), 0.36);

    expect(forward).toEqual(reverse);
    expect(forward.noteCount).toBe(3);
    // c is constrained to the main-cardioid boundary parameterisation used
    // by the canonical quadratic map z -> z^2 + c.
    expect(forward.cX).toBeGreaterThanOrEqual(-0.75);
    expect(forward.cX).toBeLessThanOrEqual(0.25);
    expect(forward.cY).toBeGreaterThanOrEqual(-0.66);
    expect(forward.cY).toBeLessThanOrEqual(0.66);
    expect(forward.hue).toBeGreaterThanOrEqual(0);
    expect(forward.hue).toBeLessThan(360);
    expect(forward.warp).toBeGreaterThanOrEqual(0.06);
    expect(forward.warp).toBeLessThanOrEqual(0.95);
    expect(forward.speed).toBeGreaterThanOrEqual(0.08);
    expect(forward.speed).toBeLessThanOrEqual(1.15);
    expect(forward.energy).toBeGreaterThanOrEqual(0);
    expect(forward.energy).toBeLessThanOrEqual(1);
    expect(forward.family).toBeGreaterThanOrEqual(0);
    expect(forward.family).toBeLessThanOrEqual(1);
    expect(forward.zoomDirection).toBeGreaterThanOrEqual(-1);
    expect(forward.zoomDirection).toBeLessThanOrEqual(1);
  });

  it("rejects invalid controls, merges octaves, and caps polyphony", () => {
    const controls = Array.from({ length: 12 }, (_, pitchClass) =>
      note(pitchClass, 110 * 2 ** (pitchClass / 12)),
    );
    controls.push(note(0, 440, 1, 1));
    controls.push(note(2, Number.NaN));
    controls.push(note(3, 220, 0, 1));

    const parameters = deriveFractalFlightParameters(controls, 50);

    expect(parameters.noteCount).toBe(8);
    expect(parameters.energy).toBeGreaterThan(0.9);
    expect(parameters.energy).toBeLessThanOrEqual(1);
  });

  it("maps different tones to different fractal families and zoom directions", () => {
    const c = deriveFractalFlightParameters([note(0, 261.63)], 0.42);
    const e = deriveFractalFlightParameters([note(4, 329.63)], 0.42);
    const g = deriveFractalFlightParameters([note(7, 392)], 0.42);

    expect(new Set([c.family, e.family, g.family]).size).toBe(3);
    expect(c.zoomDirection).toBeGreaterThan(0);
    expect(g.zoomDirection).toBeLessThan(0);
  });

  it("derives a repelling fixed point of the canonical quadratic map", () => {
    for (const controls of [
      [],
      [note(0, 261.63)],
      [note(4, 329.63), note(7, 392)],
    ]) {
      const { cX, cY } = deriveFractalFlightParameters(controls, 0.42);
      const fixedPoint = repellingJuliaFixedPoint(cX, cY);
      const squaredX =
        fixedPoint.x * fixedPoint.x - fixedPoint.y * fixedPoint.y + cX;
      const squaredY = 2 * fixedPoint.x * fixedPoint.y + cY;

      expect(squaredX).toBeCloseTo(fixedPoint.x, 10);
      expect(squaredY).toBeCloseTo(fixedPoint.y, 10);
      expect(2 * Math.hypot(fixedPoint.x, fixedPoint.y)).toBeGreaterThan(1);
    }
  });
});

describe("gate projection", () => {
  it("projects an unrotated gate with perspective around screen centre", () => {
    expect(projectGatePoint(1, 1, identityPose, 800, 600)).toEqual({
      x: 670,
      y: 30,
      visible: true,
    });
    expect(projectGatePoint(0, 0, identityPose, 800, 600)).toEqual({
      x: 400,
      y: 300,
      visible: true,
    });
  });

  it("applies roll and yaw before perspective projection", () => {
    const rolled = projectGatePoint(
      1,
      0,
      { ...identityPose, depth: 2, scale: 1, roll: Math.PI / 2 },
      800,
      400,
    );
    expect(rolled.x).toBeCloseTo(400, 12);
    expect(rolled.y).toBeCloseTo(20, 12);

    const yawed = projectGatePoint(
      1,
      0,
      { ...identityPose, yaw: Math.PI / 2, scale: 1 },
      800,
      600,
    );
    expect(yawed.x).toBeCloseTo(400, 12);
    expect(yawed.y).toBeCloseTo(300, 12);
    expect(yawed.visible).toBe(true);
  });

  it("marks points behind the near plane and invalid viewports as hidden", () => {
    expect(
      projectGatePoint(0, 0, { ...identityPose, depth: 0.01 }, 800, 600),
    ).toEqual({ x: 400, y: 300, visible: false });
    expect(projectGatePoint(0, 0, identityPose, 0, 600)).toEqual({
      x: 0,
      y: 300,
      visible: false,
    });
  });
});

describe("flight gate lifecycle", () => {
  it("admits up to capacity without mutating or replacing existing gates", () => {
    const first = { id: 1, depth: 1.2 };
    const second = { id: 2, depth: 4.8 };
    const existing = Object.freeze([first, second]);

    const admitted = admitFlightGate(existing, { id: 3, depth: 6.4 }, 3);

    expect(existing).toEqual([first, second]);
    expect(admitted).not.toBe(existing);
    expect(admitted).toEqual([first, second, { id: 3, depth: 6.4 }]);
    expect(admitted[0]).toBe(first);
    expect(admitted[1]).toBe(second);

    const atCapacity = admitFlightGate(
      admitted,
      { id: 4, depth: 7.2 },
      3,
    );
    expect(atCapacity).toBe(admitted);
    expect(atCapacity).toEqual([first, second, { id: 3, depth: 6.4 }]);
  });

  it("moves monotonically from the far spawn point past the exit in five to eight seconds", () => {
    const frameSeconds = 1 / 60;
    const speedControl = 0.75;
    let elapsedSeconds = 0;
    let depth = FLIGHT_GATE_START_DEPTH;

    while (depth > FLIGHT_GATE_EXIT_DEPTH && elapsedSeconds < 10) {
      const nextDepth = advanceFlightGateDepth(
        depth,
        frameSeconds,
        speedControl,
      );
      expect(nextDepth).toBeLessThan(depth);
      depth = nextDepth;
      elapsedSeconds += frameSeconds;
    }

    expect(depth).toBeLessThanOrEqual(FLIGHT_GATE_EXIT_DEPTH);
    expect(elapsedSeconds).toBeGreaterThanOrEqual(5);
    expect(elapsedSeconds).toBeLessThanOrEqual(8);
  });

  it("keeps the launch plane clear in both time and depth", () => {
    const launchBoundary =
      FLIGHT_GATE_START_DEPTH - FLIGHT_GATE_MIN_DEPTH_GAP;

    expect(canLaunchFlightGate([], Number.POSITIVE_INFINITY)).toBe(true);
    expect(
      canLaunchFlightGate(
        [{ depth: launchBoundary }],
        FLIGHT_GATE_MIN_SPAWN_INTERVAL_MS,
      ),
    ).toBe(true);
    expect(
      canLaunchFlightGate(
        [{ depth: launchBoundary + 0.01 }],
        FLIGHT_GATE_MIN_SPAWN_INTERVAL_MS,
      ),
    ).toBe(false);
    expect(
      canLaunchFlightGate(
        [{ depth: launchBoundary - 0.2 }],
        FLIGHT_GATE_MIN_SPAWN_INTERVAL_MS - 1,
      ),
    ).toBe(false);
  });

  it("fades distant gates in, stays opaque near the camera, and fades only after passing it", () => {
    const cameraNearPlane = 0.05;
    const halfwayBehindCamera = FLIGHT_GATE_EXIT_DEPTH / 2;

    expect(flightGateOpacity(FLIGHT_GATE_START_DEPTH)).toBeGreaterThan(0.3);
    expect(flightGateOpacity(FLIGHT_GATE_START_DEPTH)).toBeLessThan(0.5);
    expect(flightGateOpacity(4)).toBe(1);
    expect(flightGateOpacity(cameraNearPlane)).toBe(1);
    expect(flightGateOpacity(0)).toBe(1);
    expect(flightGateOpacity(halfwayBehindCamera)).toBeGreaterThan(0);
    expect(flightGateOpacity(halfwayBehindCamera)).toBeLessThan(1);
    expect(flightGateOpacity(FLIGHT_GATE_EXIT_DEPTH)).toBe(0);
  });
});

describe("live flight-gate geometry", () => {
  it("morphs fully in the distance and keeps breathing near the camera", () => {
    expect(flightGateMorphStrength(FLIGHT_GATE_START_DEPTH)).toBe(1);
    expect(flightGateMorphStrength(FLIGHT_GATE_FULL_LIVE_DEPTH)).toBe(1);
    expect(flightGateMorphStrength(FLIGHT_GATE_COAST_DEPTH)).toBeGreaterThan(
      FLIGHT_GATE_NEAR_MORPH_FLOOR,
    );
    expect(flightGateMorphStrength(FLIGHT_GATE_COAST_DEPTH)).toBeLessThan(1);
    expect(flightGateMorphStrength(0)).toBe(FLIGHT_GATE_NEAR_MORPH_FLOOR);
    expect(flightGateMorphStrength(-10)).toBe(
      FLIGHT_GATE_NEAR_MORPH_FLOOR,
    );
    expect(flightGateMorphStrength(Number.NaN)).toBe(0);
  });

  it("uses frame-rate-independent smoothing without freezing near gates", () => {
    const depth = FLIGHT_GATE_START_DEPTH;
    const oneStepAlpha = flightGateMorphAlpha(depth, 1 / 30);
    const halfStepAlpha = flightGateMorphAlpha(depth, 1 / 60);
    const composedHalfSteps = 1 - (1 - halfStepAlpha) ** 2;

    expect(oneStepAlpha).toBeCloseTo(composedHalfSteps, 12);
    expect(oneStepAlpha).toBeGreaterThan(0);
    expect(oneStepAlpha).toBeLessThan(1);
    expect(flightGateMorphAlpha(0, 1 / 60)).toBeGreaterThan(0);
  });

  it("enters and leaves echo mode smoothly with frame-rate-independent steps", () => {
    const oneStep = advanceFlightGateEcho(0, false, 1 / 30);
    const halfStep = advanceFlightGateEcho(0, false, 1 / 60);
    const composedHalfSteps =
      halfStep + (1 - halfStep) * advanceFlightGateEcho(0, false, 1 / 60);

    expect(oneStep).toBeCloseTo(composedHalfSteps, 12);
    expect(oneStep).toBeGreaterThan(0);
    expect(oneStep).toBeLessThan(1);
    expect(advanceFlightGateEcho(oneStep, true, 1 / 30)).toBeLessThan(
      oneStep,
    );

    const coastOneStep = flightGateCoastAlpha(1 / 30);
    const coastHalfStep = flightGateCoastAlpha(1 / 60);
    expect(coastOneStep).toBeCloseTo(
      1 - (1 - coastHalfStep) ** 2,
      12,
    );
    expect(coastOneStep).toBeGreaterThan(0);
    expect(coastOneStep).toBeLessThan(1);
  });

  it("writes a finite, bounded autonomous echo into the existing buffer", () => {
    const anchor = Float32Array.of(
      1, 0,
      0.7, 0.7,
      0, 1,
      -0.7, 0.7,
      -1, 0,
      -0.7, -0.7,
      0, -1,
      0.7, -0.7,
    );
    const target = new Float32Array(anchor.length);
    const targetIdentity = target.buffer;

    writeFlightGateEchoTarget(anchor, target, 7, 19, 0.8, 3, 0);
    expect(target.buffer).toBe(targetIdentity);
    expect([...target]).toEqual([...anchor]);

    writeFlightGateEchoTarget(anchor, target, 7, 19, 1.4, 3, 1);
    expect(target.buffer).toBe(targetIdentity);
    expect([...target].every(Number.isFinite)).toBe(true);
    expect(
      [...target].some((value, index) => Math.abs(value - anchor[index]) > 1e-4),
    ).toBe(true);
    target.forEach((value, index) => {
      expect(Math.abs(value - anchor[index])).toBeLessThan(0.2);
    });
  });

  it("crossfades exactly once while the front gate passes the camera", () => {
    expect(flightGateHandoffProgress(1.65)).toBe(0);
    expect(flightGateHandoffProgress(1.05)).toBeCloseTo(0.5, 12);
    expect(flightGateHandoffProgress(0.45)).toBe(1);
    expect(flightGateHandoffProgress(10)).toBe(0);
    expect(flightGateHandoffProgress(-10)).toBe(1);
    expect(flightGateHandoffProgress(Number.NaN)).toBe(1);
  });

  it("hands portraits over through the fractal instead of overlapping traces", () => {
    const distant = flightGateHandoffWeights(1.65);
    const midpoint = flightGateHandoffWeights(1.05);
    const passed = flightGateHandoffWeights(0.45);

    expect(distant).toEqual({ front: 1, successor: 0 });
    expect(midpoint).toEqual({ front: 0, successor: 0 });
    expect(passed).toEqual({ front: 0, successor: 1 });
    for (let depth = 0.45; depth <= 1.65; depth += 0.03) {
      const weights = flightGateHandoffWeights(depth);
      expect(weights.front === 0 || weights.successor === 0).toBe(true);
    }
  });

  it("phase-aligns a shifted closed portrait before fixed-size resampling", () => {
    const reference = Float32Array.of(
      1, 0,
      0, 1,
      -1, 0,
      0, -1,
    );
    const shifted = Float32Array.of(
      -1, 0,
      0, -1,
      1, 0,
      0, 1,
    );
    const offset = findCyclicTraceOffset(reference, shifted);
    const target = new Float32Array(reference.length);

    resampleCyclicTraceInto(target, shifted, offset);

    expect(offset).toBe(2);
    expect([...target]).toEqual([...reference]);
  });

  it("resamples into the existing buffer, clamps deformation to the anchor, and morphs in place", () => {
    const anchor = Float32Array.of(0, 0, 1, 0, 0, 1, -1, 0);
    const source = Float32Array.of(5, 5, -5, 5, -5, -5, 5, -5);
    const target = new Float32Array(anchor.length);
    const current = anchor.slice();
    const targetIdentity = target.buffer;
    const currentIdentity = current.buffer;

    resampleCyclicTraceInto(target, source, 0, anchor, 0.25);
    expect(target.buffer).toBe(targetIdentity);
    target.forEach((value, index) => {
      expect(Math.abs(value - anchor[index])).toBeLessThanOrEqual(0.250001);
    });

    expect(morphTracePointsInPlace(current, target, 0.5)).toBe(true);
    expect(current.buffer).toBe(currentIdentity);
    current.forEach((value, index) => {
      expect(value).toBeCloseTo((anchor[index] + target[index]) / 2, 6);
    });
    expect(morphTracePointsInPlace(current, target, 0)).toBe(false);
  });
});
