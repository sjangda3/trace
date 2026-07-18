# Trace design

The canonical Trace design reference is the offline interactive [design system and brandbook](design/brandbook/index.html). Open it directly in a browser; no build step or network connection is required.

## Identity

- The original [Frame mark](design/trace-frame.svg) is the sole approved logo. Its three paths and 64-unit geometry must not be redrawn, compacted, or turned into a bespoke wordmark.
- Trace uses a fixed deep-navy, cobalt, acrylic-blue, and ice brand atmosphere. Cobalt, violet, teal, amber, and rose are workbench personalization accents—not corporate identity colors.
- Frame-derived fields, nested corners, orthogonal rails, and alignment guides form the graphic language. The legacy Ramp-derived arrow lattice is not part of the brand.
- Product voice follows calm precision: direct, technically honest, privacy-aware, and explicit about ownership, local files, errors, control, and recovery.

## Product system

The implemented workbench uses the system/SF stack for interface text and IBM Plex Mono with system-mono fallbacks for technical roles. Its compact foundations use:

- 2, 4, 6, 8, 12, 16, and 24px spacing
- 6, 8, and 18px radii
- 80, 110, 140, and 180ms motion durations
- quiet neutral surfaces, clear selection and focus, and restrained elevation

The brandbook documents layouts, controls, panels, collaboration ownership, annotations, Git and diffs, Monaco, terminal, onboarding, responsive behavior, empty/loading/error/offline states, accessibility, and recovery language.

## Implementation interface

[tokens.json](design/brandbook/tokens.json) is the machine-readable documentation interface. Every token is labeled **implemented** when transcribed from the current product or **extension** when it is newly approved guidance.

The brandbook is documentation, not a silent migration. It does not change application components, runtime styles, onboarding behavior, packaging, or dependencies. Known contrast gaps are recorded as migration targets; application adoption, app icons, marketing templates, and replacement of legacy in-product marks remain future work.

Exploratory files under **design/trace-logo-exploration/** remain an unlinked archive and are not approved identity assets.
