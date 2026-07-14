import { createHmac, randomBytes } from "node:crypto";

const TOKEN_BYTES = 32;
const MINIMUM_PEPPER_BYTES = 32;
export const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class InviteTokenCodec {
  readonly #pepper: Buffer;

  constructor(pepper: Uint8Array) {
    if (pepper.byteLength < MINIMUM_PEPPER_BYTES) {
      throw new Error(`The invite token pepper must be at least ${MINIMUM_PEPPER_BYTES} bytes.`);
    }
    this.#pepper = Buffer.from(pepper);
  }

  issue(): { token: string; tokenHash: string } {
    const token = randomBytes(TOKEN_BYTES).toString("base64url");
    return { token, tokenHash: this.hash(token) };
  }

  hash(token: string): string {
    if (!INVITE_TOKEN_PATTERN.test(token)) {
      throw new Error("The invite token is invalid.");
    }
    return createHmac("sha256", this.#pepper).update(token, "utf8").digest("hex");
  }
}
