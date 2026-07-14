import { useId, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  GitBranch,
  GitFork,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import type {
  GitBranch as GitBranchModel,
  GitBranches,
  GitBranchMutationResult,
} from "../types";

const revealTransition = { type: "tween" as const, duration: 0.14 };
const layoutTransition = {
  type: "tween" as const,
  duration: 0.16,
  layout: { type: "tween" as const, duration: 0.16 },
};

export interface BranchesSidebarProps {
  repositoryName: string;
  branches: GitBranches | null;
  loading?: boolean;
  busy?: boolean;
  notRepository?: boolean;
  error?: string | null;
  onRefresh: () => void | GitBranches | null | Promise<GitBranches | null>;
  onCheckout: (name: string) => void | GitBranchMutationResult | null | Promise<GitBranchMutationResult | null>;
  onCreate: (name: string) => void | GitBranchMutationResult | null | Promise<GitBranchMutationResult | null>;
}

export interface BranchesViewProps {
  branches: GitBranches | null;
  query?: string;
  loading?: boolean;
  busy?: boolean;
  notRepository?: boolean;
  error?: string | null;
  onCheckout: BranchesSidebarProps["onCheckout"];
  onCreate: BranchesSidebarProps["onCreate"];
  onRefresh?: BranchesSidebarProps["onRefresh"];
}

type BranchSectionProps = {
  title: string;
  branches: GitBranchModel[];
  currentName: string | null;
  emptyLabel: string;
  busy: boolean;
  allowCheckout?: boolean;
  onCheckout: BranchesSidebarProps["onCheckout"];
};

function shortRemoteName(name: string): { remote: string; branch: string } {
  const slash = name.indexOf("/");
  if (slash < 0) return { remote: "remote", branch: name };
  return { remote: name.slice(0, slash), branch: name.slice(slash + 1) };
}

function BranchSection({
  title,
  branches,
  currentName,
  emptyLabel,
  busy,
  allowCheckout = false,
  onCheckout,
}: BranchSectionProps) {
  const [expanded, setExpanded] = useState(true);
  const bodyId = useId();
  return (
    <motion.section className="git-branch-section" layout transition={layoutTransition}>
      <button
        type="button"
        className="git-section-toggle git-branch-section-toggle"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((current) => !current)}
      >
        <ChevronDown aria-hidden="true" />
        <span>{title}</span>
        <small>{branches.length}</small>
      </button>
      <AnimatePresence initial={false} mode="popLayout">
      {expanded ? (
        <motion.div
          className="git-branch-list"
          id={bodyId}
          key="branch-list"
          initial={{ opacity: 0, scaleY: 0.98 }}
          animate={{ opacity: 1, scaleY: 1 }}
          exit={{ opacity: 0, scaleY: 0.98 }}
          style={{ transformOrigin: "top" }}
          transition={revealTransition}
        >
          {branches.length === 0 ? <p className="git-section-empty">{emptyLabel}</p> : null}
          <AnimatePresence initial={false} mode="popLayout">
          {branches.map((branch) => {
            const remote = branch.kind === "remote" ? shortRemoteName(branch.name) : null;
            const current = branch.current || branch.name === currentName;
            return (
              <motion.div
                className={`git-branch-row ${current ? "is-current" : ""}`}
                key={branch.ref}
                layout="position"
                initial={{ opacity: 0, y: -3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -3 }}
                transition={revealTransition}
              >
                <GitBranch aria-hidden="true" />
                <div className="git-branch-copy">
                  <span>{remote?.branch ?? branch.name}</span>
                  <small>
                    {remote ? `${remote.remote} · ` : ""}
                    {branch.subject || branch.hash.slice(0, 7)}
                  </small>
                </div>
                {branch.ahead > 0 || branch.behind > 0 ? (
                  <span className="git-tracking-count" aria-label={`${branch.ahead} ahead, ${branch.behind} behind`}>
                    {branch.ahead > 0 ? `↑${branch.ahead}` : ""}
                    {branch.ahead > 0 && branch.behind > 0 ? " " : ""}
                    {branch.behind > 0 ? `↓${branch.behind}` : ""}
                  </span>
                ) : null}
                {current ? (
                  <Check className="git-current-check" aria-label="Current branch" />
                ) : allowCheckout ? (
                  <button
                    type="button"
                    className="git-row-button"
                    disabled={busy}
                    onClick={() => void onCheckout(branch.name)}
                  >
                    Checkout
                  </button>
                ) : null}
              </motion.div>
            );
          })}
          </AnimatePresence>
        </motion.div>
      ) : null}
      </AnimatePresence>
    </motion.section>
  );
}

