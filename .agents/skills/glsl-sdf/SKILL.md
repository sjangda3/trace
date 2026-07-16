---
name: glsl-sdf
description: GLSL signed distance fields — 2D/3D primitives, boolean operations, ray marching. Use when creating geometric shapes, text effects, procedural geometry, or ray-marched scenes.
---

# GLSL Signed Distance Fields

A signed distance field (SDF) returns the shortest distance from a point to a shape's surface. Negative = inside, positive = outside, zero = on the boundary.

## 2D Primitives

```glsl
// Circle
float sdCircle(vec2 p, float r) {
  return length(p) - r;
}

// Box (centered at origin)
float sdBox(vec2 p, vec2 b) {
  vec2 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

// Rounded box
float sdRoundedBox(vec2 p, vec2 b, float r) {
  vec2 d = abs(p) - b + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}

// Line segment
float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

// Equilateral triangle
float sdTriangle(vec2 p, float r) {
  const float k = sqrt(3.0);
  p.x = abs(p.x) - r;
  p.y = p.y + r / k;
  if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}

// Regular hexagon
float sdHexagon(vec2 p, float r) {
  const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
  p = abs(p);
  p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
  p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
  return length(p) * sign(p.y);
}

// Star (5-pointed)
float sdStar(vec2 p, float r, int n, float m) {
  float an = 3.141593 / float(n);
  float en = 3.141593 / m;
  vec2 acs = vec2(cos(an), sin(an));
  vec2 ecs = vec2(cos(en), sin(en));

  float bn = mod(atan(p.x, p.y), 2.0 * an) - an;
  p = length(p) * vec2(cos(bn), abs(sin(bn)));
  p -= r * acs;
  p += ecs * clamp(-dot(p, ecs), 0.0, r * acs.y / ecs.y);
  return length(p) * sign(p.x);
}
```

## 3D Primitives

```glsl
// Sphere
float sdSphere(vec3 p, float r) {
  return length(p) - r;
}

// Box
float sdBox(vec3 p, vec3 b) {
  vec3 d = abs(p) - b;
  return length(max(d, 0.0)) + min(max(d.x, max(d.y, d.z)), 0.0);
}

// Torus
float sdTorus(vec3 p, vec2 t) {
  vec2 q = vec2(length(p.xz) - t.x, p.y);
  return length(q) - t.y;
}

// Cylinder (infinite along Y)
float sdCylinder(vec3 p, float r) {
  return length(p.xz) - r;
}

// Capped cylinder
float sdCappedCylinder(vec3 p, float h, float r) {
  vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r, h);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}

// Cone
float sdCone(vec3 p, vec2 c, float h) {
  vec2 q = h * vec2(c.x / c.y, -1.0);
  vec2 w = vec2(length(p.xz), p.y);
  vec2 a = w - q * clamp(dot(w, q) / dot(q, q), 0.0, 1.0);
  vec2 b = w - q * vec2(clamp(w.x / q.x, 0.0, 1.0), 1.0);
  float k = sign(q.y);
  float d = min(dot(a, a), dot(b, b));
  float s = max(k * (w.x * q.y - w.y * q.x), k * (w.y - q.y));
  return sqrt(d) * sign(s);
}

// Capsule
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

// Plane (n must be normalized)
float sdPlane(vec3 p, vec3 n, float h) {
  return dot(p, n) + h;
}
```

## Boolean Operations

```glsl
// Union (combine shapes)
float opUnion(float d1, float d2) {
  return min(d1, d2);
}

// Subtraction (cut d2 from d1)
float opSubtraction(float d1, float d2) {
  return max(d1, -d2);
}

// Intersection (keep overlap only)
float opIntersection(float d1, float d2) {
  return max(d1, d2);
}
```

## Smooth Boolean Operations

Blended versions for organic transitions.

```glsl
// Smooth union (smooth min)
float opSmoothUnion(float d1, float d2, float k) {
  float h = clamp(0.5 + 0.5 * (d2 - d1) / k, 0.0, 1.0);
  return mix(d2, d1, h) - k * h * (1.0 - h);
}

// Smooth subtraction
float opSmoothSubtraction(float d1, float d2, float k) {
  float h = clamp(0.5 - 0.5 * (d2 + d1) / k, 0.0, 1.0);
  return mix(d2, -d1, h) + k * h * (1.0 - h);
}

// Smooth intersection
float opSmoothIntersection(float d1, float d2, float k) {
  float h = clamp(0.5 - 0.5 * (d2 - d1) / k, 0.0, 1.0);
  return mix(d2, d1, h) + k * h * (1.0 - h);
}
```

## Transformations

