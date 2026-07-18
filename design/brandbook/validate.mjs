#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const brandbookDirectory = fileURLToPath(new URL(".", import.meta.url));
const designDirectory = resolve(brandbookDirectory, "..");
const repositoryDirectory = resolve(designDirectory, "..");
const tokenFile = resolve(brandbookDirectory, "tokens.json");
const htmlFile = resolve(brandbookDirectory, "index.html");
const errors = [];

function report(message) {
  errors.push(message);
}

function readText(path, label = path) {
  if (!existsSync(path)) {
    report(`Missing ${label}.`);
    return "";
  }

  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    report(`Could not read ${label}: ${error.message}`);
    return "";
  }
}

function parseJson(text, label) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    report(`${label} is not valid JSON: ${error.message}`);
    return null;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validValueForType(type, value) {
  if (type === "fontWeight") {
    return Number.isInteger(value) && value >= 100 && value <= 900;
  }

  if (type === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }

  if (!isNonEmptyString(value) || value.includes(";")) return false;

  switch (type) {
    case "color":
      return /^(?:#[0-9a-f]{6}(?:[0-9a-f]{2})?|rgba?\([^\n]+\)|hsla?\([^\n]+\)|color-mix\([^\n]+\)|transparent|currentColor)$/i.test(value);
    case "dimension":
      return /^-?(?:\d+|\d*\.\d+)(?:px|rem|em|%)$/.test(value);
    case "duration":
      return /^(?:\d+|\d*\.\d+)(?:ms|s)$/.test(value);
    case "easing":
      return /^(?:linear|ease|ease-in|ease-out|ease-in-out|cubic-bezier\([^\n]+\))$/.test(value);
    case "gradient":
      return /^(?:linear|radial|conic)-gradient\([^\n]+\)$/.test(value);
    case "shadow":
      return value === "none" || /-?(?:\d+|\d*\.\d+)px/.test(value);
    case "border":
      return /^\d+(?:\.\d+)?px\s+(?:solid|dashed|dotted)\s+.+$/.test(value);
    case "fontFamily":
    case "string":
      return true;
    default:
      return false;
  }
}

function parseHexColor(value) {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) return null;
  return [0, 2, 4].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16));
}

