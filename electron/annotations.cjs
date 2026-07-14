const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { WorkspaceError } = require("./workspace.cjs");

const STORAGE_VERSION = 1;
const MAX_STORAGE_BYTES = 8 * 1024 * 1024;
const MAX_LIST_OUTPUT_BYTES = 512 * 1024;
const MAX_CONTEXT_BYTES = 16 * 1024;
const MAX_REPLY_BYTES = 4 * 1024;
const MAX_FILE_PATH_BYTES = 2 * 1024;
const MAX_ANNOTATIONS_PER_WORKSPACE = 2_000;
const MAX_OUTBOX_ENTRIES = 2_000;
const MAX_MUTATION_JOURNAL_ENTRIES = 4_000;
const MAX_WORKSPACES = 256;
const MAX_PAGE_SIZE = 100;
const MAX_OUTBOX_PAGE_SIZE = 100;
const MAX_ACKNOWLEDGEMENTS = 100;
const MAX_REPLIES_PER_ANNOTATION = 64;
const MAX_LINE = 10_000_000;
const MAX_COLUMN = 1_000_000;

const OPERATIONS = new Set(["create", "update", "resolve", "delete", "reply"]);
const GITHUB_LINK_KINDS = new Set(["issue", "pull_request"]);
const MUTATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const MEMBER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const ANNOTATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const GITHUB_OWNER_PATTERN = /^(?!-)[A-Za-z0-9-]{1,39}(?<!-)$/;
const GITHUB_REPOSITORY_PATTERN = /^(?!\.)(?!.*\.git$)[A-Za-z0-9._-]{1,100}$/i;
const OPAQUE_GITHUB_ID_PATTERN = /^[A-Za-z0-9_:\-=+/]{1,256}$/;
const GIT_OID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const CONTENT_HASH_PATTERN = /^[a-f0-9]{64}$/i;

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function invalidRequest(message = "The annotation request is invalid.") {
  return new WorkspaceError("INVALID_REQUEST", message);
}

function requireRecord(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidRequest(message);
  }
  return value;
}

function assertOnlyKeys(value, allowedKeys, message = "The annotation request is invalid.") {
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw invalidRequest(message);
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function boundedText(value, {
  label,
  maximumBytes,
  minimumBytes = 1,
  trim = false,
  allowEmpty = false,
} = {}) {
  if (typeof value !== "string" || value.includes("\0")) {
    throw invalidRequest(`${label} is invalid.`);
  }
  const normalized = trim ? value.trim() : value;
  const size = byteLength(normalized);
  if ((!allowEmpty && (size < minimumBytes || normalized.trim().length === 0)) || size > maximumBytes) {
    throw invalidRequest(`${label} is invalid.`);
  }
  return normalized;
}

function normalizeWorkspaceId(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || byteLength(value) > 8_192) {
    throw invalidRequest("The annotation request is missing its workspace identity.");
  }
  return value;
}

function normalizeMutationId(value) {
  if (typeof value !== "string" || !MUTATION_ID_PATTERN.test(value)) {
    throw invalidRequest("A valid mutation identity is required.");
  }
  return value;
}

function normalizeAnnotationId(value) {
  if (typeof value !== "string" || !ANNOTATION_ID_PATTERN.test(value)) {
    throw invalidRequest("A valid annotation identity is required.");
  }
  return value;
}

function normalizeActor(value) {
  const actor = requireRecord(value, "A workspace member identity is required.");
  assertOnlyKeys(actor, new Set(["memberId", "id", "displayName", "name"]), "The workspace member identity is invalid.");
  const memberId = actor.memberId ?? actor.id;
  if (typeof memberId !== "string" || !MEMBER_ID_PATTERN.test(memberId)) {
    throw invalidRequest("A valid workspace member identity is required.");
  }
  const rawDisplayName = actor.displayName ?? actor.name ?? memberId;
  const displayName = boundedText(rawDisplayName, {
    label: "The member name",
    maximumBytes: 256,
    trim: true,
  });
  return { memberId, displayName };
}

function normalizeFilePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    path.posix.isAbsolute(value) ||
    byteLength(value) > MAX_FILE_PATH_BYTES
  ) {
    throw new WorkspaceError("INVALID_PATH", "A workspace-relative file path is required.");
  }

  const normalized = path.posix.normalize(value);
  const segments = normalized.split("/");
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    segments.length > 128 ||
    segments.some((segment) => (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      byteLength(segment) > 255
    ))
  ) {
    throw new WorkspaceError("INVALID_PATH", "A workspace-relative file path is required.");
  }
  return normalized;
}

function normalizePositiveInteger(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw invalidRequest(`${label} is invalid.`);
  }
  return value;
}

function normalizeRange(value) {
  const range = requireRecord(value, "A valid code range is required.");
  assertOnlyKeys(range, new Set(["startLine", "startColumn", "endLine", "endColumn"]), "A valid code range is required.");
  const normalized = {
    startLine: normalizePositiveInteger(range.startLine, MAX_LINE, "The start line"),
    startColumn: normalizePositiveInteger(range.startColumn, MAX_COLUMN, "The start column"),
    endLine: normalizePositiveInteger(range.endLine, MAX_LINE, "The end line"),
    endColumn: normalizePositiveInteger(range.endColumn, MAX_COLUMN, "The end column"),
  };
  if (
    normalized.endLine < normalized.startLine ||
    (normalized.endLine === normalized.startLine && normalized.endColumn < normalized.startColumn)
  ) {
    throw invalidRequest("The code range must end after it starts.");
  }
  return normalized;
}

