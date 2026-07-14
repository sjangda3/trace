const DEFAULT_TYPING_IDLE_MS = 900;

class ExclusiveControlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExclusiveControlError";
    this.code = code;
  }
}

function controlError(code, message) {
  return new ExclusiveControlError(code, message);
}

function validateActor(actor, { nullable = false } = {}) {
  if (nullable && actor === null) return null;
  if (
    !actor ||
    typeof actor !== "object" ||
    typeof actor.id !== "string" ||
    actor.id.length === 0 ||
    typeof actor.name !== "string" ||
    actor.name.length === 0
  ) {
    throw controlError("INVALID_CONTROL_ACTOR", "A valid control actor is required.");
  }
  return { id: actor.id, name: actor.name };
}

function validateCounter(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw controlError("INVALID_CONTROL_STATE", `The initial control ${label} is invalid.`);
  }
  return value;
}

function validateExpectedCounter(value, label) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw controlError("INVALID_CONTROL_REQUEST", `The expected control ${label} is invalid.`);
  }
  return value;
}

class ExclusiveControl {
  #clock;
  #setTimer;
  #clearTimer;
  #idleMs;
  #owner;
  #version;
  #fence;
  #typingUntil = null;
  #typingTimer = null;
  #listeners = new Set();
  #disposed = false;

  constructor({
    owner = null,
    clock = () => Date.now(),
    idleMs = DEFAULT_TYPING_IDLE_MS,
    version = 0,
    fence = 0,
    setTimer,
    clearTimer,
  } = {}) {
    if (typeof clock !== "function") {
      throw controlError("INVALID_CONTROL_STATE", "The control clock is invalid.");
    }
    if (!Number.isSafeInteger(idleMs) || idleMs <= 0) {
      throw controlError("INVALID_CONTROL_STATE", "The typing idle interval is invalid.");
    }
    if (setTimer !== undefined && typeof setTimer !== "function") {
      throw controlError("INVALID_CONTROL_STATE", "The control timer scheduler is invalid.");
    }
    if (clearTimer !== undefined && typeof clearTimer !== "function") {
      throw controlError("INVALID_CONTROL_STATE", "The control timer canceller is invalid.");
    }

    this.#clock = clock;
    this.#setTimer = setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.#clearTimer = clearTimer ?? ((timer) => clearTimeout(timer));
    this.#idleMs = idleMs;
    this.#owner = validateActor(owner, { nullable: true });
    this.#version = validateCounter(version, "version");
    this.#fence = validateCounter(fence, "fence");
  }

  onDidChange(listener) {
    this.#assertActive();
    if (typeof listener !== "function") {
      throw controlError("INVALID_CONTROL_REQUEST", "A valid control listener is required.");
    }
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  snapshot(viewer = null) {
    this.#assertActive();
    this.#expireTyping(false);
    const viewerId = viewer === null
      ? null
      : typeof viewer === "string"
        ? viewer
        : validateActor(viewer).id;
    return this.#snapshot(viewerId);
  }

  assertOwner(actor, { expectedFence } = {}) {
    this.#assertActive();
    const nextActor = validateActor(actor);
    this.#assertExpectedFence(validateExpectedCounter(expectedFence, "fence"));
    if (!this.#owner || this.#owner.id !== nextActor.id) {
      throw controlError("NOT_CONTROL_OWNER", "Take control before making this change.");
    }
    return this.#snapshot(nextActor.id);
  }

  requestControl(actor, { expectedVersion } = {}) {
    this.#assertActive();
    const nextActor = validateActor(actor);
    this.#expireTyping(false);
    this.#assertExpectedVersion(validateExpectedCounter(expectedVersion, "version"));

    if (this.#owner?.id === nextActor.id) return this.#snapshot(nextActor.id);
    if (this.#typingUntil !== null) {
      throw controlError(
        "CONTROL_BUSY",
        "Control can only change hands after everyone has stopped typing.",
      );
    }

    this.#assertFenceCanAdvance();
    this.#assertVersionCanAdvance();
    this.#incrementFence();
    this.#incrementVersion();
    this.#owner = nextActor;
    this.#emit();
    return this.#snapshot(nextActor.id);
  }

  markTyping(actor, { expectedFence } = {}) {
    this.#assertActive();
    const nextActor = validateActor(actor);
    this.#expireTyping(false);
    this.#assertExpectedFence(validateExpectedCounter(expectedFence, "fence"));
    if (!this.#owner || this.#owner.id !== nextActor.id) {
      throw controlError("NOT_CONTROL_OWNER", "Take control before making this change.");
    }

    const wasTyping = this.#typingUntil !== null;
    const now = this.#now();
    const nextDeadline = now + this.#idleMs;
    if (!Number.isSafeInteger(nextDeadline)) {
      throw controlError("CONTROL_STATE_EXHAUSTED", "The control timer can no longer advance safely.");
    }
    if (!wasTyping) this.#assertVersionCanAdvance();
    this.#typingUntil = nextDeadline;
    this.#scheduleTypingIdle();
    if (!wasTyping) {
      this.#incrementVersion();
      this.#emit();
    }
    return this.#snapshot(nextActor.id);
  }

  stopTyping({ notify = true } = {}) {
    this.#assertActive();
    if (typeof notify !== "boolean") {
      throw controlError("INVALID_CONTROL_REQUEST", "The typing notification option is invalid.");
    }
    if (this.#typingUntil === null) return this.#snapshot(null);
    this.#assertVersionCanAdvance();
    this.#typingUntil = null;
    this.#cancelTypingTimer();
    this.#incrementVersion();
    if (notify) this.#emit();
    return this.#snapshot(null);
  }

  releaseControl(actor, { expectedVersion, expectedFence } = {}) {
    this.#assertActive();
    const currentActor = validateActor(actor);
    this.#expireTyping(false);
    this.#assertExpectedVersion(validateExpectedCounter(expectedVersion, "version"));
    this.#assertExpectedFence(validateExpectedCounter(expectedFence, "fence"));
    if (!this.#owner || this.#owner.id !== currentActor.id) {
      throw controlError("NOT_CONTROL_OWNER", "Only the current owner can release control.");
    }

    this.#assertFenceCanAdvance();
    this.#assertVersionCanAdvance();
    this.#typingUntil = null;
    this.#cancelTypingTimer();
    this.#incrementFence();
    this.#incrementVersion();
    this.#owner = null;
    this.#emit();
    return this.#snapshot(currentActor.id);
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cancelTypingTimer();
    this.#listeners.clear();
  }

  #assertActive() {
    if (this.#disposed) {
      throw controlError("CONTROL_DISPOSED", "This control resource is no longer available.");
    }
  }

  #now() {
    const value = this.#clock();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw controlError("INVALID_CONTROL_STATE", "The control clock returned an invalid time.");
    }
    return value;
  }

