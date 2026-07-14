# Trace interface system

This interface is a dense macOS product surface. It should feel native, quiet, and exact—not like a dashboard assembled from cards.

## Geometry

The reference window is `1250 × 727` logical pixels at its default size.

| Element | Token |
| --- | --- |
| Window radius | `18px` |
| Outer panel inset | `8px` |
| Sidebar | `324px` at the default window width |
| Split channel | `8px` |
| Editor | `900px` at the default window width |
| Titlebar | `34px` |
| Editor tabs | `32px` |
| Breadcrumb bar | `31px` |
| Statusbar | `32px` |
| Tree row | `30px` |
| Code line | `20px` |
| Panel radius | `8px` |
| Control radius | `5–7px` |
| Main icon | `16px`, `1.5px` rounded stroke |

Spacing uses a strict `4 / 8 / 12 / 16 / 24px` scale. Related controls stay within `4–8px`; separate toolbar groups use `12–16px` or flexible space.

## Typography

- Product UI: `-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, "Helvetica Neue", Arial, sans-serif`.
- Code: `"IBM Plex Mono", "SF Mono", Menlo, Monaco, ui-monospace, monospace`.
- UI roles: `12px` metadata, `13px` toolbar/tab text, `14px` tree text.
- Code: `14px / 20px`, weight `400`, ligatures disabled.
- Use regular and semibold as the primary UI weights. Syntax tokens never become bold.
- Keep default letter spacing and tabular line numbers.

## Palette

| Role | Value |
| --- | --- |
| Acrylic chrome | `#d2e5f3` |
| Panel | `#fdfdfc` |
| Primary text | `#303438` |
| Secondary text | `#858b91` |
| Hairline | `rgba(70, 81, 91, .19)` |
| Selection | `#e5eef7` |
| Active code line | `#e9ebef` |
| Keyword | `#9b5f50` |
| String/path | `#4f7192` |
| Type | `#705a80` |
| Function | `#617354` |

## Icon treatment

- Toolbar actions use thin, rounded line icons without labels.
- File-tree folders are filled, low-contrast silhouettes.
- Source files use compact colored document tiles with white internal marks.
- Do not mix emoji, filled app icons, or oversized illustrations into the work surface.

## Composition rules

- The editor is always the dominant uninterrupted plane.
- Navigation and tools are continuous surfaces separated by insets and hairlines, not cards.
- Project Map, terminal, PR review, and preview surfaces open as panels only when requested.
- Avoid large headings, pill-heavy controls, card grids, decorative gradients inside panels, and persistent AI chat UI.
- Product features appear as subtle tools within the shell; they do not reshape the default editor layout.
