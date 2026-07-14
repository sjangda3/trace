import { readdirSync, readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  PROTOCOL_LIMITS,
  PROTOCOL_SCHEMA_ID,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  WRITER_TYPING_IDLE_MS,
  assertValidWireMessage,
  isQueueableCommand,
  negotiateProtocolVersion,
  parseWireMessage,
  serializeWireMessage,
  validateCommandEnvelope,
  validateEventEnvelope,
  validateNegotiationMessage,
  validateRoomSnapshot,
  validateSnapshotEnvelope,
  validateWireMessage,
  wireMessageSchema,
  type Annotation,
  type CommandEnvelope,
  type EventEnvelope,
  type RecoveryDraftPutMutation,
  type RoomSnapshot,
  type SnapshotEnvelope,
  type TerminalInputCommand,
  type WriterControlState,
} from "../src/index.js";

const timestamp = "2026-07-13T20:00:00.000Z";
const laterTimestamp = "2026-07-13T20:00:01.000Z";
const roomId = "room:trace";

function annotation(): Annotation {
  return {
    id: "annotation-0001",
    filePath: "src/editor.ts",
    context: "Guard the writer lease before applying this edit.",
    range: { startLine: 10, startColumn: 2, endLine: 12, endColumn: 8 },
    authorMemberId: "member:ada",
    authorDisplayName: "Ada Lovelace",
    createdAt: timestamp,
    updatedAt: laterTimestamp,
    updatedByMemberId: "member:grace",
    resolved: false,
    resolvedAt: null,
    resolvedByMemberId: null,
    githubLink: {
      kind: "pull_request",
      owner: "octo-org",
      repository: "trace",
      number: 17,
      commentId: "9007",
      reviewThreadId: "PRRT_kwDOBounded_1",
    },
    anchorRevision: "a".repeat(40),
    anchorContentHash: "b".repeat(64),
    replies: [{
      id: "reply-0001",
      context: "I can cover the disconnect edge case.",
      authorMemberId: "member:grace",
      authorDisplayName: "Grace Hopper",
      createdAt: laterTimestamp,
    }],
    revision: 2,
  };
}

function terminalWriterState(): WriterControlState {
  return {
    resource: { kind: "terminal", sessionId: "terminal-0001" },
    version: 3,
    fence: 3,
    ownerMemberId: "member:ada",
    ownerClientId: "client:ada:mac",
    leaseExpiresAt: "2026-07-13T20:01:00.000Z",
    typingCount: 0,
    typingUntil: null,
  };
}

function roomSnapshot(): RoomSnapshot {
  return {
    roomId,
    snapshotVersion: 7,
    generatedAt: laterTimestamp,
    repository: {
      provider: "github",
      owner: "octo-org",
      name: "trace",
      defaultBranch: "main",
    },
    members: [
      { memberId: "member:ada", displayName: "Ada Lovelace", role: "owner", joinedAt: timestamp },
      { memberId: "member:grace", displayName: "Grace Hopper", role: "member", joinedAt: timestamp },
    ],
    presence: [{
      memberId: "member:ada",
      clientId: "client:ada:mac",
      status: "active",
      activePath: "src/editor.ts",
      cursor: { startLine: 10, startColumn: 2, endLine: 10, endColumn: 2 },
      typing: true,
      lastSeenAt: laterTimestamp,
    }],
    annotations: [annotation()],
    writerControls: [terminalWriterState()],
    recoveryDrafts: [{
      draftId: "draft-0001",
      filePath: "src/offline.ts",
      baseRevision: "b".repeat(40),
      contentSha256: "c".repeat(64),
      sizeBytes: 0,
      authorMemberId: "member:ada",
      createdAt: timestamp,
      updatedAt: laterTimestamp,
    }],
  };
}

function snapshotEnvelope(): SnapshotEnvelope {
  return {
    kind: "snapshot",
    protocolVersion: PROTOCOL_VERSION,
    roomId,
    sequence: 42,
    cursor: "cursor:42",
    emittedAt: laterTimestamp,
    snapshot: roomSnapshot(),
  };
}

