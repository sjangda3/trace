---
name: shaderbase-manifest
description: Writing shader.json manifests for the ShaderBase registry — schema reference, capability profiles, uniforms, provenance tracking. Use when creating or editing ShaderBase shader packages.
---

# ShaderBase Manifest (shader.json)

Every shader in the ShaderBase registry has a `shader.json` manifest. This is the source of truth for metadata, capabilities, and integration.

## Minimal Example

```json
{
  "schemaVersion": "0.1.0",
  "name": "my-shader",
  "displayName": "My Shader",
  "version": "0.1.0",
  "summary": "One-line description.",
  "description": "Longer description of what the shader does and how it works.",
  "author": { "name": "Your Name" },
  "license": "MIT",
  "tags": ["color", "surface"],
  "category": "color",
  "capabilityProfile": {
    "pipeline": "surface",
    "stage": "fragment",
    "requires": ["uv"],
    "outputs": ["color"]
  },
  "compatibility": {
    "three": ">=0.160.0",
    "renderers": ["webgl2"],
    "material": "shader-material",
    "environments": ["three", "react-three-fiber"]
  },
  "uniforms": [],
  "inputs": [
    { "name": "uv", "kind": "uv", "description": "Mesh UV coordinates.", "required": true }
  ],
  "outputs": [
    { "name": "color", "kind": "color", "description": "Output color." }
  ],
  "files": {
    "vertex": "vertex.glsl",
    "fragment": "fragment.glsl",
    "includes": []
  },
  "recipes": [
    {
      "target": "three",
      "path": "recipes/three.ts",
      "exportName": "createMyShaderMaterial",
      "summary": "Create a ShaderMaterial for vanilla Three.js.",
      "placeholders": [],
      "requirements": ["three-scene", "mesh"]
    }
  ],
  "preview": {
    "path": "preview.svg",
    "format": "svg",
    "width": 512,
    "height": 512,
    "deterministic": true
  },
  "provenance": {
    "sourceKind": "original",
    "sources": [],
    "attribution": {
      "summary": "Original work."
    }
  }
}
```

## Field Reference

### Top-Level Fields

| Field             | Type     | Required | Description                                            |
|-------------------|----------|----------|--------------------------------------------------------|
| `schemaVersion`   | `"0.1.0"`| Yes      | Always `"0.1.0"` for current schema                   |
| `name`            | string   | Yes      | Kebab-case identifier: `[a-z0-9]+(-[a-z0-9]+)*`       |
| `displayName`     | string   | Yes      | Human-readable name                                    |
| `version`         | string   | Yes      | Semver string                                          |
| `summary`         | string   | Yes      | One-line description                                   |
| `description`     | string   | Yes      | Detailed description                                   |
| `author`          | object   | Yes      | `{ name, github?, url? }`                             |
| `license`         | string   | Yes      | SPDX identifier                                        |
| `tags`            | string[] | Yes      | At least 1 tag                                         |
| `category`        | string   | Yes      | Primary category                                       |

### Capability Profile

Describes what the shader does and what it needs.

```json
"capabilityProfile": {
  "pipeline": "surface",
  "stage": "vertex-and-fragment",
  "requires": ["uv", "time"],
  "outputs": ["color", "alpha"]
}
```

**`pipeline`** — What the shader is for:
- `"surface"` — Applied to mesh surfaces (color, patterns)
- `"postprocessing"` — Fullscreen effect on rendered scene
- `"geometry"` — Modifies vertex positions
- `"utility"` — Helper (noise generation, coordinate transforms)

**`stage`** — Which shader stages are used:
- `"fragment"` — Fragment shader only (passthrough vertex)
- `"vertex"` — Vertex shader only
- `"vertex-and-fragment"` — Both
- `"fullscreen-pass"` — Fullscreen quad for post-processing

**`requires`** — What the shader needs from the host:
- `"uv"`, `"time"`, `"resolution"`, `"mouse"`, `"normals"`
- `"world-position"`, `"input-texture"`, `"camera"`, `"screen-space"`

**`outputs`** — What the shader produces (at least 1):
- `"color"`, `"alpha"`, `"emissive"`
- `"position-offset"`, `"normal-perturbation"`

### Uniforms

```json
"uniforms": [
  {
    "name": "uRadius",
    "type": "float",
    "defaultValue": 0.42,
    "description": "Radius where the blend reaches the outer color.",
    "min": 0.05,
    "max": 1
  },
  {
    "name": "uColor",
    "type": "vec3",
    "defaultValue": [1, 0.76, 0.32],
    "description": "RGB color value."
  },
  {
    "name": "uTexture",
    "type": "sampler2D",
    "defaultValue": null,
    "description": "Input texture."
  }
]
```

**Supported types and their `defaultValue` format:**

| Type          | Default Value Format          | Example                      |
|---------------|------------------------------|------------------------------|
| `float`       | number                       | `0.5`                        |
| `int`         | integer                      | `4`                          |
| `bool`        | boolean                      | `true`                       |
| `vec2`        | `[number, number]`           | `[0.5, 0.5]`               |
| `vec3`        | `[number, number, number]`   | `[1.0, 0.5, 0.0]`          |
| `vec4`        | 4 numbers                    | `[1, 1, 1, 1]`             |
| `color`       | `[r, g, b]`                  | `[1, 0.76, 0.32]`          |
| `mat3`        | 9 numbers (column-major)     | `[1,0,0, 0,1,0, 0,0,1]`    |
| `mat4`        | 16 numbers (column-major)    | `[1,0,0,0, ...]`           |
| `sampler2D`   | `null` or string path        | `null`                       |
| `samplerCube` | `null` or string path        | `null`                       |

