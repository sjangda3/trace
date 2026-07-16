import { useEffect, useRef } from "react";
import fragmentShaderSource from "./shaders/opening-background.frag.glsl?raw";
import vertexShaderSource from "./shaders/opening-background.vert.glsl?raw";

export type OpeningTransitionTarget = "login" | "signup" | null;
export type OpeningTransitionDirection = "forward" | "reverse";

type ConcreteOpeningTarget = Exclude<OpeningTransitionTarget, null>;

interface OpeningShaderBackgroundProps {
  transitionTarget?: OpeningTransitionTarget;
  transitionDirection?: OpeningTransitionDirection;
  onTransitionComplete?: (target: ConcreteOpeningTarget, direction: OpeningTransitionDirection) => void;
}

interface TransitionState {
  target: OpeningTransitionTarget;
  direction: OpeningTransitionDirection;
  startedAt: number;
  phaseTime: number;
  completed: boolean;
}

const MAX_DEVICE_PIXEL_RATIO = 1.5;
const AMBIENT_FRAME_INTERVAL_MS = 50;
const TRANSITION_DURATION_SECONDS = 0.84;
const FALLBACK_SETTLE_MS = 440;

export function openingTransitionProgress(
  direction: OpeningTransitionDirection,
  time: number,
  startedAt: number,
  reducedMotion = false,
) {
  if (reducedMotion) return direction === "reverse" ? 0 : 1;
  const forwardProgress = Math.min(Math.max((time - startedAt) / TRANSITION_DURATION_SECONDS, 0), 1);
  return direction === "reverse" ? 1 - forwardProgress : forwardProgress;
}

type ColorStop = readonly [number, number, number];
type TargetPalette = readonly [ColorStop, ColorStop, ColorStop, ColorStop];

// Login and Sign up are different navigation targets, but they intentionally
// resolve through the same blue/cyan field so the opening motion has one visual
// language and one implementation path.
export const AUTH_TRANSITION_PALETTE: TargetPalette = [
  [0.976, 0.992, 1.000],
  [0.702, 0.890, 0.969],
  [0.631, 0.710, 0.941],
  [0.290, 0.439, 0.878],
];

function compileShader(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("WebGL could not allocate a shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "Unknown shader compilation error.";
    gl.deleteShader(shader);
    throw new Error(log);
  }
  return shader;
}

function linkProgram(gl: WebGL2RenderingContext) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    throw new Error("WebGL could not allocate a shader program.");
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "Unknown shader link error.";
    gl.deleteProgram(program);
    throw new Error(log);
  }
  return program;
}

