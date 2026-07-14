import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import {
  PROTOCOL_SCHEMA_ID,
  wireMessageSchema,
} from "./schemas.js";
import {
  PROTOCOL_LIMITS,
  SUPPORTED_PROTOCOL_VERSIONS,
  type Annotation,
  type CommandEnvelope,
  type CommandPayload,
  type EventEnvelope,
  type NegotiationMessage,
  type ProtocolVersion,
  type RoomSnapshot,
  type SnapshotEnvelope,
  type ValidationIssue,
  type ValidationResult,
  type WireMessage,
  type WriterControlState,
  type WriterResource,
} from "./types.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const ajv = new Ajv2020({
  allErrors: true,
  allowUnionTypes: true,
  strict: true,
  ownProperties: true,
  validateFormats: false,
});

ajv.addSchema(wireMessageSchema);

const validatorCache = new Map<string, ValidateFunction>();

function schemaReference(definition?: string): string {
  return definition ? `${PROTOCOL_SCHEMA_ID}#/$defs/${definition}` : PROTOCOL_SCHEMA_ID;
}

function definitionValidator(definition?: string): ValidateFunction {
  const reference = schemaReference(definition);
  const cached = validatorCache.get(reference);
  if (cached) return cached;
  const validator = ajv.getSchema(reference);
  if (!validator) throw new Error(`Collaboration schema definition is unavailable: ${definition ?? "root"}`);
  validatorCache.set(reference, validator);
  return validator;
}

function unionValidator(cacheKey: string, definitions: string[]): ValidateFunction {
  const cached = validatorCache.get(cacheKey);
  if (cached) return cached;
  const validator = ajv.compile({
    oneOf: definitions.map((definition) => ({ $ref: schemaReference(definition) })),
  });
  validatorCache.set(cacheKey, validator);
  return validator;
}

const durableEventTypes = new Set([
  "annotation.changed",
  "writer.control.changed",
  "writer.fence.advanced",
  "recovery.draft.changed",
]);

const queueableCommandTypes = new Set([
  "annotation.create",
  "annotation.update",
  "annotation.reply",
  "annotation.resolve",
  "annotation.delete",
  "recovery.draft.put",
  "recovery.draft.delete",
]);

function issue(instancePath: string, keyword: string, message: string): ValidationIssue {
  return { instancePath, keyword, message };
}

function schemaIssues(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).slice(0, PROTOCOL_LIMITS.maxValidationIssues).map((error) => ({
    instancePath: error.instancePath || "/",
    keyword: error.keyword,
    message: (error.message ?? "Schema validation failed.").slice(0, 256),
  }));
}

function addIssue(issues: ValidationIssue[], value: ValidationIssue): void {
  if (issues.length < PROTOCOL_LIMITS.maxValidationIssues) issues.push(value);
}

function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function isCanonicalTimestamp(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validateRelativePath(value: string, instancePath: string, issues: ValidationIssue[]): void {
  const segments = value.split("/");
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("\0") ||
    utf8Bytes(value) > 2048 ||
    segments.length > 128 ||
    segments.some((segment) => (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      utf8Bytes(segment) > 255
    ))
  ) {
    addIssue(issues, issue(instancePath, "relativePath", "Path must be a bounded canonical workspace-relative path."));
  }
}

function validateText(
  value: string,
  maximumBytes: number,
  instancePath: string,
  issues: ValidationIssue[],
): void {
  if (value.includes("\0") || value.trim().length === 0 || utf8Bytes(value) > maximumBytes) {
    addIssue(issues, issue(instancePath, "utf8Bytes", `Text must be non-blank and at most ${maximumBytes} UTF-8 bytes.`));
  }
}

function validateRange(
  range: { startLine: number; startColumn: number; endLine: number; endColumn: number },
  instancePath: string,
  issues: ValidationIssue[],
): void {
  if (
    range.endLine < range.startLine ||
    (range.endLine === range.startLine && range.endColumn < range.startColumn)
  ) {
    addIssue(issues, issue(instancePath, "rangeOrder", "Code range must end at or after its start."));
  }
}

