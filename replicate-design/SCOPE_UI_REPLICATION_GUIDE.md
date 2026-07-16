# Scope Desktop UI Replication Guide

Implementation-derived specification for recreating the active authenticated Scope desktop workspace as an IDE while replacing the accent color.

This document includes only UI and techniques currently exercised by the desktop workbench or its active dashboard routes. It does not treat dormant shared components, public-site treatments, or alternate-platform implementations as replication sources.

## Contents

1. Replication scope
2. Visual character
3. Active source hierarchy
4. Desktop workbench anatomy
5. Design tokens
6. Active component system
7. Command palette
8. Active motion system
9. Active route patterns and IDE mappings
10. Icon system
11. Accessibility
12. Desktop window behavior
13. Active skills and technology
14. IDE translation architecture
15. Implementation order
16. Color replacement procedure
17. Quality checklist
18. Active source index

## 1. Replication scope

### Preserve

- Quiet neutral work surfaces with one controlled accent family.
- A full-window workbench with a collapsible navigation rail, editor-style tabs, history controls, command palette, and inset content canvas.
- Hairline borders and low elevation instead of heavy shadows.
- Dense information organized by type, spacing, local grouping, and status.
- Fast color feedback and short physical transitions.
- Icons that clarify objects and actions while text remains primary.
- A designed dark theme rather than automatic color inversion.
- Loading states that preserve destination shape and context.
- Keyboard, focus, reduced-motion, and semantic-state behavior.
- Role-filtered navigation and actions.

### Change

- Slate-blue accent ramp.
- Logo and product name.
- Roofing terminology, routes, status names, and data.
- Chart series colors that intentionally use the accent family.
- Domain actions such as Add Client, Schedule Visit, and Production.

### Do not promote into the new system

- Route-local color literals when a semantic token already exists.
- Domain-specific pipeline labels.
- Shared files that are present in the repository but have no imports in the active workbench.
- Page-specific animation libraries or effects that are not part of the shell and reusable component system.

## 2. Visual character

Scope is an ink-first professional workspace placed on a faint cool canvas, with a muted accent, soft geometric cards, thin lines, compact outline icons, and restrained desktop motion.

For an IDE, preserve this relationship:

> editor-tab behavior + hierarchical navigation + calm document canvas + command-palette speed + precise desktop micro-interactions

The quality comes from the whole system:

- Cool outer canvas.
- White or dark-card working surface.
- Low-contrast lines.
- Compact controls.
- Stable geometry during navigation.
- Strong but infrequent selection color.
- A few carefully staged save, drag, and editor transitions.

## 3. Active source hierarchy

Use these sources in this order:

1. salesview-web/app/globals.css for semantic colors, raw ramps, radii, shadows, scrollbars, active keyframes, and reduced motion.
2. Actively imported files under salesview-web/components/ui for reusable controls and surfaces.
3. salesview-web/components/dashboard for the shell, tab strip, navigation rail, command palette, route loading, page headers, and metric cards.
4. Active authenticated routes under salesview-web/app/(dashboard) for dense page composition and task-specific patterns.

The active desktop implementation passed the optimized Next.js production build while this guide was compiled.

## 4. Desktop workbench anatomy

### 4.1 Overall frame

Source: salesview-web/components/dashboard/DashboardShell.tsx.

| Region | Active specification |
| --- | --- |
| Root | Full viewport height, vertical flex, overflow hidden, canvas-page background |
| Workbench header | 44 px high |
| Expanded rail | 236 px |
| Collapsed rail | 72 px |
| Canvas inset | 2 px top, 10 px right, 10 px bottom |
| Main canvas | Semantic card surface, 18 px radius, 1 px border, small shadow |
| Page padding | 24 px horizontal, 16 px top, 24 px bottom |
| Scroll owner | Inner content canvas, not the browser document |
| Minimum desktop shell breakpoint | 768 px |

Structure:

    viewport / canvas-page
    ├── 44 px workbench header
    │   ├── product, rail toggle, search, history
    │   └── horizontally scrolling editor tabs
    └── workbench body
        ├── 236 px or 72 px navigation rail
        └── inset content canvas
            ├── active route content
            └── opaque route-loading layer when navigating

The root and every important flex/grid ancestor use min-height zero where needed. This lets the canvas own vertical scrolling while boards, tables, and inspector-like side regions can own local scrolling.

### 4.2 Inset content canvas

The canvas is the central visual device.

- Outer surface: canvas-page, #eef0f4 in light mode.
- Inner surface: card, #ffffff in light mode.
- Border: rgba(14,16,19,0.08).
- Radius: 18 px.
- Shadow: shadow-sm.
- Desktop gutter: 2 px top and 10 px on right/bottom.

Keep the border, radius, outer contrast, and small gutter together. Removing them makes the shell read like a conventional dashboard. Increasing the shadow makes it feel like a floating website card.

### 4.3 Header controls

Source: salesview-web/components/dashboard/DashboardHeader.tsx.

- Header height: 44 px.
- Left region width matches the rail: 236 px expanded, 72 px collapsed.
- Width transition: 300 ms with cubic-bezier(.22,1,.36,1).
- Product mark: 20 px.
- Wordmark: 15 px bold with -0.02em tracking.
- Rail toggle, search, history back, and history forward controls: 32 × 32 px.
- Standard header icons: 17 px at 1.5 stroke.
- Expanded state shows product, search, back, and forward.
- Collapsed state preserves the rail toggle and editor tabs.

### 4.4 Editor-style tabs

Source: salesview-web/components/dashboard/DashboardHeader.tsx.

Geometry:

- Height: 32 px.
- Minimum width: 120 px at the desktop shell width.
- Maximum width: 188 px.
- Gap: 4 px.
- Radius: 12 px.
- Label: 13 px medium.
- Close target: 24 × 24 px.
- Close icon: 13 px.
- Add-tab target: 32 × 32 px.
- Strip scrolls horizontally and never wraps.
- Scrollbar is hidden.

States:

- Active: card surface, visible semantic border, foreground text, shadow-sm.
- Inactive light: black at 3.5% opacity.
- Inactive dark: white at 4% opacity.
- Inactive hover light: black at 5.5%.
- Inactive hover dark: white at 7%.
- Dragged: opacity 40%.
- Close icon rests at 70% opacity and becomes fully visible on hover/focus.

Behavior:

- Pointer movement must exceed 6 px before reorder begins.
- Moving over another tab reorders the array in place.
- Click suppression prevents a drag release from navigating.
- Closing the active tab selects the left neighbor first, then the item now at the same index.
- Closing the last tab leaves an intentional empty workbench.
- The tab array is role-filtered and automatically registers a route reached outside the tab strip.

Empty workbench:

- Centered layout.
- 96 × 96 px icon tile.
- 28 px tile radius.
- PanelsTopLeft icon at 44 px and 1.25 stroke.
- 20 px semibold title.
- 14 px explanatory copy.
- 40 px primary New tab action.

IDE mapping:

- Route tab becomes editor tab.
- Add dirty state and document identity later without changing the current geometry.
- Preserve the zero-editor state rather than forcing a default editor open.

### 4.5 Navigation rail

