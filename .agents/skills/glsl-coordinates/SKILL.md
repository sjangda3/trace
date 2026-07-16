---
name: glsl-coordinates
description: GLSL space transformations — rotation, polar/spherical, tiling, domain repetition. Use when manipulating coordinate spaces, creating patterns, or transforming geometry.
---

# GLSL Coordinate Transformations

## 2D Rotation

```glsl
// Rotation matrix (counter-clockwise, angle in radians)
mat2 rot2D(float angle) {
  float s = sin(angle);
  float c = cos(angle);
  return mat2(c, -s, s, c);
}

// Usage
vec2 rotated = rot2D(radians(45.0)) * uv;

// Rotate around a custom center
vec2 rotateAround(vec2 p, vec2 center, float angle) {
  return rot2D(angle) * (p - center) + center;
}
```

## 3D Rotation Matrices

```glsl
// Rotate around X axis
mat3 rotateX(float angle) {
  float s = sin(angle), c = cos(angle);
  return mat3(1, 0, 0,  0, c, -s,  0, s, c);
}

// Rotate around Y axis
mat3 rotateY(float angle) {
  float s = sin(angle), c = cos(angle);
  return mat3(c, 0, s,  0, 1, 0,  -s, 0, c);
}

// Rotate around Z axis
mat3 rotateZ(float angle) {
  float s = sin(angle), c = cos(angle);
  return mat3(c, -s, 0,  s, c, 0,  0, 0, 1);
}

// Rotate around arbitrary axis (axis must be normalized)
mat3 rotateAxis(vec3 axis, float angle) {
  float s = sin(angle), c = cos(angle);
  float oc = 1.0 - c;
  return mat3(
    oc * axis.x * axis.x + c,           oc * axis.x * axis.y - axis.z * s,  oc * axis.z * axis.x + axis.y * s,
    oc * axis.x * axis.y + axis.z * s,  oc * axis.y * axis.y + c,           oc * axis.y * axis.z - axis.x * s,
    oc * axis.z * axis.x - axis.y * s,  oc * axis.y * axis.z + axis.x * s,  oc * axis.z * axis.z + c
  );
}

// Usage (ray marching)
vec3 p = rotateY(uTime * 0.5) * position;
```

## Polar ↔ Cartesian

```glsl
// Cartesian to Polar: (x, y) → (radius, angle)
vec2 toPolar(vec2 p) {
  return vec2(length(p), atan(p.y, p.x));
}

// Polar to Cartesian: (radius, angle) → (x, y)
vec2 toCartesian(vec2 polar) {
  return polar.x * vec2(cos(polar.y), sin(polar.y));
}

// Usage: radial symmetry
vec2 polar = toPolar(vUv - 0.5);
polar.y += uTime;                    // rotate
polar.y = mod(polar.y, TAU / 6.0);   // 6-fold symmetry
vec2 p = toCartesian(polar);
```

### Polar Patterns

```glsl
// Spiral
vec2 center = vUv - 0.5;
float r = length(center);
float a = atan(center.y, center.x);
float spiral = sin(a * 5.0 + r * 20.0 - uTime * 3.0);

// Radial lines (like clock marks)
float radialLines = abs(sin(a * float(numLines)));

// Polar grid
float rings = sin(r * 20.0);
float spokes = sin(a * 8.0);
float grid = max(rings, spokes);
```

## Spherical Coordinates

```glsl
// Cartesian to Spherical: (x, y, z) → (radius, theta, phi)
// theta: polar angle from Y axis [0, PI]
// phi: azimuthal angle in XZ plane [−PI, PI]
vec3 toSpherical(vec3 p) {
  float r = length(p);
  float theta = acos(p.y / r);
  float phi = atan(p.z, p.x);
  return vec3(r, theta, phi);
}

// Spherical to Cartesian
vec3 fromSpherical(float r, float theta, float phi) {
  return r * vec3(
    sin(theta) * cos(phi),
    cos(theta),
    sin(theta) * sin(phi)
  );
}

// Equirectangular UV from direction (for environment maps)
vec2 directionToEquirect(vec3 dir) {
  vec2 uv = vec2(
    atan(dir.z, dir.x) / (2.0 * PI) + 0.5,
    asin(clamp(dir.y, -1.0, 1.0)) / PI + 0.5
  );
  return uv;
}
```

## UV Tiling / Repeat