function CreateBranchDialog({
  busy,
  error,
  onCancel,
  onCreate,
}: {
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onCreate: BranchesSidebarProps["onCreate"];
}) {
  const titleId = useId();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const submit = async () => {
    const branchName = name.trim();
    if (!branchName) {
      setValidationError("Enter a branch name.");
      inputRef.current?.focus();
      return;
    }
    const result = await onCreate(branchName);
    if (result !== null) onCancel();
  };

  return (
    <motion.div
      className="git-sidebar-dialog-backdrop"
      onMouseDown={onCancel}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={revealTransition}
    >
      <motion.section
        className="git-sidebar-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
        initial={{ opacity: 0, y: -4, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -4, scale: 0.985 }}
        transition={revealTransition}
      >
        <header>
          <strong id={titleId}>Create &amp; Checkout</strong>
          <button type="button" aria-label="Close create branch dialog" onClick={onCancel}><X aria-hidden="true" /></button>
        </header>
        <label htmlFor={inputId}>Branch name</label>
        <input
          id={inputId}
          ref={inputRef}
          autoFocus
          autoComplete="off"
          spellCheck={false}
          value={name}
          placeholder="feature/workspace-sync"
          aria-invalid={Boolean(validationError || error)}
          aria-describedby={validationError || error ? `${inputId}-error` : undefined}
          onChange={(event) => { setName(event.target.value); setValidationError(null); }}
          onKeyDown={(event) => {
            if (event.key === "Escape") onCancel();
            if (event.key === "Enter") { event.preventDefault(); void submit(); }
          }}
        />
        <AnimatePresence initial={false} mode="popLayout">
          {validationError || error ? (
            <motion.p
              id={`${inputId}-error`}
              className="git-dialog-error"
              initial={{ opacity: 0, y: -2 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -2 }}
              transition={revealTransition}
            >
              {validationError ?? error}
            </motion.p>
          ) : null}
        </AnimatePresence>
        <p>The new branch starts at the current commit and becomes active immediately.</p>
        <footer>
          <button type="button" onClick={onCancel}>Cancel</button>
          <button className="is-primary" type="button" disabled={busy} onClick={() => void submit()}>
            <AnimatePresence initial={false} mode="wait">
              <motion.span
                className="git-operation-icon"
                key={busy ? "busy" : "ready"}
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={revealTransition}
              >
                {busy ? <LoaderCircle className="git-spin" aria-hidden="true" /> : <GitBranch aria-hidden="true" />}
              </motion.span>
            </AnimatePresence>
            Create
          </button>
        </footer>
      </motion.section>
    </motion.div>
  );
}

