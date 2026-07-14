import {
  PROTOCOL_VERSION,
  validateSnapshotEnvelope,
  type SnapshotEnvelope,
  type ValidationIssue,
} from "@trace/collaboration-protocol";
import type { WorkspaceBootstrapState } from "./domain.js";

export class ProtocolAdapterError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super("The workspace bootstrap state cannot be represented by the collaboration protocol.");
    this.name = "ProtocolAdapterError";
  }
}

/**
 * Replay cursors are opaque on the wire. Keeping the room and decimal sequence
 * in this server-owned representation makes the mapping deterministic without
 * teaching clients to parse it.
 */
export function cursorForRoomSequence(roomId: string, roomSequence: number): string {
  if (!Number.isSafeInteger(roomSequence) || roomSequence < 0) {
    throw new RangeError("A non-negative safe room sequence is required.");
  }
  return `room:${roomId}:sequence:${roomSequence}`;
}

/**
 * Builds the first supported wire snapshot from durable control-plane state.
 * Unsupported collaboration collections remain empty until their authoritative
 * stores are connected; this function must not be used as a WebSocket handler.
 */
export function createInitialSnapshotEnvelope(
  state: WorkspaceBootstrapState,
  emittedAt: string,
): SnapshotEnvelope {
  if (state.repository === null) {
    throw new ProtocolAdapterError([
      {
        instancePath: "/snapshot/repository",
        keyword: "repositoryBinding",
        message: "A GitHub repository must be bound before emitting a protocol snapshot.",
      },
    ]);
  }

  const sequence = state.workspace.roomSequence;
  const envelope: SnapshotEnvelope = {
    kind: "snapshot",
    protocolVersion: PROTOCOL_VERSION,
    roomId: state.workspace.roomId,
    sequence,
    cursor: cursorForRoomSequence(state.workspace.roomId, sequence),
    emittedAt,
    snapshot: {
      roomId: state.workspace.roomId,
      snapshotVersion: sequence,
      generatedAt: emittedAt,
      repository: state.repository,
      members: state.members.map((member) => ({
        memberId: member.memberId,
        displayName: member.displayName,
        role: member.role,
        joinedAt: member.joinedAt,
      })),
      presence: [],
      annotations: [],
      writerControls: [state.writerControl],
      recoveryDrafts: [],
    },
  };

  const validated = validateSnapshotEnvelope(envelope);
  if (!validated.ok) throw new ProtocolAdapterError(validated.issues);
  return validated.value;
}
