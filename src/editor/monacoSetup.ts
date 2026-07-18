import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import TypeScriptWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { baseMonacoThemeName, monacoThemeName } from "../preferences/presentation";
import type { Accent, ResolvedAppearance } from "../preferences/types";

type MonacoWorkerEnvironment = {
  getWorker: (_moduleId: string, label: string) => Worker;
};

const workerScope = self as typeof self & {
  MonacoEnvironment?: MonacoWorkerEnvironment;
};

workerScope.MonacoEnvironment = {
  getWorker: (_moduleId, label) => {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TypeScriptWorker();
    return new EditorWorker();
  },
};

let configured = false;

const accents: Record<Accent, { cursor: string; selection: string; inactiveSelection: string; focus: string }> = {
  cobalt: { cursor: "5D86AE", selection: "DCE8F2", inactiveSelection: "E8EFF4", focus: "5D86AE66" },
  violet: { cursor: "806AB0", selection: "EBE5F5", inactiveSelection: "F1EDF7", focus: "806AB066" },
  teal: { cursor: "3F8A87", selection: "DCEFED", inactiveSelection: "E8F4F2", focus: "3F8A8766" },
  amber: { cursor: "A57A3C", selection: "F3EAD8", inactiveSelection: "F7F0E4", focus: "A57A3C66" },
  rose: { cursor: "AD6876", selection: "F4E3E6", inactiveSelection: "F8ECEE", focus: "AD687666" },
};

function defineTraceTheme(
  appearance: ResolvedAppearance,
  accent: Accent,
  name = monacoThemeName(appearance, accent),
) {
  const tone = accents[accent];
  const dark = appearance === "dark";
  monaco.editor.defineTheme(name, {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: dark ? [
      { token: "", foreground: "D8E0E8", background: "141B22" },
      { token: "comment", foreground: "7C8792", fontStyle: "" },
      { token: "keyword", foreground: "E0A092" },
      { token: "keyword.flow", foreground: "E0A092" },
      { token: "string", foreground: "8DBBDA" },
      { token: "string.escape", foreground: "A4C9E2" },
      { token: "number", foreground: "DAB37D" },
      { token: "type", foreground: "B7A5D4" },
      { token: "type.identifier", foreground: "B7A5D4" },
      { token: "identifier", foreground: "D8E0E8" },
      { token: "function", foreground: "A9C690" },
      { token: "delimiter", foreground: "A6B0BA" },
      { token: "tag", foreground: "E0A092" },
      { token: "attribute.name", foreground: "B7A5D4" },
      { token: "attribute.value", foreground: "8DBBDA" },
      { token: "variable", foreground: "D8E0E8" },
      { token: "regexp", foreground: "A3C691" },
    ] : [
      { token: "", foreground: "4F5358", background: "FFFFFF" },
      { token: "comment", foreground: "8B9197", fontStyle: "" },
      { token: "keyword", foreground: "9B5F50" },
      { token: "keyword.flow", foreground: "9B5F50" },
      { token: "string", foreground: "4F7192" },
      { token: "string.escape", foreground: "6686A2" },
      { token: "number", foreground: "927050" },
      { token: "type", foreground: "705A80" },
      { token: "type.identifier", foreground: "705A80" },
      { token: "identifier", foreground: "4F5358" },
      { token: "function", foreground: "617354" },
      { token: "delimiter", foreground: "73797F" },
      { token: "tag", foreground: "9B5F50" },
      { token: "attribute.name", foreground: "705A80" },
      { token: "attribute.value", foreground: "4F7192" },
      { token: "variable", foreground: "4F5358" },
      { token: "regexp", foreground: "66815B" },
    ],
    colors: dark ? {
      "editor.background": "#141B22",
      "editor.foreground": "#D8E0E8",
      "editorLineNumber.foreground": "#74808B",
      "editorLineNumber.activeForeground": "#D8E0E8",
      "editor.lineHighlightBackground": "#1B2630",
      "editor.lineHighlightBorder": "#00000000",
      "editorCursor.foreground": `#${tone.cursor}`,
      "editor.selectionBackground": `#${tone.selection}`,
      "editor.inactiveSelectionBackground": `#${tone.inactiveSelection}`,
      "editor.selectionHighlightBackground": "#263542AA",
      "editor.wordHighlightBackground": "#273742AA",
      "editor.wordHighlightStrongBackground": "#314451AA",
      "editorIndentGuide.background1": "#25323D",
      "editorIndentGuide.activeBackground1": "#405260",
      "editorWhitespace.foreground": "#34424D",
      "editorBracketMatch.background": "#283947",
      "editorBracketMatch.border": `#${tone.cursor}`,
      "editor.findMatchBackground": "#6F582F99",
      "editor.findMatchHighlightBackground": "#7D663B66",
      "editorHoverWidget.background": "#1B242D",
      "editorHoverWidget.border": "#34424E",
      "editorSuggestWidget.background": "#1B242D",
      "editorSuggestWidget.border": "#34424E",
      "editorSuggestWidget.selectedBackground": "#263846",
      "editorWidget.background": "#1B242D",
      "editorWidget.border": "#34424E",
      "scrollbarSlider.background": "#B3C0CC2C",
      "scrollbarSlider.hoverBackground": "#B3C0CC44",
      "scrollbarSlider.activeBackground": "#B3C0CC60",
      "focusBorder": `#${tone.focus}`,
    } : {
      "editor.background": "#FFFFFF",
      "editor.foreground": "#4F5358",
      "editorLineNumber.foreground": "#8B8E94",
      "editorLineNumber.activeForeground": "#303238",
      "editor.lineHighlightBackground": "#E9EBEF",
      "editor.lineHighlightBorder": "#00000000",
      "editorCursor.foreground": `#${tone.cursor}`,
      "editor.selectionBackground": `#${tone.selection}`,
      "editor.inactiveSelectionBackground": `#${tone.inactiveSelection}`,
      "editor.selectionHighlightBackground": "#E7EEF3AA",
      "editor.wordHighlightBackground": "#E4EBF0AA",
      "editor.wordHighlightStrongBackground": "#D9E4ECAA",
      "editorIndentGuide.background1": "#EDF0F2",
      "editorIndentGuide.activeBackground1": "#D3DADF",
      "editorWhitespace.foreground": "#D8DDE1",
      "editorBracketMatch.background": "#E7EEF3",
      "editorBracketMatch.border": `#${tone.cursor}`,
      "editor.findMatchBackground": "#EBCF8F88",
      "editor.findMatchHighlightBackground": "#F2E2B766",
      "editorHoverWidget.background": "#FFFFFF",
      "editorHoverWidget.border": "#D8DEE3",
      "editorSuggestWidget.background": "#FFFFFF",
      "editorSuggestWidget.border": "#D8DEE3",
      "editorSuggestWidget.selectedBackground": "#E8F0F7",
      "editorWidget.background": "#FFFFFF",
      "editorWidget.border": "#D8DEE3",
      "scrollbarSlider.background": "#58636B33",
      "scrollbarSlider.hoverBackground": "#58636B44",
      "scrollbarSlider.activeBackground": "#58636B55",
      "focusBorder": `#${tone.focus}`,
    },
  });
}