export function OpeningShaderBackground({
  transitionTarget = null,
  transitionDirection = "forward",
  onTransitionComplete,
}: OpeningShaderBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const elapsedSecondsRef = useRef(0);
  const rendererReadyRef = useRef(false);
  const drawRef = useRef<(() => void) | null>(null);
  const startAnimationRef = useRef<(() => void) | null>(null);
  const transitionCompleteRef = useRef(onTransitionComplete);
  const transitionStateRef = useRef<TransitionState>({
    target: transitionTarget,
    direction: transitionDirection,
    startedAt: 0,
    phaseTime: 0,
    completed: false,
  });

  transitionCompleteRef.current = onTransitionComplete;

  const completeTransitionRef = useRef<() => void>(() => undefined);
  completeTransitionRef.current = () => {
    const transition = transitionStateRef.current;
    if (!transition.target || transition.completed) return;
    transition.completed = true;

    // Returning to the opening field ends on the captured contour. Rebase the
    // ambient clock before React removes the transition target so the live wave
    // resumes from that same contour instead of snapping to a later phase.
    if (transition.direction === "reverse") elapsedSecondsRef.current = transition.phaseTime;

    const target = transition.target;
    const direction = transition.direction;
    queueMicrotask(() => {
      const current = transitionStateRef.current;
      if (current.target === target && current.direction === direction) {
        transitionCompleteRef.current?.(target, direction);
      }
    });
  };

  useEffect(() => {
    const transition = transitionStateRef.current;
    const targetChanged = transition.target !== transitionTarget;
    const directionChanged = transition.direction !== transitionDirection;
    if (targetChanged || directionChanged) {
      transitionStateRef.current = {
        target: transitionTarget,
        direction: transitionDirection,
        startedAt: elapsedSecondsRef.current,
        // A forward -> reverse change is the same captured wave traversing in
        // the other direction. Only a new target is allowed to capture anew.
        phaseTime: targetChanged ? elapsedSecondsRef.current : transition.phaseTime,
        completed: false,
      };
    }

    drawRef.current?.();
    startAnimationRef.current?.();

    if (!transitionTarget) return;
    const fallbackTimer = window.setTimeout(() => {
      if (!rendererReadyRef.current) completeTransitionRef.current();
    }, FALLBACK_SETTLE_MS);
    return () => window.clearTimeout(fallbackTimer);
  }, [transitionTarget, transitionDirection]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const contextAttributes: WebGLContextAttributes = {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: "low-power",
    };

    let gl: WebGL2RenderingContext | null = null;
    let program: WebGLProgram | null = null;
    let vertexBuffer: WebGLBuffer | null = null;
    let vertexArray: WebGLVertexArrayObject | null = null;
    let resolutionUniform: WebGLUniformLocation | null = null;
    let timeUniform: WebGLUniformLocation | null = null;
    let transitionProgressUniform: WebGLUniformLocation | null = null;
    let transitionPhaseUniform: WebGLUniformLocation | null = null;
    let transitionActiveUniform: WebGLUniformLocation | null = null;
    let targetColor0Uniform: WebGLUniformLocation | null = null;
    let targetColor1Uniform: WebGLUniformLocation | null = null;
    let targetColor2Uniform: WebGLUniformLocation | null = null;
    let targetColor3Uniform: WebGLUniformLocation | null = null;
    let animationFrame = 0;
    let previousFrameTime = performance.now();
    let previousDrawTime = -Infinity;
    let contextLost = false;
    let disposed = false;
    let cssWidth = 0;
    let cssHeight = 0;

    const updateCanvasBounds = () => {
      const bounds = canvas.getBoundingClientRect();
      cssWidth = bounds.width;
      cssHeight = bounds.height;
    };

    const cancelAnimation = () => {
      if (!animationFrame) return;
      cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    };

    const disposeResources = () => {
      if (!gl || contextLost) return;
      if (vertexArray) gl.deleteVertexArray(vertexArray);
      if (vertexBuffer) gl.deleteBuffer(vertexBuffer);
      if (program) gl.deleteProgram(program);
      vertexArray = null;
      vertexBuffer = null;
      program = null;
      rendererReadyRef.current = false;
    };

    const createResources = () => {
      if (!gl) return false;
      disposeResources();
      program = linkProgram(gl);
      vertexBuffer = gl.createBuffer();
      vertexArray = gl.createVertexArray();
      if (!vertexBuffer || !vertexArray) throw new Error("WebGL could not allocate fullscreen geometry.");

      const positionAttribute = gl.getAttribLocation(program, "aPosition");
      resolutionUniform = gl.getUniformLocation(program, "uResolution");
      timeUniform = gl.getUniformLocation(program, "uTime");
      transitionProgressUniform = gl.getUniformLocation(program, "uTransitionProgress");
      transitionPhaseUniform = gl.getUniformLocation(program, "uTransitionPhase");
      transitionActiveUniform = gl.getUniformLocation(program, "uTransitionActive");
      targetColor0Uniform = gl.getUniformLocation(program, "uTargetColor0");
      targetColor1Uniform = gl.getUniformLocation(program, "uTargetColor1");
      targetColor2Uniform = gl.getUniformLocation(program, "uTargetColor2");
      targetColor3Uniform = gl.getUniformLocation(program, "uTargetColor3");
      if (
        positionAttribute < 0
        || !resolutionUniform
        || !timeUniform
        || !transitionProgressUniform
        || !transitionPhaseUniform
        || !transitionActiveUniform
        || !targetColor0Uniform
        || !targetColor1Uniform
        || !targetColor2Uniform
        || !targetColor3Uniform
      ) {
        throw new Error("WebGL optimized away a required opening-background input.");
      }

      gl.bindVertexArray(vertexArray);
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(positionAttribute);
      gl.vertexAttribPointer(positionAttribute, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
      rendererReadyRef.current = true;
      return true;
    };

    const progressFor = (time: number) => {
      const transition = transitionStateRef.current;
      if (!transition.target) return 0;
      return openingTransitionProgress(transition.direction, time, transition.startedAt, motionPreference.matches);
    };

    const draw = (time: number) => {
      if (!gl || !program || !vertexArray || contextLost || disposed) return;
      if (cssWidth <= 0 || cssHeight <= 0) updateCanvasBounds();
      if (cssWidth <= 0 || cssHeight <= 0) return;

      const pixelRatio = Math.min(window.devicePixelRatio || 1, MAX_DEVICE_PIXEL_RATIO);
      const width = Math.max(1, Math.round(cssWidth * pixelRatio));
      const height = Math.max(1, Math.round(cssHeight * pixelRatio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      const transition = transitionStateRef.current;
      const progress = progressFor(time);

      // Context restoration resets WebGL state even when the dimensions match.
      gl.viewport(0, 0, width, height);
      gl.useProgram(program);
      gl.uniform2f(resolutionUniform, width, height);
      gl.uniform1f(timeUniform, time);
      gl.uniform1f(transitionProgressUniform, progress);
      gl.uniform1f(transitionPhaseUniform, transition.phaseTime);
      gl.uniform1f(transitionActiveUniform, transition.target ? 1 : 0);
      gl.uniform3fv(targetColor0Uniform, AUTH_TRANSITION_PALETTE[0]);
      gl.uniform3fv(targetColor1Uniform, AUTH_TRANSITION_PALETTE[1]);
      gl.uniform3fv(targetColor2Uniform, AUTH_TRANSITION_PALETTE[2]);
      gl.uniform3fv(targetColor3Uniform, AUTH_TRANSITION_PALETTE[3]);
      gl.bindVertexArray(vertexArray);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
      canvas.classList.add("is-ready");

      const transitionFinished = transition.direction === "reverse" ? progress <= 0 : progress >= 1;
      if (transition.target && transitionFinished) completeTransitionRef.current();
    };

    const tick = (now: number) => {
      animationFrame = 0;
      if (disposed || contextLost || motionPreference.matches || document.hidden) return;

      elapsedSecondsRef.current += Math.min((now - previousFrameTime) / 1000, 0.1);
      previousFrameTime = now;
      const transition = transitionStateRef.current;
      const transitionActive = Boolean(transition.target && !transition.completed);

      // Ambient drift stays low-power at 20 fps; the short full-screen wipe uses
      // display-rate RAF so its crest never advances in visible steps.
      if (transitionActive || now - previousDrawTime >= AMBIENT_FRAME_INTERVAL_MS) {
        draw(elapsedSecondsRef.current);
        previousDrawTime = now;
      }

      if (transitionStateRef.current.target && transitionStateRef.current.completed) return;
      animationFrame = requestAnimationFrame(tick);
    };

    const startAnimation = () => {
      const transition = transitionStateRef.current;
      if (
        animationFrame
        || disposed
        || contextLost
        || motionPreference.matches
        || document.hidden
        || Boolean(transition.target && transition.completed)
      ) return;
      previousFrameTime = performance.now();
      animationFrame = requestAnimationFrame(tick);
    };

    drawRef.current = () => draw(elapsedSecondsRef.current);
    startAnimationRef.current = startAnimation;

    const handleResize = () => {
      updateCanvasBounds();
      draw(elapsedSecondsRef.current);
    };
    const handleObservedResize = (entries: ResizeObserverEntry[]) => {
      const bounds = entries[0]?.contentRect;
      if (bounds) {
        cssWidth = bounds.width;
        cssHeight = bounds.height;
      } else {
        updateCanvasBounds();
      }
      draw(elapsedSecondsRef.current);
    };
    const handleVisibilityChange = () => {
      if (document.hidden) {
        cancelAnimation();
        return;
      }
      draw(elapsedSecondsRef.current);
      startAnimation();
    };
    const handleMotionChange = () => {
      if (motionPreference.matches) {
        cancelAnimation();
        draw(elapsedSecondsRef.current);
      } else {
        startAnimation();
      }
    };
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      contextLost = true;
      rendererReadyRef.current = false;
      cancelAnimation();
      canvas.classList.remove("is-ready");
      completeTransitionRef.current();
    };
    const handleContextRestored = () => {
      contextLost = false;
      try {
        if (createResources()) {
          draw(elapsedSecondsRef.current);
          startAnimation();
        }
      } catch (error) {
        canvas.classList.remove("is-ready");
        console.warn("Trace opening shader could not be restored; using the static background.", error);
      }
    };

    const resizeObserver = new ResizeObserver(handleObservedResize);
    resizeObserver.observe(canvas);
    window.addEventListener("resize", handleResize);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    motionPreference.addEventListener("change", handleMotionChange);
    canvas.addEventListener("webglcontextlost", handleContextLost);
    canvas.addEventListener("webglcontextrestored", handleContextRestored);

    try {
      updateCanvasBounds();
      gl = canvas.getContext("webgl2", contextAttributes);
      if (!gl) throw new Error("WebGL2 is unavailable.");
      if (createResources()) {
        draw(0);
        startAnimation();
      }
    } catch (error) {
      canvas.classList.remove("is-ready");
      disposeResources();
      console.warn("Trace opening shader is unavailable; using the static background.", error);
    }

    return () => {
      disposed = true;
      cancelAnimation();
      resizeObserver.disconnect();
      window.removeEventListener("resize", handleResize);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      motionPreference.removeEventListener("change", handleMotionChange);
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      canvas.removeEventListener("webglcontextrestored", handleContextRestored);
      canvas.classList.remove("is-ready");
      drawRef.current = null;
      startAnimationRef.current = null;
      rendererReadyRef.current = false;
      disposeResources();
    };
  }, []);

  return <canvas ref={canvasRef} className="onboarding-opening-shader" aria-hidden="true" />;
}
