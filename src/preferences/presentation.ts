import type {
  Accent,
  CodeSize,
  ResolvedAppearance,
} from "./types";

export function editorMetrics(codeSize: CodeSize) {
  const fontSize = codeSize === "small" ? 13 : codeSize === "large" ? 16 : 14;
  return { fontSize, lineHeight: Math.round(fontSize * 1.43) };
}

export function terminalMetrics(codeSize: CodeSize) {
  return { fontSize: Math.max(10, editorMetrics(codeSize).fontSize - 2), lineHeight: 1.45 };
}

export function monacoThemeName(appearance: ResolvedAppearance, accent: Accent) {
  return `trace-${appearance}-${accent}`;
}

/** Stable base names retained for integrations that expect a light/dark pair. */
export function baseMonacoThemeName(appearance: ResolvedAppearance) {
  return `trace-${appearance}`;
}

const accents: Record<Accent, { cursor: string; selectionLight: string; selectionDark: string }> = {
  cobalt: { cursor: "#5d86ae", selectionLight: "#dce8f2", selectionDark: "#254664" },
  violet: { cursor: "#806ab0", selectionLight: "#ebe5f5", selectionDark: "#44385c" },
  teal: { cursor: "#3f8a87", selectionLight: "#dcefed", selectionDark: "#244b4b" },
  amber: { cursor: "#a57a3c", selectionLight: "#f3ead8", selectionDark: "#584323" },
  rose: { cursor: "#ad6876", selectionLight: "#f4e3e6", selectionDark: "#5d3540" },
};

export function accentColor(accent: Accent) {
  return accents[accent].cursor;
}

export function terminalPalette(
  appearance: ResolvedAppearance,
  accent: Accent,
) {
  const tone = accents[accent];
  if (appearance === "dark") {
    return {
      background: "#00000000",
      foreground: "#d8e0e8",
      cursor: tone.cursor,
      cursorAccent: "#111820",
      selectionBackground: tone.selectionDark,
      black: "#293541",
      red: "#df8d8a",
      green: "#9bc59b",
      yellow: "#dfb47b",
      blue: "#8fb9df",
      magenta: "#b6a1d4",
      cyan: "#8abfc0",
      white: "#d8e0e8",
      brightBlack: "#72808d",
      brightRed: "#f0a39e",
      brightGreen: "#b5dbb5",
      brightYellow: "#ebc694",
      brightBlue: "#a9c9e9",
      brightMagenta: "#c7b7df",
      brightCyan: "#a8d2d2",
      brightWhite: "#f4f7fa",
    };
  }
  return {
    background: "#00000000",
    foreground: "#51575c",
    cursor: tone.cursor,
    cursorAccent: "#fcfcfb",
    selectionBackground: tone.selectionLight,
    black: "#4f5358",
    red: "#9a6558",
    green: "#657f5c",
    yellow: "#927050",
    blue: "#4f7192",
    magenta: "#7c6c8c",
    cyan: "#5d7790",
    white: "#e8eaeb",
    brightBlack: "#8b9197",
    brightRed: "#a86d60",
    brightGreen: "#67835f",
    brightYellow: "#a07e56",
    brightBlue: "#6686a2",
    brightMagenta: "#8d789b",
    brightCyan: "#6f8e9e",
    brightWhite: "#ffffff",
  };
}
