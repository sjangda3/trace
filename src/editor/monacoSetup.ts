import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import TypeScriptWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

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

export function configureMonaco() {
  if (configured) return monaco;
  configured = true;

  monaco.editor.defineTheme("trace-light", {
    base: "vs",
    inherit: true,
    rules: [
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
    colors: {
      "editor.background": "#FFFFFF",
      "editor.foreground": "#4F5358",
      "editorLineNumber.foreground": "#8B8E94",
      "editorLineNumber.activeForeground": "#303238",
      "editor.lineHighlightBackground": "#E9EBEF",
      "editor.lineHighlightBorder": "#00000000",
      "editorCursor.foreground": "#5D6871",
      "editor.selectionBackground": "#DCE8F2",
      "editor.inactiveSelectionBackground": "#E8EFF4",
      "editor.selectionHighlightBackground": "#E7EEF3AA",
      "editor.wordHighlightBackground": "#E4EBF0AA",
      "editor.wordHighlightStrongBackground": "#D9E4ECAA",
      "editorIndentGuide.background1": "#EDF0F2",
      "editorIndentGuide.activeBackground1": "#D3DADF",
      "editorWhitespace.foreground": "#D8DDE1",
      "editorBracketMatch.background": "#E7EEF3",
      "editorBracketMatch.border": "#9EB4C6",
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
      "focusBorder": "#5D86AE66",
    },
  });

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