Source: salesview-web/components/dashboard/AppSidebar.tsx.

Expanded geometry:

- Width: 236 px.
- Stable internal icon column: 48 px.
- Team/workspace trigger: 36 px high, 12 px radius.
- Home and group rows: 36 px high.
- Nested route rows: 32 px high.
- Account trigger: at least 44 px high.
- Primary icons: 18 px at 1.5 stroke.
- Nested icons: 14 px at 1.5 stroke.
- Row text: 13–14 px.
- Standard outer horizontal padding: 12 px.

Collapsed geometry:

- Width: 72 px.
- Text collapses through maximum width, opacity, and slight horizontal translation.
- The 48 px icon column does not move.
- A collapsed group click expands the rail before exposing children.
- Accessible names remain descriptive when visible labels disappear.

Navigation hierarchy:

- Home.
- Sales: Clients, Calendar.
- Documents: Production, Files.
- Insights: Analytics, Reports.
- Team: Members, Team settings.
- Settings: Billing, Account.

Active navigation:

- Active primary rows use solid brand background and brand-foreground text.
- Nested routes follow the same clear active treatment.
- Group children reveal inline using grid-template-rows and opacity.
- Chevron rotates over 200 ms.

Workspace identity:

- Team avatar and name sit at the top.
- The avatar is deterministic from tenant seed and selected shader.
- Owners receive Add members and Team settings actions.
- The menu visually joins the trigger through shared edges and adjusted corner radii.

Account identity:

- Account control anchors the bottom.
- Menu opens upward.
- Contains known accounts, Add account, Dark mode, Account, and Sign out.
- Dark mode is stored in localStorage and applied to the document root.

IDE mapping:

- Team trigger → workspace or repository selector.
- Sales group → projects and search.
- Documents group → files and build artifacts.
- Insights group → diagnostics and profiler.
- Team group → collaboration.
- Settings group → workspace and account preferences.

### 4.6 Route continuity

Source: DashboardShell.tsx, WorkspacePageLoading.tsx, and WorkspaceRouteMarker.tsx.

Navigation sequence:

1. Register the destination as a tab.
2. Mark it pending and visually active.
3. Prefetch its route.
4. Place an opaque card-colored loading surface over the current canvas.
5. Wait until a matching data-workspace-route marker exists in rendered content.
6. Clear the overlay on the next animation frame.

Tab picker prefetches on pointer enter and keyboard focus.

Loading surface:

- Preserves page padding and canvas dimensions.
- 40 × 40 px destination icon tile.
- 18 px destination icon.
- 14 px semibold loading title.
- 12 px muted detail.
- 16 px spinner aligned right.
- Skeleton grid uses two 96 px blocks and one 224 px block.
- Skeletons use muted 30% surfaces and border 60%.

This is directly reusable for file loading, project indexing, remote connection, or editor initialization.

## 5. Design tokens

### 5.1 Typography

Source: salesview-web/app/layout.tsx and globals.css.

| Role | Family |
| --- | --- |
| Interface | Inter |
| Code, times, IDs, file types | JetBrains Mono 400/500 |

Body text uses tabular figures globally through font-feature-settings: tnum 1.

Active type ladder:

| Size | Active use |
| --- | --- |
| 8 px | File-type micro labels |
| 11 px | Group labels, key hints, dense table headings |
| 12 px | Metadata, helper text, status badges |
| 13 px | Rail destinations and editor tabs |
| 14 px | Body, buttons, fields, rows |
| 15 px | Command input and emphasized controls |
| 16 px | Dialog and section titles |
| 20 px | Empty-workbench title |
| 24 px | Major route title where rendered |
| 30 px | Standard metric |
| 44 px | Hero metric |

Tracking:

- -0.02em for wordmarks, compact titles, and metrics.
- -0.03em for major route titles.
- 0.08em for 11 px uppercase command groups.

### 5.2 Light semantic colors

| Token | Value | Use |
| --- | --- | --- |
| background | #f4f6f8 | Page-level surface |
| foreground | #070419 | Primary ink |
| card | #ffffff | Working surface |
| popover | #ffffff | Menus and dialogs |
| canvas-page | #eef0f4 | Outer workbench |
| faint | #8b919c | Tertiary text and icons |
| secondary | #f4f6f8 | Neutral control surface |
| secondary-foreground | #2e3238 | Strong secondary text |
| muted | #f4f6f8 | Neutral hover/fill |
| muted-foreground | #686e78 | Supporting copy |
| accent | #f4f6f8 | Neutral interactive hover |
| brand | #4c5b83 | Active navigation, links, focus, info |
| brand-emphasis | #3d4a6d | Strong accent |
| brand-soft | #eef2f8 | Soft selection |
| brand-soft-foreground | #3d4a6d | Text on soft selection |
| border | rgba(14,16,19,0.08) | Hairlines |
| input | rgba(14,16,19,0.14) | Field boundary |
| ring | #4c5b83 | Focus ring |
| success | #2e9e6b | Positive status |
| success-soft | #e8f6ef | Positive surface |
| success-soft-foreground | #1e7a50 | Positive text |
| warning | #e0a53c | Warning/progress |
| warning-soft | #fbf1dd | Warning surface |
| warning-soft-foreground | #9a6b16 | Warning text |
| destructive | #e5484d | Error/destructive action |
| destructive-soft | #fcebe9 | Error surface |
| destructive-soft-foreground | #b02a2e | Error text |

### 5.3 Dark semantic colors

| Token | Value |
| --- | --- |
| background / canvas-page | #070419 |
| foreground | #f4f6f8 |
| card / popover | #120e26 |
| muted | #15181c |
| muted-foreground | #b5bbc4 |
| secondary / accent | #1a1d21 |
| brand | #c2cee0 |
| brand-emphasis | #eef2f8 |
| brand-soft | rgba(194,206,224,0.14) |
| brand-soft-foreground | #eef2f8 |
| border | rgba(255,255,255,0.08) |
| input | rgba(255,255,255,0.12) |
| ring | #c2cee0 |
| sidebar | #0d0820 |

Status soft surfaces become 16% translucent overlays in dark mode rather than pale solid fills.

### 5.4 Raw ramps

Neutral:

#fafbfc, #f4f6f8, #e9ecf0, #dce0e6, #b5bbc4, #8b919c, #686e78, #4b5057, #2e3238, #1a1d21, #070419.

Accent:

#f7f9fc, #eef2f8, #dce4f0, #c2cee0, #8fa0bc, #65759d, #4c5b83, #3d4a6d, #303a58, #252e48, #171d31.

Status:

- Success 50/100/500/700: #e8f6ef, #cdebdd, #2e9e6b, #1e7a50.
- Warning 50/100/500/700: #fbf1dd, #f6e3bc, #e0a53c, #9a6b16.
- Danger 50/100/500/700: #fcebe9, #f8d5d0, #e5484d, #b02a2e.

### 5.5 Radius and elevation