function annotationCommand(): CommandEnvelope {
  return {
    kind: "command",
    protocolVersion: PROTOCOL_VERSION,
    roomId,
    requestId: "request-0001",
    sentAt: timestamp,
    payload: {
      type: "annotation.create",
      delivery: "durable",
      queuePolicy: "offline_allowed",
      mutationId: "mutation-0001",
      annotationId: "annotation-0002",
      filePath: "src/control.ts",
      context: "Only apply after the writer fence has advanced.",
      range: { startLine: 4, startColumn: 1, endLine: 4, endColumn: 20 },
      githubLink: null,
      anchorRevision: "d".repeat(40),
      anchorContentHash: "e".repeat(64),
      createdAt: timestamp,
    },
  };
}

function ephemeralEvent(payload: EventEnvelope["payload"]): EventEnvelope {
  return {
    kind: "event",
    protocolVersion: PROTOCOL_VERSION,
    roomId,
    eventId: "event-0001",
    emittedAt: laterTimestamp,
    stream: "ephemeral",
    sequence: null,
    cursor: null,
    previousCursor: null,
    payload,
  };
}

function durableEvent(payload: EventEnvelope["payload"]): EventEnvelope {
  return {
    kind: "event",
    protocolVersion: PROTOCOL_VERSION,
    roomId,
    eventId: "event-0002",
    emittedAt: laterTimestamp,
    stream: "durable",
    sequence: 43,
    cursor: "cursor:43",
    previousCursor: "cursor:42",
    payload,
  };
}

