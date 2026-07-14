import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Code2, Search, TerminalSquare } from "lucide-react";
import { LANGUAGE_DEFINITIONS } from "../editor";
import "./tooling.css";

const revealTransition = { type: "tween" as const, duration: 0.12 };
const layoutTransition = {
  type: "tween" as const,
  duration: 0.15,
  layout: { type: "tween" as const, duration: 0.15 },
};

export function LanguageSupportSidebar() {
  const [query, setQuery] = useState("");
  const languages = useMemo(() => {
    const rawQuery = query.trim().toLocaleLowerCase();
    const normalized = rawQuery.startsWith(".") ? rawQuery.slice(1) : rawQuery;
    if (!normalized) return LANGUAGE_DEFINITIONS;
    return LANGUAGE_DEFINITIONS.filter((language) => (
      language.label.toLocaleLowerCase().includes(normalized) ||
      language.extensions.some((extension) => extension.includes(normalized))
    ));
  }, [query]);

  return (
    <aside className="sidebar panel-surface tooling-sidebar" aria-label="Built-in language support">
      <label className="search-field">
        <Search aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter languages"
          aria-label="Filter built-in languages"
        />
        <Code2 aria-hidden="true" />
      </label>

      <div className="tooling-heading">
        <span>Editor languages</span>
        <small>{LANGUAGE_DEFINITIONS.length}</small>
      </div>

      <motion.div className="tooling-list" layout transition={layoutTransition}>
        <AnimatePresence initial={false} mode="popLayout">
        {languages.map((language) => (
          <motion.div
            className="tooling-language"
            key={language.id}
            layout="position"
            initial={{ opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -3 }}
            transition={layoutTransition}
          >
            <span className={`tooling-language-icon is-${language.id}`}><Code2 aria-hidden="true" /></span>
            <span>
              <strong>{language.label}</strong>
              <small>{language.extensions.map((extension) => `.${extension}`).join("  ")}</small>
            </span>
            <span className="tooling-enabled" title="Syntax support enabled"><Check aria-hidden="true" /></span>
          </motion.div>
        ))}
        {languages.length === 0 ? (
          <motion.div
            className="tooling-empty"
            key="tooling-empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={revealTransition}
          >
            No matching language
          </motion.div>
        ) : null}
        </AnimatePresence>
      </motion.div>

      <footer className="tooling-footer">
        <TerminalSquare aria-hidden="true" />
        <span><strong>Runtime toolchains</strong><small>Use the workspace terminal for compilers and package managers.</small></span>
      </footer>
    </aside>
  );
}
