import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  type MutableRefObject,
} from "react";
import { configureMonaco, monaco } from "./monacoSetup";
import { accentColor, editorMetrics, monacoThemeName } from "../preferences/presentation";
import type { Accent, CodeSize, ResolvedAppearance } from "../preferences/types";

export type CursorPosition = {
  line: number;
  column: number;
};

export type EditorReviewRange = {
  startLine: number;
  endLine?: number;
};

export type EditorSelectionRange = {
  startLine: number;
  endLine: number;
};

export type EditorTextRange = {
  startLine: number;
  startColumn: number;
  endLine?: number;
  endColumn: number;
};

export type MonacoEditorHandle = {
  focus: () => void;
  find: () => void;
  goToNextProblem: () => void;
  openCommandPalette: () => void;
  resetZoom: () => void;
  toggleWordWrap: () => void;
  getSelectionRange: () => EditorSelectionRange | null;
  focusTextRange: (range: EditorTextRange) => void;
  focusReviewRange: (range: EditorReviewRange) => void;
  clearReviewRange: () => void;
};

type MonacoEditorProps = {
  workspaceId: string;
  activePath: string | null;
  value: string;
  language: string;
  openPaths: string[];
  readOnly?: boolean;
  resolvedAppearance: ResolvedAppearance;
  accent: Accent;
  codeSize: CodeSize;
  onChange: (path: string, value: string) => void;
  onCursorChange?: (position: CursorPosition) => void;
};

function opaqueWorkspaceSegment(workspaceId: string): string {
  let bytesAsText = "";
  for (const byte of new TextEncoder().encode(workspaceId)) {
    bytesAsText += String.fromCharCode(byte);
  }
  return btoa(bytesAsText)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "") || "workspace";
}

function modelUri(workspaceId: string, path: string) {
  const workspace = opaqueWorkspaceSegment(workspaceId);
  const normalized = path.split("/").filter(Boolean).join("/") || "untitled";
  return monaco.Uri.from({
    scheme: "trace-file",
    authority: "workspace",
    path: `/${workspace}/${normalized}`,
  });
}

function runEditorAction(
  editorRef: MutableRefObject<monaco.editor.IStandaloneCodeEditor | null>,
  actionId: string,
) {
  void editorRef.current?.getAction(actionId)?.run();
}

