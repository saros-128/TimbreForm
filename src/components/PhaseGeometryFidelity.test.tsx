import { act, cleanup, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LissajousScope } from "./LissajousScope";

type Props = ComponentProps<typeof LissajousScope>;
type Geometry = "lines" | "cage" | "surface";
type Command = { op: string; values: number[] };
type PaintState = {
  strokeStyle: string;
  fillStyle: string;
  lineWidth: number;
  globalAlpha: number;
  shadowBlur: number;
  shadowColor: string;
  globalCompositeOperation: string;
};
type Paint = { path: Command[]; state: PaintState };
type Frame = { strokes: Paint[]; fills: Paint[]; rectangles: Paint[] };
type Snapshot = Frame & { filter: string; opacity: string };

const COLOR = "#51acdd";
const GEOMETRIES: Geometry[] = ["lines", "cage", "surface"];

// Several slightly different turns of one measured trace, rather than a
// perfectly repeated circle whose connecting faces have zero area.
function trace(variant = 0) {
  const count = 720;
  return {
    x: Float32Array.from({ length: count }, (_, index) => {
      const phase = (index / 80) * Math.PI * 2;
      const radius = 0.4 + (index / count) * 0.28;
      return (
        radius *
        (Math.sin(phase) + (0.12 + variant * 0.16) * Math.sin(phase * 3))
      );
    }),
    y: Float32Array.from({ length: count }, (_, index) => {
      const phase = (index / 80) * Math.PI * 2;
      const radius = 0.4 + (index / count) * 0.28;
      return (
        radius *
        (Math.cos(phase) + (0.08 + variant * 0.12) * Math.cos(phase * 2))
      );
    }),
  };
}

function canvasRecorder() {
  let state: PaintState = {
    strokeStyle: "#000",
    fillStyle: "#000",
    lineWidth: 1,
    globalAlpha: 1,
    shadowBlur: 0,
    shadowColor: "transparent",
    globalCompositeOperation: "source-over",
  };
  let path: Command[] = [];
  const stack: PaintState[] = [];
  let frame: Frame = { strokes: [], fills: [], rectangles: [] };
  const record = () => ({
    path: path.map((command) => ({
      op: command.op,
      values: [...command.values],
    })),
    state: { ...state },
  });
  const command = (op: string, values: number[]) => path.push({ op, values });
  const context = {
    setTransform() {
      frame = { strokes: [], fills: [], rectangles: [] };
    },
    save() {
      stack.push({ ...state });
    },
    restore() {
      state = stack.pop() ?? state;
    },
    clearRect() {},
    fillRect(...values: number[]) {
      frame.rectangles.push({
        path: [{ op: "rect", values }],
        state: { ...state },
      });
    },
    beginPath() {
      path = [];
    },
    closePath() {
      command("close", []);
    },
    moveTo(...values: number[]) {
      command("move", values);
    },
    lineTo(...values: number[]) {
      command("line", values);
    },
    bezierCurveTo(...values: number[]) {
      command("bezier", values);
    },
    arc(...values: number[]) {
      command("arc", values);
    },
    ellipse(...values: number[]) {
      command("ellipse", values);
    },
    stroke() {
      frame.strokes.push(record());
    },
    fill() {
      frame.fills.push(record());
    },
    setLineDash() {},
  };
  for (const key of Object.keys(state) as (keyof PaintState)[]) {
    Object.defineProperty(context, key, {
      get: () => state[key],
      set: (value: never) => {
        state[key] = value;
      },
      configurable: true,
    });
  }
  return {
    context: context as unknown as CanvasRenderingContext2D,
    frame: () => frame,
  };
}

function paintKey(paint: Paint) {
  return JSON.stringify(paint);
}
function originalStrokes(snapshot: Snapshot, color = COLOR) {
  return snapshot.strokes.filter((paint) => paint.state.strokeStyle === color);
}
function endpoints(paints: Paint[]) {
  return paints.flatMap((paint) =>
    paint.path.flatMap((command) => {
      if (command.op === "move" || command.op === "line")
        return [command.values.slice(0, 2)];
      if (command.op === "bezier") return [command.values.slice(-2)];
      return [];
    }),
  );
}
function vertexKey(point: number[]) {
  return point.map((value) => value.toFixed(6)).join(",");
}

