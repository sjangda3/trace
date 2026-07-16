---
name: glsl-math
description: GLSL math utilities — remap, smoothstep, easing, smoothmin, complex numbers, anti-aliasing helpers, constants. Use for interpolation, animation curves, or mathematical operations in shaders.
---

# GLSL Math Utilities

## Remap / Map Range

```glsl
// Map value from [inMin, inMax] to [outMin, outMax]
float remap(float value, float inMin, float inMax, float outMin, float outMax) {
  return outMin + (outMax - outMin) * (value - inMin) / (inMax - inMin);
}

// Map value from [inMin, inMax] to [0, 1]
float toUnit(float value, float inMin, float inMax) {
  return (value - inMin) / (inMax - inMin);
}

// Map value from [0, 1] to [outMin, outMax]
float fromUnit(float t, float outMin, float outMax) {
  return mix(outMin, outMax, t);
}

// Clamped remap (saturates at boundaries)
float remapClamped(float value, float inMin, float inMax, float outMin, float outMax) {
  float t = clamp((value - inMin) / (inMax - inMin), 0.0, 1.0);
  return mix(outMin, outMax, t);
}
```

## smoothstep and Variants

```glsl
// Built-in smoothstep: Hermite interpolation
// smoothstep(edge0, edge1, x) → 0 when x <= edge0, 1 when x >= edge1
float s = smoothstep(0.3, 0.7, vUv.x);

// smootherstep: Ken Perlin's C2-continuous version (smoother)
float smootherstep(float edge0, float edge1, float x) {
  x = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
  return x * x * x * (x * (x * 6.0 - 15.0) + 10.0);
}

// Inverse smoothstep: find x given smoothstep output
float inverseSmoothstep(float y) {
  return 0.5 - sin(asin(1.0 - 2.0 * y) / 3.0);
}
```

### smoothstep Patterns

```glsl
// Soft threshold (anti-aliased step)
float softStep = smoothstep(threshold - softness, threshold + softness, value);

// Band / stripe
float band = smoothstep(a, a + w, x) - smoothstep(b - w, b, x);

// Pulse
float pulse(float x, float center, float width) {
  return smoothstep(center - width, center, x)
       - smoothstep(center, center + width, x);
}
```

## Easing Functions

All take `t` in [0, 1] and return [0, 1].

```glsl
// Quadratic
float easeInQuad(float t)    { return t * t; }
float easeOutQuad(float t)   { return t * (2.0 - t); }
float easeInOutQuad(float t) {
  return t < 0.5 ? 2.0 * t * t : -1.0 + (4.0 - 2.0 * t) * t;
}

// Cubic
float easeInCubic(float t)    { return t * t * t; }
float easeOutCubic(float t)   { float u = 1.0 - t; return 1.0 - u * u * u; }
float easeInOutCubic(float t) {
  return t < 0.5 ? 4.0 * t * t * t : 1.0 - pow(-2.0 * t + 2.0, 3.0) / 2.0;
}

// Exponential
float easeInExpo(float t)  { return t == 0.0 ? 0.0 : pow(2.0, 10.0 * t - 10.0); }
float easeOutExpo(float t) { return t == 1.0 ? 1.0 : 1.0 - pow(2.0, -10.0 * t); }

// Sine
float easeInSine(float t)    { return 1.0 - cos(t * 1.5707963); }
float easeOutSine(float t)   { return sin(t * 1.5707963); }
float easeInOutSine(float t) { return 0.5 * (1.0 - cos(t * 3.1415926)); }

// Elastic
float easeOutElastic(float t) {
  return t == 0.0 ? 0.0 : t == 1.0 ? 1.0 :
    pow(2.0, -10.0 * t) * sin((t * 10.0 - 0.75) * 2.0943951) + 1.0;
}

// Bounce
float easeOutBounce(float t) {
  if (t < 1.0 / 2.75) return 7.5625 * t * t;
  if (t < 2.0 / 2.75) { t -= 1.5 / 2.75; return 7.5625 * t * t + 0.75; }
  if (t < 2.5 / 2.75) { t -= 2.25 / 2.75; return 7.5625 * t * t + 0.9375; }
  t -= 2.625 / 2.75;
  return 7.5625 * t * t + 0.984375;
}
```

## Smooth Min / Max

Blend two values smoothly instead of hard min/max.