function validateAnnotation(annotation: Annotation, instancePath: string, issues: ValidationIssue[]): void {
  validateRelativePath(annotation.filePath, `${instancePath}/filePath`, issues);
  validateText(annotation.context, PROTOCOL_LIMITS.maxContextBytes, `${instancePath}/context`, issues);
  validateText(annotation.authorDisplayName, 256, `${instancePath}/authorDisplayName`, issues);
  validateRange(annotation.range, `${instancePath}/range`, issues);
  const created = Date.parse(annotation.createdAt);
  const updated = Date.parse(annotation.updatedAt);
  if (updated < created) {
    addIssue(issues, issue(`${instancePath}/updatedAt`, "chronology", "updatedAt cannot precede createdAt."));
  }
  const hasResolutionMetadata = annotation.resolvedAt !== null && annotation.resolvedByMemberId !== null;
  if (annotation.resolved !== hasResolutionMetadata) {
    addIssue(issues, issue(`${instancePath}/resolved`, "resolutionState", "Resolved state and resolution metadata must agree."));
  }
  if (annotation.resolvedAt !== null) {
    const resolved = Date.parse(annotation.resolvedAt);
    if (resolved < created || resolved > updated) {
      addIssue(issues, issue(`${instancePath}/resolvedAt`, "chronology", "resolvedAt must be within the annotation lifetime."));
    }
  }
  const replyIds = new Set<string>();
  let priorReplyTime = created - 1;
  annotation.replies.forEach((reply, index) => {
    const replyPath = `${instancePath}/replies/${index}`;
    validateText(reply.context, PROTOCOL_LIMITS.maxReplyBytes, `${replyPath}/context`, issues);
    validateText(reply.authorDisplayName, 256, `${replyPath}/authorDisplayName`, issues);
    if (replyIds.has(reply.id)) {
      addIssue(issues, issue(`${replyPath}/id`, "uniqueId", "Reply IDs must be unique within an annotation."));
    }
    replyIds.add(reply.id);
    const replyTime = Date.parse(reply.createdAt);
    if (replyTime <= priorReplyTime || replyTime < created || replyTime > updated) {
      addIssue(issues, issue(`${replyPath}/createdAt`, "chronology", "Replies must be chronologically ordered within the annotation lifetime."));
    }
    priorReplyTime = replyTime;
  });
}

function resourceKey(resource: WriterResource): string {
  if (resource.kind === "workspace") return `workspace:${resource.channel}`;
  return resource.kind === "editor" ? `editor:${resource.filePath}` : `terminal:${resource.sessionId}`;
}

function validateWriterState(state: WriterControlState, instancePath: string, issues: ValidationIssue[]): void {
  if (state.resource.kind === "editor") {
    validateRelativePath(state.resource.filePath, `${instancePath}/resource/filePath`, issues);
  }
  const ownerFields = [state.ownerMemberId, state.ownerClientId, state.leaseExpiresAt];
  const allNull = ownerFields.every((value) => value === null);
  const allPresent = ownerFields.every((value) => value !== null);
  if (!allNull && !allPresent) {
    addIssue(issues, issue(instancePath, "leaseState", "Writer owner and lease fields must be all present or all null."));
  }
  if ((state.typingCount === 0) !== (state.typingUntil === null)) {
    addIssue(issues, issue(instancePath, "typingState", "typingUntil must be present exactly when typingCount is positive."));
  }
  if (allNull && state.typingCount !== 0) {
    addIssue(issues, issue(instancePath, "typingOwner", "An unowned writer resource cannot have active typists."));
  }
}