function relativeLuminance(value) {
  const channels = parseHexColor(value);
  if (!channels) return null;
  const [red, green, blue] = channels.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(foreground, background) {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  if (foregroundLuminance === null || backgroundLuminance === null) return null;
  const light = Math.max(foregroundLuminance, backgroundLuminance);
  const dark = Math.min(foregroundLuminance, backgroundLuminance);
  return (light + 0.05) / (dark + 0.05);
}

function validateWcag(id, wcag) {
  if (!isPlainObject(wcag)) {
    report(`Token ${id} has invalid wcag metadata.`);
    return;
  }

  const ratio = contrastRatio(wcag.foreground, wcag.background);
  if (ratio === null) {
    report(`Token ${id} wcag foreground/background must be six-digit hex colors.`);
    return;
  }

  if (typeof wcag.ratio !== "number" || Math.abs(wcag.ratio - ratio) > 0.011) {
    report(`Token ${id} records WCAG ratio ${wcag.ratio}, but the computed ratio is ${ratio.toFixed(2)}.`);
  }

  if (wcag.target !== 3 && wcag.target !== 4.5) {
    report(`Token ${id} wcag target must be 3 or 4.5.`);
  }

  if (!["pass", "migration-target"].includes(wcag.assessment)) {
    report(`Token ${id} wcag assessment must be pass or migration-target.`);
  } else {
    const expected = ratio >= wcag.target ? "pass" : "migration-target";
    if (wcag.assessment !== expected) {
      report(`Token ${id} wcag assessment is ${wcag.assessment}; ${ratio.toFixed(2)}:1 against ${wcag.target}:1 should be ${expected}.`);
    }
  }
}

function validateTokens(document) {
  const requiredGroups = [
    "brand",
    "color",
    "accent",
    "semantic",
    "syntax",
    "typography",
    "spacing",
    "radius",
    "elevation",
    "motion",
    "layout",
    "iconography",
  ];
  const allowedStatuses = new Set(["implemented", "extension"]);
  const allowedTypes = new Set([
    "border",
    "color",
    "dimension",
    "duration",
    "easing",
    "fontFamily",
    "fontWeight",
    "gradient",
    "number",
    "shadow",
    "string",
  ]);
  const tokens = new Map();

  if (!isPlainObject(document)) {
    report("tokens.json root must be an object.");
    return tokens;
  }

  if (!/^\d+\.\d+\.\d+$/.test(document.schemaVersion ?? "")) {
    report("tokens.json schemaVersion must be a semantic version such as 1.0.0.");
  }
  if (!isNonEmptyString(document.name)) report("tokens.json name must be a non-empty string.");
  if (!isNonEmptyString(document.description)) report("tokens.json description must be a non-empty string.");
  if (document.canonicalLogo !== "../trace-frame.svg") {
    report("tokens.json canonicalLogo must remain ../trace-frame.svg so the approved mark has one source of truth.");
  }
  if (!isPlainObject(document.statusDefinitions)) {
    report("tokens.json statusDefinitions must be an object.");
  } else {
    for (const status of allowedStatuses) {
      if (!isNonEmptyString(document.statusDefinitions[status])) {
        report(`tokens.json statusDefinitions.${status} must be a non-empty string.`);
      }
    }
  }
  if (!isPlainObject(document.groups)) {
    report("tokens.json groups must be an object.");
    return tokens;
  }

  for (const requiredGroup of requiredGroups) {
    if (!Object.hasOwn(document.groups, requiredGroup)) {
      report(`tokens.json is missing required group ${requiredGroup}.`);
    }
  }

  for (const [groupName, group] of Object.entries(document.groups)) {
    if (!/^[a-z][a-z0-9-]*$/.test(groupName)) {
      report(`Token group name ${groupName} is not lowercase kebab-case.`);
    }
    if (!isPlainObject(group)) {
      report(`Token group ${groupName} must be an object.`);
      continue;
    }
    if (!isNonEmptyString(group.description)) {
      report(`Token group ${groupName} needs a description.`);
    }
    if (!isPlainObject(group.tokens) || Object.keys(group.tokens).length === 0) {
      report(`Token group ${groupName} needs a non-empty tokens object.`);
      continue;
    }

    for (const [tokenName, token] of Object.entries(group.tokens)) {
      const id = `${groupName}.${tokenName}`;
      if (!/^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/.test(id)) {
        report(`Token id ${id} must use lowercase dotted segments.`);
      }
      if (tokens.has(id)) report(`Duplicate token id ${id}.`);
      tokens.set(id, token);

      if (!isPlainObject(token)) {
        report(`Token ${id} must be an object.`);
        continue;
      }
      if (!allowedTypes.has(token.type)) {
        report(`Token ${id} has unsupported type ${String(token.type)}.`);
      } else if (!validValueForType(token.type, token.value)) {
        report(`Token ${id} has invalid value ${JSON.stringify(token.value)} for type ${token.type}.`);
      }
      if (!allowedStatuses.has(token.status)) {
        report(`Token ${id} status must be implemented or extension.`);
      }
      if (typeof token.documented !== "boolean") {
        report(`Token ${id} documented must be boolean.`);
      }
      if (!isNonEmptyString(token.description)) {
        report(`Token ${id} needs a description.`);
      }
      if (token.source !== undefined && !isNonEmptyString(token.source)) {
        report(`Token ${id} source must be a non-empty string when present.`);
      }
      if (token.wcag !== undefined) validateWcag(id, token.wcag);
    }
  }

  const requiredTokenValues = new Map([
    ["brand.deep-navy", "#062B68"],
    ["brand.atmosphere-cobalt", "#2F6FE9"],
    ["brand.interface-cobalt", "#5D86AE"],
    ["brand.acrylic-blue", "#D2E5F3"],
    ["brand.ice", "#F7F9FE"],
    ["color.light.surface", "#FDFDFC"],
    ["color.light.text", "#303438"],
    ["color.dark.surface", "#19232C"],
    ["color.dark.text", "#E0E8EE"],
    ["accent.cobalt", "#5D86AE"],
    ["accent.violet", "#806AB0"],
    ["accent.teal", "#3F8A87"],
    ["accent.amber", "#A57A3C"],
    ["accent.rose", "#AD6876"],
    ["spacing.2", "2px"],
    ["spacing.4", "4px"],
    ["spacing.6", "6px"],
    ["spacing.8", "8px"],
    ["spacing.12", "12px"],
    ["spacing.16", "16px"],
    ["spacing.24", "24px"],
    ["radius.control", "6px"],
    ["radius.panel", "8px"],
    ["radius.window", "18px"],
    ["motion.instant", "80ms"],
    ["motion.fast", "110ms"],
    ["motion.standard", "140ms"],
    ["motion.panel", "180ms"],
  ]);
  for (const [id, expectedValue] of requiredTokenValues) {
    if (!tokens.has(id)) report(`tokens.json is missing required token ${id}.`);
    else if (tokens.get(id).value !== expectedValue) {
      report(`Token ${id} must remain ${expectedValue}; found ${JSON.stringify(tokens.get(id).value)}.`);
    }
  }

  return tokens;
}

function attributeValues(markup, attribute) {
  const values = [];
  const expression = new RegExp(`\\b${attribute}\\s*=\\s*(["'])(.*?)\\1`, "gis");
  for (const match of markup.matchAll(expression)) values.push(match[2].trim());
  return values;
}

function stripQueryAndFragment(value) {
  return value.split("#", 1)[0].split("?", 1)[0];
}

function isExternalReference(value) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value);
}

