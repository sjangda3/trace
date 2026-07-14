import { describe, expect, it } from "vitest";
import type { WorkspaceTree } from "./types";
import {
  breadcrumbSegments,
  findNodeByPath,
  findPreferredInitialFiles,
  flattenWorkspaceTree,
} from "./tree";

const tree: WorkspaceTree = [
  { kind: "file", name: "notes.txt", path: "notes.txt", language: "plaintext" },
  {
    kind: "directory",
    name: "src",
    path: "src",
    children: [
      {
        kind: "directory",
        name: "components",
        path: "src/components",
        children: [
          {
            kind: "file",
            name: "workspace-shell.tsx",
            path: "src/components/workspace-shell.tsx",
            language: "typescript",
          },
          { kind: "file", name: "button.tsx", path: "src/components/button.tsx", language: "typescript" },
        ],
      },
      {
        kind: "directory",
        name: "legacy",
        path: "src/legacy",
        children: [
          {
            kind: "file",
            name: "workspace-shell.tsx",
            path: "src/legacy/workspace-shell.tsx",
            language: "typescript",
          },
        ],
      },
    ],
  },
  {
    kind: "directory",
    name: "docs",
    path: "docs",
    children: [
      { kind: "file", name: "README.md", path: "docs/README.md", language: "markdown" },
      { kind: "file", name: "product-spec.md", path: "docs/product-spec.md", language: "markdown" },
    ],
  },
  { kind: "file", name: "package.json", path: "package.json", language: "json" },
  { kind: "file", name: "preview.png", path: "preview.png", binary: true },
];

describe("flattenWorkspaceTree", () => {
  it("respects expansion state, depth, full paths, and source ordering", () => {
    const rows = flattenWorkspaceTree(tree, new Set(["src", "src/components"]));

    expect(rows.map(({ path, depth }) => [path, depth])).toEqual([
      ["notes.txt", 0],
      ["src", 0],
      ["src/components", 1],
      ["src/components/workspace-shell.tsx", 2],
      ["src/components/button.tsx", 2],
      ["src/legacy", 1],
      ["docs", 0],
      ["package.json", 0],
      ["preview.png", 0],
    ]);
    expect(rows[3]?.node).toBe(findNodeByPath(tree, "src/components/workspace-shell.tsx"));
  });

  it("searches collapsed descendants and retains each matching ancestor", () => {
    const rows = flattenWorkspaceTree(tree, new Set(), "WORKSPACE-SHELL");

    expect(rows.map(({ path, depth }) => [path, depth])).toEqual([
      ["src", 0],
      ["src/components", 1],
      ["src/components/workspace-shell.tsx", 2],
      ["src/legacy", 1],
      ["src/legacy/workspace-shell.tsx", 2],
    ]);
  });

  it("can match a full path without leaking unrelated siblings", () => {
    const rows = flattenWorkspaceTree(tree, new Set(["docs"]), "legacy/workspace");

    expect(rows.map((row) => row.path)).toEqual([
      "src",
      "src/legacy",
      "src/legacy/workspace-shell.tsx",
    ]);
  });
});

describe("findNodeByPath", () => {
  it("distinguishes duplicate basenames using their full paths", () => {
    expect(findNodeByPath(tree, "src/components/workspace-shell.tsx")?.path)
      .toBe("src/components/workspace-shell.tsx");
    expect(findNodeByPath(tree, "src/legacy/workspace-shell.tsx")?.path)
      .toBe("src/legacy/workspace-shell.tsx");
    expect(findNodeByPath(tree, "workspace-shell.tsx")).toBeUndefined();
  });
});

describe("findPreferredInitialFiles", () => {
  it("uses preference order before filling with the first text files", () => {
    expect(findPreferredInitialFiles(tree, 6).map((file) => file.path)).toEqual([
      "src/components/workspace-shell.tsx",
      "docs/product-spec.md",
      "docs/README.md",
      "package.json",
      "notes.txt",
      "src/components/button.tsx",
    ]);
  });

  it("honors the limit, ignores binary entries, and returns the first duplicate preference", () => {
    expect(findPreferredInitialFiles(tree, 1).map((file) => file.path))
      .toEqual(["src/components/workspace-shell.tsx"]);
    expect(findPreferredInitialFiles(tree, 20).some((file) => file.path === "preview.png")).toBe(false);
    expect(findPreferredInitialFiles(tree, 0)).toEqual([]);
  });
});

describe("breadcrumbSegments", () => {
  it("normalizes separators and removes empty or current-directory segments", () => {
    expect(breadcrumbSegments("/apps//desktop/./src/workspace-shell.tsx/"))
      .toEqual(["apps", "desktop", "src", "workspace-shell.tsx"]);
    expect(breadcrumbSegments("src\\components\\button.tsx"))
      .toEqual(["src", "components", "button.tsx"]);
  });
});