function normalizeGitHubLink(value, { nullable = true } = {}) {
  if (value === null && nullable) return null;
  const link = requireRecord(value, "The GitHub linkage is invalid.");
  assertOnlyKeys(
    link,
    new Set(["kind", "owner", "repository", "number", "commentId", "reviewThreadId"]),
    "The GitHub linkage is invalid.",
  );
  if (!GITHUB_LINK_KINDS.has(link.kind)) {
    throw invalidRequest("The GitHub linkage is invalid.");
  }
  if (typeof link.owner !== "string" || !GITHUB_OWNER_PATTERN.test(link.owner)) {
    throw invalidRequest("The GitHub repository owner is invalid.");
  }
  if (typeof link.repository !== "string" || !GITHUB_REPOSITORY_PATTERN.test(link.repository)) {
    throw invalidRequest("The GitHub repository name is invalid.");
  }
  const normalized = {
    kind: link.kind,
    owner: link.owner,
    repository: link.repository,
    number: normalizePositiveInteger(link.number, 2_147_483_647, "The GitHub item number"),
    commentId: null,
    reviewThreadId: null,
  };
  for (const field of ["commentId", "reviewThreadId"]) {
    if (link[field] === undefined || link[field] === null) continue;
    const stringValue = typeof link[field] === "number" && Number.isSafeInteger(link[field])
      ? String(link[field])
      : link[field];
    if (typeof stringValue !== "string" || !OPAQUE_GITHUB_ID_PATTERN.test(stringValue)) {
      throw invalidRequest("The GitHub linkage is invalid.");
    }
    normalized[field] = stringValue;
  }
  return normalized;
}

function normalizeAnchorRevision(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !GIT_OID_PATTERN.test(value)) {
    throw invalidRequest("The annotation anchor revision is invalid.");
  }
  return value.toLowerCase();
}

function normalizeAnchorContentHash(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !CONTENT_HASH_PATTERN.test(value)) {
    throw invalidRequest("The annotation anchor content hash is invalid.");
  }
  return value.toLowerCase();
}

function normalizeExpectedRevision(value) {
  if (value === undefined || value === null) return null;
  return normalizePositiveInteger(value, Number.MAX_SAFE_INTEGER, "The expected annotation revision");
}

function normalizeNonNegativeInteger(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw invalidRequest(`${label} is invalid.`);
  }
  return value;
}

function normalizeLimit(value, maximum, fallback) {
  if (value === undefined) return fallback;
  return normalizePositiveInteger(value, maximum, "The page size");
}

function normalizeIsoTimestamp(value) {
  if (typeof value !== "string" || value.length !== 24) {
    throw new Error("Invalid stored timestamp");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error("Invalid stored timestamp");
  }
  return value;
}

function normalizeStoredNullableMemberId(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !MEMBER_ID_PATTERN.test(value)) {
    throw new Error("Invalid stored member identity");
  }
  return value;
}

function normalizeStoredReply(value) {
  try {
    const reply = requireRecord(value, "Invalid stored annotation reply");
    const author = normalizeActor({
      memberId: reply.authorMemberId,
      displayName: reply.authorDisplayName,
    });
    return {
      id: normalizeAnnotationId(reply.id),
      context: boundedText(reply.context, {
        label: "The reply context",
        maximumBytes: MAX_REPLY_BYTES,
      }),
      authorMemberId: author.memberId,
      authorDisplayName: author.displayName,
      createdAt: normalizeIsoTimestamp(reply.createdAt),
    };
  } catch (error) {
    if (error instanceof WorkspaceError) throw new Error("Invalid stored annotation reply");
    throw error;
  }
}

function normalizeStoredAnnotation(value) {
  try {
    const annotation = requireRecord(value, "Invalid stored annotation");
    const id = normalizeAnnotationId(annotation.id);
    const filePath = normalizeFilePath(annotation.filePath);
    const context = boundedText(annotation.context, {
      label: "The annotation context",
      maximumBytes: MAX_CONTEXT_BYTES,
    });
    const range = normalizeRange(annotation.range);
    const author = normalizeActor({
      memberId: annotation.authorMemberId,
      displayName: annotation.authorDisplayName,
    });
    const updatedByMemberId = normalizeActor({ memberId: annotation.updatedByMemberId }).memberId;
    const resolved = annotation.resolved;
    if (typeof resolved !== "boolean") throw new Error("Invalid stored resolution state");
    const resolvedAt = annotation.resolvedAt === null ? null : normalizeIsoTimestamp(annotation.resolvedAt);
    const resolvedByMemberId = normalizeStoredNullableMemberId(annotation.resolvedByMemberId);
    if (resolved !== Boolean(resolvedAt && resolvedByMemberId)) {
      throw new Error("Invalid stored resolution metadata");
    }
    const revision = normalizePositiveInteger(
      annotation.revision,
      Number.MAX_SAFE_INTEGER,
      "The annotation revision",
    );
    if (!Array.isArray(annotation.replies) || annotation.replies.length > MAX_REPLIES_PER_ANNOTATION) {
      throw new Error("Invalid stored annotation replies");
    }
    const replies = annotation.replies.map(normalizeStoredReply);
    if (new Set(replies.map((reply) => reply.id)).size !== replies.length) {
      throw new Error("Invalid stored annotation reply identities");
    }
    const createdAt = normalizeIsoTimestamp(annotation.createdAt);
    const updatedAt = normalizeIsoTimestamp(annotation.updatedAt);
    if (
      updatedAt < createdAt ||
      (resolvedAt !== null && (resolvedAt < createdAt || resolvedAt > updatedAt)) ||
      replies.some((reply, index) => (
        reply.createdAt < createdAt ||
        reply.createdAt > updatedAt ||
        (index > 0 && reply.createdAt <= replies[index - 1].createdAt)
      ))
    ) {
      throw new Error("Invalid stored annotation chronology");
    }
    return {
      id,
      filePath,
      context,
      range,
      authorMemberId: author.memberId,
      authorDisplayName: author.displayName,
      createdAt,
      updatedAt,
      updatedByMemberId,
      resolved,
      resolvedAt,
      resolvedByMemberId,
      githubLink: normalizeGitHubLink(annotation.githubLink),
      anchorRevision: normalizeAnchorRevision(annotation.anchorRevision),
      anchorContentHash: normalizeAnchorContentHash(annotation.anchorContentHash),
      replies,
      revision,
    };
  } catch (error) {
    if (error instanceof WorkspaceError) throw new Error("Invalid stored annotation");
    throw error;
  }
}

