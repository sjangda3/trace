---
name: shaderbase-recipes
description: Writing Three.js and React Three Fiber integration recipes for ShaderBase shaders — factory functions, component patterns, placeholders, requirements. Use when creating shader integration code for the ShaderBase registry.
---

# ShaderBase Recipes

Recipes are copy-paste-ready integration files that let users add a ShaderBase shader to their project. Each shader has a `recipes/three.ts` and/or `recipes/r3f.tsx`.

## Three.js Recipe Pattern

A factory function that creates a `ShaderMaterial` with inlined GLSL.

```typescript
import { Color, ShaderMaterial } from "three";

type MyShaderOptions = {
  color?: string;
  intensity?: number;
};

const vertexShader = `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = `
precision highp float;

varying vec2 vUv;

uniform vec3 uColor;
uniform float uIntensity;

void main() {
  vec3 color = uColor * uIntensity;
  gl_FragColor = vec4(color, 1.0);
}
`;

export function createMyShaderMaterial(options: MyShaderOptions = {}) {
  return new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uColor: { value: new Color(options.color ?? "#ff6600") },
      uIntensity: { value: options.intensity ?? 1.0 },
    },
  });
}
```

### Key Rules

1. **Inline the GLSL** — shader source lives as template literals inside the recipe, not as imports (the CLI copies this single file)
2. **Export a factory function** — named `create<Name>Material`, returns `ShaderMaterial`
3. **Options object with defaults** — every parameter has a sensible default
4. **Type the options** — explicit TypeScript type for the options object
5. **Import only from `three`** — no external dependencies

### Usage by Consumer

```typescript
import { createMyShaderMaterial } from "./shaders/my-shader/recipes/three";

const material = createMyShaderMaterial({ color: "#00ff88", intensity: 0.8 });
mesh.material = material;
```

## React Three Fiber Recipe Pattern

A React component that creates the material with props.

```tsx
import { useRef } from "react";
import { Color, ShaderMaterial } from "three";

type MyShaderProps = {
  color?: string;
  intensity?: number;
};

const vertexShader = `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = `
precision highp float;

varying vec2 vUv;

uniform vec3 uColor;
uniform float uIntensity;

void main() {
  vec3 color = uColor * uIntensity;
  gl_FragColor = vec4(color, 1.0);
}
`;

export function MyShaderMaterial({
  color = "#ff6600",
  intensity = 1.0,
}: MyShaderProps) {
  const materialRef = useRef<ShaderMaterial | null>(null);

  if (!materialRef.current) {
    materialRef.current = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uColor: { value: new Color(color) },
        uIntensity: { value: intensity },
      },
    });
  }

  return <primitive attach="material" object={materialRef.current} />;
}
```

### Key Rules

1. **Inline the GLSL** — same as Three.js recipe
2. **Export a component** — named `<ShaderName>Material`, returns JSX
3. **Props with defaults** — destructured with default values
4. **useRef for lazy init** — create the material once, not on every render
5. **Import only from `react` and `three`** — no `@react-three/fiber` or `@react-three/drei` needed for the material itself

### Usage by Consumer

```tsx
import { MyShaderMaterial } from "./shaders/my-shader/recipes/r3f";

function Scene() {
  return (
    <mesh>
      <planeGeometry args={[2, 2]} />
      <MyShaderMaterial color="#00ff88" intensity={0.8} />
    </mesh>
  );
}
```

## Animated Shaders (Time Uniform)

When the shader needs `uTime`, the recipe must handle the animation loop.

### Three.js — Return Material + Provide Update Guidance

```typescript
export function createAnimatedMaterial(options: AnimatedOptions = {}) {
  const material = new ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uTime: { value: 0 },
      uSpeed: { value: options.speed ?? 1.0 },
    },
  });

  return material;
}

// Consumer updates in their render loop:
// material.uniforms.uTime.value = clock.getElapsedTime();
```

### R3F — Use useFrame

```tsx
import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { ShaderMaterial } from "three";

export function AnimatedMaterial({ speed = 1.0 }: AnimatedProps) {
  const materialRef = useRef<ShaderMaterial | null>(null);

  if (!materialRef.current) {
    materialRef.current = new ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uSpeed: { value: speed },
      },
    });
  }

  useFrame(({ clock }) => {
    if (materialRef.current) {
      materialRef.current.uniforms.uTime.value = clock.getElapsedTime();
    }
  });

  return <primitive attach="material" object={materialRef.current} />;
}
```

