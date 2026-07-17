// @vitest-environment jsdom

import { act, createRef } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  ARROW_REPULSION_CONFIG,
  canUpdateOpeningPointer,
  exponentialApproach,
  isHoverPointer,
  OpeningArrowBackground,
  relativePointerOrigin,
  repulsionMagnitude,
  type OpeningArrowBackgroundHandle,
} from "./OpeningArrowBackground";
import rendererSource from "./OpeningArrowBackground.tsx?raw";
import fragmentShaderSource from "./shaders/opening-background.frag.glsl?raw";

interface UniformSnapshot {
  name: string;
  values: number[];
}

interface MockMediaQueryList {
  readonly matches: boolean;
  readonly media: string;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

interface RendererHarness {
  gl: WebGL2RenderingContext & Record<string, ReturnType<typeof vi.fn>>;
  ownershipAtDraw: Array<{ canvasReady: boolean; rootReady: boolean }>;
  uniform1fSnapshots: UniformSnapshot[];
  uniform2fSnapshots: UniformSnapshot[];
  uniform4fvSnapshots: UniformSnapshot[];
}

let currentTime = 1_000;
let documentIsHidden = false;
let devicePixelRatio = 1;
let canvasLeft = 0;
let canvasTop = 0;
let canvasWidth = 400;
let canvasHeight = 240;
let nextAnimationFrameId = 1;
let animationFrames = new Map<number, FrameRequestCallback>();
let resizeObservers: MockResizeObserver[] = [];
let motionListeners = new Set<(event: MediaQueryListEvent) => void>();
let reducedMotion = false;
let mediaQueryList: MockMediaQueryList;
let harness: RendererHarness;

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    top,
    right: left + width,
    bottom: top + height,
    left,
    width,
    height,
    toJSON: () => ({}),
  };
}

class MockResizeObserver implements ResizeObserver {
  readonly callback: ResizeObserverCallback;
  readonly observed = new Set<Element>();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeObservers.push(this);
  }

  observe(target: Element) {
    this.observed.add(target);
  }

  unobserve(target: Element) {
    this.observed.delete(target);
  }

  disconnect() {
    this.observed.clear();
  }

  emit(width: number, height: number) {
    const target = [...this.observed][0];
    if (!target) throw new Error("ResizeObserver has no observed target.");
    this.callback([
      {
        target,
        contentRect: rect(canvasLeft, canvasTop, width, height),
      } as ResizeObserverEntry,
    ], this);
  }
}

class LoadedImage {
  decoding = "auto";
  onload: ((this: GlobalEventHandlers, ev: Event) => unknown) | null = null;
  onerror: OnErrorEventHandler = null;
  private value = "";

  get src() {
    return this.value;
  }

  set src(value: string) {
    this.value = value;
    queueMicrotask(() => {
      this.onload?.call(this as unknown as GlobalEventHandlers, new Event("load"));
    });
  }
}

function locationName(location: WebGLUniformLocation | null) {
  return (location as unknown as { name?: string } | null)?.name ?? "unknown";
}

