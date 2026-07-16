---
name: glsl-color
description: GLSL color space operations — HSV, cosine palettes, tonemapping, OKLab, sRGB. Use when working with color manipulation, gradients, palettes, or HDR rendering.
---

# GLSL Color Operations

## HSV ↔ RGB

```glsl
// RGB to HSV
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));

  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

// HSV to RGB
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
```

### Usage

```glsl
// Hue rotation
vec3 hsv = rgb2hsv(color.rgb);
hsv.x = fract(hsv.x + 0.33); // shift hue by 120°
color.rgb = hsv2rgb(hsv);

// Desaturate
vec3 hsv = rgb2hsv(color.rgb);
hsv.y *= 0.5; // reduce saturation
color.rgb = hsv2rgb(hsv);

// Rainbow from UV
vec3 rainbow = hsv2rgb(vec3(vUv.x, 1.0, 1.0));
```

## Cosine Color Palettes

Inigo Quilez's technique — generate smooth, looping color ramps from 4 parameter vectors.

```glsl
// palette(t) = a + b * cos(2π * (c * t + d))
vec3 palette(float t, vec3 a, vec3 b, vec3 c, vec3 d) {
  return a + b * cos(6.28318 * (c * t + d));
}
```

### Preset Palettes

```glsl
// Rainbow
vec3 rainbow = palette(t,
  vec3(0.5, 0.5, 0.5),
  vec3(0.5, 0.5, 0.5),
  vec3(1.0, 1.0, 1.0),
  vec3(0.00, 0.33, 0.67));

// Sunset (warm orange → purple)
vec3 sunset = palette(t,
  vec3(0.5, 0.5, 0.5),
  vec3(0.5, 0.5, 0.5),
  vec3(1.0, 1.0, 0.5),
  vec3(0.80, 0.90, 0.30));

// Ocean (teal → blue → purple)
vec3 ocean = palette(t,
  vec3(0.5, 0.5, 0.5),
  vec3(0.5, 0.5, 0.5),
  vec3(1.0, 0.7, 0.4),
  vec3(0.00, 0.15, 0.20));

// Fire (black → red → orange → yellow)
vec3 fire = palette(t,
  vec3(0.5, 0.5, 0.5),
  vec3(0.5, 0.5, 0.5),
  vec3(2.0, 1.0, 0.0),
  vec3(0.50, 0.20, 0.25));

// Neon
vec3 neon = palette(t,
  vec3(0.5, 0.5, 0.5),
  vec3(0.5, 0.5, 0.5),
  vec3(1.0, 1.0, 1.0),
  vec3(0.00, 0.10, 0.20));
```

### Using Palettes with Distance/Time

```glsl
// Color by distance from center
float d = length(vUv - 0.5);
vec3 color = palette(d * 2.0 + uTime * 0.3,
  vec3(0.5), vec3(0.5), vec3(1.0, 1.0, 0.5), vec3(0.8, 0.9, 0.3));
```

## sRGB ↔ Linear

GPUs compute in linear space. Display expects sRGB. Convert at boundaries.

```glsl
// sRGB to Linear (input textures are usually sRGB)
vec3 srgbToLinear(vec3 c) {
  return pow(c, vec3(2.2));
}

// Linear to sRGB (output for display)
vec3 linearToSrgb(vec3 c) {
  return pow(c, vec3(1.0 / 2.2));
}

// Precise sRGB to Linear
vec3 srgbToLinearPrecise(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(lo, hi, step(0.04045, c));
}

// Precise Linear to sRGB
vec3 linearToSrgbPrecise(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(0.0031308, c));
}
```

Note: Three.js with `renderer.outputColorSpace = THREE.SRGBColorSpace` handles the final linear→sRGB conversion automatically. Apply gamma only when doing manual passes.

## Tonemapping

Map HDR values to displayable [0, 1] range.

```glsl
// Reinhard (simple)
vec3 tonemapReinhard(vec3 c) {
  return c / (1.0 + c);
}

// Reinhard (luminance-based, preserves color ratios)
vec3 tonemapReinhardLuminance(vec3 c) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float lMapped = l / (1.0 + l);
  return c * (lMapped / l);
}

// ACES Filmic (industry standard, good contrast)
vec3 tonemapACES(vec3 x) {
  float a = 2.51;
  float b = 0.03;
  float c = 2.43;
  float d = 0.59;
  float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// Uncharted 2 (filmic, good shadow detail)
vec3 uncharted2Helper(vec3 x) {
  float A = 0.15, B = 0.50, C = 0.10;
  float D = 0.20, E = 0.02, F = 0.30;
  return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}

vec3 tonemapUncharted2(vec3 c) {
  float W = 11.2;
  vec3 curr = uncharted2Helper(c * 2.0);
  vec3 whiteScale = 1.0 / uncharted2Helper(vec3(W));
  return curr * whiteScale;
}
```

