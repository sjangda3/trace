import { useId } from "react";
import type {
  Accent,
  Appearance,
  CodeSize,
  ResolvedAppearance,
  TracePreferences,
} from "./types";

const appearanceOptions: Array<{
  value: Appearance;
  label: string;
  description: string;
}> = [
  { value: "system", label: "System", description: "Use your Mac setting" },
  { value: "light", label: "Light", description: "Light interface" },
  { value: "dark", label: "Dark", description: "Dark interface" },
];

const accentOptions: Array<{ value: Accent; label: string }> = [
  { value: "cobalt", label: "Cobalt" },
  { value: "violet", label: "Violet" },
  { value: "teal", label: "Teal" },
  { value: "amber", label: "Amber" },
  { value: "rose", label: "Rose" },
];

const codeSizeOptions: Array<{ value: CodeSize; label: string; preview: string }> = [
  { value: "small", label: "Small code", preview: "A−" },
  { value: "default", label: "Default code", preview: "A" },
  { value: "large", label: "Large code", preview: "A+" },
];

function previewTheme(
  appearance: Appearance,
  resolvedAppearance: ResolvedAppearance,
): ResolvedAppearance {
  return appearance === "system" ? resolvedAppearance : appearance;
}

function CodePreview({
  appearance,
  accent,
  codeSize,
  resolvedAppearance,
}: {
  appearance: Appearance;
  accent: Accent;
  codeSize: CodeSize;
  resolvedAppearance: ResolvedAppearance;
}) {
  const theme = previewTheme(appearance, resolvedAppearance);
  return (
    <span
      aria-hidden="true"
      className={`appearance-code-preview is-${theme} is-${codeSize} is-accent-${accent}`}
    >
      <span className="appearance-code-preview__chrome">
        <i />
        <i />
        <i />
      </span>
      <span className="appearance-code-preview__line">
        <b>const</b> <em>trace</em> <span>=</span> <strong>"ready"</strong>;
      </span>
      <span className="appearance-code-preview__line">
        <b>return</b> <em>trace</em>;
      </span>
    </span>
  );
}

export function AppearanceControls({
  value,
  resolvedAppearance,
  onChange,
  disabled = false,
  className = "",
}: {
  value: TracePreferences;
  resolvedAppearance: ResolvedAppearance;
  onChange: (next: TracePreferences) => void;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const update = (partial: Partial<TracePreferences>) => {
    onChange({ ...value, ...partial });
  };

  return (
    <div className={`appearance-controls ${className}`.trim()} aria-disabled={disabled || undefined}>
      <fieldset className="appearance-controls__group">
        <legend>Appearance</legend>
        <div className="appearance-controls__themes">
          {appearanceOptions.map((option) => {
            const inputId = `${id}-appearance-${option.value}`;
            const selected = value.appearance === option.value;
            return (
              <label
                key={option.value}
                className={`appearance-theme-choice${selected ? " is-selected" : ""}`}
                htmlFor={inputId}
              >
                <input
                  id={inputId}
                  type="radio"
                  name={`${id}-appearance`}
                  value={option.value}
                  checked={selected}
                  disabled={disabled}
                  onChange={() => update({ appearance: option.value })}
                />
                <CodePreview
                  appearance={option.value}
                  accent={value.accent}
                  codeSize={value.codeSize}
                  resolvedAppearance={resolvedAppearance}
                />
                <span className="appearance-theme-choice__label">{option.label}</span>
                <span className="appearance-theme-choice__description">{option.description}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="appearance-controls__group">
        <legend>Accent color</legend>
        <div className="appearance-controls__accents">
          {accentOptions.map((option) => {
            const inputId = `${id}-accent-${option.value}`;
            const selected = value.accent === option.value;
            return (
              <label
                key={option.value}
                className={`appearance-accent-choice is-${option.value}${selected ? " is-selected" : ""}`}
                htmlFor={inputId}
                title={option.label}
              >
                <input
                  id={inputId}
                  type="radio"
                  name={`${id}-accent`}
                  value={option.value}
                  checked={selected}
                  disabled={disabled}
                  onChange={() => update({ accent: option.value })}
                />
                <span aria-hidden="true" className="appearance-accent-choice__swatch" />
                <span className="sr-only">{option.label}</span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="appearance-controls__group">
        <legend>Code size</legend>
        <div className="appearance-controls__sizes">
          {codeSizeOptions.map((option) => {
            const inputId = `${id}-code-size-${option.value}`;
            const selected = value.codeSize === option.value;
            return (
              <label
                key={option.value}
                className={`appearance-size-choice${selected ? " is-selected" : ""}`}
                htmlFor={inputId}
              >
                <input
                  id={inputId}
                  type="radio"
                  name={`${id}-code-size`}
                  value={option.value}
                  checked={selected}
                  disabled={disabled}
                  onChange={() => update({ codeSize: option.value })}
                />
                <span aria-hidden="true" className="appearance-size-choice__mark">{option.preview}</span>
                <span>{option.label}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
    </div>
  );
}