function expectPreservedStrokes(
  reference: Snapshot,
  actual: Snapshot,
  color = COLOR,
) {
  const expected = originalStrokes(reference, color).map(paintKey);
  const actualKeys = actual.strokes.map(paintKey);
  expect(expected.length).toBeGreaterThan(0);
  for (const key of expected) expect(actualKeys).toContain(key);
  return new Set(expected);
}

function expectMeshUsesSource(
  reference: Snapshot,
  actual: Snapshot,
  geometry: Geometry,
  color = COLOR,
) {
  const sourceKeys = expectPreservedStrokes(reference, actual, color);
  if (geometry === "lines") return;
  const bridges = actual.strokes.filter(
    (paint) =>
      paint.state.strokeStyle === color && !sourceKeys.has(paintKey(paint)),
  );
  const faces = actual.fills.filter(
    (paint) =>
      paint.state.fillStyle === color &&
      paint.path.some((command) => command.op === "line"),
  );
  expect(bridges.length).toBeGreaterThan(0);
  if (geometry === "surface") expect(faces.length).toBeGreaterThan(0);
  const sourceVertices = new Set(
    endpoints(originalStrokes(reference, color)).map(vertexKey),
  );
  const addedVertices = endpoints([...bridges, ...faces]);
  expect(addedVertices.length).toBeGreaterThan(0);
  for (const point of addedVertices)
    expect(sourceVertices.has(vertexKey(point))).toBe(true);
}