function validateLocalReference(value, baseDirectory, label) {
  if (!value || value.startsWith("#")) return;
  if (isExternalReference(value)) {
    if (!value.startsWith("data:")) report(`${label} uses external reference ${value}; the brandbook must remain offline-capable.`);
    return;
  }
  if (value.startsWith("/")) {
    report(`${label} uses root-absolute path ${value}, which will not be portable over file://.`);
    return;
  }

  const localPath = stripQueryAndFragment(value);
  if (!localPath) return;
  const resolvedPath = resolve(baseDirectory, decodeURIComponent(localPath));
  if (!existsSync(resolvedPath)) report(`${label} points to missing asset ${value}.`);
}

function validateHtml(tokens, html) {
  if (!html) return;
  const ids = attributeValues(html, "id");
  const idCounts = new Map();
  for (const id of ids) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  for (const [id, count] of idCounts) {
    if (count > 1) report(`index.html contains duplicate id ${id} (${count} occurrences).`);
  }

  for (const href of attributeValues(html, "href")) {
    if (href === "#") {
      report("index.html contains an empty # link.");
      continue;
    }
    if (href.startsWith("#")) {
      let target;
      try {
        target = decodeURIComponent(href.slice(1));
      } catch {
        report(`index.html contains malformed internal anchor ${href}.`);
        continue;
      }
      if (!idCounts.has(target)) report(`index.html link ${href} has no matching id.`);
      continue;
    }
    validateLocalReference(href, brandbookDirectory, "index.html href");
  }

  for (const src of attributeValues(html, "src")) {
    validateLocalReference(src, brandbookDirectory, "index.html src");
  }

  const documentedIds = new Set(
    [...tokens].filter(([, token]) => token?.documented === true).map(([id]) => id),
  );
  const displayedIds = new Set(attributeValues(html, "data-token"));
  for (const id of displayedIds) {
    if (!tokens.has(id)) report(`index.html data-token references unknown token ${id}.`);
  }
  for (const id of documentedIds) {
    if (!displayedIds.has(id)) report(`Documented token ${id} is missing from index.html data-token attributes.`);
  }

  const inlineUrls = [...html.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gis)].map((match) => match[2].trim());
  for (const value of inlineUrls) validateLocalReference(value, brandbookDirectory, "index.html inline style");
}

function walk(directory) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = resolve(directory, entry);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

