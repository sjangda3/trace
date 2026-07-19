import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import arrowTileUrl from "../assets/onboarding-onramp-arrow-tile.png";
import densityMaskUrl from "../assets/onboarding-onramp-density.png";
import fieldUrl from "../assets/onboarding-onramp-field.png";
import fragmentShaderSource from "./shaders/opening-background.frag.glsl?raw";
import vertexShaderSource from "./shaders/opening-background.vert.glsl?raw";
import { OPENING_SCENE_DURATION_MS } from "./opening-motion";

export interface PointerPoint {
  x: number;
  y: number;
}

export interface OpeningArrowBackgroundHandle {
  updatePointer: (point: PointerPoint) => void;
  clearPointer: () => void;
}

/**
 * The opening forms sit above a deliberately dense arrow field. These presets
 * soften only that arrow layer in a broad, feathered ellipse so text remains
 * legible without introducing a visible panel or touching the base gradient.
 */
export type OpeningReadingField = "none" | "compact" | "expanded";

export const ARROW_REPULSION_CONFIG = {
  radiusPx: 120,
  innerRatio: 0.72,
  minShiftPx: 2,
  maxShiftPx: 6,
  pointerTimeConstantMs: 60,
  enterTimeConstantMs: 36,
  releaseTimeConstantMs: 36,
  releaseDurationMs: 120,
} as const;

const OPENING_ARTWORK_WIDTH = 1248;
const OPENING_ARTWORK_HEIGHT = 725;
const MAX_DEVICE_PIXEL_RATIO = 2;
const POSITION_EPSILON_PX = 0.05;
const STRENGTH_EPSILON = 0.002;
const READING_FIELD_TRANSITION_MS = OPENING_SCENE_DURATION_MS;

function readingFieldStrength(field: OpeningReadingField) {
  if (field === "compact") return 0.82;
  if (field === "expanded") return 0.8;
  return 0;
}

function writeReadingFieldUniform(
  target: Float32Array,
  field: OpeningReadingField,
  viewportWidth: number,
  viewportHeight: number,
) {
  target[0] = viewportWidth * 0.5;
  target[1] = viewportHeight * 0.5;

  if (field === "compact") {
    target[2] = Math.min(Math.max(viewportWidth * 0.34, 250), 360);
    target[3] = Math.min(Math.max(viewportHeight * 0.5, 250), 360);
    return readingFieldStrength(field);
  }

  if (field === "expanded") {
    target[2] = Math.min(Math.max(viewportWidth * 0.5, 360), 460);
    target[3] = Math.min(Math.max(viewportHeight * 0.68, 390), 500);
    return readingFieldStrength(field);
  }

  // A non-zero radius keeps the shader math well-defined while the zero
  // strength makes the choice screen visually identical to the original.
  target[2] = 1;
  target[3] = 1;
  return 0;
}

interface CoverUvTransform {
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}

function centeredCoverUvTransform(
  viewportWidth: number,
  viewportHeight: number,
): CoverUvTransform {
  if (viewportWidth <= 0 || viewportHeight <= 0) {
    return { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };
  }

  const artworkAspect = OPENING_ARTWORK_WIDTH / OPENING_ARTWORK_HEIGHT;
  const viewportAspect = viewportWidth / viewportHeight;
  const scaleX = viewportAspect < artworkAspect
    ? viewportAspect / artworkAspect
    : 1;
  const scaleY = viewportAspect > artworkAspect
    ? artworkAspect / viewportAspect
    : 1;

  return {
    scaleX,
    scaleY,
    offsetX: (1 - scaleX) * 0.5,
    offsetY: (1 - scaleY) * 0.5,
  };
}

const staticPatternStyle = {
  backgroundImage: `url("${arrowTileUrl}")`,
  WebkitMaskImage: `url("${densityMaskUrl}")`,
  maskImage: `url("${densityMaskUrl}")`,
};

export function isHoverPointer(pointerType: string, pressure = 0) {
  return pointerType === "mouse" || (pointerType === "pen" && pressure === 0);
}

export function canUpdateOpeningPointer(
  isChoiceScreen: boolean,
  pointerType: string,
  pressure = 0,
) {
  return isChoiceScreen && isHoverPointer(pointerType, pressure);
}

export function relativePointerOrigin(
  clientX: number,
  clientY: number,
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
) {
  return {
    x: Math.min(Math.max(clientX - bounds.left, 0), bounds.width),
    y: Math.min(Math.max(clientY - bounds.top, 0), bounds.height),
  };
}

