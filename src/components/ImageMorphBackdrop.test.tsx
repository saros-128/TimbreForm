import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ImageMorphBackdrop,
  type ImageMorphSource,
} from "./ImageMorphBackdrop";

const sources: ImageMorphSource[] = [
  { id: "one", name: "Первое", url: "blob:first" },
  { id: "two", name: "Второе", url: "blob:second" },
];

function fixedBounds(width = 640, height = 360): DOMRect {
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
  const spies = {
    clearRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    drawImage: vi.fn(),
    globalAlpha: 1,
    filter: "none",
  };
  return {
    context: spies as unknown as CanvasRenderingContext2D,
    spies,
  };
}

function defaultProps() {
  return {
    sources,
    enabled: true,
    mode: "beat" as const,
    energy: 0.35,
    onsetSequence: 0,
    tempoBpm: 120,
    transitionMs: 200,
    changeRate: 4,
    morph: 0.7,
    opacity: 0.55,
    brightness: 1.2,
    phaseInfluence: 0.6,
  };
}

describe("ImageMorphBackdrop", () => {
  let callbacks: FrameRequestCallback[];

  beforeEach(() => {
    callbacks = [];
    class FakeImage {
      decoding = "auto";
      naturalWidth = 1280;
      naturalHeight = 720;
      width = 1280;
      height = 720;
      onload: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      private source = "";

      set src(value: string) {
        this.source = value;
        queueMicrotask(() => {
          if (value.includes("broken")) {
            this.onerror?.(new Event("error"));
          } else {
            this.onload?.(new Event("load"));
          }
        });
      }

      get src() {
        return this.source;
      }
    }

    vi.stubGlobal("Image", FakeImage as unknown as typeof Image);
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        callbacks.push(callback);
        return callbacks.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      fixedBounds(),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps an inert diagnostic canvas when image rendering is disabled", () => {
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(null);

    const view = render(
      <ImageMorphBackdrop {...defaultProps()} enabled={false} />,
    );
    const canvas = view.container.querySelector("canvas");

    expect(canvas).toHaveClass("image-morph-backdrop");
    expect(canvas).toHaveAttribute("aria-hidden", "true");
    expect(canvas).toHaveAttribute("data-image-morph-enabled", "false");
    expect(canvas).toHaveAttribute("data-image-morph-source-count", "2");
    expect(canvas).toHaveAttribute("data-image-morph-state", "disabled");
    expect(getContext).not.toHaveBeenCalled();
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });

  it("falls back to Canvas 2D and draws only successfully loaded images", async () => {
    const { context, spies } = create2dContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      (kind) => (kind === "2d" ? context : null),
    );
    const mixedSources = [
      sources[0],
      { id: "broken", name: "Ошибка", url: "blob:broken" },
    ];

    const view = render(
      <ImageMorphBackdrop {...defaultProps()} sources={mixedSources} />,
    );
    await act(async () => Promise.resolve());
    act(() => callbacks.shift()?.(0));
    const canvas = view.container.querySelector("canvas");

    expect(canvas).toHaveAttribute("data-image-morph-renderer", "canvas2d");
    expect(canvas).toHaveAttribute("data-image-morph-loaded", "1");
    expect(canvas).toHaveAttribute("data-image-morph-total", "2");
    expect(canvas).toHaveAttribute("data-image-morph-current", "one");
    expect(canvas).toHaveAttribute("data-image-morph-state", "active");
    expect(spies.drawImage).toHaveBeenCalled();
  });

  it("starts a smooth image transition on an onset and keeps the old image until it completes", async () => {
    const { context } = create2dContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      (kind) => (kind === "2d" ? context : null),
    );
    const props = defaultProps();
    const view = render(<ImageMorphBackdrop {...props} />);
    await act(async () => Promise.resolve());
    act(() => callbacks.shift()?.(0));
    const canvas = view.container.querySelector("canvas");
    expect(canvas).toHaveAttribute("data-image-morph-current", "one");

    view.rerender(<ImageMorphBackdrop {...props} onsetSequence={1} />);
    act(() => callbacks.shift()?.(16));
    expect(canvas).toHaveAttribute("data-image-morph-transitioning", "true");
    expect(canvas).toHaveAttribute("data-image-morph-current", "one");
    expect(canvas).toHaveAttribute("data-image-morph-next", "two");

    act(() => callbacks.shift()?.(116));
    expect(Number(canvas?.dataset.imageMorphProgress)).toBeGreaterThan(0);
    expect(canvas).toHaveAttribute("data-image-morph-current", "one");

    act(() => callbacks.shift()?.(240));
    expect(canvas).toHaveAttribute("data-image-morph-transitioning", "false");
    expect(canvas).toHaveAttribute("data-image-morph-current", "two");
    expect(canvas).toHaveAttribute("data-image-morph-next", "");
  });

  it("cleans up its animation frame when removed", async () => {
    const { context } = create2dContext();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      (kind) => (kind === "2d" ? context : null),
    );
    const view = render(<ImageMorphBackdrop {...defaultProps()} />);
    await act(async () => Promise.resolve());

    view.unmount();
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });
});