describe("protocol schemas and negotiation", () => {
  it("compiles every published category schema in strict draft-2020 mode", () => {
    const schemaDirectory = new URL("../src/schemas/", import.meta.url);
    const ajv = new Ajv2020({ strict: true, allErrors: true, ownProperties: true });
    ajv.addSchema(wireMessageSchema);
    const categoryFiles = readdirSync(schemaDirectory)
      .filter((name) => name.endsWith(".schema.json") && name !== "wire-message.schema.json")
      .sort();
    expect(categoryFiles).toHaveLength(8);
    for (const fileName of categoryFiles) {
      const schema = JSON.parse(readFileSync(new URL(fileName, schemaDirectory), "utf8"));
      expect(() => ajv.compile(schema), fileName).not.toThrow();
    }
  });

  it("exports a strict draft-2020 schema and negotiates the highest local preference", () => {
    expect(PROTOCOL_SCHEMA_ID).toBe("https://trace.dev/schemas/collaboration-protocol-v1.json");
    expect(wireMessageSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(SUPPORTED_PROTOCOL_VERSIONS).toEqual(["1.0"]);
    expect(negotiateProtocolVersion(["2.0", "1.0"])).toBe("1.0");
    expect(negotiateProtocolVersion(["2.0"])).toBeNull();
    expect(negotiateProtocolVersion(["1.0", "1.0"])).toBeNull();
  });

  it("validates hello/accept messages and rejects unknown fields or versions", () => {
    const hello = {
      kind: "protocol.hello",
      supportedVersions: ["1.0", "2.0"],
      clientInstanceId: "client:ada:mac",
      appVersion: "0.1.0",
      platform: "macos",
      resume: { roomId, cursor: "cursor:42" },
    };
    expect(validateNegotiationMessage(hello)).toEqual({ ok: true, value: hello });
    expect(validateWireMessage({ ...hello, secret: "must-not-pass" }).ok).toBe(false);
    expect(validateWireMessage({
      kind: "protocol.accept",
      version: "2.0",
      connectionId: "connection-0001",
      serverTime: timestamp,
      heartbeatMs: 15_000,
      maxFrameBytes: PROTOCOL_LIMITS.maxFrameBytes,
      resumeStatus: "accepted",
    }).ok).toBe(false);
  });
});

describe("room snapshots and presence", () => {
  it("accepts a bounded, internally consistent snapshot", () => {
    expect(validateRoomSnapshot(roomSnapshot())).toMatchObject({ ok: true });
    expect(validateSnapshotEnvelope(snapshotEnvelope())).toMatchObject({ ok: true });
    expect(validateWireMessage(snapshotEnvelope())).toMatchObject({ ok: true });
  });

  it("rejects path traversal, invalid ranges, duplicate identities, and incoherent offline presence", () => {
    const snapshot = roomSnapshot();
    snapshot.members.push({ ...snapshot.members[0]! });
    snapshot.presence[0] = {
      ...snapshot.presence[0]!,
      status: "offline",
      activePath: "src/editor.ts",
      typing: true,
    };
    snapshot.annotations[0]!.range = { startLine: 12, startColumn: 1, endLine: 10, endColumn: 1 };
    const result = validateRoomSnapshot(snapshot);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((entry) => entry.keyword === "uniqueId")).toBe(true);
      expect(result.issues.some((entry) => entry.keyword === "offlinePresence" || entry.keyword === "pattern")).toBe(true);
      expect(result.issues.some((entry) => entry.keyword === "rangeOrder")).toBe(true);
    }
    const traversing = roomSnapshot();
    traversing.presence[0] = { ...traversing.presence[0]!, activePath: "../secrets.ts" };
    expect(validateRoomSnapshot(traversing)).toMatchObject({ ok: false });
  });

  it("rejects partial writer ownership and a mismatched snapshot room", () => {
    const snapshot = roomSnapshot();
    snapshot.writerControls[0] = {
      ...snapshot.writerControls[0]!,
      ownerClientId: null,
    };
    expect(validateRoomSnapshot(snapshot)).toMatchObject({ ok: false });
    expect(validateSnapshotEnvelope({ ...snapshotEnvelope(), roomId: "room:other" })).toMatchObject({ ok: false });
  });

  it("accepts an initial sequence-zero snapshot and rejects incoherent writer typing state", () => {
    const initialSnapshot = roomSnapshot();
    initialSnapshot.snapshotVersion = 0;
    expect(validateRoomSnapshot(initialSnapshot)).toMatchObject({ ok: true });
    const initialEnvelope = snapshotEnvelope();
    initialEnvelope.sequence = 0;
    initialEnvelope.cursor = "cursor:0";
    initialEnvelope.snapshot.snapshotVersion = 0;
    expect(validateSnapshotEnvelope(initialEnvelope)).toMatchObject({ ok: true });

    const incoherent = roomSnapshot();
    incoherent.writerControls[0] = {
      ...incoherent.writerControls[0]!,
      typingCount: 1,
      typingUntil: null,
    };
    const result = validateRoomSnapshot(incoherent);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((entry) => entry.keyword === "typingState")).toBe(true);
    }

    const activelyTyping = roomSnapshot();
    activelyTyping.writerControls[0] = {
      ...activelyTyping.writerControls[0]!,
      typingCount: 1,
      typingUntil: laterTimestamp,
    };
    expect(validateRoomSnapshot(activelyTyping)).toMatchObject({ ok: true });
    expect(WRITER_TYPING_IDLE_MS).toBe(900);
  });

  it("keeps presence publication and events ephemeral", () => {
    const command: CommandEnvelope = {
      kind: "command",
      protocolVersion: PROTOCOL_VERSION,
      roomId,
      requestId: "request-presence-0001",
      sentAt: timestamp,
      payload: {
        type: "presence.publish",
        delivery: "ephemeral",
        queuePolicy: "never",
        status: "active",
        activePath: "src/editor.ts",
        cursor: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
        typing: false,
      },
    };
    expect(validateCommandEnvelope(command)).toMatchObject({ ok: true });
    expect(isQueueableCommand(command.payload)).toBe(false);
    expect(validateEventEnvelope(ephemeralEvent({
      type: "presence.changed",
      presence: roomSnapshot().presence[0]!,
    }))).toMatchObject({ ok: true });
  });
});

