# macOS release workflow

Trace is packaged with electron-builder. The configuration produces a DMG and
a ZIP for the selected architecture, keeps application code in an ASAR archive,
and unpacks `node-pty` so its native binary can run. Signed builds use Apple's
hardened runtime and are notarized automatically when credentials are present.

## Local unsigned build

Install dependencies and build an unpacked app for the current Mac architecture:

```sh
npm ci
npm run package:mac:unsigned
```

The app is written under `release/`. To also create an unsigned DMG and ZIP:

```sh
npm run dist:mac:unsigned
```

Unsigned artifacts are for local testing only. macOS Gatekeeper will not treat
them as distributable software.

## Developer ID signing and notarization

Public distribution outside the Mac App Store requires membership in the Apple
Developer Program and a `Developer ID Application` certificate. For CI, export a
certificate as a password-protected `.p12` and provide it to electron-builder:

```sh
export CSC_LINK="/secure/path/DeveloperIDApplication.p12"
export CSC_KEY_PASSWORD="your-p12-password"
```

`CSC_LINK` may also use electron-builder's supported base64 or secure URL forms.
On a developer Mac, an identity already installed in the login keychain is
discovered automatically; `CSC_NAME` can select a specific identity.

The recommended notarization method is an App Store Connect API key:

```sh
export APPLE_API_KEY="/secure/path/AuthKey_ABC123DEFG.p8"
export APPLE_API_KEY_ID="ABC123DEFG"
export APPLE_API_ISSUER="00000000-0000-0000-0000-000000000000"
```

Supported alternatives are:

- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`
- a `notarytool` profile in `APPLE_KEYCHAIN_PROFILE`, with optional
  `APPLE_KEYCHAIN`

Never commit certificates, private keys, passwords, or notarization profiles.

Build each architecture separately because the app contains the native
`node-pty` module:

```sh
npm run release:mac:arm64
npm run release:mac:x64
```

The release scripts run a credential preflight, require code signing, build the
renderer, rebuild native dependencies for the requested architecture, notarize
the signed app, and create DMG and ZIP artifacts in `release/`.

## Verify an artifact

Use the actual output folder for the selected architecture:

```sh
codesign --verify --deep --strict --verbose=2 "release/mac-arm64/Trace.app"
spctl --assess --type execute --verbose=4 "release/mac-arm64/Trace.app"
xcrun stapler validate "release/mac-arm64/Trace.app"
```

Test both a clean install from the DMG and first launch on a Mac that has never
run an unsigned development copy.

## Identity decisions before the first public release

- Confirm `com.trace.desktop` as the permanent bundle identifier. Changing it
  later changes macOS's identity for the app and can disrupt stored permissions.
- Add approved artwork as `build/icon.icns` or `build/icon.icon`. The repository
  intentionally ships no invented placeholder brand; local builds use Electron's
  default icon until real artwork exists.
- Add the legal publisher or company as the `author` in `package.json`; it is
  intentionally omitted until that identity is known.
- Set the final version in `package.json`. Artifact names include product name,
  version, and CPU architecture.