  #assertExpectedVersion(expectedVersion) {
    if (expectedVersion !== undefined && expectedVersion !== this.#version) {
      throw controlError("CONTROL_CHANGED", "Control changed before the request could be applied.");
    }
  }

  #assertExpectedFence(expectedFence) {
    if (expectedFence !== undefined && expectedFence !== this.#fence) {
      throw controlError("CONTROL_CHANGED", "Control changed before the request could be applied.");
    }
  }

  #incrementVersion() {
    this.#assertVersionCanAdvance();
    this.#version += 1;
  }

  #incrementFence() {
    this.#assertFenceCanAdvance();
    this.#fence += 1;
  }

  #assertVersionCanAdvance() {
    if (this.#version >= Number.MAX_SAFE_INTEGER) {
      throw controlError("CONTROL_STATE_EXHAUSTED", "The control version can no longer advance safely.");
    }
  }

  #assertFenceCanAdvance() {
    if (this.#fence >= Number.MAX_SAFE_INTEGER) {
      throw controlError("CONTROL_STATE_EXHAUSTED", "The control fence can no longer advance safely.");
    }
  }

  #scheduleTypingIdle() {
    this.#cancelTypingTimer();
    const delay = Math.max(0, this.#typingUntil - this.#now());
    this.#typingTimer = this.#setTimer(() => {
      this.#typingTimer = null;
      if (this.#disposed) return;
      if (!this.#expireTyping(true) && this.#typingUntil !== null) this.#scheduleTypingIdle();
    }, delay);
  }

  #cancelTypingTimer() {
    if (this.#typingTimer === null) return;
    this.#clearTimer(this.#typingTimer);
    this.#typingTimer = null;
  }

  #expireTyping(notify) {
    if (this.#typingUntil === null || this.#typingUntil > this.#now()) return false;
    this.#assertVersionCanAdvance();
    this.#typingUntil = null;
    this.#cancelTypingTimer();
    this.#incrementVersion();
    if (notify) this.#emit();
    return true;
  }

  #snapshot(viewerId) {
    return {
      ownerId: this.#owner?.id ?? null,
      ownerName: this.#owner?.name ?? null,
      typingCount: this.#typingUntil === null ? 0 : 1,
      localHasControl: viewerId !== null && this.#owner?.id === viewerId,
      version: this.#version,
      fence: this.#fence,
    };
  }

  #emit() {
    const event = this.#snapshot(null);
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("Exclusive control listener failed:", error);
      }
    }
  }
}

module.exports = {
  DEFAULT_TYPING_IDLE_MS,
  ExclusiveControl,
  ExclusiveControlError,
};