| Token | Value | Active use |
| --- | --- | --- |
| radius-sm | 4 px | Tiny indicators |
| radius-md | 6 px | Badges and keycaps |
| radius-lg | 8 px | Controls and navigation rows |
| radius-xl | 12 px | Cards, tabs, and compact menus |
| radius-2xl | 18 px | Main canvas, large cards, dialogs |
| shadow-sm | 0 1px 2px rgba(16,18,21,0.06) | Cards and active tabs |
| shadow-md | 0 2px 8px rgba(16,18,21,0.08) | Menus |
| shadow-lg | 0 10px 28px -8px rgba(16,18,21,0.18) | Dialogs |

Use border and surface before shadow. Most persistent UI stops at shadow-sm.

### 5.6 Spacing

The active workbench follows a 4 px rhythm.

- 4 px: tab and compact-menu gaps.
- 6–8 px: icon-label gaps and compact padding.
- 10–12 px: row padding and control groups.
- 16 px: local card grouping and page top padding.
- 20 px: standard card padding.
- 24 px: desktop page and dialog padding.

## 6. Active component system

This section includes only shared components imported by the active workbench or dashboard routes.

### 6.1 Buttons

Sources: components/ui/button.tsx, button-effects.ts, and components/dashboard/dashboardControls.ts.

Shared button:

- Radius: 8 px.
- Text: 14 px medium.
- Heights: 24, 28, 32, and 36 px.
- Icon buttons use matching square sizes.
- Default icon: 16 px.
- Small icon: 14 px.
- Extra-small icon: 12 px.
- Focus: ring-colored border plus 3 px ring at 50%.
- Invalid: destructive border and ring.
- Disabled: pointer events removed and opacity 50%.

Active variants:

| Variant | Treatment |
| --- | --- |
| Default | Solid foreground, inverse text, shadow-sm |
| Brand | Brand-emphasis surface, brand-foreground text |
| Brand soft | Brand-soft surface, 30% brand border |
| Outline | Card surface, input border, muted hover |
| Secondary | Card surface, input border, foreground text |
| Ghost | Transparent rest, muted hover |
| Destructive | Soft destructive surface and border |
| Link | Brand text, underline on hover |

Primary physical response:

- 200 ms.
- cubic-bezier(.22,1,.36,1).
- Hover scale 1.015.
- Press scale 0.99.

Dashboard control helpers standardize:

- 36 px height.
- 8 px radius.
- 14 px semibold.
- Brand focus border and 3 px brand/20 ring.
- Compact select hover scale 1.02 over 150 ms.

### 6.2 Fields and custom select

Source: components/ui/input.tsx.

Input and textarea:

- Radius: 8 px.
- Card background.
- 1 px input border.
- 12 px horizontal and 10 px vertical padding.
- 14 px foreground text.
- Faint placeholder.
- Focus border changes to brand.
- Focus ring: 3 px brand at 20%.
- Label: 12 px semibold.
- Label gap: 6 px.
- Error/hint: 12 px.
- Disabled: muted background, faint text, not-allowed cursor.

Custom select:

- Uses a visually hidden native select for form compatibility.
- Visible trigger follows field geometry.
- Value change uses SelectionTransition.
- Listbox sits 6 px below the trigger.
- Listbox radius: 12 px.
- Maximum height: 256 px.
- Card surface with border, shadow, and backdrop blur.
- Open transition: 150 ms opacity and vertical translation.
- Selected option uses a subtle ink surface and Check icon.

### 6.3 Cards

Source: components/ui/card.tsx.

- Radius: 12 px.
- Card background.
- Semantic border.
- shadow-sm at rest.
- shadow-md on hover over 200 ms.
- Header: 24 px horizontal, 16 px vertical, bottom border.
- Content: 24 px horizontal, 16 px vertical.
- Footer: muted surface, top border, 24 × 16 px padding.

Home uses this primitive for Today, Needs you, Quick actions, and Recent clients.

### 6.4 Metric cards and charts

Sources: DashboardMetricCard.tsx, HomeMetrics.tsx, OdometerNumber.tsx, Sparkline.tsx, and active analytics widgets.

Metric card:

- Minimum height: 136 px.
- Radius: 12 px.
- Padding: 20 px.
- 36 × 36 px icon tile.
- Label: 14 px medium and muted.
- Value: 24 px bold, -0.02em tracking, tabular figures.
- Detail: 12 px, right aligned.
- Hover raises shadow only.
- Cards enter with active animate-in fade/slide classes.
- Grid item delay: index × 70 ms.

Hero metric:

- Radius: 18 px.
- Padding: 24 px.
- Value: 44 px.
- Sparkline height: 72 px.
- Sparkline area fades from 22% opacity to transparent.
- Numeric transition uses the active odometer component.

Analytics includes:

- Revenue heatmap.
- Pipeline funnel.
- Inspector leaderboard.
- Pipeline value radial gauge.
- Sparklines and summary metrics.

### 6.5 Badges and status

Sources: badge.tsx and status-badge.tsx.

Badge:

- Radius: 6 px.
- Padding: 10 px horizontal, 4 px vertical.
- Text: 12 px semibold.
- Icon: 12 px.
- Gap: 6 px.

Active semantic variants:

- Neutral.
- Solid.
- Brand/info.
- Success.
- Warning.
- Destructive.

Status badges pair icon and text. Color is never the only signal.

Processing states:

- Completed: success + Check.
- In review: info + Eye.
- Compiling: warning + spinning Loader2.
- Failed: destructive + X.

### 6.6 Dialog

Source: components/ui/dialog.tsx.

Geometry:

- Fixed centered layer.
- 16 px viewport inset.
- Radius: 18 px.
- Semantic card surface and border.
- shadow-lg.
- Width presets: 384, 448, 512, 672, and 896 px maximum.
- Header: 24 px horizontal, 16 px vertical.
- Body: 24 px.

Behavior:

- Escape closes.
- Scrim click closes.
- Scrim: neutral-950 at 40% plus 1 px backdrop blur.
- Hidden panel: translateY(8px), scale .97, opacity 0, blur 1 px.
- Visible panel: settled at scale 1.
- Duration: 180 ms.
- Unmount waits 180 ms so exit motion completes.
- Reduced motion removes the delay and spatial transition.

### 6.7 Table

Source: components/ui/table.tsx.

- Header height: 40 px.
- Header text: 12 px semibold and muted.
- Header surface: neutral-50.
- Cells: 16 px horizontal and 12 px vertical padding.
- Rows use hairline separators.
- Row hover changes background without translating the row.
- Dense route-specific tables use 11 px uppercase headings and sticky headers.
- Wide tables use explicit minimum widths and horizontal scrolling.

Active uses:

- Team members.
- Billing invoices.
- Client files.
- Reports and analytics results.

### 6.8 Avatar and team identity

Sources: avatar.tsx and team-avatar.tsx.

User avatar:

- Active sizes: 32, 40, and 56 px.
- Circular initials.
- Deterministic restrained tint selection.

Team avatar:

- Sizes: 24, 28, and 48 px.
- Rounded gradient canvas.
- Deterministic tenant seed.
- Optional shader.
- Hairline framed container.
- Decorative in the sidebar because the adjacent team name carries identity.

### 6.9 File-type badge

Source: file-type-badge.tsx.

