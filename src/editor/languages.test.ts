import { describe, expect, it } from "vitest";
import { detectLanguage, getLanguageDefinition, isKnownTextLanguage } from "./languages";
import type { EditorLanguageId } from "./types";

describe("detectLanguage", () => {
  it.each<[string, EditorLanguageId]>([
    ["src/App.tsx", "typescript"],
    ["src/types.mts", "typescript"],
    ["scripts/build.JS", "javascript"],
    ["public/index.html", "html"],
    ["styles/editor.scss", "css"],
    ["tsconfig.json", "json"],
    ["docs/README.md", "markdown"],
    ["server/main.py", "python"],
    ["src/Main.java", "java"],
    ["native/main.c", "c"],
    ["native/widget.hpp", "cpp"],
    ["db/schema.sql", "sql"],
    ["cmd/server/main.go", "go"],
  ])("detects %s as %s", (path, expected) => {
    expect(detectLanguage(path)).toBe(expected);
  });

  it("recognizes common exact filenames and supplemental languages", () => {
    expect(detectLanguage(".eslintrc")).toBe("json");
    expect(detectLanguage("Dockerfile")).toBe("shell");
    expect(detectLanguage(".github/workflows/ci.yml")).toBe("yaml");
    expect(detectLanguage("icons/logo.svg")).toBe("xml");
    expect(detectLanguage("src/lib.rs")).toBe("rust");
  });

  it("uses content only as a safe extensionless fallback", () => {
    expect(detectLanguage("bin/tool", "#!/usr/bin/env python3\nprint('ok')")).toBe("python");
    expect(detectLanguage("bin/dev", "#!/usr/bin/env node\nconsole.log('ok')")).toBe("javascript");
    expect(detectLanguage("bin/setup", "#!/bin/zsh\necho ok")).toBe("shell");
    expect(detectLanguage("document", "  <?xml version=\"1.0\"?>")).toBe("xml");
    expect(detectLanguage("page", "<!DOCTYPE html><html></html>")).toBe("html");
  });

  it("falls back to plaintext for unknown files", () => {
    expect(detectLanguage("data/archive.custom", "opaque data")).toBe("plaintext");
    expect(getLanguageDefinition("plaintext").mimeType).toBe("text/plain");
    expect(isKnownTextLanguage("README")).toBe(true);
    expect(isKnownTextLanguage("asset.unknown")).toBe(false);
  });
});
