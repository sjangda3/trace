---
name: glsl-noise
description: GLSL noise functions — hash, value, simplex, FBM, Voronoi, Worley. Use when generating procedural textures, terrain, organic patterns, or animated effects.
---

# GLSL Noise Functions

## Hash / Random

Fast pseudo-random from a seed. Not continuous — produces white noise.

```glsl
// Float hash from vec2 seed
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// Float hash from float seed
float hash(float n) {
  return fract(sin(n) * 43758.5453123);
}

// vec2 hash from vec2 seed (for Voronoi)
vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)),
           dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}

// vec3 hash from vec3 seed
vec3 hash3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)),
           dot(p, vec3(269.5, 183.3, 246.1)),
           dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453);
}
```

**When to use**: Quick randomness, dithering, jitter. Not suitable for smooth patterns.

## Value Noise (2D)

Smoothly interpolated random values on a grid.

```glsl
float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);

  // Four corner values
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));

  // Smooth interpolation (Hermite curve)
  vec2 u = f * f * (3.0 - 2.0 * f);

  return mix(mix(a, b, u.x),
             mix(c, d, u.x), u.y);
}
```

**When to use**: Simple procedural textures, clouds, terrain height. Cheaper than simplex but has visible grid artifacts at low frequencies.

## Value Noise (3D)

```glsl
float valueNoise3D(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);

  return mix(
    mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), u.x),
        mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), u.x), u.y),
    mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), u.x),
        mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), u.x), u.y),
    u.z);
}

// Overload hash for vec3
float hash(vec3 p) {
  return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}
```

## Simplex Noise (2D)

Higher quality than value noise, less grid bias, slightly more expensive.

```glsl
// 2D simplex noise (compact version)
vec3 mod289(vec3 x) { return x - floor(x / 289.0) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x / 289.0) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 10.0) * x); }

float snoise(vec2 v) {
  const vec4 C = vec4(
    0.211324865405187,   // (3.0 - sqrt(3.0)) / 6.0
    0.366025403784439,   //  0.5 * (sqrt(3.0) - 1.0)
   -0.577350269189626,   // -1.0 + 2.0 * C.x
    0.024390243902439);  //  1.0 / 41.0

  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);

  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;

  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
                           + i.x + vec3(0.0, i1.x, 1.0));

  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy),
                           dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;

  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;

  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);

  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;

  return 130.0 * dot(m, g);
}
```

**When to use**: Most general-purpose noise needs. Good for terrain, organic textures, fluid-like motion. Output range approximately [-1, 1].

## Simplex Noise (3D)

Full 3D simplex noise — use for animated effects (pass time as the 3rd coordinate) or volumetric patterns.

```glsl
vec4 mod289(vec4 x) { return x - floor(x / 289.0) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);

  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);

  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);

  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;

  i = mod289(i);
  vec4 p = permute(permute(permute(
    i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));

  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;

  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);

  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);

  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));

  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;

  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);

  vec4 norm = taylorInvSqrt(vec4(
    dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;

  vec4 m = max(0.5 - vec4(
    dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;

  return 105.0 * dot(m * m,
    vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
```

## Fractal Brownian Motion (FBM)

Layer multiple noise octaves for natural-looking detail.

```glsl
float fbm(vec2 p, int octaves) {
  float value = 0.0;
  float amplitude = 0.5;
  float frequency = 1.0;

  for (int i = 0; i < octaves; i++) {
    value += amplitude * snoise(p * frequency);
    frequency *= 2.0;   // lacunarity
    amplitude *= 0.5;   // gain (persistence)
  }

  return value;
}

// Usage
float n = fbm(vUv * 4.0, 6);
```

### Tuning Parameters

| Parameter    | Default | Effect                          |
|-------------|---------|----------------------------------|
| Octaves     | 4–8     | More = finer detail, more cost   |
| Lacunarity  | 2.0     | Frequency multiplier per octave  |
| Gain        | 0.5     | Amplitude multiplier per octave  |

```glsl
// Customizable FBM
float fbm(vec2 p, int octaves, float lacunarity, float gain) {
  float value = 0.0;
  float amplitude = 0.5;
  float frequency = 1.0;

  for (int i = 0; i < octaves; i++) {
    value += amplitude * snoise(p * frequency);
    frequency *= lacunarity;
    amplitude *= gain;
  }

  return value;
}
```

## Voronoi / Worley Noise

Cell-based noise that creates organic, cellular patterns.