export function exponentialApproach(
  current: number,
  target: number,
  deltaMs: number,
  timeConstantMs: number,
) {
  const elapsedMs = Math.max(deltaMs, 0);
  const blend = 1 - Math.exp(-elapsedMs / Math.max(timeConstantMs, 1));
  return current + (target - current) * blend;
}

function smootherstep01(value: number) {
  const unit = Math.min(Math.max(value, 0), 1);
  return unit * unit * unit * (unit * (unit * 6 - 15) + 10);
}

function smootherstepDerivative01(value: number) {
  const unit = Math.min(Math.max(value, 0), 1);
  return 30 * unit * unit * (unit - 1) * (unit - 1);
}

export function repulsionMagnitude(distancePx: number, strength = 1) {
  const {
    innerRatio,
    maxShiftPx,
    minShiftPx,
    radiusPx,
  } = ARROW_REPULSION_CONFIG;
  const normalizedDistance = Math.min(
    Math.max(distancePx / radiusPx, 0),
    1,
  );
  const coreProgress = smootherstep01(normalizedDistance / innerRatio);
  const coreMagnitude = maxShiftPx
    + (minShiftPx - maxShiftPx) * coreProgress;
  const featherProgress = smootherstep01(
    (normalizedDistance - innerRatio) / (1 - innerRatio),
  );
  return coreMagnitude
    * (1 - featherProgress)
    * Math.min(Math.max(strength, 0), 1);
}