- Base size: 22 × 22 px.
- Radius: 5 px.
- JetBrains Mono.
- 8 px medium text.
- Maximum four uppercase characters.
- Extension families use semantic soft surfaces.
- Active route overrides enlarge it for staged uploads and viewer headers.

### 6.10 SelectionTransition

Source: selection-transition.tsx.

Used by active selects, pipeline sort controls, file visibility controls, and text-style controls.

- Previous value remains in the same grid cell while leaving.
- Old value: y 0 to -2 px and opacity 1 to 0.
- New value: y 2 px to 0 and opacity 0 to 1.
- Duration: 180 ms.
- Retention window: 190 ms by default.
- Reduced motion swaps immediately.

### 6.11 Tree menu

Source: tree-menu.tsx.

- Container radius: 12 px.
- Container padding: 6 px.
- Minimum row height: 32 px.
- Row radius: 8 px.
- Row text: 14 px semibold.
- Base left padding: 8 px.
- Depth 1: 20 px.
- Depth 2: 32 px.
- Active row: muted surface and foreground text.
- Submenu width: 196 px.
- Submenu horizontal gap: 6 px.
- Submenu radius: 18 px.
- Submenu shadow: 0 18px 40px rgba(15,23,42,0.12).
- Submenu transition: 200 ms, x -6 px to 0, opacity 0 to 1.

Active uses:

- Pipeline sorting.
- Client assignment and status editing.
- File access roles.
- File access users.
- File metadata menus.

### 6.12 Rich-text controls

Sources: text-style-dropdown.tsx, notes-toolbar-state.ts, and the active client editor in ClientsClient.tsx.

Active editor controls:

- Text style.
- Bold.
- Italic.
- Underline.
- Strikethrough.
- Bulleted list.
- Numbered list.
- Checklist.
- Code.
- Quote.

Toolbar controls are compact, icon-led, and expose active state through surface and foreground changes. The editor uses a muted 25% background, rounded border, 14 px text, and 28 px line height.

### 6.13 Typewriter text

Source: typewriter-text.tsx.

- Default rate: 35 ms per character.
- Used by active Home/Admin greetings and DashboardPageHeader descriptions.
- Cursor is a 2 px brand bar with pulse.
- Reduced motion renders the complete string immediately.

## 7. Command palette

Source: components/dashboard/CommandPalette.tsx.

### 7.1 Geometry

- Maximum width: 600 px.
- Dialog viewport inset: 16 px.
- Search row: 56 px.
- Result viewport maximum height: 380 px.
- Search icon: 20 px, 1.75 stroke.
- Input: 15 px.
- Keycap: at least 20 px wide, 11 px text, 6 px radius.
- Result row radius: 12 px.
- Result row padding: 10 px horizontal, 8 px vertical.
- Result icon tile: 32 × 32 px.
- Result icon: 16 px at 1.6 stroke.
- Selected return tile: 24 × 24 px.
- Group heading: 11 px uppercase, 0.08em tracking.

### 7.2 Active groups

1. Quick actions.
2. Open tabs.
3. Pages.

Role capability checks remove unavailable commands before rendering.

Current quick actions:

- Add a client.
- Schedule an event.
- Upload files.
- Invite a teammate.

IDE mapping:

- Commands.
- Open editors.
- Files and symbols.
- Recent projects.

Keep each result as two lines:

- Primary action/resource name.
- Secondary context or destination.

### 7.3 Keyboard and pointer behavior

- Command/Ctrl+K opens.
- Input focuses after the panel has mounted.
- Arrow Down/Up moves selection.
- Selection clamps at the first and last result.
- Enter activates.
- Escape closes through Dialog.
- Mouse movement synchronizes selected index with pointer position.
- Selected result uses brand-soft.
- Selected icon tile becomes solid brand.
- Selected result alone reveals the return tile.
- No-result state uses a 40 px search tile, title, and suggestion.
- Footer documents navigation and activation keys.

## 8. Active motion system

### 8.1 Principles

- Routine hover is color-first.
- Geometry uses short transform and opacity transitions.
- Persistent chrome moves less than route content.
- Completion receives one restrained settle or pulse.
- Dragging uses opacity, cursor, local scale, and inset rings.
- Layout remains stable during navigation and loading.
- Reduced motion removes continuous and spatial effects.

Canonical spatial curve:

cubic-bezier(.22,1,.36,1)

### 8.2 Active transition catalog

| Pattern | Start | End | Duration/ease |
| --- | --- | --- | --- |
| Rail and header collapse | 236 px | 72 px | 300 ms canonical |
| Main left padding | 236 px | 72 px | 300 ms canonical |
| Rail labels | Visible | max-width 0, opacity 0, slight x shift | 200 ms ease-out |
| Rail group | grid row 0fr, opacity 0 | 1fr, opacity 1 | 200 ms ease-out |
| Group chevron | Closed angle | Open angle | 200 ms |
| Account chevron | Closed angle | Open angle | 300 ms canonical |
| Team/account menu | y about -4 px, opacity 0 | y 0, opacity 1 | 150 ms ease-out |
| Tree submenu | x -6 px, opacity 0 | x 0, opacity 1 | 200 ms canonical |
| Dialog scrim | opacity 0 | opacity 1 | 180 ms ease-out |
| Dialog panel | y 8, scale .97, blur 1, opacity 0 | settled | 180 ms canonical |
| Primary action | scale 1 | hover 1.015 / press .99 | 200 ms canonical |
| Compact select | scale 1 | hover 1.02 | 150 ms |
| Selection old value | y 0, opacity 1 | y -2, opacity 0 | 180 ms standard |
| Selection new value | y 2, opacity 0 | y 0, opacity 1 | 180 ms ease-out |
| Metric cards | small bottom slide and fade | settled | active animate-in plus 70 ms/item delay |
| Account, Team, Settings sections | bottom slide 16 px and fade | settled | 700 ms active animate-in |
| Team hierarchy nodes | fade with small zoom or left slide | settled | 400–500 ms active animate-in |
| Pipeline FLIP reorder | inverse old/new delta | transform 0 | 420 ms canonical |
| Pipeline count | y 85%, opacity 0 | y 0, opacity 1 | 360 ms canonical |
| Save rail | x -110% | x 170% | 900 ms infinite |
| Save sheen | x -135% | x 135% | 1150 ms infinite |
| Completion settle | scale 1 to 1.012 to 1 | scale 1 | 620 ms canonical |
| Completion wash | opacity 0 to 1 to 0 | opacity 0 | 580 ms canonical |
| Completion edges | axis scale 0 to 1, fade out | hidden | 430 ms, 0/90/180/270 delay |
| Client editor body | y 6, opacity 0 | settled | 220 ms canonical |
| Notes editor | y 5, opacity .58 | settled | 300 ms + 45 ms delay |
| Details panel | y -6, scale .992, blur 1 | settled | 260 ms canonical |
| Photo backdrop | opacity 0 | opacity 1 | 180 ms ease-out |
| Photo panel | y 8, scale .975, blur 2 | settled | 260 ms canonical |
| Photo media | scale .985, opacity 0 | scale 1, opacity 1 | 240 ms + 70 ms delay |
| Heatmap label | opacity 0 | opacity 1 | 200 ms ease |
| Typewriter | empty | complete text | 35 ms/character |
| Odometer | previous number | new number | 850 ms cubic ease-in-out |
| Account panels | previous view | edit/read view | 350 ms height + 250 ms crossfade |