```glsl
// Returns (distance to nearest cell, distance to second nearest)
vec2 voronoi(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);

  float d1 = 1.0; // nearest
  float d2 = 1.0; // second nearest

  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 neighbor = vec2(float(x), float(y));
      vec2 point = hash2(i + neighbor);
      vec2 diff = neighbor + point - f;
      float d = dot(diff, diff);

      if (d < d1) {
        d2 = d1;
        d1 = d;
      } else if (d < d2) {
        d2 = d;
      }
    }
  }

  return vec2(sqrt(d1), sqrt(d2));
}

// Usage — different patterns from the same function
vec2 v = voronoi(vUv * 8.0);
float cells    = v.x;           // distance to nearest → cell pattern
float edges    = v.y - v.x;     // difference → edge detection
float cracks   = smoothstep(0.0, 0.05, v.y - v.x); // sharp edges
```

### Animated Voronoi

```glsl
vec2 voronoiAnimated(vec2 p, float time) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float d1 = 1.0;

  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 neighbor = vec2(float(x), float(y));
      vec2 point = hash2(i + neighbor);
      // Animate cell centers
      point = 0.5 + 0.5 * sin(time + 6.2831 * point);
      vec2 diff = neighbor + point - f;
      float d = dot(diff, diff);
      d1 = min(d1, d);
    }
  }

  return vec2(sqrt(d1), 0.0);
}
```

## Turbulence

Absolute-value FBM — creates veined, turbulent patterns.

```glsl
float turbulence(vec2 p, int octaves) {
  float value = 0.0;
  float amplitude = 0.5;
  float frequency = 1.0;

  for (int i = 0; i < octaves; i++) {
    value += amplitude * abs(snoise(p * frequency));
    frequency *= 2.0;
    amplitude *= 0.5;
  }

  return value;
}
```

## Domain Warping

Feed noise output back as input coordinates for organic distortion.

```glsl
// Single warp
float domainWarp(vec2 p) {
  vec2 q = vec2(
    fbm(p + vec2(0.0, 0.0), 4),
    fbm(p + vec2(5.2, 1.3), 4)
  );
  return fbm(p + 4.0 * q, 4);
}

// Double warp (more complex swirling)
float domainWarp2(vec2 p, float time) {
  vec2 q = vec2(
    fbm(p + vec2(0.0, 0.0), 4),
    fbm(p + vec2(5.2, 1.3), 4)
  );

  vec2 r = vec2(
    fbm(p + 4.0 * q + vec2(1.7, 9.2) + 0.15 * time, 4),
    fbm(p + 4.0 * q + vec2(8.3, 2.8) + 0.126 * time, 4)
  );

  return fbm(p + 4.0 * r, 4);
}
```

## Performance vs Quality Guide

| Function     | Cost    | Grid Artifacts | Quality  | Best For                        |
|-------------|---------|----------------|----------|---------------------------------|
| hash        | Lowest  | N/A (discrete) | Low      | Jitter, dithering               |
| Value noise | Low     | Visible        | Medium   | Quick textures, prototyping     |
| Simplex 2D  | Medium  | Minimal        | High     | General-purpose 2D noise        |
| Simplex 3D  | Medium  | Minimal        | High     | Animated effects (time as z)    |
| FBM (4 oct) | High    | Depends on base| High     | Terrain, clouds, fire           |
| FBM (8 oct) | Very high| Depends on base| Very high| Fine detail, close-up textures |
| Voronoi     | High    | None           | High     | Cells, cracks, organic patterns |
| Domain warp | Very high| None           | Very high| Marble, abstract art, fluid    |

## Common Recipes

### Animated Cloud / Smoke

```glsl
float cloud = fbm(vUv * 3.0 + uTime * 0.1, 6);
cloud = smoothstep(0.0, 0.6, cloud);
gl_FragColor = vec4(vec3(cloud), 1.0);
```

### Terrain Height Map

```glsl
float height = fbm(vUv * 5.0, 8, 2.0, 0.5);
height = height * 0.5 + 0.5; // remap to [0, 1]
```

### Organic Blob

```glsl
vec2 center = vUv - 0.5;
float dist = length(center);
float noise = snoise(vec2(atan(center.y, center.x) * 3.0, uTime * 0.5));
float blob = smoothstep(0.3 + noise * 0.1, 0.29 + noise * 0.1, dist);
```

## See Also

- `glsl-fundamentals` — coordinate systems, data types
- `glsl-math` — smoothstep, remap, easing
- `glsl-sdf` — combine noise with signed distance fields
- `glsl-coordinates` — domain repetition, polar coordinates