export function repulsionCompressionCompensation(
  distancePx: number,
  strength = 1,
) {
  const {
    innerRatio,
    minShiftPx,
    radiusPx,
  } = ARROW_REPULSION_CONFIG;
  const featherStartPx = radiusPx * innerRatio;
  if (distancePx < featherStartPx || distancePx >= radiusPx) return 1;

  const normalizedDistance = Math.min(
    Math.max(distancePx / radiusPx, 0),
    1,
  );
  const featherUnit = (normalizedDistance - innerRatio) / (1 - innerRatio);
  const clampedStrength = Math.min(Math.max(strength, 0), 1);
  const derivative = -minShiftPx
    * smootherstepDerivative01(featherUnit)
    / (radiusPx * (1 - innerRatio))
    * clampedStrength;
  const radialScale = 1 + derivative;
  const tangentialScale = 1
    + repulsionMagnitude(distancePx, clampedStrength) / distancePx;
  const jacobian = Math.min(
    Math.max(radialScale * tangentialScale, 0),
    1,
  );
  return jacobian ** 0.78;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
) {
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

function loadImage(source: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load opening texture: ${source}`));
    image.src = source;
  });
}

function createTexture(
  gl: WebGL2RenderingContext,
  image: HTMLImageElement,
  repeat: boolean,
) {
  const texture = gl.createTexture();
  if (!texture) throw new Error("WebGL could not allocate an opening texture.");

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_WRAP_S,
    repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE,
  );
  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_WRAP_T,
    repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE,
  );
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    image,
  );
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

export const OpeningArrowBackground = forwardRef<
  OpeningArrowBackgroundHandle,
  { readingField?: OpeningReadingField }
>(
  function OpeningArrowBackground({ readingField = "none" }, ref) {
    const rootRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const readingFieldRef = useRef<OpeningReadingField>(readingField);
    const washClearTimeoutRef = useRef<number | null>(null);
    const [readingWash, setReadingWash] = useState<OpeningReadingField>(readingField);
    const [readingWashActive, setReadingWashActive] = useState(
      readingField !== "none",
    );
    const redrawRef = useRef<() => void>(() => undefined);
    const updateReadingFieldRef = useRef<(field: OpeningReadingField) => void>(
      () => undefined,
    );
    const updatePointerRef = useRef<OpeningArrowBackgroundHandle["updatePointer"]>(
      () => undefined,
    );
    const clearPointerRef = useRef<OpeningArrowBackgroundHandle["clearPointer"]>(
      () => undefined,
    );

    useImperativeHandle(ref, () => ({
      updatePointer(point) {
        updatePointerRef.current(point);
      },
      clearPointer() {
        clearPointerRef.current();
      },
    }), []);

    useEffect(() => {
      const root = rootRef.current;
      const canvas = canvasRef.current;
      if (!root || !canvas) return;

      const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
      const contextAttributes: WebGLContextAttributes = {
        alpha: true,
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
      let densityTexture: WebGLTexture | null = null;
      let arrowTexture: WebGLTexture | null = null;
      let images: readonly [HTMLImageElement, HTMLImageElement] | null = null;
      let animationFrame = 0;
      let contextLost = false;
      let disposed = false;
      let rendererReady = false;
      let ownsArrowLayer = false;
      let cssLeft = 0;
      let cssTop = 0;
      let cssWidth = 0;
      let cssHeight = 0;
      let hasClientPointer = false;
      let lastClientX = 0;
      let lastClientY = 0;
      let currentPointerX = 0;
      let currentPointerY = 0;
      let targetPointerX = 0;
      let targetPointerY = 0;
      let currentStrength = 0;
      let targetStrength = 0;
      let currentReadingFieldStrength = readingFieldStrength(readingField);
      let targetReadingFieldStrength = currentReadingFieldStrength;
      let readingFieldTransitionFrom = currentReadingFieldStrength;
      let readingFieldTransitionStartedAt: number | null = null;
      let lastFrameTime: number | null = null;
      let releaseStartedAt: number | null = null;
      let canvasPixelRatio = 0;
      const uniforms: Record<string, WebGLUniformLocation | null> = {};
      const repulsionConfig = new Float32Array([
        ARROW_REPULSION_CONFIG.radiusPx,
        ARROW_REPULSION_CONFIG.minShiftPx,
        ARROW_REPULSION_CONFIG.maxShiftPx,
        ARROW_REPULSION_CONFIG.innerRatio,
      ]);
      const densityUvTransform = new Float32Array([1, 1, 0, 0]);
      const readingFieldUniform = new Float32Array(4);

      const updateCanvasBounds = () => {
        const bounds = canvas.getBoundingClientRect();
        cssLeft = bounds.left;
        cssTop = bounds.top;
        cssWidth = bounds.width;
        cssHeight = bounds.height;
        const coverTransform = centeredCoverUvTransform(cssWidth, cssHeight);
        densityUvTransform.set([
          coverTransform.scaleX,
          coverTransform.scaleY,
          coverTransform.offsetX,
          coverTransform.offsetY,
        ]);
      };

      const updateTargetFromClientPointer = () => {
        const local = relativePointerOrigin(lastClientX, lastClientY, {
          left: cssLeft,
          top: cssTop,
          width: cssWidth,
          height: cssHeight,
        });
        targetPointerX = local.x;
        targetPointerY = local.y;
      };

      const cancelAnimation = () => {
        if (!animationFrame) return;
        cancelAnimationFrame(animationFrame);
        animationFrame = 0;
      };

      const releaseArrowLayer = () => {
        ownsArrowLayer = false;
        root.classList.remove("is-webgl-ready");
        canvas.classList.remove("is-ready");
      };

      const claimArrowLayer = () => {
        if (ownsArrowLayer) return;
        ownsArrowLayer = true;
        canvas.classList.add("is-ready");
        root.classList.add("is-webgl-ready");
      };

      const clearResourceHandles = () => {
        densityTexture = null;
        arrowTexture = null;
        vertexArray = null;
        vertexBuffer = null;
        program = null;
      };

      const disposeResources = () => {
        releaseArrowLayer();
        rendererReady = false;
        if (!gl || contextLost) {
          clearResourceHandles();
          return;
        }
        if (densityTexture) gl.deleteTexture(densityTexture);
        if (arrowTexture) gl.deleteTexture(arrowTexture);
        if (vertexArray) gl.deleteVertexArray(vertexArray);
        if (vertexBuffer) gl.deleteBuffer(vertexBuffer);
        if (program) gl.deleteProgram(program);
        clearResourceHandles();
      };

      const requiredUniform = (name: string) => {
        const location = gl?.getUniformLocation(program!, name) ?? null;
        if (location === null) throw new Error(`WebGL optimized away ${name}.`);
        uniforms[name] = location;
      };

      const createResources = () => {
        if (!gl || !images) return false;
        disposeResources();
        program = linkProgram(gl);
        vertexBuffer = gl.createBuffer();
        vertexArray = gl.createVertexArray();
        if (!vertexBuffer || !vertexArray) {
          throw new Error("WebGL could not allocate fullscreen geometry.");
        }

        const positionAttribute = gl.getAttribLocation(program, "aPosition");
        if (positionAttribute < 0) {
          throw new Error("WebGL optimized away aPosition.");
        }

        [
          "uCssResolution",
          "uDensityTexture",
          "uDensityUvTransform",
          "uArrowTexture",
          "uPointer",
          "uPointerStrength",
          "uRepulsionConfig",
          "uReadingField",
          "uReadingFieldStrength",
        ].forEach(requiredUniform);

        gl.bindVertexArray(vertexArray);
        gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
        gl.bufferData(
          gl.ARRAY_BUFFER,
          new Float32Array([-1, -1, 3, -1, -1, 3]),
          gl.STATIC_DRAW,
        );
        gl.enableVertexAttribArray(positionAttribute);
        gl.vertexAttribPointer(positionAttribute, 2, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);

        densityTexture = createTexture(gl, images[0], false);
        arrowTexture = createTexture(gl, images[1], true);
        rendererReady = true;
        return true;
      };

      const draw = () => {
        if (
          !gl
          || !program
          || !vertexArray
          || !densityTexture
          || !arrowTexture
          || contextLost
          || disposed
        ) return false;

        if (cssWidth <= 0 || cssHeight <= 0) updateCanvasBounds();
        if (cssWidth <= 0 || cssHeight <= 0) return false;

        const pixelRatio = Math.min(
          window.devicePixelRatio || 1,
          MAX_DEVICE_PIXEL_RATIO,
        );
        canvasPixelRatio = pixelRatio;
        const width = Math.max(1, Math.round(cssWidth * pixelRatio));
        const height = Math.max(1, Math.round(cssHeight * pixelRatio));
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }

        gl.viewport(0, 0, width, height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.useProgram(program);
        gl.uniform2f(uniforms.uCssResolution, cssWidth, cssHeight);
        gl.uniform2f(uniforms.uPointer, currentPointerX, currentPointerY);
        gl.uniform1f(uniforms.uPointerStrength, currentStrength);
        gl.uniform4fv(uniforms.uRepulsionConfig, repulsionConfig);
        gl.uniform4fv(uniforms.uDensityUvTransform, densityUvTransform);
        writeReadingFieldUniform(
          readingFieldUniform,
          readingFieldRef.current,
          cssWidth,
          cssHeight,
        );
        gl.uniform4fv(uniforms.uReadingField, readingFieldUniform);
        gl.uniform1f(uniforms.uReadingFieldStrength, currentReadingFieldStrength);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, densityTexture);
        gl.uniform1i(uniforms.uDensityTexture, 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, arrowTexture);
        gl.uniform1i(uniforms.uArrowTexture, 1);

        gl.bindVertexArray(vertexArray);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.bindVertexArray(null);
        claimArrowLayer();
        return true;
      };

      // A screen change has no reason to recreate WebGL resources. It only
      // redraws the one static frame with the matching reading-field preset.
      redrawRef.current = draw;

      const pointerIsSettled = () => (
        Math.hypot(
          targetPointerX - currentPointerX,
          targetPointerY - currentPointerY,
        ) <= POSITION_EPSILON_PX
      );

      const strengthIsSettled = () => (
        Math.abs(targetStrength - currentStrength) <= STRENGTH_EPSILON
      );

      const readingFieldIsSettled = () => (
        readingFieldTransitionStartedAt === null
        && Math.abs(targetReadingFieldStrength - currentReadingFieldStrength)
          <= STRENGTH_EPSILON
      );

      const motionIsSettled = () => (
        pointerIsSettled() && strengthIsSettled() && readingFieldIsSettled()
      );

      const settleMotion = (time: number) => {
        const deltaMs = lastFrameTime !== null ? time - lastFrameTime : 0;
        lastFrameTime = time;
        currentPointerX = exponentialApproach(
          currentPointerX,
          targetPointerX,
          deltaMs,
          ARROW_REPULSION_CONFIG.pointerTimeConstantMs,
        );
        currentPointerY = exponentialApproach(
          currentPointerY,
          targetPointerY,
          deltaMs,
          ARROW_REPULSION_CONFIG.pointerTimeConstantMs,
        );
        currentStrength = exponentialApproach(
          currentStrength,
          targetStrength,
          deltaMs,
          targetStrength > currentStrength
            ? ARROW_REPULSION_CONFIG.enterTimeConstantMs
            : ARROW_REPULSION_CONFIG.releaseTimeConstantMs,
        );

        if (pointerIsSettled()) {
          currentPointerX = targetPointerX;
          currentPointerY = targetPointerY;
        }
        if (
          targetStrength === 0
          && releaseStartedAt !== null
          && time - releaseStartedAt >= ARROW_REPULSION_CONFIG.releaseDurationMs
        ) {
          currentStrength = 0;
          currentPointerX = targetPointerX;
          currentPointerY = targetPointerY;
        } else if (strengthIsSettled()) {
          currentStrength = targetStrength;
        }

        if (readingFieldTransitionStartedAt !== null) {
          const progress = Math.min(
            Math.max((time - readingFieldTransitionStartedAt) / READING_FIELD_TRANSITION_MS, 0),
            1,
          );
          const easedProgress = smootherstep01(progress);
          currentReadingFieldStrength = readingFieldTransitionFrom
            + (targetReadingFieldStrength - readingFieldTransitionFrom) * easedProgress;
          if (progress === 1) {
            currentReadingFieldStrength = targetReadingFieldStrength;
            readingFieldTransitionStartedAt = null;
          }
        }
      };

      const tick = (time: number) => {
        animationFrame = 0;
        if (disposed || contextLost || document.hidden) return;
        settleMotion(time);
        draw();
        if (!motionIsSettled()) {
          animationFrame = requestAnimationFrame(tick);
        } else {
          lastFrameTime = null;
          releaseStartedAt = null;
        }
      };

      const startAnimation = () => {
        if (animationFrame || disposed || contextLost || document.hidden) return;
        if (motionIsSettled()) return;
        lastFrameTime = performance.now();
        animationFrame = requestAnimationFrame(tick);
      };

      const resetPointer = () => {
        hasClientPointer = false;
        targetStrength = 0;
        currentStrength = 0;
        releaseStartedAt = null;
        lastFrameTime = null;
        cancelAnimation();
        draw();
      };

      const settleReadingField = () => {
        currentReadingFieldStrength = targetReadingFieldStrength;
        readingFieldTransitionFrom = targetReadingFieldStrength;
        readingFieldTransitionStartedAt = null;
      };

      const activatePointer = () => {
        updateTargetFromClientPointer();
        if (currentStrength <= STRENGTH_EPSILON && targetStrength === 0) {
          currentPointerX = targetPointerX;
          currentPointerY = targetPointerY;
        }
        targetStrength = 1;
        releaseStartedAt = null;
        startAnimation();
      };

      updateReadingFieldRef.current = (field) => {
        readingFieldRef.current = field;
        targetReadingFieldStrength = readingFieldStrength(field);
        if (motionPreference.matches) {
          settleReadingField();
          draw();
          return;
        }
        if (readingFieldIsSettled()) {
          currentReadingFieldStrength = targetReadingFieldStrength;
          draw();
          return;
        }
        readingFieldTransitionFrom = currentReadingFieldStrength;
        readingFieldTransitionStartedAt = performance.now();
        startAnimation();
      };

      updatePointerRef.current = (point) => {
        if (motionPreference.matches || contextLost) return;
        lastClientX = point.x;
        lastClientY = point.y;
        hasClientPointer = true;
        if (!rendererReady) return;
        if (cssWidth <= 0 || cssHeight <= 0) updateCanvasBounds();
        activatePointer();
      };

      clearPointerRef.current = () => {
        hasClientPointer = false;
        if (targetStrength === 0 && currentStrength <= STRENGTH_EPSILON) {
          currentStrength = 0;
          return;
        }
        if (targetStrength !== 0) {
          targetStrength = 0;
          releaseStartedAt = performance.now();
          // The field has not moved since its previous frame. Start the
          // release clock at the leave event so that time before pointerleave
          // is not incorrectly applied to the fade-out.
          lastFrameTime = releaseStartedAt;
        }
        startAnimation();
      };

      const handleObservedResize = () => {
        updateCanvasBounds();
        if (hasClientPointer) updateTargetFromClientPointer();
        draw();
        startAnimation();
      };
      const handleWindowResize = () => {
        const nextPixelRatio = Math.min(
          window.devicePixelRatio || 1,
          MAX_DEVICE_PIXEL_RATIO,
        );
        if (nextPixelRatio === canvasPixelRatio) return;
        draw();
      };
      const handleVisibilityChange = () => {
        if (document.hidden) {
          hasClientPointer = false;
          targetStrength = 0;
          currentStrength = 0;
          releaseStartedAt = null;
          lastFrameTime = null;
          settleReadingField();
          cancelAnimation();
          return;
        }
        draw();
      };
      const handleMotionChange = () => resetPointer();
      const handleContextLost = (event: Event) => {
        event.preventDefault();
        contextLost = true;
        rendererReady = false;
        hasClientPointer = false;
        targetStrength = 0;
        currentStrength = 0;
        settleReadingField();
        releaseStartedAt = null;
        lastFrameTime = null;
        clearResourceHandles();
        cancelAnimation();
        releaseArrowLayer();
      };
      const handleContextRestored = () => {
        contextLost = false;
        try {
          settleReadingField();
          if (createResources()) draw();
        } catch (error) {
          releaseArrowLayer();
          console.warn(
            "Trace opening arrows could not be restored; using the CSS fallback.",
            error,
          );
        }
      };

      const resizeObserver = new ResizeObserver(handleObservedResize);
      resizeObserver.observe(canvas);
      window.addEventListener("resize", handleWindowResize);
      document.addEventListener("visibilitychange", handleVisibilityChange);
      motionPreference.addEventListener("change", handleMotionChange);
      canvas.addEventListener("webglcontextlost", handleContextLost);
      canvas.addEventListener("webglcontextrestored", handleContextRestored);

      void Promise.all([
        loadImage(densityMaskUrl),
        loadImage(arrowTileUrl),
      ]).then((loadedImages) => {
        if (disposed) return;
        images = loadedImages;
        gl = canvas.getContext("webgl2", contextAttributes);
        if (!gl) throw new Error("WebGL2 is unavailable.");
        updateCanvasBounds();
        if (createResources()) {
          if (hasClientPointer && !motionPreference.matches) activatePointer();
          draw();
        }
      }).catch((error) => {
        if (disposed) return;
        releaseArrowLayer();
        console.warn(
          "Trace opening arrow interaction is unavailable; using the CSS fallback.",
          error,
        );
      });

      return () => {
        disposed = true;
        cancelAnimation();
        resizeObserver.disconnect();
        window.removeEventListener("resize", handleWindowResize);
        document.removeEventListener("visibilitychange", handleVisibilityChange);
        motionPreference.removeEventListener("change", handleMotionChange);
        canvas.removeEventListener("webglcontextlost", handleContextLost);
        canvas.removeEventListener("webglcontextrestored", handleContextRestored);
        updatePointerRef.current = () => undefined;
        clearPointerRef.current = () => undefined;
        redrawRef.current = () => undefined;
        updateReadingFieldRef.current = () => undefined;
        disposeResources();
      };
    }, []);

    useLayoutEffect(() => {
      readingFieldRef.current = readingField;
      updateReadingFieldRef.current(readingField);
    }, [readingField]);

    // Keep the previous gradient mounted while its opacity falls to zero. If
    // the profile disappeared with the prop, Back would reveal the arrow field
    // in one frame instead of completing the same 240ms transition as the form.
    useLayoutEffect(() => {
      if (washClearTimeoutRef.current !== null) {
        window.clearTimeout(washClearTimeoutRef.current);
        washClearTimeoutRef.current = null;
      }

      if (readingField !== "none") {
        setReadingWash(readingField);
        setReadingWashActive(true);
        return;
      }

      setReadingWashActive(false);
      if (readingWash !== "none") {
        washClearTimeoutRef.current = window.setTimeout(() => {
          setReadingWash("none");
          washClearTimeoutRef.current = null;
        }, READING_FIELD_TRANSITION_MS);
      }

      return () => {
        if (washClearTimeoutRef.current !== null) {
          window.clearTimeout(washClearTimeoutRef.current);
          washClearTimeoutRef.current = null;
        }
      };
    }, [readingField, readingWash]);

    return (
      <div
        ref={rootRef}
        className="onboarding-arrow-background"
        data-reading-field={readingField}
        data-reading-wash={readingWash}
        data-reading-wash-active={readingWashActive ? "true" : "false"}
        aria-hidden="true"
      >
        <img
          className="onboarding-arrow-field"
          src={fieldUrl}
          alt=""
          draggable={false}
        />
        <span
          className="onboarding-arrow-pattern"
          style={staticPatternStyle}
        />
        <canvas
          ref={canvasRef}
          className="onboarding-arrow-canvas"
          aria-hidden="true"
        />
      </div>
    );
  },
);