function validateDraftSummary(
  draft: Pick<RoomSnapshot["recoveryDrafts"][number], "filePath" | "createdAt" | "updatedAt">,
  instancePath: string,
  issues: ValidationIssue[],
): void {
  validateRelativePath(draft.filePath, `${instancePath}/filePath`, issues);
  if (Date.parse(draft.updatedAt) < Date.parse(draft.createdAt)) {
    addIssue(issues, issue(`${instancePath}/updatedAt`, "chronology", "Draft updatedAt cannot precede createdAt."));
  }
}

function validateRoomSnapshotSemantics(snapshot: RoomSnapshot, instancePath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const memberIds = new Set<string>();
  snapshot.members.forEach((member, index) => {
    if (memberIds.has(member.memberId)) {
      addIssue(issues, issue(`${instancePath}/members/${index}/memberId`, "uniqueId", "Room member IDs must be unique."));
    }
    memberIds.add(member.memberId);
    validateText(member.displayName, 256, `${instancePath}/members/${index}/displayName`, issues);
  });

  const clientIds = new Set<string>();
  snapshot.presence.forEach((presence, index) => {
    const presencePath = `${instancePath}/presence/${index}`;
    if (clientIds.has(presence.clientId)) {
      addIssue(issues, issue(`${presencePath}/clientId`, "uniqueId", "Presence client IDs must be unique."));
    }
    clientIds.add(presence.clientId);
    if (!memberIds.has(presence.memberId)) {
      addIssue(issues, issue(`${presencePath}/memberId`, "reference", "Presence must reference a current room member."));
    }
    if (presence.activePath !== null) validateRelativePath(presence.activePath, `${presencePath}/activePath`, issues);
    if (presence.cursor !== null) validateRange(presence.cursor, `${presencePath}/cursor`, issues);
    if (presence.status === "offline" && (presence.activePath !== null || presence.cursor !== null || presence.typing)) {
      addIssue(issues, issue(presencePath, "offlinePresence", "Offline presence cannot advertise an active path, cursor, or typing state."));
    }
  });

  const annotationIds = new Set<string>();
  snapshot.annotations.forEach((annotation, index) => {
    const annotationPath = `${instancePath}/annotations/${index}`;
    if (annotationIds.has(annotation.id)) {
      addIssue(issues, issue(`${annotationPath}/id`, "uniqueId", "Annotation IDs must be unique."));
    }
    annotationIds.add(annotation.id);
    validateAnnotation(annotation, annotationPath, issues);
  });

  const writerResources = new Set<string>();
  snapshot.writerControls.forEach((state, index) => {
    const statePath = `${instancePath}/writerControls/${index}`;
    const key = resourceKey(state.resource);
    if (writerResources.has(key)) {
      addIssue(issues, issue(`${statePath}/resource`, "uniqueResource", "Writer-control resources must be unique."));
    }
    writerResources.add(key);
    validateWriterState(state, statePath, issues);
    if (state.ownerMemberId !== null && !memberIds.has(state.ownerMemberId)) {
      addIssue(issues, issue(`${statePath}/ownerMemberId`, "reference", "Writer owner must be a current room member."));
    }
  });

  const draftIds = new Set<string>();
  snapshot.recoveryDrafts.forEach((draft, index) => {
    const draftPath = `${instancePath}/recoveryDrafts/${index}`;
    if (draftIds.has(draft.draftId)) {
      addIssue(issues, issue(`${draftPath}/draftId`, "uniqueId", "Recovery draft IDs must be unique."));
    }
    draftIds.add(draft.draftId);
    validateDraftSummary(draft, draftPath, issues);
  });
  return issues;
}

function validateAllTimestamps(value: unknown, instancePath: string, issues: ValidationIssue[]): void {
  if (issues.length >= PROTOCOL_LIMITS.maxValidationIssues || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateAllTimestamps(entry, `${instancePath}/${index}`, issues));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const childPath = `${instancePath}/${key}`;
    if ((key.endsWith("At") || key === "serverTime" || key === "sentAt" || key === "emittedAt") && typeof entry === "string") {
      if (!isCanonicalTimestamp(entry)) {
        addIssue(issues, issue(childPath, "timestamp", "Timestamp must be a real canonical UTC millisecond timestamp."));
      }
    }
    validateAllTimestamps(entry, childPath, issues);
  }
}