function createWebGlHarness(): RendererHarness {
  const ownershipAtDraw: RendererHarness["ownershipAtDraw"] = [];
  const uniform1fSnapshots: UniformSnapshot[] = [];
  const uniform2fSnapshots: UniformSnapshot[] = [];
  const uniform4fvSnapshots: UniformSnapshot[] = [];
  let resourceId = 0;
  const resource = () => ({ id: ++resourceId });

  const gl = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    FLOAT: 0x1406,
    TEXTURE_2D: 0x0de1,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    LINEAR: 0x2601,
    REPEAT: 0x2901,
    CLAMP_TO_EDGE: 0x812f,
    UNPACK_FLIP_Y_WEBGL: 0x9240,
    UNPACK_PREMULTIPLY_ALPHA_WEBGL: 0x9241,
    RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401,
    COLOR_BUFFER_BIT: 0x4000,
    TRIANGLES: 0x0004,
    TEXTURE0: 0x84c0,
    TEXTURE1: 0x84c1,
    createShader: vi.fn(resource),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => null),
    deleteShader: vi.fn(),
    createProgram: vi.fn(resource),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(() => null),
    deleteProgram: vi.fn(),
    createBuffer: vi.fn(resource),
    deleteBuffer: vi.fn(),
    createVertexArray: vi.fn(resource),
    deleteVertexArray: vi.fn(),
    getAttribLocation: vi.fn(() => 0),
    getUniformLocation: vi.fn((_program, name: string) => ({ name })),
    bindVertexArray: vi.fn(),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    createTexture: vi.fn(resource),
    deleteTexture: vi.fn(),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
    pixelStorei: vi.fn(),
    texImage2D: vi.fn(),
    viewport: vi.fn(),
    clearColor: vi.fn(),
    clear: vi.fn(),
    useProgram: vi.fn(),
    uniform2f: vi.fn((
      location: WebGLUniformLocation | null,
      first: number,
      second: number,
    ) => {
      uniform2fSnapshots.push({
        name: locationName(location),
        values: [first, second],
      });
    }),
    uniform1f: vi.fn((location: WebGLUniformLocation | null, value: number) => {
      uniform1fSnapshots.push({ name: locationName(location), values: [value] });
    }),
    uniform4fv: vi.fn((
      location: WebGLUniformLocation | null,
      values: Float32List,
    ) => {
      uniform4fvSnapshots.push({
        name: locationName(location),
        values: Array.from(values),
      });
    }),
    uniform1i: vi.fn(),
    activeTexture: vi.fn(),
    drawArrays: vi.fn(() => {
      ownershipAtDraw.push({
        rootReady: document.querySelector(".onboarding-arrow-background")
          ?.classList.contains("is-webgl-ready") ?? false,
        canvasReady: document.querySelector(".onboarding-arrow-canvas")
          ?.classList.contains("is-ready") ?? false,
      });
    }),
  };

  return {
    gl: gl as unknown as RendererHarness["gl"],
    ownershipAtDraw,
    uniform1fSnapshots,
    uniform2fSnapshots,
    uniform4fvSnapshots,
  };
}

function latestUniform(snapshots: UniformSnapshot[], name: string) {
  for (let index = snapshots.length - 1; index >= 0; index -= 1) {
    const snapshot = snapshots[index];
    if (snapshot?.name === name) return snapshot.values;
  }
  return undefined;
}

function setReducedMotion(matches: boolean) {
  reducedMotion = matches;
  const event = { matches, media: mediaQueryList.media } as MediaQueryListEvent;
  motionListeners.forEach((listener) => listener(event));
}

function setDocumentHidden(hidden: boolean) {
  documentIsHidden = hidden;
  document.dispatchEvent(new Event("visibilitychange"));
}

function runNextAnimationFrame(time: number) {
  const next = animationFrames.entries().next().value as
    | [number, FrameRequestCallback]
    | undefined;
  if (!next) throw new Error("No animation frame is pending.");
  const [id, callback] = next;
  animationFrames.delete(id);
  currentTime = time;
  act(() => callback(time));
}

function runUntilIdle(stepMs = 16, maximumFrames = 120) {
  let framesRun = 0;
  while (animationFrames.size > 0 && framesRun < maximumFrames) {
    runNextAnimationFrame(currentTime + stepMs);
    framesRun += 1;
  }
  if (animationFrames.size > 0) {
    throw new Error(`Renderer did not settle after ${maximumFrames} frames.`);
  }
  return framesRun;
}

async function mountRenderer() {
  const ref = createRef<OpeningArrowBackgroundHandle>();
  const result = render(<OpeningArrowBackground ref={ref} />);
  const root = result.container.querySelector<HTMLDivElement>(
    ".onboarding-arrow-background",
  );
  const canvas = result.container.querySelector<HTMLCanvasElement>(
    ".onboarding-arrow-canvas",
  );
  if (!root || !canvas) throw new Error("Opening renderer markup is incomplete.");

  await waitFor(() => expect(harness.gl.drawArrays).toHaveBeenCalledTimes(1));
  if (!ref.current) throw new Error("Opening renderer handle is unavailable.");
  return { ...result, canvas, root, handle: ref.current };
}