describe("phase geometry retains the original portrait", () => {
  let callbacks: FrameRequestCallback[];
  let clock: number;
  let recorders: WeakMap<HTMLCanvasElement, ReturnType<typeof canvasRecorder>>;

  beforeEach(() => {
    callbacks = [];
    clock = 100;
    recorders = new WeakMap();
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      function (this: HTMLCanvasElement) {
        if (!recorders.has(this)) recorders.set(this, canvasRecorder());
        return recorders.get(this)!.context;
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 640,
      bottom: 480,
      left: 0,
      width: 640,
      height: 480,
      toJSON: () => ({}),
    });
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callbacks.push(callback);
        return callbacks.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function flush() {
    const pending = callbacks.splice(0);
    act(() => pending.forEach((callback) => callback(clock)));
  }

  function mount(geometry: Geometry, overrides: Partial<Props> = {}) {
    clock = 100;
    const props: Props = {
      ...trace(),
      color: COLOR,
      phaseGeometry: geometry,
      phaseRotation: 0,
      phaseLayerMotion: 0,
      ...overrides,
    };
    const view = render(<LissajousScope {...props} />);
    const canvas = view.container.querySelector("canvas")!;
    flush();
    const snapshot = (): Snapshot => ({
      ...structuredClone(recorders.get(canvas)!.frame()),
      filter: canvas.style.filter,
      opacity: canvas.style.opacity,
    });
    return { view, snapshot, props };
  }

  function capture(geometry: Geometry, overrides: Partial<Props> = {}) {
    const instance = mount(geometry, overrides);
    const result = instance.snapshot();
    instance.view.unmount();
    return result;
  }

  it.each(["classic", "spatial"] as const)(
    "adds bridges to the same %s source vertices without replacing any stroke",
    (phasePreset) => {
      const options = {
        phasePreset,
        phaseTilt: 0.4,
        phaseBend: 0.7,
        phaseEnergy: 0.6,
      };
      const reference = capture("lines", options);
      for (const geometry of GEOMETRIES)
        expectMeshUsesSource(reference, capture(geometry, options), geometry);
    },
  );

  it("attaches each colored note only to its own original contour", () => {
    const options: Partial<Props> = {
      x: new Float32Array(),
      y: new Float32Array(),
      layers: [
        { ...trace(), color: COLOR, pitchClass: 0, opacity: 0.7 },
        { ...trace(1), color: "#c47ff3", pitchClass: 7, opacity: 0.85 },
      ],
      phasePreset: "spatial",
      phaseTilt: 0.4,
      phaseBend: 0.7,
      phaseAxisDiversity: 0.8,
      phaseLayerMotion: 0.5,
      phaseEnergy: 0.6,
    };
    const reference = capture("lines", options);
    for (const geometry of GEOMETRIES) {
      const result = capture(geometry, options);
      for (const color of [COLOR, "#c47ff3"])
        expectMeshUsesSource(reference, result, geometry, color);
    }
  });

  it("retains the original detail reduction and spline in every geometry", () => {
    const high = capture("lines", { phaseDetail: 1 });
    const low = capture("lines", { phaseDetail: 0.25 });
    expect(endpoints(originalStrokes(low)).length).toBeLessThan(
      endpoints(originalStrokes(high)).length,
    );
    expect(
      originalStrokes(low).some((paint) =>
        paint.path.some((command) => command.op === "bezier"),
      ),
    ).toBe(true);
    for (const geometry of GEOMETRIES) {
      expectPreservedStrokes(high, capture(geometry, { phaseDetail: 1 }));
      expectPreservedStrokes(low, capture(geometry, { phaseDetail: 0.25 }));
    }
  });

  it.each(["phaseTilt", "phaseBend"] as const)(
    "moves the original contour and its attached mesh together when %s changes",
    (control) => {
      const before = {
        phasePreset: "spatial" as const,
        phaseTilt: 0.15,
        phaseBend: 0.2,
        phaseEnergy: 0.7,
      };
      const after = { ...before, [control]: 0.95 };
      const referenceBefore = capture("lines", before);
      const referenceAfter = capture("lines", after);
      expect(endpoints(originalStrokes(referenceAfter))).not.toEqual(
        endpoints(originalStrokes(referenceBefore)),
      );
      for (const geometry of GEOMETRIES) {
        const first = capture(geometry, before);
        const second = capture(geometry, after);
        expectMeshUsesSource(referenceBefore, first, geometry);
        expectMeshUsesSource(referenceAfter, second, geometry);
        expect(second.strokes.map(paintKey)).not.toEqual(
          first.strokes.map(paintKey),
        );
      }
    },
  );

  it.each(GEOMETRIES)(
    "keeps width, halo, blur, brightness and opacity effective in %s",
    (geometry) => {
      const settings = {
        phaseLineWidth: 2.5,
        phaseGlow: 2.2,
        phaseBlur: 3,
        phaseBrightness: 1.8,
        phaseOpacity: 0.45,
      };
      const normal = capture("lines");
      const adjusted = capture("lines", settings);
      const result = capture(geometry, settings);
      expect(
        Math.max(
          ...originalStrokes(adjusted).map((paint) => paint.state.lineWidth),
        ),
      ).toBeGreaterThan(
        Math.max(
          ...originalStrokes(normal).map((paint) => paint.state.lineWidth),
        ),
      );
      expect(
        Math.max(
          ...originalStrokes(adjusted).map((paint) => paint.state.shadowBlur),
        ),
      ).toBeGreaterThan(
        Math.max(
          ...originalStrokes(normal).map((paint) => paint.state.shadowBlur),
        ),
      );
      expectPreservedStrokes(adjusted, result);
      expect(result.filter).toContain("blur(3px)");
      expect(result.filter).toContain("brightness(1.8)");
      expect(result.opacity).toBe("0.45");
    },
  );

  it.each(GEOMETRIES)("retains actual trail compositing in %s", (geometry) => {
    const short = capture(geometry, { persistence: 0.2 });
    const long = capture(geometry, { persistence: 0.9 });
    const eraseAlpha = (snapshot: Snapshot) =>
      snapshot.rectangles.find(
        (paint) => paint.state.globalCompositeOperation === "destination-out",
      )?.state.globalAlpha;
    expect(eraseAlpha(short)).toBeCloseTo(0.8);
    expect(eraseAlpha(long)).toBeCloseTo(0.1);
  });

  function changedSignal(geometry: Geometry, phaseSpeed: number) {
    const instance = mount(geometry, { phaseSpeed });
    const before = instance.snapshot();
    clock = 116;
    instance.view.rerender(
      <LissajousScope {...instance.props} {...trace(1)} />,
    );
    flush();
    const after = instance.snapshot();
    instance.view.unmount();
    return { before, after };
  }

  it("uses the same speed-controlled response to a changed signal in every geometry", () => {
    const slow = changedSignal("lines", 0.1);
    const fast = changedSignal("lines", 1);
    expect(endpoints(originalStrokes(slow.after))).not.toEqual(
      endpoints(originalStrokes(slow.before)),
    );
    expect(endpoints(originalStrokes(slow.after))).not.toEqual(
      endpoints(originalStrokes(fast.after)),
    );
    for (const geometry of GEOMETRIES) {
      expectPreservedStrokes(slow.after, changedSignal(geometry, 0.1).after);
      expectPreservedStrokes(fast.after, changedSignal(geometry, 1).after);
    }
  });
});
