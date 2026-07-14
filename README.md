# Trace

Trace is a macOS-first, collaboration-focused desktop IDE. It uses a native-feeling Electron shell, Monaco for editing, xterm/node-pty for terminals, and main-process services for filesystem, Git, GitHub, and local-first annotations.

This repository contains a working desktop foundation—not a web app—plus separately runnable cloud protocol and control-plane packages. Remote room sockets and sandbox workers remain separate from the downloadable client so local files, credentials, and the Mac user's shell are never exposed directly to teammates.

## Implemented

- Reference-matched macOS window, functional file tree, tabs, navigation history, breadcrumbs, command shortcuts, and status bar
- Real folder opening, file reads/writes, create/rename/delete, watching, dirty-file recovery, and external-change handling
- Bounded native workspace text search with case/whole-word modes, safe file filtering, cancellation, and exact match selection
- Monaco editing for the requested core languages plus the common application-development formats Monaco supports
- An honest built-in language-support panel instead of a simulated extension marketplace
- Multiple native terminal sessions with bounded replay/backpressure and fenced single-writer input control
- Native Git status, diffs, stage/unstage, commits, branches, history, and conflict reporting
- GitHub App Device Flow, pull requests, issues, review threads, and revision-safe click-to-highlight
- Local-first code annotations with replies, resolve/reopen, Git and content-hash anchors, idempotent outbox persistence, and restart recovery
- Fenced workspace control enforced in Electron main for filesystem and Git mutations, with a 900 ms typing-idle handoff rule
- Workspace presence/control UI that clearly labels local/offline state until a cloud room is connected
- Transport-neutral collaboration schemas/validators and a standalone Fastify/PostgreSQL workspace, membership, invite, and room-snapshot control-plane slice
- Unsigned local macOS app, DMG, and ZIP packaging; signing/notarization scripts for public distribution

## Run the desktop app

```sh
npm ci
npm run dev
```

To run the last production renderer build:

```sh
npm run build

(cd packages/collaboration-protocol && npm test)
(cd services/control-plane && npm test)
npm start
```

## Validate

```sh
npm run typecheck
npm test
npm run build
```

## Build for macOS

```sh
npm run package:mac:unsigned
npm run dist:mac:unsigned
```

Unsigned output is written to `release/`. Public releases require an Apple Developer ID, notarization credentials, final bundle identity, and approved artwork. See [docs/MAC_RELEASE.md](docs/MAC_RELEASE.md).

## Architecture

- [DESIGN.md](DESIGN.md) defines the visual geometry, typography, color, and composition rules.
- [docs/COLLABORATION_PROTOCOL.md](docs/COLLABORATION_PROTOCOL.md) defines the non-CRDT, fenced single-writer contract.
- [docs/CLOUD_ARCHITECTURE.md](docs/CLOUD_ARCHITECTURE.md) separates implemented local behavior from the cloud room, sandbox, invite, and sync services still required for real remote collaboration.
- [packages/collaboration-protocol](packages/collaboration-protocol/README.md) contains the strict, transport-neutral room protocol.
- [services/control-plane](services/control-plane/README.md) contains the independently runnable workspace/invite/membership API.
- [docs/GITHUB_APP_SETUP.md](docs/GITHUB_APP_SETUP.md) covers the GitHub App configuration.

Local `node-pty` terminals are intentionally private to the Mac. A real shared terminal must run inside a dedicated cloud sandbox with its own per-terminal control fence; it must never proxy the user's local shell to invited teammates.
