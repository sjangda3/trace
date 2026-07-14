import type { EditorLanguageId, LanguageDefinition } from "./types";

export const LANGUAGE_DEFINITIONS = [
  { id: "typescript", label: "TypeScript", extensions: ["ts", "tsx", "mts", "cts"], mimeType: "text/typescript" },
  { id: "javascript", label: "JavaScript", extensions: ["js", "jsx", "mjs", "cjs"], mimeType: "text/javascript" },
  { id: "html", label: "HTML", extensions: ["html", "htm"], mimeType: "text/html" },
  { id: "css", label: "CSS", extensions: ["css", "scss", "sass", "less"], mimeType: "text/css" },
  { id: "json", label: "JSON", extensions: ["json", "jsonc", "json5"], filenames: [".babelrc", ".eslintrc", ".prettierrc"], mimeType: "application/json" },
  { id: "markdown", label: "Markdown", extensions: ["md", "mdx", "markdown"], mimeType: "text/markdown" },
  { id: "python", label: "Python", extensions: ["py", "pyw", "pyi"], mimeType: "text/x-python" },
  { id: "java", label: "Java", extensions: ["java"], mimeType: "text/x-java-source" },
  { id: "c", label: "C", extensions: ["c", "h"], mimeType: "text/x-c" },
  { id: "cpp", label: "C++", extensions: ["cc", "cpp", "cxx", "c++", "hh", "hpp", "hxx", "h++"], mimeType: "text/x-c++src" },
  { id: "sql", label: "SQL", extensions: ["sql", "ddl", "dml"], mimeType: "application/sql" },
  { id: "go", label: "Go", extensions: ["go"], mimeType: "text/x-go" },
  { id: "yaml", label: "YAML", extensions: ["yaml", "yml"], mimeType: "application/yaml" },
  { id: "shell", label: "Shell", extensions: ["sh", "bash", "zsh", "fish"], filenames: [".zshrc", ".bashrc", ".bash_profile", ".profile"], mimeType: "text/x-shellscript" },
  { id: "xml", label: "XML", extensions: ["xml", "svg", "xsl", "xsd"], mimeType: "application/xml" },
  { id: "rust", label: "Rust", extensions: ["rs"], mimeType: "text/x-rust" },
  { id: "plaintext", label: "Plain Text", extensions: ["txt", "log"], mimeType: "text/plain" },
] as const satisfies readonly LanguageDefinition[];

const byId = new Map<EditorLanguageId, LanguageDefinition>(
  LANGUAGE_DEFINITIONS.map((definition) => [definition.id, definition]),
);

const byExtension = new Map<string, EditorLanguageId>();
const byFilename = new Map<string, EditorLanguageId>();

for (const definition of LANGUAGE_DEFINITIONS) {
  for (const extension of definition.extensions) {
    byExtension.set(extension.toLowerCase(), definition.id);
  }
  if ("filenames" in definition && definition.filenames) {
    for (const filename of definition.filenames) {
      byFilename.set(filename.toLowerCase(), definition.id);
    }
  }
}

const SPECIAL_FILENAMES: Readonly<Record<string, EditorLanguageId>> = {
  dockerfile: "shell",
  makefile: "shell",
  gemfile: "plaintext",
  procfile: "shell",
  "go.mod": "go",
  "go.sum": "plaintext",
  "cargo.toml": "plaintext",
};

export function getLanguageDefinition(language: EditorLanguageId): LanguageDefinition {
  return byId.get(language) ?? byId.get("plaintext")!;
}

/**
 * Detects a language from a path, then falls back to a shebang/content check.
 * Unknown and extensionless files remain plaintext instead of being guessed.
 */
export function detectLanguage(path: string, content?: string): EditorLanguageId {
  const filename = path.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  const exact = byFilename.get(filename) ?? SPECIAL_FILENAMES[filename];
  if (exact) return exact;

  const lastDot = filename.lastIndexOf(".");
  if (lastDot > -1 && lastDot < filename.length - 1) {
    const detected = byExtension.get(filename.slice(lastDot + 1));
    if (detected) return detected;
  }

  if (content) {
    const firstLine = content.split(/\r?\n/, 1)[0]?.toLowerCase() ?? "";
    if (firstLine.startsWith("#!")) {
      if (/\b(python|python3)\b/.test(firstLine)) return "python";
      if (/\b(node|deno|bun)\b/.test(firstLine)) return "javascript";
      if (/\b(bash|zsh|fish|sh)\b/.test(firstLine)) return "shell";
    }
    const trimmed = content.trimStart();
    if (trimmed.startsWith("<?xml")) return "xml";
    if (/^<!doctype\s+html\b/i.test(trimmed)) return "html";
  }

  return "plaintext";
}

export function isKnownTextLanguage(path: string): boolean {
  return detectLanguage(path) !== "plaintext" || /(?:^|\/)readme(?:\.[^/]*)?$/i.test(path);
}
