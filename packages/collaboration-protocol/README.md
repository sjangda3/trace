# `@trace/collaboration-protocol`

Transport-neutral JSON contracts for Trace collaboration. The package defines wire types, a strict JSON Schema, bounded runtime validators, replay envelopes, and protocol-version negotiation. It does not choose WebSocket, WebRTC, HTTP, a database, or a hosting provider.

The protocol deliberately does **not** contain CRDT operations, operational transforms, vector clocks, or automatic text merging. Live editor authority is coordinated with compare-and-swap writer leases and monotonic fencing counters. Offline text is carried as an explicit recovery draft that a person can inspect and reconcile.

## Messages

Every post-negotiation message uses protocol version `1.0` and is one of:

| Message | Purpose |
| --- | --- |
| `protocol.hello`, `protocol.accept`, `protocol.reject` | Negotiate a mutually supported version before room traffic. |
| `snapshot` | Establish bounded room state at a durable sequence and replay cursor. |
| `replay.request` | Request durable events after an opaque cursor. |
| `command` | Carry a validated client command with a request ID. |
| Durable `event` | Carry authoritative, ordered room changes with sequence and cursors. |
| Ephemeral `event` | Carry live state or acknowledgements that are not replayed. |

Room snapshots contain members, presence, annotations and replies, writer-control states, and recovery-draft summaries. Full recovery draft content only appears in a bounded `recovery.draft.put` command.

## Delivery and offline rules

Commands carry both `delivery` and `queuePolicy`. Both fields are schema constants for each command type, so changing only a flag cannot turn an unsafe live command into an offline mutation.

Queueable commands:

- annotation create, update, reply, resolve, and delete;
- recovery draft put and delete.

Never queue or replay:

- presence publication;
- writer-control CAS;
- terminal-control requests;
- terminal input.

`isQueueableCommand()` implements this allowlist. In particular, terminal input always requires `delivery: "ephemeral"` and `queuePolicy: "never"`. A disconnected client must discard unsent terminal input rather than apply it later in a different shell state.

## Writer control and fencing

`writer.control.cas` includes the resource, expected state version, expected monotonic fence, desired owner client, and requested lease duration. The authoritative service must atomically compare both the version and fence before changing ownership. Acquiring control uses a positive lease; releasing it uses a `null` desired owner and a zero lease.

`WriterControlState` also carries a bounded `typingCount` and `typingUntil` idle deadline. Services can use this authoritative state to enforce the room policy that control cannot transfer while anyone is typing; a positive count requires both an owner and an idle deadline. The protocol’s intentional typing-idle window is exactly 900 ms, exported as `WRITER_TYPING_IDLE_MS`. The authoritative service should refresh `typingUntil` from server time on each accepted typing pulse and clear the count when that deadline passes.

Writer resources can represent:

- `{ kind: "workspace", channel: "editor" }` for the product’s room-wide single-editor policy;
- `{ kind: "editor", filePath }` if a future room intentionally uses per-file authority;
- `{ kind: "terminal", sessionId }` for shared terminal input.

Every release, expiry, revocation, or disconnect increases the non-negative fencing counter. A process that accepts editor or terminal writes must compare the supplied fence to the current value at the point of use. A stale owner can therefore no longer write even if its disconnect was delayed.

CAS and terminal requests include client IDs for comparison, but authentication is outside this package. A server must derive the acting member and client from the authenticated connection and must reject attempts to acquire authority for an unrelated client.

## Durable event replay

Durable events have:

- a positive, monotonically increasing room `sequence`;
- an opaque `cursor`;
- the preceding cursor, or `null` for the first retained event.

Clients should persist the last applied cursor only after applying the event. A sequence gap or cursor mismatch requires `replay.request`; if the cursor is outside retention, the server should send a fresh snapshot. Presence and command acknowledgements use the ephemeral stream and have `null` sequence/cursor fields.

The durable event types are annotation changes, writer-control changes, fence advances, and recovery-draft changes. Runtime validation rejects these on the ephemeral stream and rejects acknowledgements or presence on the durable stream.

## Annotation and recovery identity

Annotation mutations carry idempotent mutation IDs and optimistic annotation revisions. Acknowledgements distinguish `applied`, `duplicate`, `conflict`, and `rejected`. Annotation anchors contain workspace-relative paths, bounded code ranges, a nullable canonical 40/64-hex Git OID, and a mandatory nullable lowercase SHA-256 content hash. The hash is preserved in tombstones so clients can continue to identify stale ranges after deletion.

Clients do not submit annotation author IDs. The authoritative service supplies author/member identity from the authenticated room session.

Recovery drafts are bounded full UTF-8 documents, not patches. A put command includes byte size and SHA-256 metadata but omits `authorMemberId`; the service derives it. Receivers must recompute and verify `contentSha256` before persistence. A mismatched base revision is a recovery decision, not an automatic merge instruction.

## Validation

```ts
import {
  parseWireMessage,
  validateCommandEnvelope,
  isQueueableCommand,
} from "@trace/collaboration-protocol";

const decoded = parseWireMessage(webSocketBytes);
if (!decoded.ok) {
  console.warn(decoded.issues);
  return;
}

if (decoded.value.kind === "command") {
  const checked = validateCommandEnvelope(decoded.value);
  if (checked.ok && isQueueableCommand(checked.value.payload)) {
    // Persist only the explicitly allowlisted offline mutation.
  }
}
```

Validation has two layers:

1. Draft 2020-12 JSON Schema with required fields, discriminated unions, `additionalProperties: false`, string/array bounds, and constant delivery policies.
2. Semantic checks for UTF-8 byte sizes, canonical relative paths, chronological ranges, unique snapshot identities, writer lease coherence, stream policy, and recovery content size.

`parseWireMessage()` checks the encoded frame limit before JSON parsing and uses fatal UTF-8 decoding. Validation issues are capped and never echo submitted content. The root schema is exported as `wireMessageSchema` and as the package subpath `@trace/collaboration-protocol/schemas/wire-message.json` after build.

The default bounds are exported as `PROTOCOL_LIMITS`, including a 1.5 MB frame, 1 MiB recovery draft, 64 KiB terminal input, 16 KiB annotation context, and 4 KiB reply.

Schema validation is not authorization. Services must still authenticate the connection, verify room membership, enforce roles, verify GitHub installation access, compare writer fences transactionally, and rate-limit commands.

## Versioning

The client sends an ordered list of supported versions. `negotiateProtocolVersion()` chooses the first local preference also offered by the peer. An envelope with an unselected version is invalid.

Within `1.0`, fields are intentionally closed. Adding an optional field still requires a protocol/schema release because older strict peers will reject it. Breaking semantics or changing required fields requires a new negotiated version.

## Standalone development

Node.js 20.10 or newer is required because the compiled ESM package uses standard JSON import attributes for its published schema.

From this directory:

```sh
npm install
npm run typecheck
npm test
npm run build
```

The package has no dependency on the desktop renderer, Electron main process, collaboration service, or root project configuration.
