import type {
  WorkspaceFileNode,
  WorkspacePath,
  WorkspaceTree,
  WorkspaceTreeNode,
} from "./types";

export interface WorkspaceTreeRow {
  /** Full path relative to the workspace root. */
  path: WorkspacePath;
  depth: number;
  node: WorkspaceTreeNode;
}

function normalizedSearchQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

function nodeMatchesQuery(node: WorkspaceTreeNode, query: string): boolean {
  return node.name.toLocaleLowerCase().includes(query) || node.path.toLocaleLowerCase().includes(query);
}

function flattenExpandedTree(
  tree: WorkspaceTree,
  expandedPaths: ReadonlySet<WorkspacePath>,
  depth: number,
  rows: WorkspaceTreeRow[],
): void {
  for (const node of tree) {
    rows.push({ path: node.path, depth, node });
    if (node.kind === "directory" && expandedPaths.has(node.path)) {
      flattenExpandedTree(node.children, expandedPaths, depth + 1, rows);
    }
  }
}

/**
 * Returns the visible tree rows in source order. Searching traverses collapsed
 * directories and includes every ancestor needed to locate a matching node.
 */
export function flattenWorkspaceTree(
  tree: WorkspaceTree,
  expandedPaths: ReadonlySet<WorkspacePath>,
  query = "",
): WorkspaceTreeRow[] {
  const searchQuery = normalizedSearchQuery(query);
  if (!searchQuery) {
    const rows: WorkspaceTreeRow[] = [];
    flattenExpandedTree(tree, expandedPaths, 0, rows);
    return rows;
  }

  function filterNodes(nodes: WorkspaceTree, depth: number): WorkspaceTreeRow[] {
    const rows: WorkspaceTreeRow[] = [];

    for (const node of nodes) {
      const childRows = node.kind === "directory" ? filterNodes(node.children, depth + 1) : [];
      if (nodeMatchesQuery(node, searchQuery) || childRows.length > 0) {
        rows.push({ path: node.path, depth, node }, ...childRows);
      }
    }

    return rows;
  }

  return filterNodes(tree, 0);
}

/** Finds one node by its full workspace-relative path. */
export function findNodeByPath(
  tree: WorkspaceTree,
  path: WorkspacePath,
): WorkspaceTreeNode | undefined {
  for (const node of tree) {
    if (node.path === path) return node;
    if (node.kind === "directory") {
      const child = findNodeByPath(node.children, path);
      if (child) return child;
    }
  }
  return undefined;
}

function collectFiles(tree: WorkspaceTree, files: WorkspaceFileNode[]): void {
  for (const node of tree) {
    if (node.kind === "file") files.push(node);
    else collectFiles(node.children, files);
  }
}

const PREFERRED_INITIAL_FILES: readonly ((name: string) => boolean)[] = [
  (name) => name === "workspace-shell.tsx",
  (name) => name === "product-spec.md",
  (name) => /^readme(?:\.[^/]*)?$/.test(name),
  (name) => name === "package.json",
];

/**
 * Selects useful starter documents in a deterministic order, then fills any
 * remaining slots with the first non-binary files in tree order.
 */
export function findPreferredInitialFiles(
  tree: WorkspaceTree,
  limit: number,
): WorkspaceFileNode[] {
  const normalizedLimit = Math.max(0, Math.floor(limit));
  if (normalizedLimit === 0) return [];

  const files: WorkspaceFileNode[] = [];
  collectFiles(tree, files);
  const textFiles = files.filter((file) => file.binary !== true);
  const selected: WorkspaceFileNode[] = [];
  const selectedPaths = new Set<WorkspacePath>();

  for (const matches of PREFERRED_INITIAL_FILES) {
    const preferred = textFiles.find((file) => matches(file.name.toLocaleLowerCase()));
    if (!preferred || selectedPaths.has(preferred.path)) continue;
    selected.push(preferred);
    selectedPaths.add(preferred.path);
    if (selected.length === normalizedLimit) return selected;
  }

  for (const file of textFiles) {
    if (selectedPaths.has(file.path)) continue;
    selected.push(file);
    selectedPaths.add(file.path);
    if (selected.length === normalizedLimit) break;
  }

  return selected;
}

/** Splits a portable or native-looking path into displayable breadcrumbs. */
export function breadcrumbSegments(path: WorkspacePath): string[] {
  return path.replace(/\\/g, "/").split("/").filter((segment) => segment && segment !== ".");
}