export function configureMonaco() {
  if (configured) return monaco;
  configured = true;

  for (const appearance of ["light", "dark"] as const) {
    for (const accent of Object.keys(accents) as Accent[]) {
      defineTraceTheme(appearance, accent);
    }
    // Keep canonical names alongside accent-aware variants. Cobalt is the
    // default accent, so these aliases remain stable without changing syntax.
    defineTraceTheme(appearance, "cobalt", baseMonacoThemeName(appearance));
  }

  // Monaco has no project-wide TypeScript context yet, so semantic diagnostics
  // would flag valid cross-file imports and app globals as false positives.
  // Syntax diagnostics remain enabled; the real language-server layer will
  // replace this once workspace processes are connected.
  const typeScriptLanguage = monaco.languages.typescript as unknown as {
    typescriptDefaults?: {
      setDiagnosticsOptions: (options: Record<string, unknown>) => void;
      setEagerModelSync: (enabled: boolean) => void;
    };
    javascriptDefaults?: {
      setDiagnosticsOptions: (options: Record<string, unknown>) => void;
      setEagerModelSync: (enabled: boolean) => void;
    };
  };
  for (const defaults of [typeScriptLanguage.typescriptDefaults, typeScriptLanguage.javascriptDefaults]) {
    defaults?.setEagerModelSync(true);
    defaults?.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSuggestionDiagnostics: true,
      noSyntaxValidation: false,
    });
  }

  return monaco;
}

export { monaco };
