import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LissajousScope } from "./LissajousScope";

describe("LissajousScope", () => {
  let callbacks: FrameRequestCallback[];

  beforeEach(() => {
    callbacks = [];
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("exposes an accessible image and schedules only one draw per data frame", () => {
    const firstX = Float32Array.of(0, 1, 0, -1, 0);
    const firstY = Float32Array.of(1, 0, -1, 0, 1);
    const view = render(
      <LissajousScope
        x={firstX}
        y={firstY}
        title="Тестовая кривая"
        ariaLabel="XY-кривая тестового сигнала"
      />,
    );

    expect(
      screen.getByRole("img", { name: /Тестовая кривая.*XY-кривая/ }),
    ).toBeInTheDocument();
    expect(requestAnimationFrame).toHaveBeenCalledOnce();

    act(() => callbacks.shift()?.(16));
    expect(requestAnimationFrame).toHaveBeenCalledOnce();

    view.rerender(
      <LissajousScope
        x={Float32Array.of(0, 0.5, 0, -0.5, 0)}
        y={firstY}
        title="Тестовая кривая"
        ariaLabel="XY-кривая тестового сигнала"
      />,
    );
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
  });

  it("describes every visible colored layer in multilayer mode", () => {
    render(
      <LissajousScope
        x={Float32Array.of(0, 0.4, 0, -0.4)}
        y={Float32Array.of(0.4, 0, -0.4, 0)}
        title="Послойная фаза"
        layers={[
          {
            x: Float32Array.of(0, 0.8, 0, -0.8),
            y: Float32Array.of(0.8, 0, -0.8, 0),
            color: "#ff595e",
            label: "До",
          },
          {
            x: Float32Array.of(0, 0.6, 0, -0.6),
            y: Float32Array.of(-0.6, 0, 0.6, 0),
            color: "#8ac926",
            label: "Ми",
            opacity: 0.65,
            lineWidth: 2,
          },
        ]}
      />,
    );

    const scope = screen.getByRole("img", {
      name: /Послойная фаза.*Цветных слоёв: 2 \(До, Ми\)/,
    });

    expect(scope).toHaveAccessibleName(/Основная кривая построена по 4 парам/);
    expect(scope).toHaveTextContent("Цветных слоёв: 2 (До, Ми)");
    expect(requestAnimationFrame).toHaveBeenCalledOnce();
  });

  it("keeps the same full phase renderer when a fractal background is toggled", () => {
    const x = Float32Array.from({ length: 720 }, (_, index) =>
      Math.sin((index / 720) * Math.PI * 8),
    );
    const y = Float32Array.from({ length: 720 }, (_, index) =>
      Math.cos((index / 720) * Math.PI * 10),
    );
    const layers = [
      {
        x,
        y,
        color: "#ff595e",
        pitchClass: 0,
        label: "C",
      },
      {
        x: y,
        y: x,
        color: "#8ac926",
        pitchClass: 4,
        label: "E",
      },
    ];
    const view = render(
      <LissajousScope
        x={new Float32Array()}
        y={new Float32Array()}
        layers={layers}
        phaseSourceMode="notes"
        persistence={0.18}
        title="Фазовый портрет"
      />,
    );

    const phaseCanvas = screen.getByRole("img", { name: /Фазовый портрет/ });
    expect(phaseCanvas).toHaveAttribute("data-phase-renderer", "lissajous");
    expect(phaseCanvas).toHaveAttribute("data-fractal-background", "0");
    expect(phaseCanvas).toHaveAttribute("data-phase-source-mode", "notes");
    expect(phaseCanvas).toHaveAttribute("data-phase-trace-count", "2");
    expect(phaseCanvas).toHaveAttribute("data-phase-note-count", "2");
    expect(phaseCanvas).toHaveAttribute("data-phase-pitches", "0,4");
    expect(phaseCanvas).toHaveAttribute("data-phase-point-limit", "4096");
    expect(phaseCanvas).toHaveAttribute("data-phase-detail", "1.000");
    expect(phaseCanvas).toHaveAttribute("data-phase-curve", "polyline");
    expect(phaseCanvas).toHaveAttribute("data-phase-speed", "1.000");
    expect(phaseCanvas).toHaveAttribute("data-phase-response-ms", "0");
    expect(phaseCanvas).toHaveAttribute("data-phase-opacity", "1.000");
    expect(phaseCanvas).toHaveAttribute("data-phase-brightness", "1.000");
    expect(phaseCanvas).toHaveAttribute("data-phase-max-layer-points", "720");
    expect(phaseCanvas).toHaveAttribute(
      "data-phase-rendered-max-layer-points",
      "720",
    );
    expect(phaseCanvas).toHaveAttribute("data-phase-persistence", "0.180");
    expect(phaseCanvas).toHaveAttribute(
      "data-phase-effective-persistence",
      "0.180",
    );
    expect(phaseCanvas).toHaveAttribute("data-phase-glow-scale", "1.000");

    view.rerender(
      <LissajousScope
        x={new Float32Array()}
        y={new Float32Array()}
        layers={layers}
        phaseSourceMode="notes"
        persistence={0.18}
        title="Фрактальный фазовый портрет"
        backgroundLayer={<div data-testid="fractal-background" />}
      />,
    );

    const phaseCanvasWithFractal = screen.getByRole("img", {
      name: /Фрактальный фазовый портрет/,
    });
    expect(phaseCanvasWithFractal).toBe(phaseCanvas);
    expect(phaseCanvasWithFractal).toHaveAttribute(
      "data-phase-renderer",
      "lissajous",
    );
    expect(phaseCanvasWithFractal).toHaveAttribute(
      "data-fractal-background",
      "1",
    );
    expect(phaseCanvasWithFractal).toHaveAttribute(
      "data-phase-trace-count",
      "2",
    );
    expect(phaseCanvasWithFractal).toHaveAttribute(
      "data-phase-point-limit",
      "4096",
    );
    expect(phaseCanvasWithFractal).toHaveAttribute(
      "data-phase-persistence",
      "0.180",
    );
  });

  it("applies phase density, speed, opacity, brightness, blur, glow, and line width controls", () => {
    const x = Float32Array.from({ length: 720 }, (_, index) =>
      Math.sin((index / 720) * Math.PI * 8),
    );
    const y = Float32Array.from({ length: 720 }, (_, index) =>
      Math.cos((index / 720) * Math.PI * 10),
    );

    const view = render(
      <LissajousScope
        x={x}
        y={y}
        phaseDetail={0.5}
        phaseSpeed={0.25}
        phaseOpacity={0.4}
        phaseBrightness={2.4}
        phaseLineWidth={3.5}
        phaseBlur={2}
        phaseGlow={2.5}
      />,
    );

    const phaseCanvas = screen.getByRole("img", { name: /Фазовый портрет/ });
    expect(phaseCanvas).toHaveAttribute("data-phase-detail", "0.500");
    expect(phaseCanvas).toHaveAttribute("data-phase-speed", "0.250");
    expect(phaseCanvas).toHaveAttribute("data-phase-response-ms", "2268");
    expect(phaseCanvas).toHaveAttribute("data-phase-opacity", "0.400");
    expect(phaseCanvas).toHaveAttribute("data-phase-brightness", "2.400");
    expect(phaseCanvas).toHaveAttribute("data-phase-line-width", "3.500");
    expect(phaseCanvas).toHaveAttribute("data-phase-blur", "2.000");
    expect(phaseCanvas).toHaveAttribute("data-phase-glow", "2.500");
    expect(phaseCanvas).toHaveAttribute("data-phase-main-points", "720");
    expect(phaseCanvas).toHaveAttribute(
      "data-phase-rendered-main-points",
      "360",
    );
    expect(phaseCanvas).toHaveStyle({ opacity: "0.4" });
    expect(phaseCanvas).toHaveStyle({
      filter: "brightness(2.4) blur(2px)",
    });

    view.rerender(
      <LissajousScope
        x={x}
        y={y}
        phaseBrightness={9}
        phaseLineWidth={9}
        phaseBlur={9}
        phaseGlow={9}
      />,
    );

    expect(phaseCanvas).toHaveAttribute("data-phase-brightness", "3.000");
    expect(phaseCanvas).toHaveAttribute("data-phase-line-width", "5.000");
    expect(phaseCanvas).toHaveAttribute("data-phase-blur", "8.000");
    expect(phaseCanvas).toHaveAttribute("data-phase-glow", "4.000");
    expect(phaseCanvas).toHaveStyle({
      filter: "brightness(3) blur(8px)",
    });
  });

  it("exposes the spatial preset controls and clamps their ranges", () => {
    const x = Float32Array.of(0, 1, 0, -1, 0);
    const y = Float32Array.of(1, 0, -1, 0, 1);
    render(
      <LissajousScope
        x={x}
        y={y}
        phasePreset="spatial"
        phaseProjection="orthographic"
        phaseDepth={9}
        phaseTilt={-9}
        phaseRotation={9}
        phaseBend={9}
        phaseEnergy={0.625}
        phaseAxisDiversity={9}
        phaseLayerMotion={9}
        phaseLayerSoundResponse={-9}
      />,
    );

    const phaseCanvas = screen.getByRole("img", {
      name: /Фазовый портрет/,
    });
    expect(phaseCanvas).toHaveAttribute("data-phase-preset", "spatial");
    expect(phaseCanvas).toHaveAttribute(
      "data-phase-projection",
      "orthographic",
    );
    expect(phaseCanvas).toHaveAttribute("data-phase-depth", "1.500");
    expect(phaseCanvas).toHaveAttribute("data-phase-tilt", "-1.000");
    expect(phaseCanvas).toHaveAttribute("data-phase-rotation", "2.000");
    expect(phaseCanvas).toHaveAttribute("data-phase-bend", "1.500");
    expect(phaseCanvas).toHaveAttribute(
      "data-phase-axis-diversity",
      "1.000",
    );
    expect(phaseCanvas).toHaveAttribute("data-phase-layer-motion", "4.000");
    expect(phaseCanvas).toHaveAttribute(
      "data-phase-layer-motion-model",
      "independent-axis-travel",
    );
    expect(phaseCanvas).toHaveAttribute(
      "data-phase-layer-travel-range",
      "0.440",
    );
    expect(phaseCanvas).toHaveAttribute(
      "data-phase-layer-base-velocity",
      "0.880",
    );
    expect(phaseCanvas).toHaveAttribute(
      "data-phase-layer-sound-response",
      "0.000",
    );
    expect(phaseCanvas).toHaveAttribute("data-phase-energy", "0.625");
    expect(phaseCanvas).toHaveAttribute(
      "data-phase-curve",
      "spatial-cardinal",
    );
    expect(phaseCanvas).toHaveAttribute("data-phase-path", "open");
  });

  it("keeps pitch axes stable and gives separate notes distinct axes", () => {
    const x = Float32Array.of(0, 1, 0, -1, 0);
    const y = Float32Array.of(1, 0, -1, 0, 1);
    const view = render(
      <LissajousScope
        x={new Float32Array()}
        y={new Float32Array()}
        layers={[
          { x, y, color: "#ff595e", pitchClass: 0 },
          { x: y, y: x, color: "#8ac926", pitchClass: 7 },
        ]}
        phasePreset="spatial"
        phaseAxisDiversity={1}
        phaseLayerMotion={1.25}
        phaseLayerSoundResponse={1.5}
        animate={false}
      />,
    );

    const phaseCanvas = screen.getByRole("img", {
      name: /Фазовый портрет/,
    });
    const firstAxes = phaseCanvas.getAttribute("data-phase-layer-axes");
    const firstTravelAxes = phaseCanvas.getAttribute(
      "data-phase-layer-travel-axes",
    );
    const firstTravelPhases = phaseCanvas.getAttribute(
      "data-phase-layer-travel-phases",
    );
    expect(phaseCanvas).toHaveAttribute("data-phase-axis-count", "2");
    expect(phaseCanvas).toHaveAttribute("data-phase-travel-axis-count", "2");
    expect(phaseCanvas).toHaveAttribute(
      "data-phase-layer-spin-origin",
      "layer-center",
    );
    expect(firstAxes?.split(";")).toHaveLength(2);
    expect(new Set(firstAxes?.split(";")).size).toBe(2);
    expect(firstTravelAxes?.split(";")).toHaveLength(2);
    expect(new Set(firstTravelAxes?.split(";")).size).toBe(2);
    expect(firstTravelAxes).not.toBe(firstAxes);
    expect(firstTravelPhases?.split(";")).toHaveLength(2);
    expect(new Set(firstTravelPhases?.split(";")).size).toBe(2);

    view.rerender(
      <LissajousScope
        x={new Float32Array()}
        y={new Float32Array()}
        layers={[
          { x: x.slice(), y: y.slice(), color: "#ff595e", pitchClass: 0 },
          { x: y.slice(), y: x.slice(), color: "#8ac926", pitchClass: 7 },
        ]}
        phasePreset="spatial"
        phaseAxisDiversity={1}
        phaseLayerMotion={1.25}
        phaseLayerSoundResponse={1.5}
        animate={false}
      />,
    );
    expect(phaseCanvas).toHaveAttribute("data-phase-layer-axes", firstAxes);
    expect(phaseCanvas).toHaveAttribute(
      "data-phase-layer-travel-axes",
      firstTravelAxes,
    );
    expect(phaseCanvas).toHaveAttribute(
      "data-phase-layer-travel-phases",
      firstTravelPhases,
    );

    view.rerender(
      <LissajousScope
        x={new Float32Array()}
        y={new Float32Array()}
        layers={[
          { x, y, color: "#ff595e", pitchClass: 0 },
          { x: y, y: x, color: "#8ac926", pitchClass: 7 },
        ]}
        phasePreset="spatial"
        phaseAxisDiversity={0}
        phaseLayerMotion={1.25}
        phaseLayerSoundResponse={1.5}
        animate={false}
      />,
    );
    expect(phaseCanvas).toHaveAttribute("data-phase-axis-count", "1");
    expect(phaseCanvas).toHaveAttribute("data-phase-travel-axis-count", "1");
    expect(phaseCanvas).toHaveAttribute(
      "data-phase-layer-axes",
      "0.000,1.000,0.000;0.000,1.000,0.000",
    );
    expect(phaseCanvas).toHaveAttribute(
      "data-phase-layer-travel-axes",
      "0.000,1.000,0.000;0.000,1.000,0.000",
    );
  });

  it("projects spatial layers as smooth closed depth buckets", () => {
    const bezierCurveTo = vi.fn();
    const stroke = vi.fn();
    const ellipse = vi.fn();
    const context = {
      setTransform: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      ellipse,
      stroke,
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      bezierCurveTo,
      arc: vi.fn(),
      fill: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(context);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 320,
      bottom: 320,
      left: 0,
      width: 320,
      height: 320,
      toJSON: () => ({}),
    });
    const x = Float32Array.from({ length: 96 }, (_, index) =>
      Math.sin((index / 96) * Math.PI * 6),
    );
    const y = Float32Array.from({ length: 96 }, (_, index) =>
      Math.cos((index / 96) * Math.PI * 8),
    );

    render(
      <LissajousScope
        x={new Float32Array()}
        y={new Float32Array()}
        layers={[
          { x, y, color: "#ff595e", pitchClass: 0 },
          { x: y, y: x, color: "#8ac926", pitchClass: 7 },
        ]}
        phasePreset="spatial"
        phaseDepth={1.1}
        phaseTilt={0.35}
        phaseRotation={0}
        phaseBend={0.8}
        phaseEnergy={0.7}
        animate={false}
      />,
    );

    const phaseCanvas = screen.getByRole("img", {
      name: /Фазовый портрет/,
    });
    expect(phaseCanvas).toHaveAttribute("data-phase-trace-count", "2");
    expect(phaseCanvas).toHaveAttribute("data-phase-energy", "0.700");
    expect(bezierCurveTo).toHaveBeenCalled();
    expect(stroke.mock.calls.length).toBeGreaterThan(8);
    expect(ellipse).not.toHaveBeenCalled();
  });

  it("scales main and layer core and halo widths consistently", () => {
    let currentLineWidth = 0;
    let currentGlobalAlpha = 1;
    let currentShadowBlur = 0;
    const strokeWidths: number[] = [];
    const strokeStates: Array<{
      lineWidth: number;
      globalAlpha: number;
      shadowBlur: number;
    }> = [];
    const context = {
      set lineWidth(value: number) {
        currentLineWidth = value;
      },
      get lineWidth() {
        return currentLineWidth;
      },
      set globalAlpha(value: number) {
        currentGlobalAlpha = value;
      },
      get globalAlpha() {
        return currentGlobalAlpha;
      },
      set shadowBlur(value: number) {
        currentShadowBlur = value;
      },
      get shadowBlur() {
        return currentShadowBlur;
      },
      setTransform: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      ellipse: vi.fn(),
      stroke: vi.fn(() => {
        strokeWidths.push(currentLineWidth);
        strokeStates.push({
          lineWidth: currentLineWidth,
          globalAlpha: currentGlobalAlpha,
          shadowBlur: currentShadowBlur,
        });
      }),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      bezierCurveTo: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(context);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 320,
      bottom: 320,
      left: 0,
      width: 320,
      height: 320,
      toJSON: () => ({}),
    });
    const x = Float32Array.of(0, 1, 0, -1, 0);
    const y = Float32Array.of(1, 0, -1, 0, 1);
    const hasStrokeWidth = (expected: number) =>
      strokeWidths.some((actual) => Math.abs(actual - expected) < 1e-9);
    const hasStrokeState = (
      lineWidth: number,
      globalAlpha: number,
      shadowBlur: number,
    ) =>
      strokeStates.some(
        (state) =>
          Math.abs(state.lineWidth - lineWidth) < 1e-9 &&
          Math.abs(state.globalAlpha - globalAlpha) < 1e-9 &&
          Math.abs(state.shadowBlur - shadowBlur) < 1e-9,
      );

    const view = render(
      <LissajousScope
        x={x}
        y={y}
        lineWidth={2}
        phaseLineWidth={1.5}
        phaseGlow={2}
        layers={[{ x, y, color: "#ff595e", lineWidth: 1 }]}
        animate={false}
      />,
    );

    const phaseCanvas = screen.getByRole("img", { name: /Фазовый портрет/ });
    expect(phaseCanvas).toHaveAttribute("data-phase-line-width", "1.500");
    expect(phaseCanvas).toHaveAttribute("data-phase-glow", "2.000");
    expect(hasStrokeWidth(7.2)).toBe(true);
    expect(hasStrokeWidth(3)).toBe(true);
    expect(hasStrokeWidth(5.7)).toBe(true);
    expect(hasStrokeWidth(1.5)).toBe(true);
    expect(hasStrokeState(7.2, 0.6, 28)).toBe(true);
    expect(hasStrokeState(3, 0.92, 4)).toBe(true);

    strokeWidths.length = 0;
    strokeStates.length = 0;
    view.rerender(
      <LissajousScope
        x={x}
        y={y}
        lineWidth={2}
        layers={[{ x, y, color: "#ff595e", lineWidth: 1 }]}
        animate={false}
      />,
    );

    expect(phaseCanvas).toHaveAttribute("data-phase-line-width", "1.000");
    expect(phaseCanvas).toHaveAttribute("data-phase-glow", "1.000");
    expect(hasStrokeWidth(3.4)).toBe(true);
    expect(hasStrokeWidth(2)).toBe(true);
    expect(hasStrokeWidth(2.4)).toBe(true);
    expect(hasStrokeWidth(1)).toBe(true);
    expect(hasStrokeState(3.4, 0.3, 14)).toBe(true);
    expect(hasStrokeState(2, 0.92, 4)).toBe(true);
  });

  it("uses an open spline at minimum phase detail and preserves raw endpoints", () => {
    const closePath = vi.fn();
    const bezierCurveTo = vi.fn();
    const context = {
      setTransform: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      closePath,
      ellipse: vi.fn(),
      stroke: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      bezierCurveTo,
      arc: vi.fn(),
      fill: vi.fn(),
    } as unknown as CanvasRenderingContext2D;
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(context);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 320,
      bottom: 320,
      left: 0,
      width: 320,
      height: 320,
      toJSON: () => ({}),
    });

    const x = Float32Array.from({ length: 80 }, (_, index) =>
      Math.sin((index / 80) * Math.PI * 6),
    );
    const y = Float32Array.from({ length: 80 }, (_, index) =>
      Math.cos((index / 80) * Math.PI * 8),
    );
    const view = render(
      <LissajousScope
        x={x}
        y={y}
        layers={[
          { x, y, color: "#ff595e", pitchClass: 0 },
          { x: y, y: x, color: "#8ac926", pitchClass: 4 },
          { x, y: x, color: "#1982c4", pitchClass: 7 },
        ]}
        phaseDetail={0.05}
        animate={false}
      />,
    );

    const phaseCanvas = screen.getByRole("img", { name: /Фазовый портрет/ });
    expect(phaseCanvas).toHaveAttribute("data-phase-path", "open");
    expect(phaseCanvas).toHaveAttribute("data-phase-curve", "cardinal");
    expect(phaseCanvas).toHaveAttribute(
      "data-phase-rendered-main-points",
      "4",
    );
    expect(closePath).not.toHaveBeenCalled();
    expect(bezierCurveTo).toHaveBeenCalled();
    expect(phaseCanvas).toHaveAttribute("data-phase-glow-scale", "0.383");
    expect(phaseCanvas).toHaveAttribute(
      "data-phase-effective-persistence",
      "0.492",
    );

    bezierCurveTo.mockClear();
    view.rerender(
      <LissajousScope
        x={x}
        y={y}
        layers={[
          { x, y, color: "#ff595e", pitchClass: 0 },
          { x: y, y: x, color: "#8ac926", pitchClass: 4 },
          { x, y: x, color: "#1982c4", pitchClass: 7 },
        ]}
        phaseDetail={1}
        animate={false}
      />,
    );

    expect(phaseCanvas).toHaveAttribute("data-phase-detail", "1.000");
    expect(phaseCanvas).toHaveAttribute("data-phase-curve", "polyline");
    expect(phaseCanvas).toHaveAttribute("data-phase-glow-scale", "1.000");
    expect(phaseCanvas).toHaveAttribute(
      "data-phase-effective-persistence",
      "0.860",
    );
    expect(bezierCurveTo).not.toHaveBeenCalled();
  });
});