describe("offline-safe annotation and recovery commands", () => {
  it("accepts durable annotation mutations and marks only explicitly durable commands queueable", () => {
    const command = annotationCommand();
    expect(validateCommandEnvelope(command)).toMatchObject({ ok: true });
    expect(validateWireMessage(command)).toMatchObject({ ok: true });
    expect(isQueueableCommand(command.payload)).toBe(true);

    const terminal: TerminalInputCommand = {
      type: "terminal.input",
      delivery: "ephemeral",
      queuePolicy: "never",
      sessionId: "terminal-0001",
      inputSequence: 1,
      fence: 3,
      encoding: "utf8",
      data: "npm test\r",
    };
    expect(isQueueableCommand(terminal)).toBe(false);
  });

  it("requires nullable canonical SHA-256 anchor hashes on creates, records, and tombstones", () => {
    const command = annotationCommand();
    if (command.payload.type !== "annotation.create") throw new Error("Expected annotation.create fixture.");
    const { anchorContentHash: _omitted, ...createWithoutHash } = command.payload;
    expect(validateCommandEnvelope({ ...command, payload: createWithoutHash })).toMatchObject({ ok: false });
    expect(validateCommandEnvelope({
      ...command,
      payload: { ...command.payload, anchorContentHash: "A".repeat(64) },
    })).toMatchObject({ ok: false });
    expect(validateCommandEnvelope({
      ...command,
      payload: { ...command.payload, anchorContentHash: null },
    })).toMatchObject({ ok: true });

    const update: CommandEnvelope = {
      ...command,
      requestId: "request-update-hash-0001",
      payload: {
        type: "annotation.update",
        delivery: "durable",
        queuePolicy: "offline_allowed",
        mutationId: "mutation-update-hash-0001",
        annotationId: "annotation-0001",
        expectedRevision: 2,
        patch: { anchorContentHash: "f".repeat(64) },
      },
    };
    expect(validateCommandEnvelope(update)).toMatchObject({ ok: true });
    expect(validateCommandEnvelope({
      ...update,
      payload: { ...update.payload, patch: { anchorContentHash: "not-a-sha256" } },
    })).toMatchObject({ ok: false });

    const invalidSnapshot = roomSnapshot();
    invalidSnapshot.annotations[0] = {
      ...invalidSnapshot.annotations[0]!,
      anchorContentHash: "F".repeat(64),
    };
    expect(validateRoomSnapshot(invalidSnapshot)).toMatchObject({ ok: false });

    const deleteEvent = durableEvent({
      type: "annotation.changed",
      mutationId: "mutation-delete-0001",
      operation: "delete",
      annotation: null,
      tombstone: {
        id: "annotation-0001",
        filePath: "src/editor.ts",
        githubLink: null,
        anchorRevision: "a".repeat(40),
        anchorContentHash: "b".repeat(64),
        deletedAt: laterTimestamp,
        deletedByMemberId: "member:ada",
        revision: 3,
      },
    });
    expect(validateEventEnvelope(deleteEvent)).toMatchObject({ ok: true });
    if (deleteEvent.payload.type !== "annotation.changed" || deleteEvent.payload.tombstone === null) {
      throw new Error("Expected annotation delete fixture.");
    }
    const { anchorContentHash: _deletedHash, ...tombstoneWithoutHash } = deleteEvent.payload.tombstone;
    expect(validateEventEnvelope({
      ...deleteEvent,
      payload: { ...deleteEvent.payload, tombstone: tombstoneWithoutHash },
    })).toMatchObject({ ok: false });
  });

  it("validates full recovery drafts without defining merge or CRDT operations", () => {
    const content = "const local = 'offline';\n";
    const payload: RecoveryDraftPutMutation = {
      type: "recovery.draft.put",
      delivery: "durable",
      queuePolicy: "offline_allowed",
      mutationId: "mutation-draft-0001",
      draft: {
        draftId: "draft-0002",
        filePath: "src/local.ts",
        baseRevision: "e".repeat(40),
        contentSha256: "f".repeat(64),
        sizeBytes: new TextEncoder().encode(content).byteLength,
        createdAt: timestamp,
        updatedAt: timestamp,
        encoding: "utf8",
        content,
      },
    };
    const command: CommandEnvelope<RecoveryDraftPutMutation> = {
      kind: "command",
      protocolVersion: PROTOCOL_VERSION,
      roomId,
      requestId: "request-draft-0001",
      sentAt: timestamp,
      payload,
    };
    expect(validateCommandEnvelope(command)).toMatchObject({ ok: true });
    expect(isQueueableCommand(payload)).toBe(true);

    expect(validateCommandEnvelope({
      ...command,
      payload: { ...payload, draft: { ...payload.draft, sizeBytes: payload.draft.sizeBytes + 1 } },
    })).toMatchObject({ ok: false });
    expect(validateCommandEnvelope({
      ...command,
      payload: { ...payload, operations: [{ retain: 4 }] },
    })).toMatchObject({ ok: false });
  });
});