```glsl
// Translate: shift the point before evaluating the SDF
float d = sdSphere(p - vec3(1.0, 0.0, 0.0), 0.5);

// Rotate (2D, in XZ plane)
mat2 rot2D(float a) {
  float s = sin(a), c = cos(a);
  return mat2(c, -s, s, c);
}
// Usage: p.xz = rot2D(angle) * p.xz;

// Scale (must correct the distance)
float d = sdSphere(p / scale, 1.0) * scale;

// Infinite repetition
vec3 opRepeat(vec3 p, vec3 spacing) {
  return mod(p + 0.5 * spacing, spacing) - 0.5 * spacing;
}

// Bounded repetition (n = number of copies per side)
vec3 opRepeatBounded(vec3 p, vec3 spacing, vec3 n) {
  vec3 id = clamp(round(p / spacing), -n, n);
  return p - spacing * id;
}

// Mirror along an axis
float opMirrorX(vec3 p) {
  p.x = abs(p.x);
  return sdSphere(p - vec3(1.0, 0.0, 0.0), 0.5);
}

// Round (add radius to any shape)
float opRound(float d, float r) {
  return d - r;
}

// Onion (hollow shell)
float opOnion(float d, float thickness) {
  return abs(d) - thickness;
}
```

## Ray Marching

Render 3D SDFs by stepping along view rays until hitting a surface.

```glsl
#define MAX_STEPS 100
#define MAX_DIST 100.0
#define SURF_DIST 0.001

// Scene SDF — combine all your shapes here
float scene(vec3 p) {
  float sphere = sdSphere(p - vec3(0.0, 1.0, 0.0), 1.0);
  float plane = p.y;
  return min(sphere, plane);
}

// March a ray from origin ro in direction rd
float rayMarch(vec3 ro, vec3 rd) {
  float d = 0.0;
  for (int i = 0; i < MAX_STEPS; i++) {
    vec3 p = ro + rd * d;
    float ds = scene(p);
    d += ds;
    if (d > MAX_DIST || ds < SURF_DIST) break;
  }
  return d;
}

// Estimate surface normal via gradient
vec3 getNormal(vec3 p) {
  float d = scene(p);
  vec2 e = vec2(0.001, 0.0);
  vec3 n = d - vec3(
    scene(p - e.xyy),
    scene(p - e.yxy),
    scene(p - e.yyx)
  );
  return normalize(n);
}

// Basic diffuse lighting
float getLight(vec3 p) {
  vec3 lightPos = vec3(2.0, 5.0, -3.0);
  vec3 l = normalize(lightPos - p);
  vec3 n = getNormal(p);
  float diff = clamp(dot(n, l), 0.0, 1.0);

  // Shadow ray
  float shadow = rayMarch(p + n * SURF_DIST * 2.0, l);
  if (shadow < length(lightPos - p)) diff *= 0.1;

  return diff;
}

// Fragment shader main
void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uResolution.xy) / uResolution.y;

  vec3 ro = vec3(0.0, 2.0, -5.0); // camera position
  vec3 rd = normalize(vec3(uv, 1.0)); // ray direction

  float d = rayMarch(ro, rd);
  vec3 p = ro + rd * d;

  float light = getLight(p);
  vec3 color = vec3(light);

  gl_FragColor = vec4(color, 1.0);
}
```

## Anti-Aliasing SDF Edges

```glsl
// Hard edge (aliased)
float shape = step(0.0, -d);

// Smooth edge with smoothstep
float shape = 1.0 - smoothstep(0.0, 0.01, d);

// Screen-space anti-aliasing (best quality)
float shape = 1.0 - smoothstep(-fwidth(d), fwidth(d), d);

// For 2D SDFs on a quad
float aa = 2.0 / uResolution.y;  // ~1 pixel
float shape = 1.0 - smoothstep(-aa, aa, d);
```

Note: `fwidth` requires `extensions: { derivatives: true }` in Three.js ShaderMaterial or `#extension GL_OES_standard_derivatives : enable` in WebGL1.

## Common Recipes

### 2D Shape on a Quad

```glsl
void main() {
  vec2 uv = vUv - 0.5;
  uv.x *= uResolution.x / uResolution.y;

  float d = sdCircle(uv, 0.3);
  float shape = 1.0 - smoothstep(0.0, fwidth(d), d);

  vec3 color = mix(vec3(0.1), vec3(0.9, 0.3, 0.1), shape);
  gl_FragColor = vec4(color, 1.0);
}
```

### Metaballs (Smooth Union of Circles)

```glsl
void main() {
  vec2 uv = vUv - 0.5;
  uv.x *= uResolution.x / uResolution.y;

  float d1 = sdCircle(uv - vec2(sin(uTime) * 0.2, 0.0), 0.15);
  float d2 = sdCircle(uv + vec2(sin(uTime * 1.3) * 0.2, cos(uTime) * 0.1), 0.12);
  float d = opSmoothUnion(d1, d2, 0.15);

  float shape = 1.0 - smoothstep(0.0, fwidth(d), d);
  gl_FragColor = vec4(vec3(shape), 1.0);
}
```

### Glow Around SDF

```glsl
float glow = exp(-3.0 * abs(d));
vec3 color = vec3(0.2, 0.5, 1.0) * glow;
```

## See Also

- `glsl-fundamentals` — coordinate systems, output
- `glsl-math` — smoothstep, smoothmin, easing
- `glsl-coordinates` — rotation matrices, polar coordinates
- `glsl-noise` — combine noise with SDF for organic shapes
