import { describe, expect, it } from "vitest";
import {
  AUTH_TRANSITION_PALETTE,
  openingTransitionProgress,
} from "./OpeningShaderBackground";
import fragmentShaderSource from "./shaders/opening-background.frag.glsl?raw";

describe("opening wave transition timing", () => {
  it("traverses the established shader path backward for a return transition", () => {
    expect(openingTransitionProgress("forward", 12, 12)).toBe(0);
    expect(openingTransitionProgress("forward", 12.84, 12)).toBeCloseTo(1);
    expect(openingTransitionProgress("reverse", 12, 12)).toBe(1);
    expect(openingTransitionProgress("reverse", 12.84, 12)).toBeCloseTo(0);
  });

  it("settles immediately at the correct endpoint when reduced motion is enabled", () => {
    expect(openingTransitionProgress("forward", 0, 0, true)).toBe(1);
    expect(openingTransitionProgress("reverse", 0, 0, true)).toBe(0);
  });

  it("moves the existing front ribbon through one narrow destination seam", () => {
    expect(fragmentShaderSource).toContain("movingFrontTop = frontTop - 1.070 * transitionMorph");
    expect(fragmentShaderSource).toContain("movingFrontExit = movingFrontTop + 0.185");
    expect(fragmentShaderSource).toContain("2.0 / uResolution.y");
    expect(fragmentShaderSource).not.toContain("carrierBand");
    expect(fragmentShaderSource).not.toContain("reliefRetention");
    expect(fragmentShaderSource).not.toContain("finalFront");
  });

  it("shares the established Login blue/cyan palette across both auth routes", () => {
    expect(AUTH_TRANSITION_PALETTE).toEqual([
      [0.976, 0.992, 1.000],
      [0.702, 0.890, 0.969],
      [0.631, 0.710, 0.941],
      [0.290, 0.439, 0.878],
    ]);
  });
});
