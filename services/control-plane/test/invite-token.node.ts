import assert from "node:assert/strict";
import { test } from "node:test";
import { INVITE_TOKEN_PATTERN, InviteTokenCodec } from "../src/invite-token.js";

test("invite tokens are high-entropy and only deterministic HMAC hashes are persisted", () => {
  const codec = new InviteTokenCodec(Buffer.alloc(32, 1));
  const issued = codec.issue();
  assert.match(issued.token, INVITE_TOKEN_PATTERN);
  assert.match(issued.tokenHash, /^[0-9a-f]{64}$/);
  assert.notEqual(issued.tokenHash, issued.token);
  assert.equal(codec.hash(issued.token), issued.tokenHash);

  const differentPepper = new InviteTokenCodec(Buffer.alloc(32, 2));
  assert.notEqual(differentPepper.hash(issued.token), issued.tokenHash);
});

test("invite token codec rejects weak peppers and malformed tokens", () => {
  assert.throws(() => new InviteTokenCodec(Buffer.alloc(31)), /at least 32 bytes/);
  const codec = new InviteTokenCodec(Buffer.alloc(32));
  assert.throws(() => codec.hash("not-a-token"), /invalid/);
});