export const MonacoEditor = forwardRef<MonacoEditorHandle, MonacoEditorProps>(
  function MonacoEditor(
    {
      workspaceId,
      activePath,
      value,
      language,
      openPaths,
      readOnly = false,
      resolvedAppearance,
      accent,
      codeSize,
      onChange,
      onCursorChange,
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
    const reviewDecorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
    const currentPathRef = useRef<string | null>(activePath);
    const viewStatesRef = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
    const suppressChangeRef = useRef(false);
    const callbacksRef = useRef({ onChange, onCursorChange });
    const presentationRef = useRef({ resolvedAppearance, accent, codeSize });

    callbacksRef.current = { onChange, onCursorChange };
    presentationRef.current = { resolvedAppearance, accent, codeSize };

    useImperativeHandle(ref, () => ({
      focus: () => editorRef.current?.focus(),
      find: () => runEditorAction(editorRef, "actions.find"),
      goToNextProblem: () => runEditorAction(editorRef, "editor.action.marker.next"),
      openCommandPalette: () => runEditorAction(editorRef, "editor.action.quickCommand"),
      resetZoom: () => {
        const metrics = editorMetrics(presentationRef.current.codeSize);
        editorRef.current?.updateOptions(metrics);
      },
      toggleWordWrap: () => runEditorAction(editorRef, "editor.action.toggleWordWrap"),
      getSelectionRange: () => {
        const selection = editorRef.current?.getSelection();
        if (!selection) return null;
        return {
          startLine: selection.startLineNumber,
          endLine: selection.endLineNumber,
        };
      },
      focusTextRange: ({ startLine, startColumn, endLine = startLine, endColumn }) => {
        const editor = editorRef.current;
        const model = editor?.getModel();
        if (
          !editor ||
          !model ||
          !Number.isFinite(startLine) ||
          !Number.isFinite(startColumn) ||
          !Number.isFinite(endLine) ||
          !Number.isFinite(endColumn)
        ) return;
        const range = model.validateRange(new monaco.Range(
          Math.max(1, Math.trunc(startLine)),
          Math.max(1, Math.trunc(startColumn)),
          Math.max(1, Math.trunc(endLine)),
          Math.max(1, Math.trunc(endColumn)),
        ));
        reviewDecorationsRef.current?.clear();
        editor.setSelection(range);
        editor.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Smooth);
        editor.focus();
      },
      focusReviewRange: ({ startLine, endLine = startLine }) => {
        const editor = editorRef.current;
        const model = editor?.getModel();
        if (!editor || !model || !Number.isFinite(startLine) || !Number.isFinite(endLine)) return;
        const firstLine = Math.min(model.getLineCount(), Math.max(1, Math.trunc(startLine)));
        const lastLine = Math.min(
          model.getLineCount(),
          Math.max(firstLine, Math.trunc(endLine)),
        );
        const range = new monaco.Range(firstLine, 1, lastLine, model.getLineMaxColumn(lastLine));
        reviewDecorationsRef.current?.set([{
          range,
          options: {
            isWholeLine: true,
            className: "review-line-highlight",
            linesDecorationsClassName: "review-line-marker",
            overviewRuler: {
              color: `${accentColor(presentationRef.current.accent)}8F`,
              position: monaco.editor.OverviewRulerLane.Center,
            },
          },
        }]);
        editor.revealRangeInCenter(range, monaco.editor.ScrollType.Smooth);
        editor.setPosition({ lineNumber: firstLine, column: 1 });
        editor.focus();
      },
      clearReviewRange: () => reviewDecorationsRef.current?.clear(),
    }), []);

    useEffect(() => {
      if (!containerRef.current) return;
      configureMonaco();
      const initialPresentation = presentationRef.current;
      const initialMetrics = editorMetrics(initialPresentation.codeSize);

      const editor = monaco.editor.create(containerRef.current, {
        theme: monacoThemeName(initialPresentation.resolvedAppearance, initialPresentation.accent),
        automaticLayout: true,
        accessibilitySupport: "auto",
        ariaLabel: "Code editor",
        readOnly,
        fontFamily: '"IBM Plex Mono", "SF Mono", Menlo, Monaco, ui-monospace, monospace',
        fontSize: initialMetrics.fontSize,
        fontWeight: "400",
        fontLigatures: false,
        lineHeight: initialMetrics.lineHeight,
        letterSpacing: 0,
        lineNumbersMinChars: 5,
        lineDecorationsWidth: 16,
        glyphMargin: false,
        folding: false,
        minimap: { enabled: false },
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        renderLineHighlight: "all",
        renderLineHighlightOnlyWhenFocus: false,
        renderWhitespace: "selection",
        roundedSelection: false,
        scrollBeyondLastLine: false,
        scrollBeyondLastColumn: 4,
        smoothScrolling: true,
        stickyScroll: { enabled: false },
        guides: { indentation: false, highlightActiveIndentation: false, bracketPairs: false },
        bracketPairColorization: { enabled: false },
        matchBrackets: "always",
        padding: { top: 0, bottom: 40 },
        scrollbar: {
          verticalScrollbarSize: 8,
          horizontalScrollbarSize: 8,
          useShadows: false,
          alwaysConsumeMouseWheel: false,
        },
        tabSize: 2,
        insertSpaces: true,
        detectIndentation: true,
        formatOnPaste: true,
        formatOnType: true,
        wordWrap: "off",
        wordWrapColumn: 100,
        wrappingIndent: "same",
        cursorBlinking: "smooth",
        cursorSmoothCaretAnimation: "on",
        cursorWidth: 1,
        fixedOverflowWidgets: true,
        links: true,
        mouseWheelZoom: false,
        multiCursorModifier: "alt",
        occurrencesHighlight: "off",
        selectionHighlight: false,
        "semanticHighlighting.enabled": false,
        suggest: { showWords: true, preview: true },
      });

      editorRef.current = editor;
      reviewDecorationsRef.current = editor.createDecorationsCollection();

      const contentDisposable = editor.onDidChangeModelContent(() => {
        if (suppressChangeRef.current) return;
        const path = currentPathRef.current;
        const model = editor.getModel();
        if (path && model) callbacksRef.current.onChange(path, model.getValue());
      });

      const cursorDisposable = editor.onDidChangeCursorPosition((event) => {
        callbacksRef.current.onCursorChange?.({
          line: event.position.lineNumber,
          column: event.position.column,
        });
      });

      return () => {
        contentDisposable.dispose();
        cursorDisposable.dispose();
        reviewDecorationsRef.current?.clear();
        reviewDecorationsRef.current = null;
        editor.dispose();
        editorRef.current = null;
      };
    }, []);

    useEffect(() => {
      editorRef.current?.updateOptions({ readOnly });
    }, [readOnly]);

    useEffect(() => {
      configureMonaco();
      monaco.editor.setTheme(monacoThemeName(resolvedAppearance, accent));
      const metrics = editorMetrics(codeSize);
      editorRef.current?.updateOptions(metrics);
    }, [accent, codeSize, resolvedAppearance]);

    useEffect(() => {
      const editor = editorRef.current;
      if (!editor || !activePath) {
        currentPathRef.current = activePath;
        editor?.setModel(null);
        return;
      }

      const uri = modelUri(workspaceId, activePath);
      const previousModel = editor.getModel();
      if (previousModel && previousModel.uri.toString() !== uri.toString()) {
        reviewDecorationsRef.current?.clear();
        viewStatesRef.current.set(previousModel.uri.toString(), editor.saveViewState());
      }
      let model = monaco.editor.getModel(uri);
      if (!model) model = monaco.editor.createModel(value, language, uri);
      if (model.getLanguageId() !== language) monaco.editor.setModelLanguage(model, language);

      if (model.getValue() !== value) {
        suppressChangeRef.current = true;
        model.setValue(value);
        suppressChangeRef.current = false;
      }

      currentPathRef.current = activePath;
      if (editor.getModel() !== model) {
        editor.setModel(model);
        const viewState = viewStatesRef.current.get(uri.toString());
        if (viewState) editor.restoreViewState(viewState);
      }
      const position = editor.getPosition();
      if (position) {
        callbacksRef.current.onCursorChange?.({
          line: position.lineNumber,
          column: position.column,
        });
      }
      editor.focus();
    }, [activePath, language, value, workspaceId]);

    useEffect(() => {
      const keep = new Set(openPaths.map((path) => modelUri(workspaceId, path).toString()));
      for (const model of monaco.editor.getModels()) {
        if (model.uri.scheme === "trace-file" && !keep.has(model.uri.toString())) {
          viewStatesRef.current.delete(model.uri.toString());
          model.dispose();
        }
      }
    }, [openPaths, workspaceId]);

    return <div className="monaco-editor-host" ref={containerRef} />;
  },
);