describe("writer fences, terminal input, and stream policy", () => {
  it("accepts CAS writer control but never permits it in the offline queue", () => {
    const command: CommandEnvelope = {
      kind: "command",
      protocolVersion: PROTOCOL_VERSION,
      roomId,
      requestId: "request-writer-0001",
      sentAt: timestamp,
      payload: {
        type: "writer.control.cas",
        delivery: "ephemeral",
        queuePolicy: "never",
        resource: { kind: "editor", filePath: "src/editor.ts" },
        expectedVersion: 2,
        expectedFence: 2,
        desiredOwnerClientId: "client:ada:mac",
        leaseMs: 30_000,
      },
    };
    expect(validateCommandEnvelope(command)).toMatchObject({ ok: true });
    expect(isQueueableCommand(command.payload)).toBe(false);
    expect(validateCommandEnvelope({
      ...command,
      payload: { ...command.payload, delivery: "durable", queuePolicy: "offline_allowed" },
    })).toMatchObject({ ok: false });
    expect(validateCommandEnvelope({
      ...command,
      payload: {
        ...command.payload,
        desiredOwnerClientId: null,
        leaseMs: 0,
      },
    })).toMatchObject({ ok: true });
    expect(validateCommandEnvelope({
      ...command,
      payload: {
        ...command.payload,
        desiredOwnerClientId: null,
        leaseMs: 30_000,
      },
    })).toMatchObject({ ok: false });
    expect(validateCommandEnvelope({
      ...command,
      payload: { ...command.payload, leaseMs: 0 },
    })).toMatchObject({ ok: false });
  });

  it("requires fence changes and durable sequencing for authoritative writer events", () => {
    const event = durableEvent({
      type: "writer.fence.advanced",
      resource: { kind: "editor", filePath: "src/editor.ts" },
      version: 4,
      previousFence: 3,
      fence: 4,
      revokedClientId: "client:grace:mac",
      reason: "revocation",
    });
    expect(validateEventEnvelope(event)).toMatchObject({ ok: true });
    expect(validateEventEnvelope({
      ...event,
      payload: { ...event.payload, fence: 3 },
    })).toMatchObject({ ok: false });
    expect(validateEventEnvelope({
      ...event,
      stream: "ephemeral",
      sequence: null,
      cursor: null,
      previousCursor: null,
    })).toMatchObject({ ok: false });
  });

  it("forces terminal input to be ephemeral/never-queued and enforces UTF-8 byte limits", () => {
    const payload: TerminalInputCommand = {
      type: "terminal.input",
      delivery: "ephemeral",
      queuePolicy: "never",
      sessionId: "terminal-0001",
      inputSequence: 8,
      fence: 3,
      encoding: "utf8",
      data: "😀".repeat(20_000),
    };
    const command: CommandEnvelope<TerminalInputCommand> = {
      kind: "command",
      protocolVersion: PROTOCOL_VERSION,
      roomId,
      requestId: "request-terminal-0001",
      sentAt: timestamp,
      payload,
    };
    expect(payload.data.length).toBeLessThan(65_536);
    expect(new TextEncoder().encode(payload.data).byteLength).toBeGreaterThan(65_536);
    expect(validateCommandEnvelope(command)).toMatchObject({ ok: false });
    expect(validateCommandEnvelope({
      ...command,
      payload: { ...payload, data: "ls\r", delivery: "durable", queuePolicy: "offline_allowed" },
    })).toMatchObject({ ok: false });
  });

  it("validates terminal control and its conditional acknowledgement without making either replayable", () => {
    const command: CommandEnvelope = {
      kind: "command",
      protocolVersion: PROTOCOL_VERSION,
      roomId,
      requestId: "request-terminal-control-0001",
      sentAt: timestamp,
      payload: {
        type: "terminal.control",
        delivery: "ephemeral",
        queuePolicy: "never",
        sessionId: "terminal-0001",
        action: "request",
        expectedVersion: 2,
        expectedFence: 2,
      },
    };
    expect(validateCommandEnvelope(command)).toMatchObject({ ok: true });
    expect(isQueueableCommand(command.payload)).toBe(false);
    const ack = ephemeralEvent({
      type: "terminal.control.ack",
      requestId: command.requestId,
      status: "applied",
      state: terminalWriterState(),
      error: null,
    });
    expect(validateEventEnvelope(ack)).toMatchObject({ ok: true });
    expect(validateEventEnvelope({
      ...ack,
      payload: { ...ack.payload, error: { code: "DENIED", message: "No", retryable: false } },
    })).toMatchObject({ ok: false });
  });

  it("keeps acknowledgements ephemeral and authoritative annotation changes durable", () => {
    const ack = ephemeralEvent({
      type: "annotation.ack",
      requestId: "request-0001",
      mutationId: "mutation-0001",
      status: "applied",
      annotationId: "annotation-0002",
      appliedRevision: 1,
      error: null,
    });
    expect(validateEventEnvelope(ack)).toMatchObject({ ok: true });
    expect(validateEventEnvelope(durableEvent(ack.payload))).toMatchObject({ ok: false });

    const changed = durableEvent({
      type: "annotation.changed",
      mutationId: "mutation-0001",
      operation: "create",
      annotation: annotation(),
      tombstone: null,
    });
    expect(validateEventEnvelope(changed)).toMatchObject({ ok: true });
    expect(validateEventEnvelope(ephemeralEvent(changed.payload))).toMatchObject({ ok: false });
  });
});