function validateStylesheetAssets() {
  for (const path of walk(brandbookDirectory).filter((candidate) => extname(candidate).toLowerCase() === ".css")) {
    const css = readText(path);
    for (const match of css.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gis)) {
      validateLocalReference(match[2].trim(), dirname(path), `${path.slice(repositoryDirectory.length + 1)} url()`);
    }
    for (const match of css.matchAll(/@import\s+(?:url\(\s*)?(["'])(.*?)\1/gi)) {
      validateLocalReference(match[2].trim(), dirname(path), `${path.slice(repositoryDirectory.length + 1)} @import`);
    }
  }
}

function getAttribute(tag, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "is").exec(tag);
  return match?.[2] ?? null;
}

function normalizePathData(value) {
  return value.replace(/[\s,]+/g, "");
}

function validateCanonicalSvg(tokensDocument) {
  if (!isPlainObject(tokensDocument) || !isNonEmptyString(tokensDocument.canonicalLogo)) return;
  const canonicalPath = resolve(brandbookDirectory, tokensDocument.canonicalLogo);
  const svg = readText(canonicalPath, "canonical Trace Frame SVG");
  if (!svg) return;

  const rootMatch = /<svg\b([^>]*)>([\s\S]*?)<\/svg>/i.exec(svg);
  if (!rootMatch) {
    report("Canonical Trace Frame SVG has no complete svg root element.");
    return;
  }
  const root = rootMatch[1];
  const body = rootMatch[2];
  if (getAttribute(root, "xmlns") !== "http://www.w3.org/2000/svg") {
    report("Canonical Trace Frame SVG must declare the SVG namespace.");
  }
  if ((getAttribute(root, "viewBox") ?? "").trim().replace(/\s+/g, " ") !== "0 0 64 64") {
    report("Canonical Trace Frame SVG viewBox must remain 0 0 64 64.");
  }
  if (getAttribute(root, "fill") !== "currentColor") {
    report("Canonical Trace Frame SVG must inherit fill from currentColor.");
  }
  if (getAttribute(root, "width") !== null || getAttribute(root, "height") !== null) {
    report("Canonical Trace Frame SVG must not hardcode width or height.");
  }
  if (getAttribute(root, "role") !== "img") {
    report("Canonical Trace Frame SVG must expose role=img for standalone use.");
  }

  const firstElement = /<([a-z][\w:-]*)\b([^>]*)>/i.exec(body);
  if (!firstElement || firstElement[1].toLowerCase() !== "title") {
    report("Canonical Trace Frame SVG title must be its first child element.");
  } else {
    const titleId = getAttribute(firstElement[2], "id");
    const labelledBy = (getAttribute(root, "aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
    if (!titleId || !labelledBy.includes(titleId)) {
      report("Canonical Trace Frame SVG aria-labelledby must reference the title id.");
    }
  }

  if (/<(?:script|style|image|text|foreignObject|filter|use)\b/i.test(svg)) {
    report("Canonical Trace Frame SVG must not contain scripts, styles, raster images, text nodes, filters, or use references.");
  }
  if (/\btransform\s*=/i.test(svg)) {
    report("Canonical Trace Frame SVG geometry must be flattened without transforms.");
  }

  const pathTags = [...svg.matchAll(/<path\b[^>]*>/gi)].map((match) => match[0]);
  const pathData = pathTags.map((tag) => getAttribute(tag, "d"));
  const expectedPathData = [
    "M9 9h34v8H17v26H9z",
    "M55 21v34H21v-8h26V21z",
    "M25 25h14v6H31v8h-6z",
  ];
  if (pathData.length !== expectedPathData.length || pathData.some((value) => value === null)) {
    report("Canonical Trace Frame SVG must contain exactly its three geometry paths.");
  } else {
    for (let index = 0; index < expectedPathData.length; index += 1) {
      if (normalizePathData(pathData[index]) !== normalizePathData(expectedPathData[index])) {
        report(`Canonical Trace Frame SVG path ${index + 1} geometry changed.`);
      }
    }
  }
}

function validateFrameDerivedPattern() {
  const patternPath = resolve(brandbookDirectory, "assets/frame-field.svg");
  const svg = readText(patternPath, "Frame-derived repeating field SVG");
  if (!svg) return;
  if (!/<pattern\b/i.test(svg) || !/<symbol\b/i.test(svg)) {
    report("Frame-derived repeating field SVG must define a reusable Frame symbol and pattern.");
  }
  const expectedPathData = [
    "M9 9h34v8H17v26H9z",
    "M55 21v34H21v-8h26V21z",
    "M25 25h14v6H31v8h-6z",
  ].map(normalizePathData);
  const actualPathData = [...svg.matchAll(/<path\b[^>]*>/gi)]
    .map((match) => getAttribute(match[0], "d"))
    .filter(Boolean)
    .map(normalizePathData);
  for (const expected of expectedPathData) {
    if (!actualPathData.includes(expected)) {
      report("Frame-derived repeating field SVG no longer contains the exact approved Frame geometry.");
      break;
    }
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function validateNoOnboardingAssetReuse() {
  const forbiddenPaths = [
    resolve(repositoryDirectory, "src/assets/onboarding-onramp-arrow-tile.png"),
    resolve(repositoryDirectory, "src/assets/onboarding-onramp-density.png"),
    resolve(repositoryDirectory, "src/assets/onboarding-onramp-field.png"),
  ].filter(existsSync);
  const forbiddenNames = forbiddenPaths.map((path) => path.slice(path.lastIndexOf("/") + 1));
  const forbiddenHashes = new Map(forbiddenPaths.map((path) => [sha256(path), path]));
  const textExtensions = new Set([".css", ".html", ".js", ".svg"]);

  for (const path of walk(brandbookDirectory)) {
    if (path === fileURLToPath(import.meta.url)) continue;
    const hash = sha256(path);
    if (forbiddenHashes.has(hash)) {
      report(`${path.slice(repositoryDirectory.length + 1)} duplicates forbidden onboarding asset ${forbiddenHashes.get(hash).slice(repositoryDirectory.length + 1)}.`);
    }

    if (!textExtensions.has(extname(path).toLowerCase())) continue;
    const text = readText(path);
    for (const name of forbiddenNames) {
      if (text.includes(name)) {
        report(`${path.slice(repositoryDirectory.length + 1)} references forbidden onboarding asset ${name}.`);
      }
    }
    for (const match of text.matchAll(/data:[^;,]+;base64,([a-z0-9+/=]+)/gi)) {
      try {
        const embeddedHash = createHash("sha256").update(Buffer.from(match[1], "base64")).digest("hex");
        if (forbiddenHashes.has(embeddedHash)) {
          report(`${path.slice(repositoryDirectory.length + 1)} embeds forbidden onboarding asset ${forbiddenHashes.get(embeddedHash).slice(repositoryDirectory.length + 1)}.`);
        }
      } catch {
        report(`${path.slice(repositoryDirectory.length + 1)} contains an invalid base64 data asset.`);
      }
    }
  }
}

function validateBrandbookSvgs() {
  for (const path of walk(brandbookDirectory).filter((candidate) => extname(candidate).toLowerCase() === ".svg")) {
    const svg = readText(path);
    if (/<(?:script|foreignObject|image)\b/i.test(svg)) {
      report(`${path.slice(repositoryDirectory.length + 1)} contains an unsafe or raster SVG element.`);
    }
    for (const reference of attributeValues(svg, "href")) {
      validateLocalReference(reference, dirname(path), `${path.slice(repositoryDirectory.length + 1)} href`);
    }
  }
}

const tokensDocument = parseJson(readText(tokenFile, "tokens.json"), "tokens.json");
const tokens = validateTokens(tokensDocument);
const html = readText(htmlFile, "brandbook index.html");

validateHtml(tokens, html);
validateStylesheetAssets();
validateCanonicalSvg(tokensDocument);
validateFrameDerivedPattern();
validateNoOnboardingAssetReuse();
validateBrandbookSvgs();

if (errors.length > 0) {
  console.error(`Trace brandbook validation failed with ${errors.length} ${errors.length === 1 ? "error" : "errors"}:`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exitCode = 1;
} else {
  const documentedCount = [...tokens.values()].filter((token) => token.documented).length;
  const htmlIdCount = new Set(attributeValues(html, "id")).size;
  console.log(`Trace brandbook validation passed: ${tokens.size} tokens (${documentedCount} documented), ${htmlIdCount} HTML ids, canonical Frame geometry intact.`);
}