function validateCommandSemantics(command: CommandEnvelope): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const payload = command.payload;
  switch (payload.type) {
    case "presence.publish":
      if (payload.activePath !== null) validateRelativePath(payload.activePath, "/payload/activePath", issues);
      if (payload.cursor !== null) validateRange(payload.cursor, "/payload/cursor", issues);
      break;
    case "annotation.create":
      validateRelativePath(payload.filePath, "/payload/filePath", issues);
      validateText(payload.context, PROTOCOL_LIMITS.maxContextBytes, "/payload/context", issues);
      validateRange(payload.range, "/payload/range", issues);
      break;
    case "annotation.update":
      if (payload.patch.context !== undefined) {
        validateText(payload.patch.context, PROTOCOL_LIMITS.maxContextBytes, "/payload/patch/context", issues);
      }
      if (payload.patch.range !== undefined) validateRange(payload.patch.range, "/payload/patch/range", issues);
      break;
    case "annotation.reply":
      validateText(payload.context, PROTOCOL_LIMITS.maxReplyBytes, "/payload/context", issues);
      break;
    case "writer.control.cas":
      if (payload.resource.kind === "editor") {
        validateRelativePath(payload.resource.filePath, "/payload/resource/filePath", issues);
      }
      break;
    case "recovery.draft.put": {
      validateDraftSummary(payload.draft, "/payload/draft", issues);
      const actualSize = utf8Bytes(payload.draft.content);
      if (actualSize > PROTOCOL_LIMITS.maxRecoveryDraftBytes || actualSize !== payload.draft.sizeBytes) {
        addIssue(issues, issue("/payload/draft/content", "contentSize", "Draft UTF-8 size must match sizeBytes and remain within the draft limit."));
      }
      break;
    }
    case "terminal.input":
      if (utf8Bytes(payload.data) > PROTOCOL_LIMITS.maxTerminalInputBytes) {
        addIssue(issues, issue("/payload/data", "utf8Bytes", "Terminal input exceeds the UTF-8 byte limit."));
      }
      break;
    case "annotation.resolve":
    case "annotation.delete":
    case "recovery.draft.delete":
    case "terminal.control":
      break;
  }
  return issues;
}

function validateEventSemantics(event: EventEnvelope): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const shouldBeDurable = durableEventTypes.has(event.payload.type);
  if ((shouldBeDurable && event.stream !== "durable") || (!shouldBeDurable && event.stream !== "ephemeral")) {
    addIssue(issues, issue("/stream", "streamPolicy", `${event.payload.type} must use the ${shouldBeDurable ? "durable" : "ephemeral"} stream.`));
  }
  switch (event.payload.type) {
    case "presence.changed":
      if (event.payload.presence.activePath !== null) {
        validateRelativePath(event.payload.presence.activePath, "/payload/presence/activePath", issues);
      }
      if (event.payload.presence.cursor !== null) validateRange(event.payload.presence.cursor, "/payload/presence/cursor", issues);
      break;
    case "annotation.changed":
      if (event.payload.annotation !== null) validateAnnotation(event.payload.annotation, "/payload/annotation", issues);
      if (event.payload.tombstone !== null) validateRelativePath(event.payload.tombstone.filePath, "/payload/tombstone/filePath", issues);
      break;
    case "writer.control.ack":
      validateWriterState(event.payload.state, "/payload/state", issues);
      break;
    case "writer.control.changed":
      validateWriterState(event.payload.state, "/payload/state", issues);
      break;
    case "writer.fence.advanced":
      if (event.payload.resource.kind === "editor") {
        validateRelativePath(event.payload.resource.filePath, "/payload/resource/filePath", issues);
      }
      if (event.payload.fence <= event.payload.previousFence) {
        addIssue(issues, issue("/payload/fence", "fenceAdvance", "A fence-advance event must increase the fencing counter."));
      }
      break;
    case "recovery.draft.changed":
      if (event.payload.draft !== null) validateDraftSummary(event.payload.draft, "/payload/draft", issues);
      break;
    case "terminal.control.ack":
      if (event.payload.state !== null) {
        validateWriterState(event.payload.state, "/payload/state", issues);
        if (event.payload.state.resource.kind !== "terminal") {
          addIssue(issues, issue("/payload/state/resource", "resourceKind", "Terminal control acknowledgements require a terminal resource."));
        }
      }
      break;
    case "annotation.ack":
    case "recovery.ack":
    case "terminal.input.rejected":
      break;
  }
  return issues;
}

