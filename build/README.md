# macOS build resources

The release scaffold deliberately does not include a fabricated application icon.
Until the product identity is final, electron-builder uses Electron's default icon
for local packages.

Before the first public release, add the approved macOS icon as either:

- `build/icon.icns`
- `build/icon.icon` (an Icon Composer asset)

electron-builder discovers either filename automatically. Keep the source artwork
outside this directory and generate the release asset from that canonical source.