### 8.3 Pipeline motion detail

The Clients pipeline is the most developed active motion system.

Reorder:

- Capture each card rectangle before state change.
- Measure new rectangles after render.
- Apply the inverse delta immediately.
- Animate transform back to zero over 420 ms.
- Skip spatial animation for reduced motion.

Saving:

- Top 1 px rail travels across the card.
- Diagonal low-opacity sheen crosses more slowly.
- Card keeps its dimensions and text.

Success:

- Card settles through a 1.012 scale peak.
- Brand-soft wash fades in and out once.
- Four edges trace in sequence at 90 ms intervals.
- The effect is local to the saved card.

Drop target:

- Scale 1.01.
- Brand-soft surface.
- 3 px brand/15 ring.
- 200 ms transition.

Dragged card:

- Opacity 55% on board cards.
- Grab/grabbing cursor.
- Inset brand hairline remains visible.

### 8.4 Reduced motion

globals.css applies:

- Animation duration 0.001 ms.
- One animation iteration.
- Transition duration 0.001 ms.
- Automatic scrolling instead of smooth scrolling.
- Pipeline edge traces hidden.
- Special editor/photo effects disabled.

Dialog, SelectionTransition, TypewriterText, and pipeline FLIP also query the preference in JavaScript.

For the IDE, apply the same preference to the odometer and any additional JavaScript-driven layout changes.

## 9. Active route patterns and IDE mappings

### 9.1 Home

Source: app/(dashboard)/home/HomeClient.tsx.

Layout:

- Quiet typewriter greeting.
- Left work queue occupies two columns at wide desktop widths.
- Right rail occupies one column.
- Today card.
- Needs you card with count.
- Quick actions card.
- Recent clients card.
- Admin link to full analytics.

Rows:

- Compact icon or time marker.
- 14 px primary label.
- 12 px supporting detail.
- Muted hover surface.
- Status badge aligned right.
- No per-row shadow.

IDE mapping:

- Today → current session and scheduled tasks.
- Needs you → diagnostics, conflicts, failed checks, approvals.
- Quick actions → New File, Open Project, Clone, Run.
- Recent clients → recent projects or editors.

### 9.2 Analytics

Source: app/(dashboard)/admin/DashboardClient.tsx and active dashboard widgets.

Structure:

- Analytics title and typewriter greeting.
- Hero revenue metric with sparkline.
- Deals and client metrics.
- Three-column visualization region at 1024 px and above.
- Revenue heatmap spans two columns.
- Pipeline funnel occupies one.
- Leaderboard and radial gauge form the lower row.

IDE mapping:

- Revenue → build duration, successful runs, or compute cost.
- Deals → completed tasks or deployments.
- Client pipeline → active projects or issues.
- Heatmap → commits, builds, or sessions.
- Funnel → CI or issue lifecycle.
- Gauge → coverage or deployment readiness.

### 9.3 Calendar

Sources: app/(dashboard)/calendar.

Structure:

- Quiet page header with visibility badge and actions.
- Four metric cards.
- Main calendar and 360 px agenda rail at 1280 px and above.
- Previous, Next, and Today controls.
- Month, Week, and Day mode buttons implemented through active dashboard control helpers.

Calendar geometry:

- Month: seven columns.
- Week: seven columns at standard desktop widths.
- Day: fixed 72 px time gutter.
- Today uses a solid brand circle.
- Event pills use brand-soft.
- Month cells show two visible appointments plus overflow count.

Agenda:

- Title and context.
- Type badge.
- Time with Clock.
- Assignee with UserRound.
- Location with MapPin.

IDE mapping:

- Scheduled builds, tests, releases, or automated runs.
- Agenda becomes upcoming tasks and background jobs.

### 9.4 Clients pipeline and project table

Source: app/(dashboard)/clients/ClientsClient.tsx.

Pipeline:

- Horizontal grid-flow-column track.
- Muted 35% board surface with 6 px internal padding.
- Independently scrolling columns.
- Column height range roughly 280–540 px.
- Compact cards.
- Solid colored stage headers.
- Animated counts.
- Drop-target state.
- Sort by activity, stage date, name, or value.

Client table:

- Fuse-powered search.
- Stage and assignee filters.
- Attention, recent, value, and name sorting.
- Sticky header.
- Minimum width 960 px.
- Columns: Client, Stage, Assigned, Next item, Updated, Value.
- Horizontal overflow when the window is narrower than the table.

IDE mapping:

- Pipeline → issue board, agent jobs, deployment stages.
- Table → projects, repositories, tasks, or build targets.

### 9.5 Client file workspace

Source: the active client-file dialog inside ClientsClient.tsx.

Geometry:

- Up to 1152 px wide.
- Up to 760 px high.
- Nearly full window height.
- At 1024 px and above: 290 px left metadata region plus fluid main surface.
- Main surface owns local vertical scrolling.

Behavior:

- Save action appears in the title area when dirty.
- Closing dirty content opens Keep editing, Discard changes, and Save file.
- Internal views: Overview, Work, Files, Activity.
- View content uses a 220 ms fade/slide entry.

Content:

- Editable project/client details.
- Stage checklist.
- Rich notes editor.
- Appointments and follow-ups.
- Inspection files and photos.
- Activity log.

IDE mapping:

- Left metadata region → outline, project metadata, branch/runtime/config.
- Main surface → editor.
- Overview/Work/Files/Activity → project summary, tasks, resources, timeline.
- Preserve the unsaved-close decision flow.

### 9.6 Files

Source: app/(dashboard)/files/FilesClient.tsx.

Workspace:

- Quiet route header.
- Search.
- Upload action.
- Desktop table with file type, title, context, access, date, and actions.
- Active selection uses brand-soft.

Upload:

- Multi-file drag/drop.
- Staged file list.
- Determinate progress.
- Remove controls.
- Access options for everyone, roles, or selected users.
- Drop zone transitions border, background, scale, and shadow over 300 ms.

Viewer:

- Large dialog.
- At 1024 px and above: 270 px metadata region plus preview.
- Supports images, PDFs, document frames, and fallback download.
- Tree menus handle access roles/users and labels.
- Share dialog exposes an internal deep link and copy feedback.

IDE mapping:

- Explorer/import flow.
- Editor with metadata or outline region.
- Deep link to file, line, symbol, or session.

### 9.7 Production

Source: app/(dashboard)/production/ProductionClient.tsx.

Structure:

- Page header with role/visibility badges.
- Four metrics.
- Search and stage filters.
- Job-card grid.
- 360 px selected-job detail rail at 1024 px and above.

Card behavior:

- Hover lifts 2 px and raises shadow.
- Selected card receives brand border/ring.
- Detail rail shows status, location, assignment, value, warnings, and legal next actions.
- Saving action replaces ArrowRight with Loader2.
- Completion uses CheckCircle2.

IDE mapping:

- Jobs → builds, runs, processes, deployments.
- Detail rail → run inspector.
- Stage actions → retry, cancel, promote, deploy.

### 9.8 Reports

Source: app/(dashboard)/reports/ReportsClient.tsx.

Structure:

- Quiet header with admin badge and result count.
- At 1280 px and above: 340 px report builder plus fluid results.
- Four explicit builder steps: type, scope, filters, output.
- Active options use brand tint and Check.
- Results begin with four summary tiles.
- Output becomes chart or table.
- Wide result table minimum width: 680 px.

IDE mapping:

- Diagnostics/profiler query builder.
- Type → Performance, Dependencies, Coverage.
- Scope → File, Project, Workspace.
- Filters → language, package, branch, severity.
- Output → chart or table.

### 9.9 Team

Sources: app/(dashboard)/team/TeamClient.tsx and team/settings/TeamSettingsClient.tsx.

Members:

- Team count and actions.
- Organization hierarchy.
- Role and status filters.
- Search.
- Sortable member table.
- Expandable detail rows.
- Inline roles, subteams, lead assignment, enable/disable, and removal.
- Bulk activation and deletion.
- Add-member anchored panel with comma/newline email parsing and per-email outcomes.

Team settings:

- Narrow focused page.
- Team identity card.
- 48 px generated team avatar.
- Team name field.
- Saved/dirty state.
- Shader picker in a dialog.
- Apply action appears only when selection differs.

IDE mapping:

- Collaborators, agents, code owners, and workspace access.
- Organization hierarchy → service or agent hierarchy.

### 9.10 Billing settings

Source: app/(dashboard)/settings/SettingsClient.tsx.

Structure:

- Subscription card.
- Plan and seat usage.
- Price and next payment.
- Upgrade, downgrade, and cancel actions.
- Payment methods.
- Invoice table.

Active patterns:

- Three-column subscription summary.
- 6 px usage tracks.
- Anchored confirmation cards.
- Inline payment form.
- Sticky invoice header.
- Status badges.

IDE mapping:

- License, collaborator seats, compute allowance, or usage budget.

### 9.11 Account

Source: app/(dashboard)/account/AccountClient.tsx.

Structure:

- Personal information.
- Company/workspace information.
- Password/security.

Interaction:

- Read and edit modes share the same card.
- Container height changes over 350 ms.
- Old view fades/translates out over 250 ms.
- New view fades/translates in with about 100 ms delay.
- Service area uses delayed autocomplete.
- Password uses Eye/EyeOff.
- Success and error remain inline.

IDE mapping:

- Profile, workspace identity, and security preferences.

## 10. Icon system

### 10.1 Rules

The active desktop system uses Lucide icons and currentColor.

- Primary chrome/navigation: 17–18 px.
- Nested navigation: 14 px.
- Standard actions: 14–16 px.
- Badge icons: 12 px.
- Empty workbench: 44 px.
- Default stroke: 1.5.
- Command result stroke: 1.6–1.75.
- Empty workbench stroke: 1.25.
- Object/command tiles are usually 32–40 px with 8–12 px radius.
- Back, forward, chevrons, close, search, and toolbar icons remain unboxed.
- Status pairs icon with text.
- Icon-only controls require accessible names and useful titles.

### 10.2 Route icons

| Active route/group | Icon | IDE mapping |
| --- | --- | --- |
| Home | House | Start |
| Sales / Clients | ContactRound | Projects |
| Calendar | CalendarDays | Scheduler |
| Documents / Files | FolderOpen | Explorer |
| Production | HardHat | Run/Build |
| Insights / Analytics | BarChart3 | Profiler |
| Reports | FileChartColumn | Diagnostics |
| Team / Members | UsersRound | Collaboration |
| Team settings | SlidersHorizontal | Workspace settings |
| Billing | Settings2 | License/usage |
| Account | CircleUserRound | Profile |

### 10.3 Workbench chrome

| Action | Icon |
| --- | --- |
| Collapse rail | PanelLeftClose |
| Expand rail | PanelLeftOpen |
| Search | Search |
| History back | ArrowLeft |
| History forward | ArrowRight |
| New tab | Plus |
| Close tab/dialog | X |
| Empty workbench | PanelsTopLeft |
| Loading | LoaderCircle or Loader2 |
| Open/activate key | CornerDownLeft |

### 10.4 Active sidebar and palette icons

Sidebar/account:

- ChevronDown and ChevronUp.
- UserPlus.
- SlidersHorizontal.
- Check.
- Loader2.
- Plus.
- Moon.
- UserPen.
- LogOut.

Command palette:

- ArrowDown and ArrowUp.
- CalendarPlus.
- CornerDownLeft.
- FileUp.
- Plus.
- Search.
- UserPlus.
- Current route icons.

### 10.5 Active content vocabulary

Files and artifacts:

- File, FileText, FileSpreadsheet, FolderOpen.
- FileUp, UploadCloud, Download.
- Copy, Share2, Trash2.
- Image, Camera.

Editing:

- Bold, Italic, Underline, Strikethrough.
- List, ListOrdered, ListChecks.
- Code2, Quote, Link.
- Pencil, Check, X.

Data and workflow:

- Filter, ArrowDownWideNarrow, ArrowUpDown.
- Clock, Calendar, CalendarClock.
- CircleDollarSign, Calculator.
- TrendingUp, TrendingDown.
- AlertCircle, AlertTriangle, CheckCircle2.
- ShieldCheck, ShieldOff, Lock.

People and communication:

- User, UserRound, Users, UsersRound.
- Mail, Phone, MapPin.
- MessageSquare.

### 10.6 Product and team marks

ScopeMark:

- Inline currentColor SVG.
- Three faceted planes.
- Plane opacities 1, .8, and .62.
- Inherits foreground from context.

TeamAvatar:

- Deterministic gradient canvas.
- Tenant-seeded.
- Current shader choice.
- Decorative when adjacent name supplies the accessible identity.

Replace the product mark for the IDE. Preserve the currentColor implementation idea.

## 11. Accessibility

### 11.1 Active behavior to preserve

- Semantic buttons and links.
- Named icon-only controls.
- aria-current for active navigation.
- tablist, tab, and aria-selected for editor tabs.
- aria-grabbed during pointer tab reorder.
- aria-expanded and aria-controls for rail groups.
- menu, menuitem, and menuitemcheckbox for team/account menus.
- combobox, listbox, option, and aria-activedescendant in the command palette.
- role dialog and aria-modal in dialogs.
- role status and aria-live polite in route loading.
- Decorative icons hidden from the accessibility tree.
- Focus-visible rings on active controls.
- Tabular figures for stable numeric reading.
- Status icon and text in addition to color.
- Global and component-level reduced motion.

### 11.2 Improvements required for the IDE

- Trap focus inside dialogs.
- Restore focus to the triggering control on close.
- Lock background scrolling when a dialog is open.
- Add keyboard commands for Move Tab Left and Move Tab Right.
- Give custom Select full arrow-key option traversal and typeahead.
- Ensure hidden menu/group content leaves the focus order.
- Prevent typewriter and odometer intermediate values from being announced.
- Add aria-keyshortcuts for command palette and common editor actions.
- Keep icon action targets at least 24 × 24 px.