beforeEach(() => {
  currentTime = 1_000;
  documentIsHidden = false;
  devicePixelRatio = 1;
  canvasLeft = 0;
  canvasTop = 0;
  canvasWidth = 400;
  canvasHeight = 240;
  nextAnimationFrameId = 1;
  animationFrames = new Map();
  resizeObservers = [];
  motionListeners = new Set();
  reducedMotion = false;
  harness = createWebGlHarness();

  mediaQueryList = {
    get matches() {
      return reducedMotion;
    },
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: vi.fn((
      type: string,
      listener: (event: MediaQueryListEvent) => void,
    ) => {
      if (type === "change") motionListeners.add(listener);
    }),
    removeEventListener: vi.fn((
      type: string,
      listener: (event: MediaQueryListEvent) => void,
    ) => {
      if (type === "change") motionListeners.delete(listener);
    }),
  };

  vi.stubGlobal("Image", LoadedImage);
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
    const id = nextAnimationFrameId;
    nextAnimationFrameId += 1;
    animationFrames.set(id, callback);
    return id;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => {
    animationFrames.delete(id);
  }));
  vi.stubGlobal("matchMedia", vi.fn(() => mediaQueryList));

  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => documentIsHidden,
  });
  Object.defineProperty(window, "devicePixelRatio", {
    configurable: true,
    get: () => devicePixelRatio,
  });
  vi.spyOn(performance, "now").mockImplementation(() => currentTime);
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect")
    .mockImplementation(() => rect(
      canvasLeft,
      canvasTop,
      canvasWidth,
      canvasHeight,
    ));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockImplementation(((contextId: string) => (
      contextId === "webgl2" ? harness.gl : null
    )) as HTMLCanvasElement["getContext"]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("arrow repulsion profile", () => {
  it("uses the requested 120px field and 6px-to-2px inner profile", () => {
    expect(ARROW_REPULSION_CONFIG).toEqual({
      radiusPx: 120,
      innerRatio: 0.72,
      minShiftPx: 2,
      maxShiftPx: 6,
      pointerTimeConstantMs: 45,
      enterTimeConstantMs: 28,
      releaseTimeConstantMs: 36,
      releaseDurationMs: 120,
    });
    expect(repulsionMagnitude(0)).toBe(6);
    expect(repulsionMagnitude(120 * 0.72)).toBeCloseTo(2, 8);
    expect(repulsionMagnitude(120)).toBe(0);
  });

  it("is bounded, continuous, and monotonic across the core and feather", () => {
    const samples = Array.from({ length: 241 }, (_, index) => (
      repulsionMagnitude(index / 2)
    ));
    samples.forEach((value) => {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(6);
    });
    samples.slice(1).forEach((value, index) => {
      expect(value).toBeLessThanOrEqual(samples[index]! + 1e-12);
    });

    const epsilon = 0.01;
    const innerEdge = 120 * 0.72;
    expect(repulsionMagnitude(epsilon)).toBeCloseTo(repulsionMagnitude(0), 8);
    expect(repulsionMagnitude(innerEdge - epsilon)).toBeCloseTo(2, 7);
    expect(repulsionMagnitude(innerEdge + epsilon)).toBeCloseTo(2, 7);
    expect(repulsionMagnitude(120 - epsilon)).toBeCloseTo(0, 7);
  });

  it("clamps strength without changing the spatial profile", () => {
    expect(repulsionMagnitude(40, 0.5)).toBeCloseTo(
      repulsionMagnitude(40) * 0.5,
      10,
    );
    expect(repulsionMagnitude(40, -2)).toBe(0);
    expect(repulsionMagnitude(40, 9)).toBe(repulsionMagnitude(40));
    expect(repulsionMagnitude(-20)).toBe(6);
    expect(repulsionMagnitude(200)).toBe(0);
  });

  it("uses frame-rate-independent exponential smoothing across short and long frames", () => {
    const oneFrame = exponentialApproach(0, 100, 32, 45);
    const firstHalf = exponentialApproach(0, 100, 16, 45);
    const twoFrames = exponentialApproach(firstHalf, 100, 16, 45);
    expect(twoFrames).toBeCloseTo(oneFrame, 12);
    expect(exponentialApproach(20, 100, -16, 45)).toBe(20);
    const tenSmallFrames = Array.from({ length: 10 }).reduce<number>(
      (value) => exponentialApproach(value, 100, 100, 45),
      0,
    );
    expect(exponentialApproach(0, 100, 1_000, 45))
      .toBeCloseTo(tenSmallFrames, 12);
  });

  it("accepts mouse and hovering pen input only on the choice screen", () => {
    expect(isHoverPointer("mouse", 0)).toBe(true);
    expect(isHoverPointer("pen", 0)).toBe(true);
    expect(isHoverPointer("pen", 0.5)).toBe(false);
    expect(isHoverPointer("touch", 0)).toBe(false);
    expect(isHoverPointer("", 0)).toBe(false);
    expect(canUpdateOpeningPointer(true, "mouse", 0)).toBe(true);
    expect(canUpdateOpeningPointer(true, "pen", 0)).toBe(true);
    expect(canUpdateOpeningPointer(true, "pen", 0.5)).toBe(false);
    expect(canUpdateOpeningPointer(true, "touch", 0)).toBe(false);
    expect(canUpdateOpeningPointer(false, "mouse", 0)).toBe(false);
  });

  it("converts client coordinates into clamped local CSS pixels", () => {
    const bounds = { left: 10, top: 20, width: 100, height: 80 };
    expect(relativePointerOrigin(40, 60, bounds)).toEqual({ x: 30, y: 40 });
    expect(relativePointerOrigin(-20, 140, bounds)).toEqual({ x: 0, y: 80 });
  });
});

describe("opening arrow repulsion shader", () => {
  it("is a direct WebGL2 shader with one pointer field and no timed slots", () => {
    expect(fragmentShaderSource).toContain("#version 300 es");
    expect(fragmentShaderSource).toContain("precision highp float");
    expect(fragmentShaderSource).toContain("uniform vec2 uPointer");
    expect(fragmentShaderSource).toContain("uniform float uPointerStrength");
    expect(fragmentShaderSource).toContain("uniform vec4 uRepulsionConfig");
    expect(fragmentShaderSource).not.toMatch(/uHover|uRipple|uTime|\[[234]\]/);
    expect(rendererSource).not.toMatch(/MAX_HOVER|RippleSlot|pulseHover|clearHover/);
    expect(rendererSource).not.toMatch(/three|@react-three/i);
  });

  it("keeps the measured density mask and repeating arrow tile", () => {
    expect(fragmentShaderSource).toContain("uniform sampler2D uDensityTexture");
    expect(fragmentShaderSource).toContain("uniform sampler2D uArrowTexture");
    expect(fragmentShaderSource).toContain("ARROW_PITCH_CSS_PX = 13.333333");
    expect(fragmentShaderSource).not.toContain("uFieldTexture");
  });

  it("inverse-maps one rigid translation per cell", () => {
    expect(fragmentShaderSource).toContain(
      "vec2 sourcePixel = cssPixel - cellDisplacement(cellCenter)",
    );
    expect(fragmentShaderSource).toContain(
      "vec2 local = (sourcePixel - cellOrigin) / ARROW_PITCH_CSS_PX",
    );
    expect(fragmentShaderSource).not.toMatch(/local\s*=.*\/.*scale/i);
    expect(fragmentShaderSource).not.toMatch(/combinedScale|scaleDelta|nudgeVector/);
  });

  it("keeps the exact-center arrow moving at the full repulsion magnitude", () => {
    expect(fragmentShaderSource).toContain(
      "vec2 direction = distancePx < 0.0001",
    );
    expect(fragmentShaderSource).toContain("? vec2(0.0, -1.0)");
    expect(fragmentShaderSource).toContain(
      "return direction * repulsionMagnitude(distancePx)",
    );
    expect(fragmentShaderSource).not.toContain(
      "distancePx < 0.0001 || distancePx >= uRepulsionConfig.x",
    );
  });

  it("uses a 3x3 source neighborhood and keeps the strongest overlap", () => {
    expect(fragmentShaderSource).toContain(
      "for (int offsetY = -1; offsetY <= 1; offsetY += 1)",
    );
    expect(fragmentShaderSource).toContain(
      "for (int offsetX = -1; offsetX <= 1; offsetX += 1)",
    );
    expect(fragmentShaderSource).toContain("if (candidate.a > strongestAlpha)");
    expect(fragmentShaderSource).toContain("strongest = candidate");
    expect(fragmentShaderSource).not.toMatch(/strongest\s*\+=|candidate\.a\s*\+/);
  });

  it("takes a static single-sample fast path outside the affected support", () => {
    expect(fragmentShaderSource).toContain("vec4 sampleStaticArrow");
    expect(fragmentShaderSource).toContain("bool staticFrame");
    expect(fragmentShaderSource).toContain("bool outsideAffectedSupport");
    expect(fragmentShaderSource).toContain(
      "staticFrame || outsideAffectedSupport",
    );
  });

  it("uses C2 easing and preserves arrow RGB and density alpha", () => {
    expect(fragmentShaderSource).toContain(
      "unit * unit * unit * (unit * (unit * 6.0 - 15.0) + 10.0)",
    );
    expect(fragmentShaderSource).toContain(
      "fragColor = vec4(arrow.rgb, arrow.a * density)",
    );
    expect(fragmentShaderSource).not.toMatch(
      /uniform\s+vec[34]\s+\w*(?:color|tint|gradient)/i,
    );
    expect(fragmentShaderSource).not.toMatch(/Destination|Transition|emphasis/);
  });
});

describe("OpeningArrowBackground WebGL lifecycle", () => {
  it("claims fallback ownership only after a valid static draw and idles", async () => {
    const ref = createRef<OpeningArrowBackgroundHandle>();
    const result = render(<OpeningArrowBackground ref={ref} />);
    const root = result.container.querySelector<HTMLDivElement>(
      ".onboarding-arrow-background",
    )!;
    const canvas = result.container.querySelector<HTMLCanvasElement>(
      ".onboarding-arrow-canvas",
    )!;

    expect(root.classList.contains("is-webgl-ready")).toBe(false);
    expect(canvas.classList.contains("is-ready")).toBe(false);
    expect(animationFrames.size).toBe(0);

    await waitFor(() => expect(harness.gl.drawArrays).toHaveBeenCalledTimes(1));

    expect(harness.ownershipAtDraw).toEqual([
      { rootReady: false, canvasReady: false },
    ]);
    expect(root.classList.contains("is-webgl-ready")).toBe(true);
    expect(canvas.classList.contains("is-ready")).toBe(true);
    expect(animationFrames.size).toBe(0);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
    expect(latestUniform(harness.uniform2fSnapshots, "uPointer")).toEqual([0, 0]);
    expect(latestUniform(harness.uniform1fSnapshots, "uPointerStrength"))
      .toEqual([0]);
    expect(latestUniform(harness.uniform4fvSnapshots, "uRepulsionConfig"))
      .toEqual([120, 2, 6, expect.closeTo(0.72, 6)]);
  });

  it("retains the latest pointer received before WebGL resources are ready", async () => {
    const ref = createRef<OpeningArrowBackgroundHandle>();
    const result = render(<OpeningArrowBackground ref={ref} />);
    const root = result.container.querySelector<HTMLDivElement>(
      ".onboarding-arrow-background",
    )!;
    expect(harness.gl.drawArrays).not.toHaveBeenCalled();
    expect(animationFrames.size).toBe(0);

    act(() => ref.current?.updatePointer({ x: 180, y: 90 }));

    expect(harness.gl.drawArrays).not.toHaveBeenCalled();
    expect(animationFrames.size).toBe(0);
    await waitFor(() => expect(harness.gl.drawArrays).toHaveBeenCalledTimes(1));

    expect(root.classList.contains("is-webgl-ready")).toBe(true);
    expect(latestUniform(harness.uniform2fSnapshots, "uPointer"))
      .toEqual([180, 90]);
    expect(latestUniform(harness.uniform1fSnapshots, "uPointerStrength"))
      .toEqual([0]);
    expect(animationFrames.size).toBe(1);

    runNextAnimationFrame(1_016);
    expect(latestUniform(harness.uniform1fSnapshots, "uPointerStrength")![0])
      .toBeGreaterThan(0);
  });

  it("coalesces rapid updates into one frame and follows the latest target", async () => {
    const { handle } = await mountRenderer();
    const initialDraws = vi.mocked(harness.gl.drawArrays).mock.calls.length;

    expect(handle.updatePointer({ x: 20, y: 30 })).toBeUndefined();
    expect(handle.updatePointer({ x: 100, y: 90 })).toBeUndefined();
    expect(handle.updatePointer({ x: 180, y: 150 })).toBeUndefined();
    expect(animationFrames.size).toBe(1);
    expect(harness.gl.drawArrays).toHaveBeenCalledTimes(initialDraws);

    runNextAnimationFrame(1_016);

    const expectedX = exponentialApproach(20, 180, 16, 45);
    const expectedY = exponentialApproach(30, 150, 16, 45);
    expect(latestUniform(harness.uniform2fSnapshots, "uPointer")?.[0])
      .toBeCloseTo(expectedX, 8);
    expect(latestUniform(harness.uniform2fSnapshots, "uPointer")?.[1])
      .toBeCloseTo(expectedY, 8);
    expect(latestUniform(harness.uniform1fSnapshots, "uPointerStrength")?.[0])
      .toBeCloseTo(1 - Math.exp(-16 / 28), 8);
    expect(animationFrames.size).toBe(1);
  });

  it("settles to full strength and stops all idle RAF work", async () => {
    const { handle } = await mountRenderer();
    act(() => handle.updatePointer({ x: 160, y: 100 }));

    const framesRun = runUntilIdle();

    expect(framesRun).toBeGreaterThan(1);
    expect(framesRun).toBeLessThan(40);
    expect(latestUniform(harness.uniform2fSnapshots, "uPointer"))
      .toEqual([160, 100]);
    expect(latestUniform(harness.uniform1fSnapshots, "uPointerStrength"))
      .toEqual([1]);
    expect(animationFrames.size).toBe(0);

    const rafCalls = vi.mocked(requestAnimationFrame).mock.calls.length;
    act(() => handle.updatePointer({ x: 160, y: 100 }));
    expect(animationFrames.size).toBe(0);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(rafCalls);
  });

  it("treats timestamp zero as valid for both entry and release clocks", async () => {
    const { handle } = await mountRenderer();
    currentTime = 0;

    act(() => handle.updatePointer({ x: 160, y: 100 }));
    runNextAnimationFrame(16);

    expect(latestUniform(harness.uniform1fSnapshots, "uPointerStrength")?.[0])
      .toBeCloseTo(1 - Math.exp(-16 / 28), 8);
    expect(animationFrames.size).toBe(1);
    runUntilIdle();
    expect(latestUniform(harness.uniform1fSnapshots, "uPointerStrength"))
      .toEqual([1]);

    // A settled animation has no dependency on its previous clock. Rewinding
    // the mock lets this exercise 0 as the release timestamp sentinel edge.
    currentTime = 0;
    act(() => handle.clearPointer());
    runNextAnimationFrame(60);
    expect(latestUniform(harness.uniform1fSnapshots, "uPointerStrength")![0])
      .toBeGreaterThan(0);
    runNextAnimationFrame(120);

    expect(latestUniform(harness.uniform1fSnapshots, "uPointerStrength"))
      .toEqual([0]);
    expect(animationFrames.size).toBe(0);
  });

  it("relaxes continuously, reaches exact zero by 120ms, and stays idle", async () => {
    const { handle } = await mountRenderer();
    act(() => handle.updatePointer({ x: 160, y: 100 }));
    runUntilIdle();
    const releaseAt = currentTime;

    expect(handle.clearPointer()).toBeUndefined();
    expect(animationFrames.size).toBe(1);

    runNextAnimationFrame(releaseAt + 60);
    const halfwayStrength = latestUniform(
      harness.uniform1fSnapshots,
      "uPointerStrength",
    )![0]!;
    expect(halfwayStrength).toBeGreaterThan(0);
    expect(halfwayStrength).toBeLessThan(1);
    expect(animationFrames.size).toBe(1);

    runNextAnimationFrame(releaseAt + 119);
    expect(latestUniform(harness.uniform1fSnapshots, "uPointerStrength")![0])
      .toBeGreaterThan(0);
    expect(animationFrames.size).toBe(1);

    runNextAnimationFrame(releaseAt + 120);
    expect(latestUniform(harness.uniform1fSnapshots, "uPointerStrength"))
      .toEqual([0]);
    expect(animationFrames.size).toBe(0);

    const rafCalls = vi.mocked(requestAnimationFrame).mock.calls.length;
    const draws = vi.mocked(harness.gl.drawArrays).mock.calls.length;
    act(() => handle.clearPointer());
    expect(animationFrames.size).toBe(0);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(rafCalls);
    expect(harness.gl.drawArrays).toHaveBeenCalledTimes(draws);
  });

  it("does no draw or RAF work when clearPointer is already at rest", async () => {
    const { handle } = await mountRenderer();
    const draws = vi.mocked(harness.gl.drawArrays).mock.calls.length;
    const rafCalls = vi.mocked(requestAnimationFrame).mock.calls.length;

    act(() => handle.clearPointer());

    expect(harness.gl.drawArrays).toHaveBeenCalledTimes(draws);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(rafCalls);
    expect(animationFrames.size).toBe(0);
  });

  it("disables and resets interaction under reduced motion", async () => {
    const { handle } = await mountRenderer();
    act(() => handle.updatePointer({ x: 100, y: 100 }));
    expect(animationFrames.size).toBe(1);

    act(() => setReducedMotion(true));

    expect(animationFrames.size).toBe(0);
    expect(latestUniform(harness.uniform1fSnapshots, "uPointerStrength"))
      .toEqual([0]);
    const drawsAfterReset = vi.mocked(harness.gl.drawArrays).mock.calls.length;
    act(() => handle.updatePointer({ x: 200, y: 120 }));
    expect(animationFrames.size).toBe(0);
    expect(harness.gl.drawArrays).toHaveBeenCalledTimes(drawsAfterReset);

    act(() => setReducedMotion(false));
    act(() => handle.updatePointer({ x: 200, y: 120 }));
    expect(animationFrames.size).toBe(1);
  });

  it("resets while hidden and resumes without an ambient loop", async () => {
    const { handle } = await mountRenderer();
    act(() => handle.updatePointer({ x: 80, y: 80 }));
    runNextAnimationFrame(1_016);
    expect(animationFrames.size).toBe(1);

    act(() => setDocumentHidden(true));
    expect(animationFrames.size).toBe(0);

    const drawsBeforeReveal = vi.mocked(harness.gl.drawArrays).mock.calls.length;
    act(() => setDocumentHidden(false));
    expect(harness.gl.drawArrays).toHaveBeenCalledTimes(drawsBeforeReveal + 1);
    expect(latestUniform(harness.uniform1fSnapshots, "uPointerStrength"))
      .toEqual([0]);
    expect(animationFrames.size).toBe(0);

    act(() => handle.updatePointer({ x: 90, y: 90 }));
    expect(animationFrames.size).toBe(1);
  });

  it("releases fallback ownership on context loss and restores a static frame", async () => {
    const { canvas, handle, root } = await mountRenderer();
    act(() => handle.updatePointer({ x: 100, y: 100 }));
    expect(animationFrames.size).toBe(1);

    const lostEvent = new Event("webglcontextlost", { cancelable: true });
    act(() => canvas.dispatchEvent(lostEvent));

    expect(lostEvent.defaultPrevented).toBe(true);
    expect(animationFrames.size).toBe(0);
    expect(root.classList.contains("is-webgl-ready")).toBe(false);
    expect(canvas.classList.contains("is-ready")).toBe(false);
    const rafCalls = vi.mocked(requestAnimationFrame).mock.calls.length;
    act(() => handle.updatePointer({ x: 200, y: 120 }));
    expect(requestAnimationFrame).toHaveBeenCalledTimes(rafCalls);

    const drawsBeforeRestore = vi.mocked(harness.gl.drawArrays).mock.calls.length;
    act(() => canvas.dispatchEvent(new Event("webglcontextrestored")));

    expect(harness.gl.createProgram).toHaveBeenCalledTimes(2);
    expect(harness.gl.drawArrays).toHaveBeenCalledTimes(drawsBeforeRestore + 1);
    expect(harness.ownershipAtDraw.at(-1)).toEqual({
      rootReady: false,
      canvasReady: false,
    });
    expect(root.classList.contains("is-webgl-ready")).toBe(true);
    expect(canvas.classList.contains("is-ready")).toBe(true);
    expect(latestUniform(harness.uniform1fSnapshots, "uPointerStrength"))
      .toEqual([0]);
    expect(animationFrames.size).toBe(0);
  });

  it("caches bounds between pointer frames and remeasures only on resize", async () => {
    canvasLeft = 10;
    canvasTop = 20;
    const { canvas, handle } = await mountRenderer();
    const boundsSpy = vi.mocked(canvas.getBoundingClientRect);
    expect(boundsSpy).toHaveBeenCalledTimes(1);

    act(() => handle.updatePointer({ x: 210, y: 110 }));
    act(() => handle.updatePointer({ x: 220, y: 120 }));
    expect(boundsSpy).toHaveBeenCalledTimes(1);
    runUntilIdle();
    expect(latestUniform(harness.uniform2fSnapshots, "uPointer"))
      .toEqual([210, 100]);

    canvasLeft = 20;
    canvasTop = 30;
    canvasWidth = 300;
    canvasHeight = 180;
    act(() => resizeObservers[0]!.emit(300, 180));
    expect(boundsSpy).toHaveBeenCalledTimes(2);
    runUntilIdle();
    expect(latestUniform(harness.uniform2fSnapshots, "uPointer"))
      .toEqual([200, 90]);
  });

  it("redraws resized bounds with device pixel ratio capped at 1.5", async () => {
    devicePixelRatio = 2;
    const { canvas } = await mountRenderer();

    expect(canvas.width).toBe(600);
    expect(canvas.height).toBe(360);
    expect(latestUniform(harness.uniform2fSnapshots, "uCssResolution"))
      .toEqual([400, 240]);
    expect(latestUniform(harness.uniform4fvSnapshots, "uRepulsionConfig"))
      .toEqual([120, 2, 6, expect.closeTo(0.72, 6)]);

    canvasWidth = 200;
    canvasHeight = 100;
    act(() => resizeObservers[0]!.emit(200, 100));

    expect(canvas.width).toBe(300);
    expect(canvas.height).toBe(150);
    expect(harness.gl.viewport).toHaveBeenLastCalledWith(0, 0, 300, 150);
    expect(latestUniform(harness.uniform2fSnapshots, "uCssResolution"))
      .toEqual([200, 100]);
    expect(animationFrames.size).toBe(0);
  });

  it("draws exactly once for an idle resize and does not start a RAF", async () => {
    const { canvas } = await mountRenderer();
    const draws = vi.mocked(harness.gl.drawArrays).mock.calls.length;
    const rafCalls = vi.mocked(requestAnimationFrame).mock.calls.length;
    canvasWidth = 320;
    canvasHeight = 180;

    act(() => resizeObservers[0]!.emit(320, 180));

    expect(harness.gl.drawArrays).toHaveBeenCalledTimes(draws + 1);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(rafCalls);
    expect(animationFrames.size).toBe(0);
    expect(canvas.width).toBe(320);
    expect(canvas.height).toBe(180);
  });

  it("cancels pending work and disposes GPU resources on unmount", async () => {
    const { canvas, handle, root, unmount } = await mountRenderer();
    act(() => handle.updatePointer({ x: 80, y: 80 }));

    unmount();

    expect(animationFrames.size).toBe(0);
    expect(root.classList.contains("is-webgl-ready")).toBe(false);
    expect(canvas.classList.contains("is-ready")).toBe(false);
    expect(harness.gl.deleteTexture).toHaveBeenCalledTimes(2);
    expect(harness.gl.deleteVertexArray).toHaveBeenCalledTimes(1);
    expect(harness.gl.deleteBuffer).toHaveBeenCalledTimes(1);
    expect(harness.gl.deleteProgram).toHaveBeenCalledTimes(1);
    expect(resizeObservers[0]!.observed.size).toBe(0);
    expect(motionListeners.size).toBe(0);
  });
});

describe("OpeningArrowBackground markup", () => {
  it("keeps the measured CSS fallback under neutrally named WebGL arrows", () => {
    const markup = renderToStaticMarkup(<OpeningArrowBackground />);
    expect(markup).toContain('class="onboarding-arrow-background"');
    expect(markup).toContain('class="onboarding-arrow-field"');
    expect(markup).toContain('class="onboarding-arrow-pattern"');
    expect(markup).toContain('class="onboarding-arrow-canvas"');
    expect(markup).not.toMatch(/ripple|ring|fallback-target|data-transition/i);
    expect(markup).toContain('aria-hidden="true"');
  });
});