**Validation rules:**
- `min`/`max` are optional, only for numeric types
- `min` must be ≤ `max`
- `color` type expects exactly 3 numbers

### Inputs and Outputs

```json
"inputs": [
  { "name": "uv", "kind": "uv", "description": "Mesh UV coordinates.", "required": true },
  { "name": "time", "kind": "time", "description": "Elapsed time.", "required": true }
],
"outputs": [
  { "name": "baseColor", "kind": "color", "description": "Output RGB color." },
  { "name": "opacity", "kind": "alpha", "description": "Alpha channel." }
]
```

**Input kinds:** `uv`, `position`, `normal`, `time`, `resolution`, `texture`, `mouse`
**Output kinds:** `color`, `alpha`, `emissive`, `position-offset`, `normal-perturbation`

### Files

```json
"files": {
  "vertex": "vertex.glsl",
  "fragment": "fragment.glsl",
  "includes": ["noise.glsl"]
}
```

All paths are relative to the shader directory. The validator checks that referenced files exist on disk.

### Compatibility

```json
"compatibility": {
  "three": ">=0.160.0",
  "renderers": ["webgl2"],
  "material": "shader-material",
  "environments": ["three", "react-three-fiber"]
}
```

**`material`:** `"shader-material"`, `"raw-shader-material"`, `"post-processing-pass"`, `"custom"`
**`renderers`:** `"webgl1"`, `"webgl2"`, `"webgpu"`
**`environments`:** `"three"`, `"react-three-fiber"`

If a recipe with `target: "three"` exists, environments must include `"three"`. Same for `"r3f"` → `"react-three-fiber"`.

### Recipes

```json
"recipes": [
  {
    "target": "three",
    "path": "recipes/three.ts",
    "exportName": "createGradientRadialMaterial",
    "summary": "Create a ShaderMaterial for vanilla Three.js.",
    "placeholders": [
      {
        "name": "innerColor",
        "kind": "color",
        "description": "Override the center color.",
        "required": false,
        "example": "\"#ffc252\""
      }
    ],
    "requirements": ["three-scene", "mesh"]
  }
]
```

**`target`:** `"three"` or `"r3f"`. Each target can appear only once.
**`placeholders`** — Parameters the user can customize:
  - `kind`: `"uniform"`, `"color"`, `"number"`, `"texture"`, `"mesh"`, `"time-source"`

**`requirements`** — What the host project needs:
  - `"three-scene"`, `"mesh"`, `"animation-loop"`, `"canvas"`, `"texture-input"`, `"effect-composer"`

### Preview

```json
"preview": {
  "path": "preview.svg",
  "format": "svg",
  "width": 512,
  "height": 512,
  "deterministic": true
}
```

Format must match file extension. Supported: `png`, `jpg`, `jpeg`, `webp`, `svg`.

### Provenance

Tracks where the shader code came from.

**Original work:**
```json
"provenance": {
  "sourceKind": "original",
  "sources": [],
  "attribution": {
    "summary": "Authored directly in the ShaderBase repository."
  }
}
```

**Adapted from existing code:**
```json
"provenance": {
  "sourceKind": "adapted",
  "sources": [
    {
      "name": "noise3D.glsl",
      "kind": "file",
      "url": "https://github.com/ashima/webgl-noise/blob/master/src/noise3D.glsl",
      "repositoryUrl": "https://github.com/ashima/webgl-noise",
      "revision": "master:0d5858780b7edcededdc2bff9e2c9d4d369fe1ed",
      "retrievedAt": "2026-03-06",
      "license": "MIT",
      "authors": ["Ian McEwan", "Ashima Arts"],
      "copyrightNotice": "Copyright (C) 2011 Ashima Arts.",
      "notes": "Adapted for ShaderBase displacement material."
    }
  ],
  "attribution": {
    "summary": "Uses MIT simplex noise from ashima/webgl-noise.",
    "requiredNotice": "Includes adapted code by Ian McEwan / Ashima Arts under MIT License."
  }
}
```

**Validation rules for provenance:**
- `adapted` and `ported` shaders **must** have at least one source
- `adapted` and `ported` sources **must** include `revision`
- `adapted` and `ported` **must** include `requiredNotice`
- `file`-kind sources **must** include `repositoryUrl`
- Source URLs must be unique (no duplicates)

**Source kinds:** `"file"`, `"repository"`, `"demo"`, `"article"`, `"algorithm"`

## Common Mistakes

1. **Missing `repositoryUrl` on file sources** — required when `kind: "file"`
2. **Duplicate recipe targets** — only one `"three"` and one `"r3f"` recipe allowed
3. **Environment mismatch** — having an R3F recipe without `"react-three-fiber"` in environments
4. **Absolute paths** — all file paths must be relative, no `..` traversal
5. **Wrong `defaultValue` format** — `vec3` needs `[n, n, n]`, not a single number
6. **Missing `revision` on adapted shaders** — non-original sources must record upstream revision

## Directory Structure

```
shaders/my-shader/
├── shader.json          # manifest (this file)
├── vertex.glsl          # vertex shader source
├── fragment.glsl        # fragment shader source
├── preview.svg          # preview image
└── recipes/
    ├── three.ts         # vanilla Three.js integration
    └── r3f.tsx          # React Three Fiber integration
```

## See Also

- `shaderbase-recipes` — Writing Three.js and R3F recipe files
- `glsl-fundamentals` — GLSL shader code basics
