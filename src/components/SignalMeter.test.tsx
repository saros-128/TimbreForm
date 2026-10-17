import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SignalMeter } from "./SignalMeter";

describe("SignalMeter", () => {
  it("uses the time-domain input peak for clipping", () => {
    const view = render(
      <SignalMeter rms={0.2} inputPeakDb={-0.5} noiseFloorDb={-72} />,
    );
    expect(view.container.querySelector(".signal-level")).toHaveClass("clipping");
    expect(view.container.querySelector(".signal")).toHaveAttribute(
      "title",
      expect.stringContaining("Входной пик -0.5 dBFS"),
    );

    view.rerender(
      <SignalMeter rms={0.1} inputPeakDb={-12} noiseFloorDb={-72} />,
    );
    expect(view.container.querySelector(".signal-level")).not.toHaveClass(
      "clipping",
    );
  });
});
