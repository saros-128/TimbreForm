import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FractalFlightScope } from "./FractalFlightScope";

const traceX = Float32Array.of(0, 1, 0, -1, 0);
const traceY = Float32Array.of(1, 0, -1, 0, 1);

function fixedBounds(width = 320, height = 320): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    width,
    height,
    toJSON: () => ({}),
  };
}

function create2dContext() {
  const gradient = {
    addColorStop: vi.fn(),
  } as unknown as CanvasGradient;
  const spies = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    createRadialGradient: vi.fn(() => gradient),
    fillRect: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    filter: "none",
  };
  return {
    context: spies as unknown as CanvasRenderingContext2D,
    spies,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("FractalFlightScope", () => {
  it("remains accessible and keeps both canvas layers when canvas contexts are unavailable", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

    const view = render(
      <FractalFlightScope
        x={traceX}
        y={traceY}
        title="Тестовый полёт"
        meta="TEST FLIGHT"
        ariaLabel="Фрактальная камера тестового сигнала"
        animate={false}
      />,
    );

    expect(
      screen.getByRole("img", {
        name: "Тестовый полёт",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Фрактальная камера тестового сигнала"),
    ).toBeInTheDocument();
    expect(screen.getByText("TEST FLIGHT")).toBeInTheDocument();

    const canvases = view.container.querySelectorAll("canvas");
    expect(canvases).toHaveLength(2);
    expect(canvases[0]).toHaveAttribute("aria-hidden", "true");
    expect(canvases[1]).toHaveAttribute("aria-hidden", "true");
  });

  it("draws the selected hybrid traces in one stationary plane", () => {
    const { context, spies } = create2dContext();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      fixedBounds(),
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      (contextId) => (contextId === "2d" ? context : null),
    );

    render(
      <FractalFlightScope
        x={traceX}
        y={traceY}
        layers={[
          {
            x: traceX,
            y: traceY,
            color: "#58bff5",
            pitchClass: 7,
            opacity: 0.88,
          },
        ]}
        frameId={1}
        animate={false}
      />,
    );

    const scope = screen.getByRole("img", { name: "Фрактальный полёт" });
    expect(spies.createRadialGradient).toHaveBeenCalled();
    expect(spies.fillRect).toHaveBeenCalled();
    expect(spies.stroke).toHaveBeenCalled();
    expect(scope).toHaveAttribute("data-phase-mode", "fixed-live");
    expect(scope).toHaveAttribute("data-fixed-phase-motion", "live");
    expect(scope).toHaveAttribute("data-phase-source-mode", "hybrid");
    expect(scope).toHaveAttribute("data-phase-trace-count", "2");
    expect(scope).toHaveAttribute("data-phase-signal-count", "1");
    expect(scope).toHaveAttribute("data-phase-note-count", "1");
    expect(scope).toHaveAttribute("data-phase-pitches", "7");
    expect(scope).toHaveAttribute("data-fixed-phase-count", "2");
    expect(scope).toHaveAttribute("data-fixed-phase-visible", "1");
    expect(scope).toHaveAttribute("data-fixed-phase-pitch", "7");
    expect(scope).toHaveAttribute("data-fixed-phase-pose", "stationary");
    expect(scope).toHaveAttribute("data-fixed-phase-depth", "2.550");
    expect(scope).toHaveAttribute(
      "data-fixed-phase-transform",
      "0,0,0,0,0,2.550,1.040",
    );
    expect(scope).toHaveAttribute("data-flight-gates", "0");
    expect(scope).toHaveAttribute("data-flight-gate-states", "[]");
  });

  it("adds user brightness and zoom without replacing autonomous travel", () => {
    const { context, spies } = create2dContext();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      fixedBounds(),
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      (contextId) => (contextId === "2d" ? context : null),
    );

    const view = render(
      <FractalFlightScope
        x={traceX}
        y={traceY}
        fractalBrightness={2.4}
        fractalZoomOffset={0.5}
        fractalMorph={0.35}
        fractalDetailMotion={0.9}
        fractalDensity={0.8}
        fractalSymmetry={0.6}
        fractalSpeed={1.75}
        animate={false}
      />,
    );

    const scope = screen.getByRole("img", { name: "Фрактальный полёт" });
    expect(scope).toHaveAttribute("data-fractal-brightness", "2.400");
    expect(scope).toHaveAttribute("data-fractal-zoom-offset", "0.500");
    expect(scope).toHaveAttribute("data-fractal-base-log-zoom", "1.600");
    expect(scope).toHaveAttribute("data-fractal-log-zoom", "2.225");
    expect(scope).toHaveAttribute("data-fractal-morph-amount", "0.350");
    expect(scope).toHaveAttribute("data-fractal-detail-motion", "0.900");
    expect(scope).toHaveAttribute("data-fractal-density", "0.800");
    expect(scope).toHaveAttribute("data-fractal-symmetry", "0.600");
    expect(scope).toHaveAttribute("data-fractal-speed", "1.750");
    expect(
      Number(scope.getAttribute("data-fractal-detail-count")),
    ).toBeGreaterThan(2);
    expect(
      Number(scope.getAttribute("data-fractal-sector-count")),
    ).toBeGreaterThan(2);
    expect(spies.filter).toBe("brightness(2.4)");
  });

  it("supports directional travel and a clamped sound response", () => {
    const { context, spies } = create2dContext();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      fixedBounds(),
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      (contextId) => (contextId === "2d" ? context : null),
    );

    const view = render(
      <FractalFlightScope
        x={traceX}
        y={traceY}
        fractalBrightness={9}
        fractalSpeed={1.5}
        fractalTravelMode="recede"
        fractalSoundResponse={-1}
        animate={false}
      />,
    );

    const scope = screen.getByRole("img", { name: "Фрактальный полёт" });
    expect(scope).toHaveAttribute("data-fractal-brightness", "3.000");
    expect(scope).toHaveAttribute("data-fractal-travel-mode", "recede");
    expect(scope).toHaveAttribute("data-fractal-sound-response", "0.000");
    expect(scope).toHaveAttribute("data-fractal-base-travel-rate", "0.3000");
    expect(scope).toHaveAttribute(
      "data-fractal-effective-travel-rate",
      "0.3000",
    );
    expect(scope).toHaveAttribute("data-fractal-actual-direction", "-1");
    expect(
      Number(scope.getAttribute("data-fractal-base-log-zoom")),
    ).toBeGreaterThan(1.6);
    expect(spies.filter).toBe("brightness(3)");

    view.rerender(
      <FractalFlightScope
        x={traceX}
        y={traceY}
        fractalBrightness={9}
        fractalSpeed={1.5}
        fractalTravelMode="approach"
        fractalSoundResponse={9}
        animate={false}
      />,
    );

    expect(scope).toHaveAttribute("data-fractal-travel-mode", "approach");
    expect(scope).toHaveAttribute("data-fractal-sound-response", "2.000");
    expect(scope).toHaveAttribute("data-fractal-actual-direction", "1");
    expect(
      Number(scope.getAttribute("data-fractal-effective-travel-rate")),
    ).toBeGreaterThan(
      Number(scope.getAttribute("data-fractal-base-travel-rate")),
    );
  });

  it("moves continuously in the selected one-way direction", () => {
    const { context } = create2dContext();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      fixedBounds(),
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      (contextId) => (contextId === "2d" ? context : null),
    );
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(
      () => undefined,
    );

    const approachView = render(
      <FractalFlightScope
        x={traceX}
        y={traceY}
        fractalSpeed={2}
        fractalTravelMode="approach"
        fractalSoundResponse={0}
      />,
    );
    const approachScope = screen.getByRole("img", {
      name: "Фрактальный полёт",
    });
    act(() => frames.shift()?.(1_000));
    const approachStart = Number(
      approachScope.getAttribute("data-fractal-base-log-zoom"),
    );
    act(() => {
      for (let frame = 1; frame <= 1_200; frame++) {
        frames.shift()?.(1_000 + frame * 50);
        expect(
          Number(approachScope.getAttribute("data-fractal-base-log-zoom")),
        ).toBeGreaterThanOrEqual(approachStart);
      }
    });
    expect(
      Number(approachScope.getAttribute("data-fractal-base-log-zoom")),
    ).toBeGreaterThan(20);
    expect(
      Number(approachScope.getAttribute("data-fractal-base-log-zoom")),
    ).toBeGreaterThan(approachStart);
    approachView.unmount();

    frames.length = 0;
    render(
      <FractalFlightScope
        x={traceX}
        y={traceY}
        fractalSpeed={2}
        fractalTravelMode="recede"
        fractalSoundResponse={0}
      />,
    );
    const recedeScope = screen.getByRole("img", {
      name: "Фрактальный полёт",
    });
    act(() => frames.shift()?.(2_000));
    const recedeStart = Number(
      recedeScope.getAttribute("data-fractal-base-log-zoom"),
    );
    act(() => frames.shift()?.(2_050));
    expect(
      Number(recedeScope.getAttribute("data-fractal-base-log-zoom")),
    ).toBeLessThan(recedeStart);
  });

  it("updates the contour inside one stationary phase plane", () => {
    const { context, spies } = create2dContext();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      fixedBounds(),
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      (contextId) => (contextId === "2d" ? context : null),
    );

    const first = {
      x: traceX,
      y: traceY,
      color: "#58bff5",
      pitchClass: 7,
    } as const;
    const secondX = Float32Array.of(0, 0.75, 1, -0.75, 0);
    const secondY = Float32Array.of(1, -0.4, -1, -0.4, 1);
    const view = render(
      <FractalFlightScope
        x={new Float32Array()}
        y={new Float32Array()}
        layers={[first]}
        frameId={1}
        animate={false}
      />,
    );
    const scope = screen.getByRole("img", { name: "Фрактальный полёт" });
    expect(scope).toHaveAttribute("data-fixed-phase-source-revision", "1");

    const drawsBefore = spies.clearRect.mock.calls.length;
    view.rerender(
      <FractalFlightScope
        x={new Float32Array()}
        y={new Float32Array()}
        layers={[
          {
            x: secondX,
            y: secondY,
            color: "#58bff5",
            pitchClass: 7,
          },
        ]}
        frameId={2}
        animate={false}
      />,
    );

    expect(spies.clearRect.mock.calls.length).toBeGreaterThan(drawsBefore);
    expect(scope).toHaveAttribute("data-fixed-phase-source-revision", "2");
    expect(scope).toHaveAttribute("data-fixed-phase-shape-revision", "1");
    expect(scope).toHaveAttribute("data-fixed-phase-visible", "1");
    expect(scope).toHaveAttribute("data-fixed-phase-pitch", "7");
    expect(scope).toHaveAttribute("data-fixed-phase-color", "#58bff5");
    expect(scope).toHaveAttribute("data-fixed-phase-pose", "stationary");
    expect(scope).toHaveAttribute("data-fixed-phase-depth", "2.550");
    expect(scope).toHaveAttribute("data-flight-gates", "0");
    expect(scope).toHaveAttribute("data-flight-live-gates", "0");
    expect(scope).toHaveAttribute("data-flight-echo-gates", "0");
    expect(scope).toHaveAttribute("data-flight-visible-gates", "0");
    expect(scope).toHaveAttribute("data-flight-prominent-gates", "0");
    expect(scope).toHaveAttribute("data-flight-history-size", "0");
    expect(scope).toHaveAttribute("data-flight-gate-states", "[]");
  });

  it("updates reordered note traces and removes sources that disappeared", () => {
    const { context } = create2dContext();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      fixedBounds(),
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      (contextId) => (contextId === "2d" ? context : null),
    );

    const layers = [
      { x: traceX, y: traceY, color: "#f06f91", pitchClass: 0 },
      { x: traceX, y: traceY, color: "#58bff5", pitchClass: 7 },
    ] as const;
    const view = render(
      <FractalFlightScope
        x={new Float32Array()}
        y={new Float32Array()}
        layers={layers}
        notes={[
          {
            pitchClass: 0,
            frequency: 261.63,
            confidence: 0.94,
            amplitude: 0.82,
          },
          { pitchClass: 7, frequency: 392, confidence: 0.7, amplitude: 0.55 },
        ]}
        frameId={1}
        animate={false}
      />,
    );
    const scope = screen.getByRole("img", { name: "Фрактальный полёт" });
    expect(scope).toHaveAttribute("data-phase-source-mode", "notes");
    expect(scope).toHaveAttribute("data-phase-trace-count", "2");
    expect(scope).toHaveAttribute("data-phase-note-count", "2");
    expect(scope).toHaveAttribute("data-phase-pitches", "0,7");
    expect(scope).toHaveAttribute("data-fixed-phase-pitch", "0");
    expect(scope).toHaveAttribute("data-fixed-phase-color", "#f06f91");

    view.rerender(
      <FractalFlightScope
        x={new Float32Array()}
        y={new Float32Array()}
        layers={[
          {
            x: Float32Array.of(0, 0.55, 1, -0.55, 0),
            y: Float32Array.of(1, 0.25, -1, 0.25, 1),
            color: "#58bff5",
            pitchClass: 7,
          },
          {
            x: Float32Array.of(0, 0.8, 0.25, -0.8, 0),
            y: Float32Array.of(1, -0.15, -1, -0.15, 1),
            color: "#f06f91",
            pitchClass: 0,
          },
        ]}
        notes={[
          {
            pitchClass: 0,
            frequency: 261.63,
            confidence: 0.45,
            amplitude: 0.3,
          },
          { pitchClass: 7, frequency: 392, confidence: 0.96, amplitude: 0.88 },
        ]}
        frameId={2}
        animate={false}
      />,
    );

    expect(scope).toHaveAttribute("data-fixed-phase-pitch", "0");
    expect(scope).toHaveAttribute("data-fixed-phase-color", "#f06f91");
    expect(scope).toHaveAttribute("data-fixed-phase-visible", "1");
    expect(scope).toHaveAttribute("data-phase-trace-count", "2");
    expect(scope).toHaveAttribute("data-phase-pitches", "0,7");
    expect(scope).toHaveAttribute("data-fixed-phase-source-revision", "4");
    expect(scope).toHaveAttribute("data-fixed-phase-shape-revision", "2");
    expect(scope).toHaveAttribute("data-flight-gates", "0");

    view.rerender(
      <FractalFlightScope
        x={new Float32Array()}
        y={new Float32Array()}
        layers={[
          layers[1],
          { x: traceX, y: traceY, color: "#8edb69", pitchClass: 4 },
        ]}
        notes={[
          { pitchClass: 7, frequency: 392, confidence: 0.96, amplitude: 0.88 },
          {
            pitchClass: 4,
            frequency: 329.63,
            confidence: 0.85,
            amplitude: 0.68,
          },
        ]}
        frameId={3}
        animate={false}
      />,
    );
    expect(scope).toHaveAttribute("data-phase-trace-count", "2");
    expect(scope).toHaveAttribute("data-phase-pitches", "4,7");
    expect(scope).toHaveAttribute("data-fixed-phase-pitch", "4");
    expect(scope).toHaveAttribute("data-fixed-phase-color", "#8edb69");
    expect(scope).toHaveAttribute("data-fixed-phase-source-active", "1");
    expect(scope.getAttribute("data-phase-source-states")).not.toContain(
      "note:0",
    );
    expect(scope.getAttribute("data-phase-source-states")).toContain("note:4");
  });

  it("keeps the original Newton system with an unbounded camera and explicit precision model", () => {
    const { context } = create2dContext();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      fixedBounds(),
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      (contextId) => (contextId === "2d" ? context : null),
    );

    render(
      <FractalFlightScope
        x={traceX}
        y={traceY}
        notes={[
          {
            pitchClass: 4,
            frequency: 329.63,
            confidence: 0.92,
            amplitude: 0.8,
          },
        ]}
        intensity={0.36}
        animate={false}
      />,
    );

    const scope = screen.getByRole("img", { name: "Фрактальный полёт" });
    expect(scope).toHaveAttribute(
      "data-fractal-variant",
      "continuous-newton-flow",
    );
    expect(scope).toHaveAttribute("data-fractal-power", "3");
    expect(scope).toHaveAttribute("data-fractal-iterations", "72");
    expect(scope).toHaveAttribute(
      "data-fractal-detail-mode",
      "pole-renormalized-newton",
    );
    expect(scope).toHaveAttribute("data-fractal-min-log-zoom", "unbounded");
    expect(scope).toHaveAttribute("data-fractal-max-log-zoom", "unbounded");
    expect(
      Number(scope.getAttribute("data-fractal-log-zoom")),
    ).toBeGreaterThanOrEqual(1.6);
    expect(Number(scope.getAttribute("data-fractal-local-scale"))).toBeLessThan(
      0.4,
    );
    expect(scope).toHaveAttribute("data-fractal-rotation-direction", "1");
    expect(scope.getAttribute("data-fractal-morph")).not.toBeNull();
    expect(scope.getAttribute("data-fractal-shear")).not.toBeNull();
    expect(scope.getAttribute("data-fractal-breath")).not.toBeNull();
  });

  it("removes phase traces as soon as their sources disappear", () => {
    const { context } = create2dContext();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      fixedBounds(),
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      (contextId) => (contextId === "2d" ? context : null),
    );

    const view = render(
      <FractalFlightScope
        x={new Float32Array()}
        y={new Float32Array()}
        layers={[{ x: traceX, y: traceY, color: "#f06f91", pitchClass: 0 }]}
        frameId={1}
        animate={false}
      />,
    );
    const scope = screen.getByRole("img", { name: "Фрактальный полёт" });
    expect(scope).toHaveAttribute("data-fixed-phase-source-active", "1");

    view.rerender(
      <FractalFlightScope
        x={new Float32Array()}
        y={new Float32Array()}
        layers={[]}
        frameId={2}
        animate={false}
      />,
    );

    expect(scope).toHaveAttribute("data-fixed-phase-visible", "0");
    expect(scope).toHaveAttribute("data-fixed-phase-source-active", "0");
    expect(scope).toHaveAttribute("data-phase-trace-count", "0");
    expect(scope).toHaveAttribute("data-phase-note-count", "0");
    expect(scope).toHaveAttribute("data-flight-gates", "0");
  });
});