function semanticIssues(value: WireMessage): ValidationIssue[] {
  let issues: ValidationIssue[] = [];
  validateAllTimestamps(value, "", issues);
  if (value.kind === "command") issues = issues.concat(validateCommandSemantics(value));
  if (value.kind === "event") issues = issues.concat(validateEventSemantics(value));
  if (value.kind === "snapshot") {
    if (value.roomId !== value.snapshot.roomId) {
      addIssue(issues, issue("/snapshot/roomId", "roomIdentity", "Snapshot roomId must match its envelope."));
    }
    issues = issues.concat(validateRoomSnapshotSemantics(value.snapshot, "/snapshot"));
  }
  return issues.slice(0, PROTOCOL_LIMITS.maxValidationIssues);
}

function measuredJsonBytes(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : utf8Bytes(serialized);
  } catch {
    return null;
  }
}

function validateWith<T>(
  validator: ValidateFunction,
  input: unknown,
  semanticValidator?: (value: T) => ValidationIssue[],
): ValidationResult<T> {
  const size = measuredJsonBytes(input);
  if (size === null) {
    return { ok: false, issues: [issue("/", "jsonValue", "Value must be finite, acyclic, and JSON serializable.")] };
  }
  if (size > PROTOCOL_LIMITS.maxFrameBytes) {
    return { ok: false, issues: [issue("/", "maxFrameBytes", `Message exceeds ${PROTOCOL_LIMITS.maxFrameBytes} UTF-8 bytes.`)] };
  }
  if (!validator(input)) return { ok: false, issues: schemaIssues(validator.errors) };
  const semantic = semanticValidator?.(input as T) ?? [];
  if (semantic.length > 0) return { ok: false, issues: semantic.slice(0, PROTOCOL_LIMITS.maxValidationIssues) };
  return { ok: true, value: input as T };
}

export function validateWireMessage(input: unknown): ValidationResult<WireMessage> {
  return validateWith(definitionValidator(), input, semanticIssues);
}

export function validateCommandEnvelope(input: unknown): ValidationResult<CommandEnvelope> {
  return validateWith(definitionValidator("commandEnvelope"), input, (value) => {
    const issues: ValidationIssue[] = [];
    validateAllTimestamps(value, "", issues);
    return issues.concat(validateCommandSemantics(value));
  });
}

export function validateEventEnvelope(input: unknown): ValidationResult<EventEnvelope> {
  return validateWith(unionValidator("eventEnvelope", ["durableEventEnvelope", "ephemeralEventEnvelope"]), input, (value) => {
    const issues: ValidationIssue[] = [];
    validateAllTimestamps(value, "", issues);
    return issues.concat(validateEventSemantics(value));
  });
}