## Post-Processing Recipe Pattern

Post-processing shaders use `ShaderPass` instead of `ShaderMaterial`.

### Three.js

```typescript
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";

type VignetteOptions = {
  darkness?: number;
  offset?: number;
};

const vertexShader = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const fragmentShader = `
precision highp float;
uniform sampler2D tDiffuse;
uniform float offset;
uniform float darkness;
varying vec2 vUv;

void main() {
  vec4 texel = texture2D(tDiffuse, vUv);
  vec2 uv = (vUv - 0.5) * vec2(offset);
  texel.rgb *= 1.0 - dot(uv, uv) * darkness;
  gl_FragColor = texel;
}
`;

const vignetteShader = {
  uniforms: {
    tDiffuse: { value: null },
    offset: { value: 1.0 },
    darkness: { value: 1.15 },
  },
  vertexShader,
  fragmentShader,
};

export function createVignettePass(options: VignetteOptions = {}) {
  const pass = new ShaderPass(vignetteShader);
  pass.material.uniforms.offset.value = options.offset ?? 1.0;
  pass.material.uniforms.darkness.value = options.darkness ?? 1.15;
  return pass;
}
```

### R3F

```tsx
import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";

export function VignetteEffect({
  darkness = 1.15,
  offset = 1.0,
}: VignetteEffectProps) {
  const { camera, gl, scene, size } = useThree();
  const composerRef = useRef<EffectComposer | null>(null);
  const passRef = useRef<ShaderPass | null>(null);

  if (!composerRef.current) {
    const composer = new EffectComposer(gl);
    composer.addPass(new RenderPass(scene, camera));
    const pass = new ShaderPass(vignetteShader);
    composer.addPass(pass);
    composerRef.current = composer;
    passRef.current = pass;
  }

  useEffect(() => {
    composerRef.current?.setSize(size.width, size.height);
  }, [size.width, size.height]);

  useEffect(() => {
    return () => { composerRef.current?.dispose(); };
  }, []);

  useFrame(() => {
    if (passRef.current) {
      passRef.current.material.uniforms.offset.value = offset;
      passRef.current.material.uniforms.darkness.value = darkness;
    }
    composerRef.current?.render();
  }, 1);

  return null;
}
```

## Placeholder System

Placeholders are declared in `shader.json` and map to recipe function parameters.

| Kind          | Recipe Type            | Example Value            |
|---------------|------------------------|--------------------------|
| `uniform`     | Any uniform value      | `0.5`, `[1, 0, 0]`     |
| `color`       | CSS color string       | `"#ff6600"`             |
| `number`      | Numeric value          | `0.42`                  |
| `texture`     | Texture path or object | `"./texture.png"`       |
| `mesh`        | Mesh reference         | (consumer provides)     |
| `time-source` | Clock/time provider    | `clock.getElapsedTime()`|

## Requirements Declaration

Requirements tell the consumer what their project needs.

| Requirement        | Meaning                                           |
|--------------------|---------------------------------------------------|
| `three-scene`      | A Three.js scene, camera, and renderer             |
| `mesh`             | A mesh to apply the material to                    |
| `animation-loop`   | A render loop (for time-based uniforms)            |
| `canvas`           | An R3F `<Canvas>` wrapper                          |
| `texture-input`    | A texture input (for post-processing)              |
| `effect-composer`  | Three.js EffectComposer (for post-processing)      |

## Copy-Paste Readiness Checklist

Before submitting a recipe:

- [ ] GLSL is inlined as template literals (no external imports)
- [ ] Factory function has a clear, descriptive name
- [ ] All parameters have sensible defaults
- [ ] TypeScript types are defined for options/props
- [ ] Only `three` (and `react` for R3F) are imported
- [ ] Animated shaders handle time updates
- [ ] Post-processing recipes use `ShaderPass`, not `ShaderMaterial`
- [ ] The recipe works as a standalone file after copy

## See Also

- `shaderbase-manifest` — The `shader.json` schema reference
- `threejs-shaders` — Three.js ShaderMaterial API details
- `glsl-fundamentals` — GLSL language basics
