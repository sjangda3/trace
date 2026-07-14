# Collaboration protocol

Trace uses a fenced single-writer model. Any invited member may request control, but only one member may produce canonical code edits at a time. This is intentionally not a CRDT: ownership, replay, and audit behavior stay explicit.

## Product contract

- Online work has one canonical writer for code and one writer per terminal.
- A control handoff is allowed only after the current writer has been idle for 900 ms.
- Control ownership carries a monotonically increasing fence. Delayed edits from a former writer are rejected.
- Non-writers may navigate, select, copy, inspect Git, and leave annotations.
- Offline code changes remain local recovery drafts until reconnect. A network partition cannot honestly preserve both global single-writer exclusivity and automatic offline writes.
- Offline annotations and replies are queued with idempotent mutation IDs and replayed after reconnect.
- Every code annotation keeps both an optional Git revision and a SHA-256 content anchor; the desktop refuses to highlight an old line range after the file content changes.
- Terminal input is never queued or replayed.

## Desktop boundary

The renderer talks only to a narrow `collabCollaboration` preload bridge. Electron main owns:

- authenticated member identity;
- room/workspace binding;
- exclusive-control state and fences;
- the authoritative ownership check for filesystem writes and Git mutations;
- the durable annotation outbox and code recoveries;
- WebSocket credentials and reconnect logic;
- validation of every workspace-relative path and payload.

The local absolute workspace path never leaves Electron. The cloud service receives a server-issued room ID instead.

## Control state

Each code workspace and terminal has an independent control record:

```text
resource
holder
version
fence
typingCount
typingUntil
```

Control acquisition is compare-and-swap against `version`. Every ownership change increments both `version` and `fence`. Accepted input moves the resource into a typing state; the injected clock releases that typing state after 900 ms of inactivity.

The renderer's Monaco `readOnly` state is only a user-experience guard. Electron main serializes file create/save/rename/delete and Git mutations through the workspace control record, asserts the local owner, and marks that owner as typing before executing the mutation. Release requests include both the observed `version` and `fence`; main rejects a stale request or any release while `typingCount` is non-zero.

Every canonical edit carries:

```text
operationId
controlFence
expectedControlVersion
baseDocumentVersion
baseContentHash
path
UTF-16 edits
```

The service rejects stale fences, duplicate operations, version gaps, invalid paths, and oversized edits.

## Offline behavior

| Data | Offline policy |
| --- | --- |
| Presence | Discard |
| Control requests | Do not queue |
| Terminal input | Do not queue |
| Annotation create/reply | Queue idempotently |
| Resolve/reopen | Queue with expected version |
| Code edits | Preserve a recovery snapshot |

On reconnect, Trace fetches the authoritative document. If the recovery base still matches, it may submit the accumulated diff after acquiring control. Otherwise it opens a three-way recovery view; it never silently overwrites either version.

## Shared terminal boundary

The current local `node-pty` terminal runs as the Mac user and must not be exposed to remote invitees. Production shared terminals run inside the sandboxed cloud workspace agent. The desktop terminal protocol remains responsible for output backpressure and rendering, while the cloud agent owns PTY lifecycle and canonical output replay.

## Cloud shape

```text
Electron app
  -> HTTPS control plane (accounts, invites, workspace metadata)
  -> WebSocket collaboration gateway (presence, control, event replay)
  -> sandboxed workspace agent (files, Git, PTYs)
  -> PostgreSQL event/outbox state + object storage snapshots
```

The WebSocket uses an authorization header, fixed TLS origin, bounded frames, idempotent operation IDs, monotonic room sequence numbers, and membership checks on every operation.

## GitHub-linked annotations

Workspace annotations stay private by default. Only annotations explicitly linked to a GitHub pull request or issue are published:

- pull request code feedback maps to an inline review comment when its immutable commit/range is valid;
- issue-linked code feedback maps to a normal issue comment while Trace retains the private code anchor;
- the returned GitHub comment/thread ID is persisted before acknowledging sync, preventing duplicates.