## 12. Desktop window behavior

The current persistent workbench begins at 768 px. Treat that as the minimum documented desktop width.

### 12.1 Shell behavior

- Rail stays binary: 236 px or 72 px.
- There is no active free-width rail drag.
- Header left region and content padding always match the rail.
- Editor tabs absorb narrower windows through horizontal overflow.
- Tabs never wrap.
- Command palette is full available width up to 600 px with 16 px viewport inset.
- Result list remains capped at 380 px height.

### 12.2 Active desktop reflow

| Width | Active changes |
| --- | --- |
| 768 px and above | Persistent rail and inset rounded canvas |
| 1024 px and above | Three-up metrics; client workspace 290 px + fluid editor; file viewer 270 px + preview; production content + 360 px detail |
| 1280 px and above | Four-up metrics; calendar content + 360 px agenda; reports 340 px builder + results |

Wide data:

- Client table minimum width: 960 px.
- Report table minimum width: 680 px.
- Horizontal scrolling preserves columns.
- Sticky headers stay inside the table scroll surface.

Height:

- Root never scrolls.
- Content canvas scrolls.
- Pipeline columns can scroll independently.
- Editor metadata and main content can scroll independently.
- min-height zero must survive through flex and grid ancestors.

## 13. Active skills and technology

### 13.1 Design skills visible in the active workbench

- Desktop workbench composition.
- Role-aware information architecture.
- Semantic light/dark token design.
- Dense typography and spacing hierarchy.
- Editor-tab interaction design.
- Navigation rail collapse behavior.
- Command-palette design.
- Status and permission-state design.
- Loading, empty, error, disabled, selected, drag, and success states.
- Progressive disclosure through groups, menus, dialogs, and editor regions.
- Data visualization and dense tables.
- Desktop-adaptive layout across standard and wide windows.

### 13.2 Interaction and motion skills

- Consistent spatial easing.
- Mount/unmount dialog transitions.
- FLIP reordering.
- Pointer movement thresholds.
- Keyboard command navigation.
- Contextual route prefetching and loading.
- Numeric and value transitions.
- Staged save and completion feedback.
- Reduced-motion fallbacks.
- Stable geometry during asynchronous work.

### 13.3 Accessibility skills

- Semantic ARIA for tabs, menus, listboxes, dialogs, loading, and selection.
- Visible keyboard focus.
- Accessible icon-only controls.
- Color-independent status.
- Reduced-motion support.
- Role/capability filtering that removes unavailable actions.

### 13.4 Active front-end technology

- Next.js 16.1.6.
- React 19.2.3.
- TypeScript 5.
- Tailwind CSS 4.
- shadcn stylesheet conventions.
- Base UI button primitive.
- Class Variance Authority.
- clsx and tailwind-merge.
- tw-animate-css for active animate-in utilities.
- Lucide React.
- Fuse.js for active fuzzy search.
- Recharts for active chart composition.
- PixiJS for the active analytics funnel.
- @outpacelabs/avatars for team identity.

### 13.5 Engineering techniques

- Client/server component separation.
- Typed component variants.
- Central role/capability registry.
- CSS custom properties and semantic tokens.
- Designed dark mode.
- Pointer and keyboard event coordination.
- MutationObserver and animation-frame route readiness.
- Local layout measurement for FLIP.
- Drag/drop file staging and determinate progress.
- CurrentColor SVG theming.
- Effect cleanup and timer cleanup.
- Local storage for appearance and known accounts.

### 13.6 Validation used for this guide

- Source audit of actively imported desktop workbench files.
- Active component import/use audit.
- Exact token, icon, and motion extraction.
- Optimized Next.js production build.
- Logged-in browser inspection of expanded/collapsed rail, editor tabs, Home, and command palette.

## 14. IDE translation architecture

The current workbench maps directly to a compact IDE foundation without inventing new chrome.

| Active Scope component | IDE responsibility |
| --- | --- |
| DashboardShell | WorkbenchShell |
| DashboardHeader | EditorTabStrip and global history/search controls |
| AppSidebar | ProjectNavigator |
| Main content canvas | EditorSurface |
| CommandPalette | CommandRunner / Quick Open |
| WorkspacePageLoading | EditorLoading / indexing state |
| EmptyWorkspaceTabs | EmptyEditor |
| Client file workspace | Project editor with metadata region |
| TreeMenu | Explorer and nested selection menus |
| Production detail rail | RunInspector |
| Team views | Collaboration and access |

Suggested structure:

    components/ide/
    ├── WorkbenchShell.tsx
    ├── WorkbenchHeader.tsx
    ├── ProjectNavigator.tsx
    ├── EditorTabStrip.tsx
    ├── EditorSurface.tsx
    ├── CommandRunner.tsx
    ├── EmptyEditor.tsx
    ├── EditorLoading.tsx
    ├── ProjectMetadata.tsx
    └── RunInspector.tsx

    components/ui/
    ├── button.tsx
    ├── input.tsx
    ├── dialog.tsx
    ├── card.tsx
    ├── badge.tsx
    ├── table.tsx
    ├── avatar.tsx
    ├── file-type-badge.tsx
    ├── selection-transition.tsx
    └── tree-menu.tsx

### 14.1 Current tab state model

The active shell requires:

    type WorkbenchTab = {
      id: string
      label: string
      tabLabel: string
      href: string
      icon: IconType
      permission: RouteCapability | null
    }

    type WorkbenchState = {
      tabs: WorkbenchTab[]
      activeTabId: string | null
      pendingTabId: string | null
      railCollapsed: boolean
      commandOpen: boolean
      tabPickerOpen: boolean
    }

Port the active rules:

- One tab per destination/resource.
- Register before navigation.
- Mark pending immediately.
- Prefetch before route replacement.
- Reorder only after a 6 px threshold.
- Close active to nearest stable neighbor.
- Permit zero tabs.
- Preserve loading geometry until rendered content exists.

### 14.2 Theme contract

Use semantic variables in all new IDE components:

    --workbench-canvas: #eef0f4
    --workbench-surface: #ffffff
    --workbench-muted: #f4f6f8
    --workbench-ink: #070419
    --workbench-ink-secondary: #4b5057
    --workbench-ink-muted: #686e78
    --workbench-border: rgba(14,16,19,0.08)
    --brand: #4c5b83
    --brand-strong: #3d4a6d
    --brand-soft: #eef2f8
    --brand-on-soft: #3d4a6d
    --success: #2e9e6b
    --warning: #e0a53c
    --danger: #e5484d

Do not name components after colors. Use PrimaryButton, ActiveTab, InfoBadge, and DestructiveAction.

### 14.3 Motion contract

Recommended shared values are direct extractions from the active workbench:

    fast: 150 ms
    standard: 200 ms
    spatial: 300 ms
    dialog: 180 ms
    settle: cubic-bezier(.22,1,.36,1)
    enterOffset: 6 px
    dialogOffset: 8 px
    pressScale: .99
    hoverScale: 1.015