### Typical HDR Pipeline

```glsl
void main() {
  vec3 hdr = /* your lighting calculation */;
  vec3 mapped = tonemapACES(hdr);
  vec3 output = linearToSrgb(mapped);
  gl_FragColor = vec4(output, 1.0);
}
```

## OKLab / OKLch

Perceptually uniform — interpolations look natural to the human eye.

```glsl
// Linear sRGB to OKLab
vec3 linearToOklab(vec3 c) {
  float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;

  float l_ = pow(l, 1.0 / 3.0);
  float m_ = pow(m, 1.0 / 3.0);
  float s_ = pow(s, 1.0 / 3.0);

  return vec3(
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
  );
}

// OKLab to Linear sRGB
vec3 oklabToLinear(vec3 c) {
  float l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s_ = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;

  float l = l_ * l_ * l_;
  float m = m_ * m_ * m_;
  float s = s_ * s_ * s_;

  return vec3(
     4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  );
}

// OKLab to OKLch (polar form — better for hue interpolation)
vec3 oklabToOklch(vec3 lab) {
  float C = length(lab.yz);
  float h = atan(lab.z, lab.y);
  return vec3(lab.x, C, h);
}

// OKLch to OKLab
vec3 oklchToOklab(vec3 lch) {
  return vec3(lch.x, lch.y * cos(lch.z), lch.y * sin(lch.z));
}
```

### OKLab Gradient (perceptually smooth)

```glsl
vec3 a = srgbToLinear(vec3(0.1, 0.2, 0.8)); // blue
vec3 b = srgbToLinear(vec3(0.9, 0.8, 0.1)); // yellow
vec3 labA = linearToOklab(a);
vec3 labB = linearToOklab(b);
vec3 mixed = mix(labA, labB, vUv.x);
vec3 color = linearToSrgb(oklabToLinear(mixed));
```

## Luminance

```glsl
// Rec. 709 (sRGB primaries)
float luminance(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

// Quick approximation
float luminanceApprox(vec3 c) {
  return dot(c, vec3(0.299, 0.587, 0.114));
}
```

## Hue Rotation

```glsl
vec3 hueRotate(vec3 c, float angle) {
  vec3 hsv = rgb2hsv(c);
  hsv.x = fract(hsv.x + angle / 6.28318);
  return hsv2rgb(hsv);
}
```

## Saturation Adjustment

```glsl
vec3 adjustSaturation(vec3 c, float amount) {
  float lum = luminance(c);
  return mix(vec3(lum), c, amount);
}
```

## Gradient Patterns

```glsl
// Linear gradient (vertical)
vec3 color = mix(colorA, colorB, vUv.y);

// Radial gradient
float d = distance(vUv, vec2(0.5));
vec3 color = mix(centerColor, edgeColor, smoothstep(0.0, 0.5, d));

// Angular gradient
float angle = atan(vUv.y - 0.5, vUv.x - 0.5);
float t = angle / 6.28318 + 0.5;
vec3 color = palette(t, ...);

// Multi-stop gradient
vec3 gradient3(float t, vec3 c0, vec3 c1, vec3 c2) {
  return mix(mix(c0, c1, smoothstep(0.0, 0.5, t)),
             c2, smoothstep(0.5, 1.0, t));
}

// Diamond gradient
float d = abs(vUv.x - 0.5) + abs(vUv.y - 0.5);
vec3 color = mix(centerColor, edgeColor, d);
```

## Common Recipes

### Posterize (Reduce Color Levels)

```glsl
float levels = 4.0;
vec3 posterized = floor(color * levels) / levels;
```

### Color Grading with Curves

```glsl
// Simple S-curve for contrast
vec3 sCurve(vec3 c) {
  return c * c * (3.0 - 2.0 * c); // same as smoothstep(0, 1, c)
}
```

### Vignette

```glsl
float vignette(vec2 uv) {
  uv = uv * 2.0 - 1.0;
  return 1.0 - dot(uv, uv) * 0.5;
}
// Usage: color *= vignette(vUv);
```

## See Also

- `glsl-fundamentals` — data types, precision
- `glsl-math` — smoothstep, remap, easing functions
- `glsl-noise` — noise-based color variation
