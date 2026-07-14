import { useMemo } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, FileCode2, FileDiff, LoaderCircle, X } from "lucide-react";
import type { GitFileDiff } from "../types";

const revealTransition = { type: "tween" as const, duration: 0.14 };

export interface GitPatchPanelProps {
  diff: GitFileDiff | null;
  loading?: boolean;
  error?: string | null;
  onClose: () => void;
  onOpenFile: (path: string) => void;
}

type PatchLineKind = "header" | "hunk" | "context" | "added" | "removed" | "meta";

type PatchLine = {
  text: string;
  kind: PatchLineKind;
  oldLine: number | null;
  newLine: number | null;
};

function parsePatch(patch: string): PatchLine[] {
  const output: PatchLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const rawLines = patch.endsWith("\n") ? patch.slice(0, -1).split("\n") : patch.split("\n");

  for (const text of rawLines) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      oldLine = Number.parseInt(hunk[1], 10);
      newLine = Number.parseInt(hunk[2], 10);
      inHunk = true;
      output.push({ text, kind: "hunk", oldLine: null, newLine: null });
      continue;
    }

    if (
      text.startsWith("diff --git ") ||
      text.startsWith("index ") ||
      text.startsWith("--- ") ||
      text.startsWith("+++ ") ||
      text.startsWith("new file mode ") ||
      text.startsWith("deleted file mode ") ||
      text.startsWith("similarity index ") ||
      text.startsWith("rename from ") ||
      text.startsWith("rename to ")
    ) {
      output.push({ text, kind: "header", oldLine: null, newLine: null });
      continue;
    }

    if (text.startsWith("\\")) {
      output.push({ text, kind: "meta", oldLine: null, newLine: null });
      continue;
    }

    if (!inHunk) {
      output.push({ text, kind: "meta", oldLine: null, newLine: null });
      continue;
    }

    if (text.startsWith("+")) {
      output.push({ text, kind: "added", oldLine: null, newLine });
      newLine += 1;
      continue;
    }
    if (text.startsWith("-")) {
      output.push({ text, kind: "removed", oldLine, newLine: null });
      oldLine += 1;
      continue;
    }

    output.push({ text, kind: "context", oldLine, newLine });
    oldLine += 1;
    newLine += 1;
  }
  return output;
}

function modeLabel(diff: GitFileDiff): string {
  if (diff.mode === "staged") return "Staged";
  if (diff.mode === "commit") return diff.commit ? `Commit ${diff.commit.slice(0, 7)}` : "Commit";
  return "Working Tree";
}

export function GitPatchPanel({
  diff,
  loading = false,
  error = null,
  onClose,
  onOpenFile,
}: GitPatchPanelProps) {
  const lines = useMemo(() => parsePatch(diff?.patch ?? ""), [diff?.patch]);

  return (
    <motion.section
      className="git-patch-panel"
      aria-label={diff ? `Changes in ${diff.path}` : "File changes"}
      aria-busy={loading}
      initial={{ opacity: 0, scale: 0.995 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={revealTransition}
    >
      <header>
        <div className="git-patch-title">
          <FileDiff aria-hidden="true" />
          <div>
            <strong>{diff?.path ?? "File Changes"}</strong>
            <span>{diff ? modeLabel(diff) : "Diff"}</span>
          </div>
        </div>
        <div className="git-patch-actions">
          <button
            type="button"
            disabled={!diff}
            onClick={() => { if (diff) onOpenFile(diff.path); }}
          >
            <FileCode2 aria-hidden="true" />
            Open File
          </button>
          <button type="button" className="git-patch-close" aria-label="Close file changes" title="Close" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="git-patch-body">
        <AnimatePresence initial={false} mode="wait">
        {error ? (
          <motion.div
            className="git-patch-message git-patch-message--error"
            role="status"
            key="patch-error"
            initial={{ opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -3 }}
            transition={revealTransition}
          >
            <AlertTriangle aria-hidden="true" />
            <strong>Couldn’t load this diff</strong>
            <span>{error}</span>
          </motion.div>
        ) : null}

        {!error && loading ? (
          <motion.div
            className="git-patch-message"
            role="status"
            key="patch-loading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={revealTransition}
          >
            <LoaderCircle className="git-spin" aria-hidden="true" />
            <span>Reading file changes…</span>
          </motion.div>
        ) : null}

        {!error && !loading && diff && diff.patch.length === 0 ? (
          <motion.div
            className="git-patch-message"
            key="patch-empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={revealTransition}
          >
            <FileDiff aria-hidden="true" />
            <strong>No text changes</strong>
            <span>This file has no patch in the selected view.</span>
          </motion.div>
        ) : null}

        {!error && !loading && diff && diff.patch.length > 0 ? (
          <motion.div
            className="git-patch-scroll"
            tabIndex={0}
            aria-label={`Text patch for ${diff.path}`}
            key={`${diff.mode}:${diff.path}:${diff.commit ?? "working"}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={revealTransition}
          >
            <div className="git-patch-code">
              {lines.map((line, index) => (
                <div className={`git-patch-line git-patch-line--${line.kind}`} key={`${index}-${line.text}`}>
                  <span className="git-patch-old-line" aria-hidden="true">{line.oldLine ?? ""}</span>
                  <span className="git-patch-new-line" aria-hidden="true">{line.newLine ?? ""}</span>
                  <code>{line.text || " "}</code>
                </div>
              ))}
            </div>
          </motion.div>
        ) : null}
        </AnimatePresence>
      </div>
    </motion.section>
  );
}
