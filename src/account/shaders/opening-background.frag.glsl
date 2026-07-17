#version 300 es

precision highp float;

in vec2 vUv;
out vec4 fragColor;

uniform vec2 uCssResolution;
uniform sampler2D uDensityTexture;
uniform sampler2D uArrowTexture;
uniform vec2 uPointer;
uniform float uPointerStrength;
uniform vec4 uRepulsionConfig;

const float ARROW_PITCH_CSS_PX = 13.333333;
const float CELL_HALF_DIAGONAL = 0.70710678118 * ARROW_PITCH_CSS_PX;

float smootherstep01(float value) {
  float unit = clamp(value, 0.0, 1.0);
  return unit * unit * unit * (unit * (unit * 6.0 - 15.0) + 10.0);
}

float repulsionMagnitude(float distancePx) {
  float radiusPx = uRepulsionConfig.x;
  float minShiftPx = uRepulsionConfig.y;
  float maxShiftPx = uRepulsionConfig.z;
  float innerRatio = uRepulsionConfig.w;
  float normalizedDistance = clamp(distancePx / radiusPx, 0.0, 1.0);
  float coreProgress = smootherstep01(normalizedDistance / innerRatio);
  float coreMagnitude = mix(maxShiftPx, minShiftPx, coreProgress);
  float featherProgress = smootherstep01(
    (normalizedDistance - innerRatio) / (1.0 - innerRatio)
  );
  return coreMagnitude * (1.0 - featherProgress) * uPointerStrength;
}

vec2 cellDisplacement(vec2 cellCenter) {
  vec2 fromPointer = cellCenter - uPointer;
  float distancePx = length(fromPointer);
  if (distancePx >= uRepulsionConfig.x) {
    return vec2(0.0);
  }

  // Exact center overlap has no mathematical radial direction. Use one stable
  // direction there so the nearest arrow still receives the full 6px push
  // instead of appearing pinned at the center of the field.
  vec2 direction = distancePx < 0.0001
    ? vec2(0.0, -1.0)
    : fromPointer / distancePx;
  return direction * repulsionMagnitude(distancePx);
}

vec4 sampleStaticArrow(vec2 cssPixel) {
  vec2 local = fract(cssPixel / ARROW_PITCH_CSS_PX);
  return texture(uArrowTexture, vec2(local.x, 1.0 - local.y));
}

vec4 sampleRepelledArrows(vec2 cssPixel) {
  vec2 baseCell = floor(cssPixel / ARROW_PITCH_CSS_PX);
  vec4 strongest = vec4(0.0);
  float strongestAlpha = -1.0;

  // Six pixels of maximum travel is smaller than one cell, so the source
  // arrow for this destination fragment must be in this 3x3 neighborhood.
  for (int offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (int offsetX = -1; offsetX <= 1; offsetX += 1) {
      vec2 cellId = baseCell + vec2(float(offsetX), float(offsetY));
      vec2 cellOrigin = cellId * ARROW_PITCH_CSS_PX;
      vec2 cellCenter = cellOrigin + vec2(ARROW_PITCH_CSS_PX * 0.5);

      // Inverse-map through the cell's one translation. Every texel in an
      // arrow therefore moves rigidly rather than stretching around the cursor.
      vec2 sourcePixel = cssPixel - cellDisplacement(cellCenter);
      vec2 local = (sourcePixel - cellOrigin) / ARROW_PITCH_CSS_PX;
      bool inside = all(greaterThanEqual(local, vec2(0.0)))
        && all(lessThan(local, vec2(1.0)));
      if (!inside) continue;

      vec4 candidate = texture(
        uArrowTexture,
        vec2(local.x, 1.0 - local.y)
      );
      if (candidate.a > strongestAlpha) {
        strongest = candidate;
        strongestAlpha = candidate.a;
      }
    }
  }

  return strongest;
}

void main() {
  vec2 topUv = vec2(vUv.x, 1.0 - vUv.y);
  vec2 cssPixel = topUv * uCssResolution;
  float affectedSupport = uRepulsionConfig.x
    + uRepulsionConfig.z
    + CELL_HALF_DIAGONAL;
  bool staticFrame = uPointerStrength <= 0.0001;
  bool outsideAffectedSupport = distance(cssPixel, uPointer) > affectedSupport;
  vec4 arrow = staticFrame || outsideAffectedSupport
    ? sampleStaticArrow(cssPixel)
    : sampleRepelledArrows(cssPixel);
  float density = texture(uDensityTexture, vUv).a;

  fragColor = vec4(arrow.rgb, arrow.a * density);
}
