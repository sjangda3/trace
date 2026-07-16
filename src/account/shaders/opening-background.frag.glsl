#version 300 es

precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform float uTime;
uniform vec2 uResolution;
uniform float uTransitionProgress;
uniform float uTransitionPhase;
uniform float uTransitionActive;
uniform vec3 uTargetColor0;
uniform vec3 uTargetColor1;
uniform vec3 uTargetColor2;
uniform vec3 uTargetColor3;

const float TAU = 6.28318530718;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
    mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0)), u.x),
    u.y
  );
}

float softBand(float y, float top, float thickness, float feather) {
  float enter = smoothstep(top - feather, top + feather, y);
  float leave = 1.0 - smoothstep(top + thickness - feather, top + thickness + feather, y);
  return enter * leave;
}

float softCrestBand(float y, float top, float thickness) {
  float enter = smoothstep(top - 0.026, top + 0.008, y);
  float leave = 1.0 - smoothstep(top + thickness - 0.018, top + thickness + 0.018, y);
  return enter * leave;
}

vec3 srgbToLinear(vec3 color) {
  vec3 low = color / 12.92;
  vec3 high = pow((color + 0.055) / 1.055, vec3(2.4));
  return mix(low, high, step(vec3(0.04045), color));
}

vec3 linearToSrgb(vec3 color) {
  color = max(color, 0.0);
  vec3 low = color * 12.92;
  vec3 high = 1.055 * pow(color, vec3(1.0 / 2.4)) - 0.055;
  return mix(low, high, step(vec3(0.0031308), color));
}

float smootherstep01(float t) {
  t = clamp(t, 0.0, 1.0);
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

vec3 gradient4(float t, vec3 color0, vec3 color1, vec3 color2, vec3 color3) {
  vec3 color = mix(color0, color1, smootherstep01(t / 0.38));
  color = mix(color, color2, smootherstep01((t - 0.38) / 0.33));
  return mix(color, color3, smootherstep01((t - 0.71) / 0.29));
}

void main() {
  // Top-origin normalized coordinates make the art direction easier to reason about.
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  float x = uv.x;
  float y = uv.y;

  // The ambient drift is live until a choice is made. From then on, the exact
  // wave geometry at the moment of the click is held in place and becomes the
  // contour that resolves into the destination field.
  float ambientPhase = uTime * 0.120;
  float capturedPhase = uTransitionPhase * 0.120;
  float phase = mix(ambientPhase, capturedPhase, uTransitionActive);
  float transitionProgress = clamp(uTransitionProgress, 0.0, 1.0);
  float transitionMorph = smootherstep01(transitionProgress);

  vec3 iceTop = srgbToLinear(vec3(0.978, 0.991, 0.998));
  vec3 iceBottom = srgbToLinear(vec3(0.902, 0.956, 0.986));
  float baseDepth = smoothstep(0.52, 1.0, y);
  vec3 baseColor = mix(iceTop, iceBottom, baseDepth * 0.46);

  // Fixed low-frequency grain prevents banding without turning the whole surface
  // into animated shimmer.
  baseColor += (valueNoise(uv * 2.6) - 0.5) * 0.0022;
  vec3 color = baseColor;

  float quietWarp = (valueNoise(vec2(x * 1.45, 4.7)) - 0.5) * 0.004;
  float rearTop = 0.600 - 0.014 * x
    + 0.032 * sin(TAU * (x * 0.73) + 1.18 + phase) + quietWarp;
  float middleTop = 0.704 + 0.010 * x
    + 0.042 * sin(TAU * (x * 0.82) - 0.42 - phase * 0.78) - quietWarp * 0.55;
  float frontTop = 0.821 - 0.018 * x
    + 0.050 * sin(TAU * (x * 0.62) + 2.02 + phase * 0.92) + quietWarp * 0.42;

  // The visible front ribbon is the transition carrier. Subtracting one
  // uniform vertical distance preserves the captured contour's amplitude,
  // tilt, phase, thickness, and color instead of spawning a second band.
  float movingFrontTop = frontTop - 1.070 * transitionMorph;

  // Overlap the translucent bands so the transitions stay luminous and never
  // become full-width white seams.
  float rearRibbon = softCrestBand(y, rearTop, 0.155);
  float middleRibbon = softBand(y, middleTop, 0.160, 0.020);
  float frontRibbon = softBand(y, movingFrontTop, 0.185, 0.022);

  vec3 violet = srgbToLinear(vec3(0.46, 0.31, 0.88));
  vec3 cobalt = srgbToLinear(vec3(0.29, 0.44, 0.88));
  vec3 periwinkle = srgbToLinear(vec3(0.63, 0.71, 0.94));
  // Keep enough cyan contrast at x=1 for the ribbons to remain visible through
  // the right edge instead of dissolving into the ice-blue canvas.
  vec3 paleCyan = srgbToLinear(vec3(0.70, 0.89, 0.97));
  float violetLens = 1.0 - smoothstep(0.09, 0.29, abs(x - 0.36));
  vec3 rearColor = mix(mix(periwinkle, paleCyan, smoothstep(0.48, 0.96, x)), violet, violetLens * 0.22);
  vec3 middleColor = mix(mix(cobalt, paleCyan, smoothstep(0.52, 0.96, x)), violet, violetLens * 0.62);
  vec3 frontColor = mix(mix(periwinkle, paleCyan, smoothstep(0.58, 0.98, x)), violet, violetLens * 0.35);

  color = mix(color, rearColor, rearRibbon * 0.315);
  color = mix(color, middleColor, middleRibbon * 0.365);
  color = mix(color, frontColor, frontRibbon * 0.265);

  // Violet is earned by overlapping layers, not by a freestanding radial blob.
  float overlap = rearRibbon * middleRibbon + middleRibbon * frontRibbon + rearRibbon * frontRibbon;
  float violetFocus = exp(-pow((x - 0.36) / 0.23, 2.0)) * smoothstep(0.68, 0.92, y);
  color = mix(color, violet, clamp(overlap * violetFocus * 0.080, 0.0, 0.09));

  vec3 target0 = srgbToLinear(uTargetColor0);
  vec3 target1 = srgbToLinear(uTargetColor1);
  vec3 target2 = srgbToLinear(uTargetColor2);
  vec3 target3 = srgbToLinear(uTargetColor3);
  vec3 targetField = gradient4(y, target0, target1, target2, target3);

  // One narrow seam follows the lower edge of that same moving ribbon. Source
  // pixels ahead of it remain untouched; the destination is fully established
  // behind it. The short entry guard keeps progress 0 exactly identical to the
  // opening frame without turning the transition into a global opacity fade.
  float movingFrontExit = movingFrontTop + 0.185;
  float seamDistance = y - movingFrontExit;
  float seamFeather = max(2.0 / uResolution.y, fwidth(seamDistance) * 1.35);
  float destinationCoverage = smoothstep(-seamFeather, seamFeather, seamDistance);
  float entryGuard = smootherstep01(transitionProgress / 0.035);
  color = mix(color, targetField, destinationCoverage * entryGuard);

  vec3 outputColor = linearToSrgb(clamp(color, 0.0, 1.0));
  float dither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) - 0.5;
  outputColor += dither * (0.36 / 255.0);
  fragColor = vec4(clamp(outputColor, 0.0, 1.0), 1.0);
}