```glsl
// Polynomial smooth min (most common, k controls blend radius)
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// Polynomial smooth max
float smax(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(a, b, h) + k * h * (1.0 - h);
}

// Exponential smooth min (smoother tails)
float sminExp(float a, float b, float k) {
  float res = exp(-k * a) + exp(-k * b);
  return -log(res) / k;
}

// Power smooth min
float sminPow(float a, float b, float k) {
  a = pow(a, k);
  b = pow(b, k);
  return pow((a * b) / (a + b), 1.0 / k);
}
```

## Complex Number Operations

Complex numbers as `vec2(real, imaginary)`.

```glsl
// Multiply
vec2 cMul(vec2 a, vec2 b) {
  return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

// Divide
vec2 cDiv(vec2 a, vec2 b) {
  float denom = dot(b, b);
  return vec2(dot(a, b), a.y * b.x - a.x * b.y) / denom;
}

// Square
vec2 cSqr(vec2 z) {
  return vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y);
}

// Magnitude and argument
float cAbs(vec2 z) { return length(z); }
float cArg(vec2 z) { return atan(z.y, z.x); }

// Exponential
vec2 cExp(vec2 z) {
  return exp(z.x) * vec2(cos(z.y), sin(z.y));
}

// Power (z^n)
vec2 cPow(vec2 z, float n) {
  float r = length(z);
  float theta = atan(z.y, z.x);
  return pow(r, n) * vec2(cos(n * theta), sin(n * theta));
}
```

### Mandelbrot Example

```glsl
void main() {
  vec2 c = (vUv - 0.5) * 3.0 - vec2(0.5, 0.0);
  vec2 z = vec2(0.0);
  int iter = 0;
  const int MAX_ITER = 100;

  for (int i = 0; i < MAX_ITER; i++) {
    z = cSqr(z) + c;
    if (dot(z, z) > 4.0) break;
    iter++;
  }

  float t = float(iter) / float(MAX_ITER);
  gl_FragColor = vec4(vec3(t), 1.0);
}
```

## Anti-Aliasing Helpers

```glsl
// fwidth: sum of absolute partial derivatives (screen-space pixel size)
// Requires GL_OES_standard_derivatives or WebGL2
float fw = fwidth(value);

// dFdx / dFdy: partial derivatives in screen space
float dx = dFdx(value);
float dy = dFdy(value);

// Anti-aliased edge (1-pixel smooth transition)
float aaEdge(float d) {
  return 1.0 - smoothstep(-fwidth(d), fwidth(d), d);
}

// Anti-aliased step
float aaStep(float threshold, float value) {
  float fw = fwidth(value);
  return smoothstep(threshold - fw, threshold + fw, value);
}

// Anti-aliased grid lines
float grid(vec2 uv, float lineWidth) {
  vec2 grid = abs(fract(uv - 0.5) - 0.5);
  vec2 fw = fwidth(uv);
  vec2 lines = smoothstep(fw * 0.5, fw * 1.5, grid - lineWidth * 0.5);
  return 1.0 - min(lines.x, lines.y);
}
```

## Useful Constants

```glsl
#define PI 3.14159265359
#define TAU 6.28318530718
#define HALF_PI 1.57079632679
#define E 2.71828182846
#define PHI 1.61803398875       // golden ratio
#define SQRT2 1.41421356237
#define SQRT3 1.73205080757
#define DEG2RAD 0.01745329252
#define RAD2DEG 57.2957795131
```

## Useful One-Liners

```glsl
// Saturate (clamp to [0, 1]) — not built-in in GLSL, unlike HLSL
#define saturate(x) clamp(x, 0.0, 1.0)

// Linear step (unclamped lerp between edges)
float linearstep(float lo, float hi, float x) {
  return (x - lo) / (hi - lo);
}

// Repeat / wrap value to [0, len)
float repeat(float x, float len) {
  return mod(x, len);
}

// Ping-pong (triangle wave between 0 and len)
float pingpong(float x, float len) {
  return len - abs(mod(x, 2.0 * len) - len);
}

// Sign that returns 1.0 for 0.0 (never zero)
float signNonZero(float x) {
  return x >= 0.0 ? 1.0 : -1.0;
}

// Approximate equality
bool approxEqual(float a, float b, float eps) {
  return abs(a - b) < eps;
}
```

## See Also

- `glsl-fundamentals` — data types, built-in functions
- `glsl-sdf` — smooth min/max used for SDF blending
- `glsl-color` — tonemapping, gamma correction
- `glsl-coordinates` — rotation, polar math