describe("bounded parsing and strict envelopes", () => {
  it("round-trips valid JSON strings and Uint8Arrays", () => {
    const serialized = serializeWireMessage(annotationCommand());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    expect(parseWireMessage(serialized.value)).toMatchObject({ ok: true });
    expect(parseWireMessage(new TextEncoder().encode(serialized.value))).toMatchObject({ ok: true });
    expect(() => assertValidWireMessage(JSON.parse(serialized.value))).not.toThrow();
  });

  it("rejects malformed JSON, invalid UTF-8, cycles, and oversized frames without throwing", () => {
    expect(parseWireMessage("{broken")).toMatchObject({ ok: false });
    expect(parseWireMessage(new Uint8Array([0xc3, 0x28]))).toMatchObject({ ok: false });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(validateWireMessage(cyclic)).toMatchObject({ ok: false });
    expect(parseWireMessage(`"${"x".repeat(PROTOCOL_LIMITS.maxFrameBytes)}"`)).toMatchObject({ ok: false });
  });

  it("rejects unknown messages and caps validation error disclosure", () => {
    const result = validateWireMessage({
      kind: "command",
      protocolVersion: PROTOCOL_VERSION,
      roomId,
      requestId: "request-invalid-0001",
      sentAt: "2026-02-31T20:00:00.000Z",
      payload: {
        type: "document.crdt.update",
        delivery: "durable",
        queuePolicy: "offline_allowed",
        vectorClock: {},
        operations: [],
      },
      extra: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.length).toBeLessThanOrEqual(PROTOCOL_LIMITS.maxValidationIssues);
  });

  it("bounds replay requests and accepts recovery acknowledgements only on the ephemeral stream", () => {
    expect(validateWireMessage({
      kind: "replay.request",
      protocolVersion: PROTOCOL_VERSION,
      roomId,
      afterCursor: "cursor:42",
      limit: PROTOCOL_LIMITS.maxReplayEvents,
    })).toMatchObject({ ok: true });
    expect(validateWireMessage({
      kind: "replay.request",
      protocolVersion: PROTOCOL_VERSION,
      roomId,
      afterCursor: "cursor:42",
      limit: PROTOCOL_LIMITS.maxReplayEvents + 1,
    })).toMatchObject({ ok: false });

    const ack = ephemeralEvent({
      type: "recovery.ack",
      requestId: "request-draft-0001",
      mutationId: "mutation-draft-0001",
      status: "duplicate",
      draftId: "draft-0002",
      updatedAt: laterTimestamp,
      error: null,
    });
    expect(validateEventEnvelope(ack)).toMatchObject({ ok: true });
    expect(validateEventEnvelope(durableEvent(ack.payload))).toMatchObject({ ok: false });
  });
});