Use CSS transitions for routine color and small transform changes. Use the active local FLIP approach when list reordering needs spatial continuity.

## 15. Implementation order

1. Create semantic light/dark variables and replace the accent ramp.
2. Build the full-window shell and inset editor canvas.
3. Implement the 236/72 px rail and synchronized header/content transition.
4. Build the 44 px header and 32 px editor-tab strip.
5. Implement open, close, reorder, history, and zero-tab state.
6. Port the command palette geometry and keyboard behavior.
7. Port active shared primitives: button, field/select, card, badge, dialog, table, avatar, file badge, selection transition, and tree menu.
8. Port contextual loading that clears only after rendered editor content exists.
9. Build a project table and editor workspace from Clients.
10. Build Explorer/import/viewer patterns from Files.
11. Build run cards and detail rail from Production.
12. Build diagnostics/report filtering from Reports.
13. Build collaboration/access from Team.
14. Validate focus, keyboard input, dark mode, reduced motion, and desktop window resizing.

## 16. Color replacement procedure

1. Build a new 50–950 accent ramp with similar perceptual spacing.
2. Map brand, brand-emphasis, brand-soft, and brand-soft-foreground for light mode.
3. Design separate dark-mode values.
4. Update focus ring.
5. Update text selection tint.
6. Update active rail and editor selection.
7. Update chart series that intentionally use the brand family.
8. Check contrast for solid-brand text and brand-soft text.
9. Test selected, hover, and focus-visible simultaneously.

Keep success, warning, and destructive families independent from the new brand.

## 17. Quality checklist

### Visual

- [ ] Workbench canvas is distinct from the editor canvas.
- [ ] Main canvas uses one hairline and shadow-sm.
- [ ] Rail width aligns exactly with header controls and main padding.
- [ ] Active editor tab is clear without a saturated full tab.
- [ ] Icons follow the size and stroke system.
- [ ] Dense rows use type and spacing instead of extra card chrome.
- [ ] Status always includes text or icon in addition to color.
- [ ] Dark mode uses designed semantic values.

### Interaction

- [ ] Command/Ctrl+K opens and focuses the command palette.
- [ ] Arrow keys, Enter, and Escape work.
- [ ] Tabs open, close, reorder, and support zero open tabs.
- [ ] Tab drag begins only after the threshold.
- [ ] Loading preserves canvas geometry.
- [ ] Save feedback runs once.
- [ ] Menus visually join their triggers where designed.
- [ ] Pointer and keyboard selection stay synchronized.

### Accessibility

- [ ] Focus order follows visual order.
- [ ] Dialog focus is trapped and restored.
- [ ] Focus-visible rings meet contrast requirements.
- [ ] Icon-only actions have names and titles.
- [ ] Reduced motion removes transforms and repeating effects.
- [ ] Animated text exposes only the final accessible value.
- [ ] Tab reorder has a keyboard command.

### Desktop window behavior

- [ ] Persistent workbench remains usable from 768 px upward.
- [ ] Tabs scroll and never wrap.
- [ ] Command palette retains 16 px window inset.
- [ ] Tables scroll horizontally at their minimum width.
- [ ] Standard and wide layouts switch at 1024 and 1280 px.
- [ ] Nested scroll surfaces do not force the document to scroll.

### Performance

- [ ] Continuous animation uses transform and opacity.
- [ ] Hidden route content does not perform unnecessary work.
- [ ] Loading clears on rendered content, not navigation intent.
- [ ] Large trees and lists can be virtualized for IDE-scale data.
- [ ] Timers, observers, and pointer listeners are cleaned up.

## 18. Active source index

### Tokens and fonts

- salesview-web/app/globals.css
- salesview-web/app/layout.tsx

### Workbench shell

- salesview-web/components/dashboard/DashboardShell.tsx
- salesview-web/components/dashboard/DashboardHeader.tsx
- salesview-web/components/dashboard/AppSidebar.tsx
- salesview-web/components/dashboard/CommandPalette.tsx
- salesview-web/components/dashboard/WorkspacePageLoading.tsx
- salesview-web/components/dashboard/WorkspaceRouteMarker.tsx
- salesview-web/lib/dashboardNavigation.ts

### Active shared components

- salesview-web/components/ui/ScopeLogo.tsx
- salesview-web/components/ui/team-avatar.tsx
- salesview-web/components/ui/avatar.tsx
- salesview-web/components/ui/button.tsx
- salesview-web/components/ui/button-effects.ts
- salesview-web/components/ui/input.tsx
- salesview-web/components/ui/dialog.tsx
- salesview-web/components/ui/card.tsx
- salesview-web/components/ui/badge.tsx
- salesview-web/components/ui/status-badge.tsx
- salesview-web/components/ui/table.tsx
- salesview-web/components/ui/file-type-badge.tsx
- salesview-web/components/ui/selection-transition.tsx
- salesview-web/components/ui/tree-menu.tsx
- salesview-web/components/ui/text-style-dropdown.tsx
- salesview-web/components/ui/notes-toolbar-state.ts
- salesview-web/components/ui/typewriter-text.tsx
- salesview-web/components/ui/OdometerNumber.tsx
- salesview-web/components/ui/Sparkline.tsx

### Active dashboard components

- salesview-web/components/dashboard/DashboardPageShell.tsx
- salesview-web/components/dashboard/DashboardMetricCard.tsx
- salesview-web/components/dashboard/dashboardControls.ts
- salesview-web/components/dashboard/HomeMetrics.tsx
- salesview-web/components/dashboard/RevenueCalendarHeatmap.tsx
- salesview-web/components/dashboard/PipelineFunnel.tsx
- salesview-web/components/dashboard/InspectorLeaderboard.tsx
- salesview-web/components/dashboard/PipelineValueGauge.tsx
- salesview-web/components/clients/AddClientDialog.tsx

### Active authenticated routes

- salesview-web/app/(dashboard)/home/HomeClient.tsx
- salesview-web/app/(dashboard)/admin/DashboardClient.tsx
- salesview-web/app/(dashboard)/calendar/CalendarClient.tsx
- salesview-web/app/(dashboard)/calendar/CalendarGrids.tsx
- salesview-web/app/(dashboard)/calendar/CalendarSidebar.tsx
- salesview-web/app/(dashboard)/calendar/CreateEventDialog.tsx
- salesview-web/app/(dashboard)/clients/ClientsClient.tsx
- salesview-web/app/(dashboard)/files/FilesClient.tsx
- salesview-web/app/(dashboard)/production/ProductionClient.tsx
- salesview-web/app/(dashboard)/reports/ReportsClient.tsx
- salesview-web/app/(dashboard)/team/TeamClient.tsx
- salesview-web/app/(dashboard)/team/settings/TeamSettingsClient.tsx
- salesview-web/app/(dashboard)/settings/SettingsClient.tsx
- salesview-web/app/(dashboard)/account/AccountClient.tsx

## Final rule

If a new screen feels plain, improve hierarchy before adding decoration. If it feels busy, remove a surface or accent before reducing useful information. The recognizable Scope quality comes from quiet chrome, exact state transitions, stable geometry, and a few carefully chosen moments of motion—not from the current slate-blue accent.