export function BranchesView({
  branches,
  query = "",
  loading = false,
  busy = false,
  notRepository = false,
  error = null,
  onCheckout,
  onCreate,
  onRefresh,
}: BranchesViewProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = useMemo(() => {
    const matches = (branch: GitBranchModel) => (
      normalizedQuery.length === 0 || branch.name.toLocaleLowerCase().includes(normalizedQuery)
    );
    return {
      local: (branches?.local ?? []).filter(matches),
      remote: (branches?.remote ?? []).filter(matches),
    };
  }, [branches, normalizedQuery]);
  const current = visible.local.filter((branch) => branch.current || branch.name === branches?.current);
  const local = visible.local.filter((branch) => !branch.current && branch.name !== branches?.current);

  return (
    <div className="git-branches-view" aria-busy={loading || busy}>
      <AnimatePresence initial={false} mode="popLayout">
      {error ? (
        <motion.div
          className="git-inline-message git-inline-message--error"
          role="status"
          key="branches-error"
          initial={{ opacity: 0, y: -3 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -3 }}
          transition={revealTransition}
        >
          <AlertTriangle aria-hidden="true" />
          <span>{error}</span>
        </motion.div>
      ) : null}
      </AnimatePresence>

      {notRepository ? (
        <div className="git-empty-state">
          <GitFork aria-hidden="true" />
          <strong>No branches to show</strong>
          <p>Open a Git repository to browse and switch branches.</p>
          {onRefresh ? <button type="button" disabled={loading} onClick={() => void onRefresh()}>Check again</button> : null}
        </div>
      ) : null}

      <AnimatePresence initial={false} mode="wait">
      {!notRepository && loading && !branches ? (
        <motion.div
          className="git-loading-state"
          role="status"
          key="branches-loading"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={revealTransition}
        >
          <LoaderCircle className="git-spin" aria-hidden="true" />
          <span>Reading branches…</span>
        </motion.div>
      ) : null}
      </AnimatePresence>

      {!notRepository && branches ? (
        <>
          <div className="git-branches-view-actions">
            <span>{branches.detached ? "Detached HEAD" : branches.current ?? "Local branches"}</span>
            <button
              type="button"
              className="git-quiet-icon-button"
              aria-label="Create and checkout branch"
              title="Create & Checkout"
              disabled={busy}
              onClick={() => setCreateOpen(true)}
            >
              <Plus aria-hidden="true" />
            </button>
          </div>
          <BranchSection
            title="Current"
            branches={current}
            currentName={branches.current}
            emptyLabel={branches.detached ? "Detached HEAD" : "No current branch"}
            busy={busy}
            onCheckout={onCheckout}
          />
          <BranchSection
            title="Local"
            branches={local}
            currentName={branches.current}
            emptyLabel={normalizedQuery ? "No matching local branches" : "No other local branches"}
            busy={busy}
            allowCheckout
            onCheckout={onCheckout}
          />
          <BranchSection
            title="Remote"
            branches={visible.remote}
            currentName={branches.current}
            emptyLabel={normalizedQuery ? "No matching remote branches" : "No remote branches"}
            busy={busy}
            onCheckout={onCheckout}
          />
        </>
      ) : null}

      <AnimatePresence initial={false}>
        {createOpen ? (
          <CreateBranchDialog key="create-branch" busy={busy} error={error} onCancel={() => setCreateOpen(false)} onCreate={onCreate} />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function BranchesSidebar({
  repositoryName,
  branches,
  loading = false,
  busy = false,
  notRepository = false,
  error = null,
  onRefresh,
  onCheckout,
  onCreate,
}: BranchesSidebarProps) {
  const [query, setQuery] = useState("");

  return (
    <aside className="sidebar panel-surface git-sidebar git-branches-sidebar" aria-label="Branches and pull requests" aria-busy={loading || busy}>
      <label className="search-field git-filter-field">
        <Search aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter branches"
          aria-label="Filter branches"
        />
        <button
          type="button"
          className="sidebar-menu-trigger"
          aria-label="Refresh branches"
          title="Refresh branches"
          disabled={loading}
          onClick={() => void onRefresh()}
        >
          <RefreshCw className={loading ? "git-spin" : ""} aria-hidden="true" />
        </button>
      </label>

      <div className="git-repository-row">
        <GitFork aria-hidden="true" />
        <div>
          <strong>{repositoryName}</strong>
          <span>{branches?.detached ? "Detached HEAD" : branches?.current ?? "Branches"}</span>
        </div>
      </div>

      <div className="git-sidebar-scroll">
        <BranchesView
          branches={branches}
          query={query}
          loading={loading}
          busy={busy}
          notRepository={notRepository}
          error={error}
          onCheckout={onCheckout}
          onCreate={onCreate}
          onRefresh={onRefresh}
        />
      </div>
      <div className="sidebar-scrollbar" aria-hidden="true"><span /></div>
    </aside>
  );
}