function normalizeStoredTombstone(value) {
  try {
    const tombstone = requireRecord(value, "Invalid stored tombstone");
    return {
      id: normalizeAnnotationId(tombstone.id),
      filePath: normalizeFilePath(tombstone.filePath),
      githubLink: normalizeGitHubLink(tombstone.githubLink),
      anchorRevision: normalizeAnchorRevision(tombstone.anchorRevision),
      anchorContentHash: normalizeAnchorContentHash(tombstone.anchorContentHash),
      deletedAt: normalizeIsoTimestamp(tombstone.deletedAt),
      deletedByMemberId: normalizeActor({ memberId: tombstone.deletedByMemberId }).memberId,
      revision: normalizePositiveInteger(tombstone.revision, Number.MAX_SAFE_INTEGER, "The deletion revision"),
    };
  } catch (error) {
    if (error instanceof WorkspaceError) throw new Error("Invalid stored tombstone");
    throw error;
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function workspaceStorageKey(workspaceId, rootPath) {
  return crypto
    .createHash("sha256")
    .update("trace-annotations:v1\0")
    .update(workspaceId)
    .update("\0")
    .update(rootPath)
    .digest("hex");
}

function defaultStorage() {
  return { version: STORAGE_VERSION, workspaces: {} };
}

function defaultWorkspaceState() {
  return {
    annotations: [],
    outbox: [],
    mutationJournal: [],
    nextSequence: 1,
  };
}

function normalizeStoredMutationResult(value) {
  const result = requireRecord(value, "Invalid stored mutation result");
  if (result.kind === "annotation") {
    return { kind: "annotation", annotation: normalizeStoredAnnotation(result.annotation) };
  }
  if (result.kind === "deleted") {
    return { kind: "deleted", id: normalizeAnnotationId(result.id) };
  }
  throw new Error("Invalid stored mutation result");
}

function normalizeStoredOutboxEntry(value) {
  const entry = requireRecord(value, "Invalid stored outbox entry");
  if (!OPERATIONS.has(entry.operation)) throw new Error("Invalid stored outbox operation");
  const normalized = {
    sequence: normalizePositiveInteger(entry.sequence, Number.MAX_SAFE_INTEGER, "The outbox sequence"),
    mutationId: normalizeMutationId(entry.mutationId),
    operation: entry.operation,
    annotationId: normalizeAnnotationId(entry.annotationId),
    actorMemberId: normalizeActor({ memberId: entry.actorMemberId }).memberId,
    occurredAt: normalizeIsoTimestamp(entry.occurredAt),
    payload: null,
  };
  if (entry.operation === "delete") {
    normalized.payload = { tombstone: normalizeStoredTombstone(entry.payload?.tombstone) };
    if (normalized.payload.tombstone.id !== normalized.annotationId) {
      throw new Error("Invalid stored outbox annotation identity");
    }
  } else {
    normalized.payload = { annotation: normalizeStoredAnnotation(entry.payload?.annotation) };
    if (normalized.payload.annotation.id !== normalized.annotationId) {
      throw new Error("Invalid stored outbox annotation identity");
    }
  }
  return normalized;
}

function normalizeStoredWorkspace(value) {
  const stored = requireRecord(value, "Invalid stored annotation workspace");
  if (
    !Array.isArray(stored.annotations) ||
    !Array.isArray(stored.outbox) ||
    !Array.isArray(stored.mutationJournal) ||
    stored.annotations.length > MAX_ANNOTATIONS_PER_WORKSPACE ||
    stored.outbox.length > MAX_OUTBOX_ENTRIES ||
    stored.mutationJournal.length > MAX_MUTATION_JOURNAL_ENTRIES
  ) {
    throw new Error("Invalid stored annotation workspace");
  }

  const annotations = stored.annotations.map(normalizeStoredAnnotation);
  const outbox = stored.outbox.map(normalizeStoredOutboxEntry);
  const mutationJournal = stored.mutationJournal.map((value) => {
    const entry = requireRecord(value, "Invalid stored mutation journal");
    if (!OPERATIONS.has(entry.operation) || typeof entry.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(entry.fingerprint)) {
      throw new Error("Invalid stored mutation journal");
    }
    const result = normalizeStoredMutationResult(entry.result);
    if (
      (entry.operation === "delete" && result.kind !== "deleted") ||
      (entry.operation !== "delete" && result.kind !== "annotation")
    ) {
      throw new Error("Invalid stored mutation result type");
    }
    return {
      mutationId: normalizeMutationId(entry.mutationId),
      fingerprint: entry.fingerprint,
      operation: entry.operation,
      result,
      recordedAt: normalizeIsoTimestamp(entry.recordedAt),
    };
  });

  const allAnnotationIds = annotations.flatMap((annotation) => [
    annotation.id,
    ...annotation.replies.map((reply) => reply.id),
  ]);
  const annotationIds = new Set(allAnnotationIds);
  const mutationIds = new Set(mutationJournal.map((entry) => entry.mutationId));
  const journalByMutationId = new Map(mutationJournal.map((entry) => [entry.mutationId, entry]));
  const outboxMutationIds = new Set(outbox.map((entry) => entry.mutationId));
  const sequences = new Set(outbox.map((entry) => entry.sequence));
  if (
    annotationIds.size !== allAnnotationIds.length ||
    mutationIds.size !== mutationJournal.length ||
    outboxMutationIds.size !== outbox.length ||
    sequences.size !== outbox.length ||
    outbox.some((entry) => {
      const journal = journalByMutationId.get(entry.mutationId);
      const resultAnnotationId = journal?.result.kind === "annotation"
        ? journal.result.annotation.id
        : journal?.result.id;
      return !journal || journal.operation !== entry.operation || resultAnnotationId !== entry.annotationId;
    })
  ) {
    throw new Error("Invalid stored annotation identities");
  }

  const largestSequence = outbox.reduce((maximum, entry) => Math.max(maximum, entry.sequence), 0);
  const nextSequence = normalizePositiveInteger(
    stored.nextSequence,
    Number.MAX_SAFE_INTEGER,
    "The next outbox sequence",
  );
  if (nextSequence <= largestSequence) throw new Error("Invalid stored outbox sequence");
  return { annotations, outbox, mutationJournal, nextSequence };
}

function parseStorage(contents) {
  let parsed;
  try {
    parsed = JSON.parse(contents);
    const root = requireRecord(parsed, "Invalid annotation storage");
    if (root.version !== STORAGE_VERSION) throw new Error("Unsupported annotation storage version");
    const workspaces = requireRecord(root.workspaces, "Invalid annotation storage");
    const entries = Object.entries(workspaces);
    if (entries.length > MAX_WORKSPACES) throw new Error("Too many annotation workspaces");
    const normalized = defaultStorage();
    for (const [key, value] of entries) {
      if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid annotation workspace key");
      normalized.workspaces[key] = normalizeStoredWorkspace(value);
    }
    return normalized;
  } catch {
    throw new WorkspaceError(
      "ANNOTATION_STORAGE_CORRUPT",
      "Local annotations could not be read safely. The stored data appears to be damaged.",
    );
  }
}

function encodeCursor(annotation) {
  return Buffer.from(JSON.stringify({ u: annotation.updatedAt, i: annotation.id }), "utf8").toString("base64url");
}

function decodeCursor(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw invalidRequest("The annotation page cursor is invalid.");
  }
  try {
    const raw = Buffer.from(value, "base64url");
    if (raw.toString("base64url") !== value) throw new Error("Non-canonical cursor");
    const cursor = JSON.parse(raw.toString("utf8"));
    return {
      updatedAt: normalizeIsoTimestamp(cursor.u),
      id: normalizeAnnotationId(cursor.i),
    };
  } catch {
    throw invalidRequest("The annotation page cursor is invalid.");
  }
}

function annotationOrder(left, right) {
  if (left.updatedAt !== right.updatedAt) return right.updatedAt.localeCompare(left.updatedAt);
  return left.id.localeCompare(right.id);
}

function mutationResult(result, pendingMutationCount, replayed) {
  if (result.kind === "annotation") {
    return {
      annotation: cloneJson(result.annotation),
      pendingMutationCount,
      replayed,
    };
  }
  return {
    id: result.id,
    deleted: true,
    pendingMutationCount,
    replayed,
  };
}

class AnnotationManager {
  #workspaceManager;
  #settingsPath;
  #now;
  #randomUUID;
  #operationQueue = Promise.resolve();

  constructor({
    workspaceManager,
    settingsPath,
    now = () => Date.now(),
    randomUUID = () => crypto.randomUUID(),
  } = {}) {
    if (!workspaceManager || typeof workspaceManager.getExecutionContext !== "function") {
      throw new TypeError("AnnotationManager requires a workspace manager.");
    }
    if (typeof settingsPath !== "string" || settingsPath.length === 0 || settingsPath.includes("\0")) {
      throw new TypeError("AnnotationManager requires a settings path.");
    }
    this.#workspaceManager = workspaceManager;
    this.#settingsPath = settingsPath;
    this.#now = now;
    this.#randomUUID = randomUUID;
  }

  async listAnnotations(request = {}) {
    const input = requireRecord(request, "The annotation list request is invalid.");
    assertOnlyKeys(
      input,
      new Set(["workspaceId", "filePath", "includeResolved", "githubLink", "limit", "cursor"]),
      "The annotation list request is invalid.",
    );
    const workspace = this.#captureWorkspace(input.workspaceId);
    const filter = {
      filePath: input.filePath === undefined ? null : normalizeFilePath(input.filePath),
      includeResolved: input.includeResolved === undefined ? true : input.includeResolved,
      githubLink: input.githubLink === undefined ? null : normalizeGitHubLink(input.githubLink, { nullable: false }),
      limit: normalizeLimit(input.limit, MAX_PAGE_SIZE, 50),
      cursor: input.cursor === undefined || input.cursor === null ? null : decodeCursor(input.cursor),
    };
    if (typeof filter.includeResolved !== "boolean") {
      throw invalidRequest("The annotation resolution filter is invalid.");
    }

    return this.#serialized(async () => {
      this.#assertWorkspace(workspace);
      const storage = await this.#loadStorage();
      this.#assertWorkspace(workspace);
      const state = storage.workspaces[workspace.key] ?? defaultWorkspaceState();
      let items = state.annotations.filter((annotation) => {
        if (filter.filePath && annotation.filePath !== filter.filePath) return false;
        if (!filter.includeResolved && annotation.resolved) return false;
        if (filter.githubLink) {
          const link = annotation.githubLink;
          if (!link || link.kind !== filter.githubLink.kind || link.owner !== filter.githubLink.owner ||
              link.repository !== filter.githubLink.repository || link.number !== filter.githubLink.number) return false;
        }
        return true;
      }).sort(annotationOrder);

      if (filter.cursor) {
        const index = items.findIndex((annotation) => (
          annotation.id === filter.cursor.id && annotation.updatedAt === filter.cursor.updatedAt
        ));
        if (index < 0) throw invalidRequest("The annotation page cursor is no longer valid.");
        items = items.slice(index + 1);
      }

      const page = [];
      let outputBytes = byteLength('{"items":[],"nextCursor":null,"pendingMutationCount":0}');
      for (const annotation of items) {
        if (page.length >= filter.limit) break;
        const itemBytes = byteLength(JSON.stringify(annotation)) + 1;
        if (page.length > 0 && outputBytes + itemBytes > MAX_LIST_OUTPUT_BYTES) break;
        page.push(cloneJson(annotation));
        outputBytes += itemBytes;
      }
      const hasMore = page.length < items.length;
      return {
        items: page,
        nextCursor: hasMore && page.length > 0 ? encodeCursor(page.at(-1)) : null,
        pendingMutationCount: state.outbox.length,
      };
    });
  }

  async createAnnotation(request = {}) {
    const input = requireRecord(request, "The annotation create request is invalid.");
    assertOnlyKeys(
      input,
      new Set(["workspaceId", "mutationId", "actor", "filePath", "context", "range", "githubLink", "anchorRevision", "anchorContentHash"]),
      "The annotation create request is invalid.",
    );
    const workspace = this.#captureWorkspace(input.workspaceId);
    const mutationId = normalizeMutationId(input.mutationId);
    const actor = normalizeActor(input.actor);
    const normalized = {
      filePath: normalizeFilePath(input.filePath),
      context: boundedText(input.context, {
        label: "The annotation context",
        maximumBytes: MAX_CONTEXT_BYTES,
      }),
      range: normalizeRange(input.range),
      githubLink: input.githubLink === undefined ? null : normalizeGitHubLink(input.githubLink),
      anchorRevision: normalizeAnchorRevision(input.anchorRevision),
      anchorContentHash: normalizeAnchorContentHash(input.anchorContentHash),
    };
    const requestFingerprint = fingerprint({
      operation: "create",
      actorMemberId: actor.memberId,
      ...normalized,
    });

    return this.#mutate({ workspace, mutationId, actor, operation: "create", requestFingerprint }, (state) => {
      if (state.annotations.length >= MAX_ANNOTATIONS_PER_WORKSPACE) {
        throw new WorkspaceError("ANNOTATION_LIMIT", "This workspace has reached its local annotation limit.");
      }
      const timestamp = this.#timestamp();
      const id = this.#uniqueId(state);
      const annotation = {
        id,
        filePath: normalized.filePath,
        context: normalized.context,
        range: normalized.range,
        authorMemberId: actor.memberId,
        authorDisplayName: actor.displayName,
        createdAt: timestamp,
        updatedAt: timestamp,
        updatedByMemberId: actor.memberId,
        resolved: false,
        resolvedAt: null,
        resolvedByMemberId: null,
        githubLink: normalized.githubLink,
        anchorRevision: normalized.anchorRevision,
        anchorContentHash: normalized.anchorContentHash,
        replies: [],
        revision: 1,
      };
      state.annotations.push(annotation);
      return { kind: "annotation", annotation };
    });
  }

  async updateAnnotation(request = {}) {
    const input = requireRecord(request, "The annotation update request is invalid.");
    assertOnlyKeys(
      input,
      new Set(["workspaceId", "mutationId", "actor", "annotationId", "patch", "expectedRevision"]),
      "The annotation update request is invalid.",
    );
    const workspace = this.#captureWorkspace(input.workspaceId);
    const mutationId = normalizeMutationId(input.mutationId);
    const actor = normalizeActor(input.actor);
    const annotationId = normalizeAnnotationId(input.annotationId);
    const patchValue = requireRecord(input.patch, "The annotation update is invalid.");
    assertOnlyKeys(
      patchValue,
      new Set(["context", "range", "githubLink", "anchorRevision", "anchorContentHash"]),
      "The annotation update is invalid.",
    );
    const patch = {};
    if (hasOwn(patchValue, "context")) {
      patch.context = boundedText(patchValue.context, {
        label: "The annotation context",
        maximumBytes: MAX_CONTEXT_BYTES,
      });
    }
    if (hasOwn(patchValue, "range")) patch.range = normalizeRange(patchValue.range);
    if (hasOwn(patchValue, "githubLink")) patch.githubLink = normalizeGitHubLink(patchValue.githubLink);
    if (hasOwn(patchValue, "anchorRevision")) patch.anchorRevision = normalizeAnchorRevision(patchValue.anchorRevision);
    if (hasOwn(patchValue, "anchorContentHash")) patch.anchorContentHash = normalizeAnchorContentHash(patchValue.anchorContentHash);
    if (Object.keys(patch).length === 0) throw invalidRequest("Choose something to update on the annotation.");
    const expectedRevision = normalizeExpectedRevision(input.expectedRevision);
    const requestFingerprint = fingerprint({
      operation: "update",
      actorMemberId: actor.memberId,
      annotationId,
      expectedRevision,
      patch,
    });

    return this.#mutate({ workspace, mutationId, actor, operation: "update", requestFingerprint }, (state) => {
      const annotation = this.#requireAnnotation(state, annotationId);
      this.#assertRevision(annotation, expectedRevision);
      Object.assign(annotation, patch);
      annotation.updatedAt = this.#nextTimestamp(annotation.updatedAt);
      annotation.updatedByMemberId = actor.memberId;
      annotation.revision += 1;
      return { kind: "annotation", annotation };
    });
  }

  async resolveAnnotation(request = {}) {
    const input = requireRecord(request, "The annotation resolution request is invalid.");
    assertOnlyKeys(
      input,
      new Set(["workspaceId", "mutationId", "actor", "annotationId", "resolved", "expectedRevision"]),
      "The annotation resolution request is invalid.",
    );
    const workspace = this.#captureWorkspace(input.workspaceId);
    const mutationId = normalizeMutationId(input.mutationId);
    const actor = normalizeActor(input.actor);
    const annotationId = normalizeAnnotationId(input.annotationId);
    if (typeof input.resolved !== "boolean") throw invalidRequest("The annotation resolution state is invalid.");
    const expectedRevision = normalizeExpectedRevision(input.expectedRevision);
    const requestFingerprint = fingerprint({
      operation: "resolve",
      actorMemberId: actor.memberId,
      annotationId,
      expectedRevision,
      resolved: input.resolved,
    });

    return this.#mutate({ workspace, mutationId, actor, operation: "resolve", requestFingerprint }, (state) => {
      const annotation = this.#requireAnnotation(state, annotationId);
      this.#assertRevision(annotation, expectedRevision);
      const timestamp = this.#nextTimestamp(annotation.updatedAt);
      annotation.resolved = input.resolved;
      annotation.resolvedAt = input.resolved ? timestamp : null;
      annotation.resolvedByMemberId = input.resolved ? actor.memberId : null;
      annotation.updatedAt = timestamp;
      annotation.updatedByMemberId = actor.memberId;
      annotation.revision += 1;
      return { kind: "annotation", annotation };
    });
  }

  async appendReply(request = {}) {
    const input = requireRecord(request, "The annotation reply request is invalid.");
    assertOnlyKeys(
      input,
      new Set(["workspaceId", "mutationId", "actor", "annotationId", "context", "expectedRevision"]),
      "The annotation reply request is invalid.",
    );
    const workspace = this.#captureWorkspace(input.workspaceId);
    const mutationId = normalizeMutationId(input.mutationId);
    const actor = normalizeActor(input.actor);
    const annotationId = normalizeAnnotationId(input.annotationId);
    const context = boundedText(input.context, {
      label: "The reply context",
      maximumBytes: MAX_REPLY_BYTES,
    });
    const expectedRevision = normalizeExpectedRevision(input.expectedRevision);
    const requestFingerprint = fingerprint({
      operation: "reply",
      actorMemberId: actor.memberId,
      annotationId,
      expectedRevision,
      context,
    });

    return this.#mutate({ workspace, mutationId, actor, operation: "reply", requestFingerprint }, (state) => {
      const annotation = this.#requireAnnotation(state, annotationId);
      this.#assertRevision(annotation, expectedRevision);
      if (annotation.replies.length >= MAX_REPLIES_PER_ANNOTATION) {
        throw new WorkspaceError("ANNOTATION_REPLY_LIMIT", "This annotation has reached its reply limit.");
      }
      const timestamp = this.#nextTimestamp(annotation.updatedAt);
      const reply = {
        id: this.#uniqueId(state),
        context,
        authorMemberId: actor.memberId,
        authorDisplayName: actor.displayName,
        createdAt: timestamp,
      };
      annotation.replies.push(reply);
      annotation.updatedAt = timestamp;
      annotation.updatedByMemberId = actor.memberId;
      annotation.revision += 1;
      return { kind: "annotation", annotation };
    });
  }

  async deleteAnnotation(request = {}) {
    const input = requireRecord(request, "The annotation delete request is invalid.");
    assertOnlyKeys(
      input,
      new Set(["workspaceId", "mutationId", "actor", "annotationId", "expectedRevision"]),
      "The annotation delete request is invalid.",
    );
    const workspace = this.#captureWorkspace(input.workspaceId);
    const mutationId = normalizeMutationId(input.mutationId);
    const actor = normalizeActor(input.actor);
    const annotationId = normalizeAnnotationId(input.annotationId);
    const expectedRevision = normalizeExpectedRevision(input.expectedRevision);
    const requestFingerprint = fingerprint({
      operation: "delete",
      actorMemberId: actor.memberId,
      annotationId,
      expectedRevision,
    });

    return this.#mutate({ workspace, mutationId, actor, operation: "delete", requestFingerprint }, (state) => {
      const index = state.annotations.findIndex((annotation) => annotation.id === annotationId);
      if (index < 0) throw new WorkspaceError("ANNOTATION_NOT_FOUND", "The annotation no longer exists.");
      const annotation = state.annotations[index];
      this.#assertRevision(annotation, expectedRevision);
      state.annotations.splice(index, 1);
      return {
        kind: "deleted",
        id: annotation.id,
        tombstone: {
          id: annotation.id,
          filePath: annotation.filePath,
          githubLink: annotation.githubLink,
          anchorRevision: annotation.anchorRevision,
          anchorContentHash: annotation.anchorContentHash,
          deletedAt: this.#nextTimestamp(annotation.updatedAt),
          deletedByMemberId: actor.memberId,
          revision: annotation.revision + 1,
        },
      };
    });
  }

  async listPendingMutations(request = {}) {
    const input = requireRecord(request, "The outbox request is invalid.");
    assertOnlyKeys(input, new Set(["workspaceId", "limit", "afterSequence"]), "The outbox request is invalid.");
    const workspace = this.#captureWorkspace(input.workspaceId);
    const limit = normalizeLimit(input.limit, MAX_OUTBOX_PAGE_SIZE, 50);
    const afterSequence = input.afterSequence === undefined || input.afterSequence === null
      ? 0
      : normalizeNonNegativeInteger(input.afterSequence, Number.MAX_SAFE_INTEGER, "The outbox cursor");
    return this.#serialized(async () => {
      this.#assertWorkspace(workspace);
      const storage = await this.#loadStorage();
      this.#assertWorkspace(workspace);
      const state = storage.workspaces[workspace.key] ?? defaultWorkspaceState();
      const candidates = state.outbox
        .filter((entry) => entry.sequence > afterSequence)
        .sort((left, right) => left.sequence - right.sequence);
      const items = [];
      let outputBytes = 0;
      for (const entry of candidates) {
        if (items.length >= limit) break;
        const entryBytes = byteLength(JSON.stringify(entry));
        if (items.length > 0 && outputBytes + entryBytes > MAX_LIST_OUTPUT_BYTES) break;
        items.push(cloneJson(entry));
        outputBytes += entryBytes;
      }
      return {
        items,
        nextSequence: items.length < candidates.length && items.length > 0 ? items.at(-1).sequence : null,
        pendingMutationCount: state.outbox.length,
      };
    });
  }

  async acknowledgeMutations(request = {}) {
    const input = requireRecord(request, "The outbox acknowledgement is invalid.");
    assertOnlyKeys(input, new Set(["workspaceId", "mutationIds"]), "The outbox acknowledgement is invalid.");
    const workspace = this.#captureWorkspace(input.workspaceId);
    if (!Array.isArray(input.mutationIds) || input.mutationIds.length === 0 || input.mutationIds.length > MAX_ACKNOWLEDGEMENTS) {
      throw invalidRequest("The outbox acknowledgement is invalid.");
    }
    const mutationIds = input.mutationIds.map(normalizeMutationId);
    if (new Set(mutationIds).size !== mutationIds.length) {
      throw invalidRequest("The outbox acknowledgement contains duplicate identities.");
    }
    return this.#serialized(async () => {
      this.#assertWorkspace(workspace);
      const storage = await this.#loadStorage();
      this.#assertWorkspace(workspace);
      const state = storage.workspaces[workspace.key];
      if (!state) return { acknowledged: 0, pendingMutationCount: 0 };
      const acknowledgedIds = new Set(mutationIds);
      const previousLength = state.outbox.length;
      state.outbox = state.outbox.filter((entry) => !acknowledgedIds.has(entry.mutationId));
      const acknowledged = previousLength - state.outbox.length;
      if (acknowledged > 0) {
        this.#trimJournal(state);
        this.#assertWorkspace(workspace);
        await this.#persistStorage(storage);
        this.#assertWorkspace(workspace);
      }
      return { acknowledged, pendingMutationCount: state.outbox.length };
    });
  }

  #mutate(metadata, applyMutation) {
    return this.#serialized(async () => {
      this.#assertWorkspace(metadata.workspace);
      const storage = await this.#loadStorage();
      this.#assertWorkspace(metadata.workspace);
      const existingState = storage.workspaces[metadata.workspace.key];
      if (!existingState && Object.keys(storage.workspaces).length >= MAX_WORKSPACES) {
        throw new WorkspaceError(
          "ANNOTATION_WORKSPACE_LIMIT",
          "Local annotation storage has reached its workspace limit.",
        );
      }
      const state = existingState ?? defaultWorkspaceState();
      storage.workspaces[metadata.workspace.key] = state;

      const prior = state.mutationJournal.find((entry) => entry.mutationId === metadata.mutationId);
      if (prior) {
        if (prior.operation !== metadata.operation || prior.fingerprint !== metadata.requestFingerprint) {
          throw new WorkspaceError(
            "MUTATION_CONFLICT",
            "That mutation identity was already used for a different annotation change.",
          );
        }
        return mutationResult(prior.result, state.outbox.length, true);
      }
      if (state.outbox.length >= MAX_OUTBOX_ENTRIES) {
        throw new WorkspaceError(
          "ANNOTATION_OUTBOX_FULL",
          "Too many annotation changes are waiting to sync. Reconnect before making more changes.",
        );
      }
      if (state.nextSequence >= Number.MAX_SAFE_INTEGER) {
        throw new WorkspaceError(
          "ANNOTATION_OUTBOX_FULL",
          "The local annotation outbox cannot accept more changes.",
        );
      }
      this.#makeJournalRoom(state);

      const result = applyMutation(state);
      const occurredAt = result.kind === "annotation" ? result.annotation.updatedAt : result.tombstone.deletedAt;
      const journalResult = result.kind === "annotation"
        ? { kind: "annotation", annotation: cloneJson(result.annotation) }
        : { kind: "deleted", id: result.id };
      const outboxPayload = result.kind === "annotation"
        ? { annotation: cloneJson(result.annotation) }
        : { tombstone: cloneJson(result.tombstone) };
      const outboxEntry = {
        sequence: state.nextSequence,
        mutationId: metadata.mutationId,
        operation: metadata.operation,
        annotationId: result.kind === "annotation" ? result.annotation.id : result.id,
        actorMemberId: metadata.actor.memberId,
        occurredAt,
        payload: outboxPayload,
      };
      state.nextSequence += 1;
      state.outbox.push(outboxEntry);
      state.mutationJournal.push({
        mutationId: metadata.mutationId,
        fingerprint: metadata.requestFingerprint,
        operation: metadata.operation,
        result: journalResult,
        recordedAt: occurredAt,
      });

      this.#assertWorkspace(metadata.workspace);
      await this.#persistStorage(storage);
      this.#assertWorkspace(metadata.workspace);
      return mutationResult(journalResult, state.outbox.length, false);
    });
  }

  #captureWorkspace(value) {
    const workspaceId = normalizeWorkspaceId(value);
    const context = this.#workspaceManager.getExecutionContext(workspaceId);
    if (
      !context ||
      typeof context.workspaceId !== "string" ||
      typeof context.rootPath !== "string" ||
      context.workspaceId.length === 0 ||
      context.rootPath.length === 0
    ) {
      throw new WorkspaceError("WORKSPACE_CHANGED", "The workspace identity could not be verified.");
    }
    return {
      workspaceId,
      key: workspaceStorageKey(context.workspaceId, context.rootPath),
    };
  }

  #assertWorkspace(expected) {
    const current = this.#captureWorkspace(expected.workspaceId);
    if (current.key !== expected.key) {
      throw new WorkspaceError(
        "WORKSPACE_CHANGED",
        "The workspace changed before the annotation operation completed. Try again in the current folder.",
      );
    }
  }

  #serialized(action) {
    const result = this.#operationQueue.then(action, action);
    this.#operationQueue = result.catch(() => {});
    return result;
  }

  #timestamp() {
    const value = this.#now();
    const milliseconds = value instanceof Date ? value.getTime() : value;
    if (!Number.isFinite(milliseconds) || milliseconds < 0 || milliseconds > 8_640_000_000_000_000) {
      throw new WorkspaceError("IO_ERROR", "The annotation timestamp could not be created.");
    }
    return new Date(Math.trunc(milliseconds)).toISOString();
  }

  #uniqueId(state) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = normalizeAnnotationId(this.#randomUUID());
      const exists = state.annotations.some((annotation) => (
        annotation.id === id || annotation.replies.some((reply) => reply.id === id)
      ));
      if (!exists) return id;
    }
    throw new WorkspaceError("IO_ERROR", "A unique annotation identity could not be created.");
  }

  #nextTimestamp(previous) {
    const currentMilliseconds = Date.parse(this.#timestamp());
    const previousMilliseconds = Date.parse(previous);
    return new Date(Math.max(currentMilliseconds, previousMilliseconds + 1)).toISOString();
  }

  #requireAnnotation(state, annotationId) {
    const annotation = state.annotations.find((item) => item.id === annotationId);
    if (!annotation) throw new WorkspaceError("ANNOTATION_NOT_FOUND", "The annotation no longer exists.");
    return annotation;
  }

  #assertRevision(annotation, expectedRevision) {
    if (expectedRevision !== null && annotation.revision !== expectedRevision) {
      throw new WorkspaceError(
        "ANNOTATION_CONFLICT",
        "The annotation changed since it was opened. Refresh it before trying again.",
      );
    }
  }

  #makeJournalRoom(state) {
    if (state.mutationJournal.length < MAX_MUTATION_JOURNAL_ENTRIES) return;
    this.#trimJournal(state);
    if (state.mutationJournal.length >= MAX_MUTATION_JOURNAL_ENTRIES) {
      throw new WorkspaceError(
        "ANNOTATION_HISTORY_FULL",
        "Local annotation history is full. Reconnect before making more changes.",
      );
    }
  }

  #trimJournal(state) {
    const pending = new Set(state.outbox.map((entry) => entry.mutationId));
    while (state.mutationJournal.length > MAX_MUTATION_JOURNAL_ENTRIES / 2) {
      const removableIndex = state.mutationJournal.findIndex((entry) => !pending.has(entry.mutationId));
      if (removableIndex < 0) break;
      state.mutationJournal.splice(removableIndex, 1);
    }
  }

  async #loadStorage() {
    let handle;
    try {
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
      handle = await fsp.open(this.#settingsPath, flags);
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > MAX_STORAGE_BYTES) {
        throw new WorkspaceError(
          "ANNOTATION_STORAGE_CORRUPT",
          "Local annotations could not be read safely. The stored data appears to be damaged.",
        );
      }
      const contents = await handle.readFile();
      if (contents.length > MAX_STORAGE_BYTES) {
        throw new WorkspaceError(
          "ANNOTATION_STORAGE_CORRUPT",
          "Local annotations could not be read safely. The stored data appears to be damaged.",
        );
      }
      return parseStorage(contents.toString("utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return defaultStorage();
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError("IO_ERROR", "Local annotations could not be read.");
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async #persistStorage(storage) {
    const contents = Buffer.from(JSON.stringify(storage), "utf8");
    if (contents.length > MAX_STORAGE_BYTES) {
      throw new WorkspaceError(
        "ANNOTATION_STORAGE_FULL",
        "Local annotation storage is full. Reconnect and sync pending changes before continuing.",
      );
    }

    const directory = path.dirname(this.#settingsPath);
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    await fsp.chmod(directory, 0o700).catch(() => {});
    const temporaryPath = `${this.#settingsPath}.${crypto.randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fsp.open(temporaryPath, "wx", 0o600);
      await handle.writeFile(contents);
      await handle.sync();
      await handle.close();
      handle = null;
      await fsp.rename(temporaryPath, this.#settingsPath);
      await fsp.chmod(this.#settingsPath, 0o600).catch(() => {});

      let directoryHandle;
      try {
        directoryHandle = await fsp.open(directory, "r");
        await directoryHandle.sync();
      } catch (error) {
        if (!["EINVAL", "ENOTSUP", "EISDIR"].includes(error?.code)) throw error;
      } finally {
        await directoryHandle?.close().catch(() => {});
      }
    } catch (error) {
      await handle?.close().catch(() => {});
      await fsp.rm(temporaryPath, { force: true }).catch(() => {});
      if (error instanceof WorkspaceError) throw error;
      throw new WorkspaceError("IO_ERROR", "Local annotations could not be saved.");
    }
  }
}

module.exports = {
  AnnotationManager,
  MAX_ANNOTATIONS_PER_WORKSPACE,
  MAX_CONTEXT_BYTES,
  MAX_LIST_OUTPUT_BYTES,
  MAX_OUTBOX_ENTRIES,
  MAX_PAGE_SIZE,
  MAX_REPLIES_PER_ANNOTATION,
  MAX_REPLY_BYTES,
  MAX_STORAGE_BYTES,
  normalizeFilePath,
  normalizeAnchorRevision,
  normalizeGitHubLink,
  normalizeRange,
  workspaceStorageKey,
};
