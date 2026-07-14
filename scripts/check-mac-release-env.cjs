"use strict";

const { execFileSync } = require("node:child_process");

function hasValue(name) {
  return typeof process.env[name] === "string" && process.env[name].trim().length > 0;
}

function hasInstalledDeveloperId() {
  try {
    const output = execFileSync(
      "/usr/bin/security",
      ["find-identity", "-v", "-p", "codesigning"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );

    return output.includes("Developer ID Application:");
  } catch {
    return false;
  }
}

function validateCredentialGroup(label, names) {
  const configured = names.filter(hasValue);
  if (configured.length > 0 && configured.length < names.length) {
    const missing = names.filter((name) => !hasValue(name));
    throw new Error(`${label} credentials are incomplete; missing ${missing.join(", ")}.`);
  }

  return configured.length === names.length;
}

function main() {
  if (process.platform !== "darwin") {
    throw new Error("macOS releases must be built on macOS.");
  }

  const hasSigningIdentity =
    hasValue("CSC_LINK") || hasValue("CSC_NAME") || hasInstalledDeveloperId();
  if (!hasSigningIdentity) {
    throw new Error(
      "No Developer ID Application identity found. Set CSC_LINK (and CSC_KEY_PASSWORD when needed), set CSC_NAME, or import the certificate into the keychain.",
    );
  }

  const hasApiKey = validateCredentialGroup("App Store Connect API key", [
    "APPLE_API_KEY",
    "APPLE_API_KEY_ID",
    "APPLE_API_ISSUER",
  ]);
  const hasAppleId = validateCredentialGroup("Apple ID", [
    "APPLE_ID",
    "APPLE_APP_SPECIFIC_PASSWORD",
    "APPLE_TEAM_ID",
  ]);
  const hasKeychainProfile = hasValue("APPLE_KEYCHAIN_PROFILE");

  if (!hasApiKey && !hasAppleId && !hasKeychainProfile) {
    throw new Error(
      "No notarization credentials found. Configure the App Store Connect API key trio, the Apple ID trio, or APPLE_KEYCHAIN_PROFILE.",
    );
  }

  process.stdout.write("macOS signing and notarization prerequisites are configured.\n");
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`macOS release preflight failed: ${message}\n`);
  process.exitCode = 1;
}
