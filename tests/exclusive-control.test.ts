import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

type Actor = { id: string; name: string };
type ControlSnapshot = {
  ownerId: string | null;
  ownerName: string | null;
  typingCount: 0 | 1;
  localHasControl: boolean;
  version: number;
  fence: number;
};

interface ExclusiveControlInstance {
  onDidChange(listener: (snapshot: ControlSnapshot) => void): () => void;
  snapshot(viewer?: Actor | string | null): ControlSnapshot;
  assertOwner(actor: Actor, options?: { expectedFence?: number }): ControlSnapshot;
  requestControl(actor: Actor, options?: { expectedVersion?: number }): ControlSnapshot;
  markTyping(actor: Actor, options?: { expectedFence?: number }): ControlSnapshot;
  stopTyping(options?: { notify?: boolean }): ControlSnapshot;
  releaseControl(
    actor: Actor,
    options?: { expectedVersion?: number; expectedFence?: number },
  ): ControlSnapshot;
  dispose(): void;
}

type TimerCallback = () => void;

class ManualTime {
  now = 10_000;
  private nextTimerId = 1;
  private timers = new Map<number, { at: number; callback: TimerCallback }>();

  readonly clock = () => this.now;

  readonly setTimer = (callback: TimerCallback, delay: number) => {
    const id = this.nextTimerId;
    this.nextTimerId += 1;
    this.timers.set(id, { at: this.now + delay, callback });
    return id;
  };

  readonly clearTimer = (id: number) => {
    this.timers.delete(id);
  };

  advance(milliseconds: number) {
    const target = this.now + milliseconds;
    let callbacks = 0;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.now = timer.at;
      timer.callback();
      callbacks += 1;
      if (callbacks > 1_000) throw new Error("Manual timer loop did not settle.");
    }
    this.now = target;
  }

  jumpWithoutTimers(milliseconds: number) {
    this.now += milliseconds;
  }

  get pendingTimers() {
    return this.timers.size;
  }
}

const require = createRequire(import.meta.url);
const {
  DEFAULT_TYPING_IDLE_MS,
  ExclusiveControl,
} = require("../electron/exclusive-control.cjs") as {
  DEFAULT_TYPING_IDLE_MS: number;
  ExclusiveControl: new (options?: {
    owner?: Actor | null;
    clock?: () => number;
    idleMs?: number;
    version?: number;
    fence?: number;
    setTimer?: (callback: TimerCallback, delay: number) => number;
    clearTimer?: (id: number) => void;
  }) => ExclusiveControlInstance;
};

const alice = { id: "alice", name: "Alice" };
const bob = { id: "bob", name: "Bob" };
const carol = { id: "carol", name: "Carol" };

function makeControl(owner: Actor | null = alice) {
  const time = new ManualTime();
  const control = new ExclusiveControl({
    owner,
    clock: time.clock,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
  });
  return { control, time };
}

function thrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the control operation to throw.");
}