export function validateSnapshotEnvelope(input: unknown): ValidationResult<SnapshotEnvelope> {
  return validateWith(definitionValidator("snapshotEnvelope"), input, (value) => {
    const issues: ValidationIssue[] = [];
    validateAllTimestamps(value, "", issues);
    if (value.roomId !== value.snapshot.roomId) {
      addIssue(issues, issue("/snapshot/roomId", "roomIdentity", "Snapshot roomId must match its envelope."));
    }
    return issues.concat(validateRoomSnapshotSemantics(value.snapshot, "/snapshot"));
  });
}

export function validateRoomSnapshot(input: unknown): ValidationResult<RoomSnapshot> {
  return validateWith(definitionValidator("roomSnapshot"), input, (value) => {
    const issues: ValidationIssue[] = [];
    validateAllTimestamps(value, "", issues);
    return issues.concat(validateRoomSnapshotSemantics(value, ""));
  });
}

export function validateNegotiationMessage(input: unknown): ValidationResult<NegotiationMessage> {
  return validateWith(unionValidator("negotiation", [
    "protocolClientHello",
    "protocolServerAccept",
    "protocolServerReject",
  ]), input, (value) => {
    const issues: ValidationIssue[] = [];
    validateAllTimestamps(value, "", issues);
    return issues;
  });
}

export function parseWireMessage(input: string | Uint8Array): ValidationResult<WireMessage> {
  let text: string;
  try {
    if (typeof input === "string") {
      if (utf8Bytes(input) > PROTOCOL_LIMITS.maxFrameBytes) {
        return { ok: false, issues: [issue("/", "maxFrameBytes", `Message exceeds ${PROTOCOL_LIMITS.maxFrameBytes} UTF-8 bytes.`)] };
      }
      text = input;
    } else if (input instanceof Uint8Array) {
      if (input.byteLength > PROTOCOL_LIMITS.maxFrameBytes) {
        return { ok: false, issues: [issue("/", "maxFrameBytes", `Message exceeds ${PROTOCOL_LIMITS.maxFrameBytes} UTF-8 bytes.`)] };
      }
      text = textDecoder.decode(input);
    } else {
      return { ok: false, issues: [issue("/", "inputType", "Wire input must be a string or Uint8Array.")] };
    }
  } catch {
    return { ok: false, issues: [issue("/", "utf8", "Wire input must be valid UTF-8.")] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, issues: [issue("/", "json", "Wire input must contain valid JSON.")] };
  }
  return validateWireMessage(parsed);
}

export function serializeWireMessage(input: unknown): ValidationResult<string> {
  const validated = validateWireMessage(input);
  if (!validated.ok) return validated;
  return { ok: true, value: JSON.stringify(validated.value) };
}

export function isQueueableCommand(payload: CommandPayload): boolean {
  return payload.delivery === "durable" &&
    payload.queuePolicy === "offline_allowed" &&
    queueableCommandTypes.has(payload.type);
}

export function negotiateProtocolVersion(
  remoteVersions: readonly string[],
  localVersions: readonly string[] = SUPPORTED_PROTOCOL_VERSIONS,
): ProtocolVersion | null {
  if (
    remoteVersions.length === 0 ||
    remoteVersions.length > 8 ||
    localVersions.length === 0 ||
    localVersions.length > 8 ||
    new Set(remoteVersions).size !== remoteVersions.length ||
    new Set(localVersions).size !== localVersions.length
  ) {
    return null;
  }
  const remote = new Set(remoteVersions);
  const selected = localVersions.find((version) => remote.has(version));
  return selected === "1.0" ? selected : null;
}

export class ProtocolValidationError extends Error {
  readonly issues: ValidationIssue[];

  constructor(issues: ValidationIssue[]) {
    super("Collaboration protocol validation failed.");
    this.name = "ProtocolValidationError";
    this.issues = issues.slice(0, PROTOCOL_LIMITS.maxValidationIssues);
  }
}

export function assertValidWireMessage(input: unknown): asserts input is WireMessage {
  const result = validateWireMessage(input);
  if (!result.ok) throw new ProtocolValidationError(result.issues);
}