```glsl
// Basic tiling (fract wraps UVs to [0, 1])
vec2 tiledUV = fract(vUv * vec2(4.0, 4.0));

// Tiling with tile ID (which tile are we in?)
vec2 scale = vec2(4.0, 4.0);
vec2 tileID = floor(vUv * scale);
vec2 tileUV = fract(vUv * scale);

// Offset every other row (brick pattern)
vec2 brickUV(vec2 uv, vec2 scale) {
  vec2 id = floor(uv * scale);
  vec2 st = fract(uv * scale);
  // Offset odd rows by 0.5
  st.x += mod(id.y, 2.0) * 0.5;
  st.x = fract(st.x);
  return st;
}

// Mirror repeat (ping-pong tiling)
vec2 mirrorUV(vec2 uv) {
  vec2 m = mod(uv, 2.0);
  return mix(m, 2.0 - m, step(1.0, m));
}
```

## Domain Repetition

Used in ray marching and 2D pattern generation.

```glsl
// Infinite repetition (period p along each axis)
vec3 opRepeat(vec3 pos, vec3 period) {
  return mod(pos + 0.5 * period, period) - 0.5 * period;
}

// Bounded repetition (N copies in each direction)
vec3 opRepeatBounded(vec3 pos, vec3 period, vec3 count) {
  vec3 id = clamp(round(pos / period), -count, count);
  return pos - period * id;
}

// 2D repetition
vec2 opRepeat2D(vec2 p, vec2 period) {
  return mod(p + 0.5 * period, period) - 0.5 * period;
}

// Repetition with random variation per cell
vec2 cellID = floor(p / period);
vec2 localP = mod(p + 0.5 * period, period) - 0.5 * period;
float randomPerCell = hash(cellID); // vary each instance
```

### Hexagonal Tiling

```glsl
// Hexagonal grid coordinates
vec4 hexCoords(vec2 uv) {
  vec2 r = vec2(1.0, sqrt(3.0));
  vec2 h = r * 0.5;

  vec2 a = mod(uv, r) - h;
  vec2 b = mod(uv - h, r) - h;

  vec2 gv;
  if (dot(a, a) < dot(b, b))
    gv = a;
  else
    gv = b;

  float x = atan(gv.x, gv.y);
  float y = 0.5 - max(dot(gv, normalize(vec2(1, sqrt(3.0)))),
                       dot(gv, normalize(vec2(1, -sqrt(3.0)))));
  vec2 id = uv - gv;

  return vec4(gv.x, gv.y, id.x, id.y);
}
```

## Quaternion Rotation

```glsl
// Apply quaternion rotation to a vector
vec3 quatRotate(vec4 q, vec3 v) {
  vec3 t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

// Create quaternion from axis + angle
vec4 quatFromAxisAngle(vec3 axis, float angle) {
  float halfAngle = angle * 0.5;
  return vec4(axis * sin(halfAngle), cos(halfAngle));
}

// Multiply quaternions
vec4 quatMul(vec4 a, vec4 b) {
  return vec4(
    a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz),
    a.w * b.w - dot(a.xyz, b.xyz)
  );
}
```

## Screen-Space to World-Space

```glsl
// In Three.js ShaderMaterial:
// projectionMatrix, viewMatrix, modelMatrix are available

// Screen UV to clip space
vec4 clipPos = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);

// Clip to view space
vec4 viewPos = inverse(projectionMatrix) * clipPos;
viewPos /= viewPos.w;

// View to world space
vec4 worldPos = inverse(viewMatrix) * viewPos;
```

Note: `inverse()` requires WebGL2 / GLSL 3.0 ES. In WebGL1, pass inverse matrices as uniforms from JavaScript.

## Kaleidoscope

```glsl
vec2 kaleidoscope(vec2 p, float segments) {
  float angle = atan(p.y, p.x);
  float segmentAngle = TAU / segments;
  angle = mod(angle, segmentAngle);
  // Mirror alternate segments
  angle = min(angle, segmentAngle - angle);
  float r = length(p);
  return r * vec2(cos(angle), sin(angle));
}

// Usage
vec2 center = vUv - 0.5;
vec2 kp = kaleidoscope(center, 6.0);
```

## Common Recipes

### Infinite Scrolling Pattern

```glsl
vec2 scrollUV = vUv + vec2(uTime * 0.1, 0.0);
vec2 tiled = fract(scrollUV * 4.0);
```

### Tunnel Effect

```glsl
vec2 center = vUv - 0.5;
float r = length(center);
float a = atan(center.y, center.x) / TAU + 0.5;

vec2 tunnelUV = vec2(a, 1.0 / r + uTime * 0.5);
vec4 color = texture2D(uTexture, fract(tunnelUV * 2.0));
```

### Ripple Distortion

```glsl
vec2 center = vUv - 0.5;
float dist = length(center);
float ripple = sin(dist * 30.0 - uTime * 5.0) * 0.01;
vec2 distortedUV = vUv + normalize(center) * ripple;
```

## See Also

- `glsl-fundamentals` — coordinate systems, UVs
- `glsl-sdf` — domain repetition for ray marching
- `glsl-math` — rotation math, trigonometry
- `glsl-noise` — noise-based distortion of coordinates