describe("ExclusiveControl", () => {
  it("starts with a stable owner and exposes viewer-relative ownership", () => {
    expect(DEFAULT_TYPING_IDLE_MS).toBe(900);
    const { control } = makeControl();

    expect(control.snapshot(alice)).toEqual({
      ownerId: "alice",
      ownerName: "Alice",
      typingCount: 0,
      localHasControl: true,
      version: 0,
      fence: 0,
    });
    expect(control.snapshot(bob)).toMatchObject({ localHasControl: false, version: 0, fence: 0 });
    expect(control.requestControl(alice, { expectedVersion: 0 })).toMatchObject({
      ownerId: "alice",
      version: 0,
      fence: 0,
    });
  });

  it("uses compare-and-swap so only one request from a shared snapshot wins", () => {
    const { control } = makeControl();
    const events: ControlSnapshot[] = [];
    control.onDidChange((event) => events.push(event));

    expect(control.requestControl(bob, { expectedVersion: 0 })).toMatchObject({
      ownerId: "bob",
      localHasControl: true,
      version: 1,
      fence: 1,
    });
    expect(thrownBy(() => control.requestControl(carol, { expectedVersion: 0 }))).toMatchObject({
      code: "CONTROL_CHANGED",
    });
    expect(control.snapshot()).toMatchObject({ ownerId: "bob", version: 1, fence: 1 });
    expect(events).toHaveLength(1);

    control.requestControl(bob, { expectedVersion: 1 });
    expect(events).toHaveLength(1);
  });

  it("blocks handoff until the exact 900ms typing-idle boundary", () => {
    const { control, time } = makeControl();
    const events: ControlSnapshot[] = [];
    control.onDidChange((event) => events.push(event));

    expect(control.markTyping(alice, { expectedFence: 0 })).toMatchObject({
      typingCount: 1,
      version: 1,
      fence: 0,
    });
    expect(thrownBy(() => control.requestControl(bob, { expectedVersion: 1 }))).toMatchObject({
      code: "CONTROL_BUSY",
    });

    time.advance(DEFAULT_TYPING_IDLE_MS - 1);
    expect(control.snapshot()).toMatchObject({ typingCount: 1, version: 1 });
    time.advance(1);
    expect(control.snapshot()).toMatchObject({ typingCount: 0, version: 2, fence: 0 });
    expect(events.map(({ version, typingCount }) => ({ version, typingCount }))).toEqual([
      { version: 1, typingCount: 1 },
      { version: 2, typingCount: 0 },
    ]);

    expect(control.requestControl(bob, { expectedVersion: 2 })).toMatchObject({
      ownerId: "bob",
      version: 3,
      fence: 1,
    });
  });

  it("extends the idle deadline without changing the observable typing version", () => {
    const { control, time } = makeControl();
    const listener = vi.fn();
    control.onDidChange(listener);

    control.markTyping(alice, { expectedFence: 0 });
    time.advance(DEFAULT_TYPING_IDLE_MS - 1);
    expect(control.markTyping(alice, { expectedFence: 0 })).toMatchObject({
      typingCount: 1,
      version: 1,
    });
    expect(listener).toHaveBeenCalledTimes(1);

    time.advance(DEFAULT_TYPING_IDLE_MS - 1);
    expect(control.snapshot()).toMatchObject({ typingCount: 1, version: 1 });
    time.advance(1);
    expect(control.snapshot()).toMatchObject({ typingCount: 0, version: 2 });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("fences delayed input after ownership changes", () => {
    const { control } = makeControl();
    control.requestControl(bob, { expectedVersion: 0 });

    expect(thrownBy(() => control.markTyping(bob, { expectedFence: 0 }))).toMatchObject({
      code: "CONTROL_CHANGED",
    });
    expect(thrownBy(() => control.markTyping(alice, { expectedFence: 1 }))).toMatchObject({
      code: "NOT_CONTROL_OWNER",
    });
    expect(control.markTyping(bob, { expectedFence: 1 })).toMatchObject({
      ownerId: "bob",
      typingCount: 1,
      version: 2,
      fence: 1,
    });
  });

  it("keeps the fence monotonic across release and reacquisition", () => {
    const { control, time } = makeControl();
    control.markTyping(alice, { expectedFence: 0 });

    expect(control.releaseControl(alice, { expectedVersion: 1, expectedFence: 0 })).toEqual({
      ownerId: null,
      ownerName: null,
      typingCount: 0,
      localHasControl: false,
      version: 2,
      fence: 1,
    });
    expect(time.pendingTimers).toBe(0);
    expect(control.requestControl(bob, { expectedVersion: 2 })).toMatchObject({
      ownerId: "bob",
      version: 3,
      fence: 2,
    });
    expect(thrownBy(() => control.releaseControl(carol, {
      expectedVersion: 3,
      expectedFence: 2,
    }))).toMatchObject({ code: "NOT_CONTROL_OWNER" });
    expect(control.snapshot()).toMatchObject({ ownerId: "bob", version: 3, fence: 2 });
  });

  it("can clear typing silently and cancels all idle work on disposal", () => {
    const { control, time } = makeControl();
    const listener = vi.fn();
    control.onDidChange(listener);
    control.markTyping(alice);

    expect(control.stopTyping({ notify: false })).toMatchObject({ typingCount: 0, version: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(time.pendingTimers).toBe(0);
    time.advance(DEFAULT_TYPING_IDLE_MS * 2);
    expect(listener).toHaveBeenCalledTimes(1);

    control.markTyping(alice);
    expect(time.pendingTimers).toBe(1);
    control.dispose();
    expect(time.pendingTimers).toBe(0);
    time.advance(DEFAULT_TYPING_IDLE_MS);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(thrownBy(() => control.snapshot())).toMatchObject({ code: "CONTROL_DISPOSED" });
  });

  it("expires typing during a synchronous read without emitting an unsolicited event", () => {
    const { control, time } = makeControl();
    const listener = vi.fn();
    control.onDidChange(listener);
    control.markTyping(alice);

    time.jumpWithoutTimers(DEFAULT_TYPING_IDLE_MS);
    expect(control.snapshot()).toMatchObject({ typingCount: 0, version: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(time.pendingTimers).toBe(0);
  });

  it("rejects invalid actors, clocks, counters, listeners, and CAS values", () => {
    expect(thrownBy(() => new ExclusiveControl({ owner: { id: "", name: "Nobody" } }))).toMatchObject({
      code: "INVALID_CONTROL_ACTOR",
    });
    expect(thrownBy(() => new ExclusiveControl({ idleMs: 0 }))).toMatchObject({
      code: "INVALID_CONTROL_STATE",
    });
    expect(thrownBy(() => new ExclusiveControl({ version: -1 }))).toMatchObject({
      code: "INVALID_CONTROL_STATE",
    });

    const invalidClock = new ExclusiveControl({ owner: alice, clock: () => Number.NaN });
    expect(thrownBy(() => invalidClock.markTyping(alice))).toMatchObject({ code: "INVALID_CONTROL_STATE" });

    const { control } = makeControl();
    expect(thrownBy(() => control.onDidChange(null as never))).toMatchObject({
      code: "INVALID_CONTROL_REQUEST",
    });
    expect(thrownBy(() => control.requestControl(bob, { expectedVersion: -1 }))).toMatchObject({
      code: "INVALID_CONTROL_REQUEST",
    });
    expect(thrownBy(() => control.markTyping(alice, { expectedFence: 1.5 }))).toMatchObject({
      code: "INVALID_CONTROL_REQUEST",
    });
  });

  it("does not partially mutate when a monotonic counter is exhausted", () => {
    const fenceExhausted = new ExclusiveControl({
      owner: alice,
      fence: Number.MAX_SAFE_INTEGER,
    });
    expect(thrownBy(() => fenceExhausted.requestControl(bob, { expectedVersion: 0 }))).toMatchObject({
      code: "CONTROL_STATE_EXHAUSTED",
    });
    expect(fenceExhausted.snapshot()).toMatchObject({
      ownerId: "alice",
      version: 0,
      fence: Number.MAX_SAFE_INTEGER,
    });

    const versionExhausted = new ExclusiveControl({
      owner: alice,
      version: Number.MAX_SAFE_INTEGER,
    });
    expect(thrownBy(() => versionExhausted.requestControl(bob, {
      expectedVersion: Number.MAX_SAFE_INTEGER,
    }))).toMatchObject({ code: "CONTROL_STATE_EXHAUSTED" });
    expect(versionExhausted.snapshot()).toMatchObject({
      ownerId: "alice",
      version: Number.MAX_SAFE_INTEGER,
      fence: 0,
    });
  });
});
