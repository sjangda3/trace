import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { argon2id } from "@noble/hashes/argon2.js";

const encoder = new TextEncoder();
const ARGON_MEMORY_KIB = 19_456;
const ARGON_ITERATIONS = 2;
const ARGON_PARALLELISM = 1;
const ARGON_OUTPUT_BYTES = 32;
const ARGON_SALT_BYTES = 16;
const MIN_PASSWORD_LENGTH = 12;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export type AccountUser = {
  id: string;
  email: string;
  displayName: string;
  emailVerifiedAt: string | null;
  createdAt: string;
};

export type StoredAccount = AccountUser & { passwordHash: string };

export type AuthTokenKind = "email-verification" | "password-reset";

export type DeviceSession = {
  id: string;
  userId: string;
  deviceId: string;
  refreshTokenHash: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string;
  revokedAt: string | null;
  replacedBySessionId: string | null;
};

export type GitHubIdentity = {
  userId: string;
  providerSubject: string;
  login: string;
  linkedAt: string;
};

export type GitHubOAuthTransaction = {
  id: string;
  userId: string;
  stateHash: string;
  codeVerifierCiphertext: string;
  redirectUri: string;
  expiresAt: string;
  consumedAt: string | null;
};

export type CreateAccountInput = {
  email: string;
  displayName: string;
  passwordHash: string;
};

export type CreateOneTimeTokenInput = {
  kind: AuthTokenKind;
  userId: string;
  tokenHash: string;
  expiresAt: string;
};

export type CreateDeviceSessionInput = {
  userId: string;
  deviceId: string;
  refreshTokenHash: string;
  expiresAt: string;
};

export type RotateDeviceSessionInput = CreateDeviceSessionInput & {
  previousRefreshTokenHash: string;
};

export type DeviceSessionRotation =
  | { kind: "rotated"; user: AccountUser; session: DeviceSession }
  | { kind: "reused-or-revoked" }
  | { kind: "missing" };

export type LinkGitHubIdentityInput = {
  userId: string;
  providerSubject: string;
  login: string;
};

export class AccountValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountValidationError";
  }
}

export function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new AccountValidationError("Enter a valid email address.");
  }
  return email;
}

export function normalizeDisplayName(value: string): string {
  const name = value.trim().replace(/\s+/gu, " ");
  if (name.length < 1 || name.length > 80 || Buffer.byteLength(name, "utf8") > 256) {
    throw new AccountValidationError("A display name between 1 and 80 characters is required.");
  }
  return name;
}

export function assertPassword(value: string): void {
  if (value.length < MIN_PASSWORD_LENGTH || value.length > 1024) {
    throw new AccountValidationError("Passwords must be at least 12 characters.");
  }
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function fixedEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

/** Password hashing with OWASP's Argon2id minimum profile (19 MiB, t=2, p=1). */
export class Argon2idPasswordHasher {
  async hash(password: string): Promise<string> {
    assertPassword(password);
    const salt = randomBytes(ARGON_SALT_BYTES);
    const output = argon2id(encoder.encode(password), salt, {
      m: ARGON_MEMORY_KIB,
      t: ARGON_ITERATIONS,
      p: ARGON_PARALLELISM,
      dkLen: ARGON_OUTPUT_BYTES,
    });
    return [
      "argon2id",
      "v=19",
      `m=${ARGON_MEMORY_KIB},t=${ARGON_ITERATIONS},p=${ARGON_PARALLELISM}`,
      encodeBase64Url(salt),
      encodeBase64Url(output),
    ].join("$");
  }

  async verify(password: string, encoded: string): Promise<boolean> {
    const parts = encoded.split("$");
    if (parts.length !== 5 || parts[0] !== "argon2id" || parts[1] !== "v=19") return false;
    const parameters = /^m=(\d+),t=(\d+),p=(\d+)$/u.exec(parts[2] ?? "");
    if (!parameters || !parts[3] || !parts[4]) return false;
    const memory = Number(parameters[1]);
    const iterations = Number(parameters[2]);
    const parallelism = Number(parameters[3]);
    if (!Number.isSafeInteger(memory) || !Number.isSafeInteger(iterations) || !Number.isSafeInteger(parallelism)) return false;
    try {
      const salt = decodeBase64Url(parts[3]);
      const expected = decodeBase64Url(parts[4]);
      const actual = argon2id(encoder.encode(password), salt, {
        m: memory,
        t: iterations,
        p: parallelism,
        dkLen: expected.length,
      });
      return fixedEqual(actual, expected);
    } catch {
      return false;
    }
  }
}

export class TokenHasher {
  readonly #key: Buffer;

  constructor(secret: string) {
    this.#key = Buffer.from(secret, "base64");
    if (this.#key.byteLength < 32) {
      throw new Error("A token pepper with at least 32 bytes is required.");
    }
  }

  hash(value: string): string {
    return createHmac("sha256", this.#key).update(value).digest("hex");
  }

  issue(bytes = 32): { token: string; tokenHash: string } {
    const token = randomBytes(bytes).toString("base64url");
    return { token, tokenHash: this.hash(token) };
  }
}

export type AccessTokenClaims = {
  sub: string;
  sid: string;
  name: string;
  email: string;
  verified: boolean;
  iat: number;
  exp: number;
};

/** Small HMAC-signed compact access token. Refresh credentials stay opaque. */
export class AccessTokenCodec {
  readonly #key: Buffer;
  readonly #issuer = "trace-control-plane";

  constructor(secret: string) {
    this.#key = Buffer.from(secret, "base64");
    if (this.#key.byteLength < 32) {
      throw new Error("An access-token signing key with at least 32 bytes is required.");
    }
  }

  issue(claims: Omit<AccessTokenClaims, "iat" | "exp">, now: Date, lifetimeSeconds = 900): string {
    const header = encodeBase64Url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
    const payload = encodeBase64Url(encoder.encode(JSON.stringify({
      iss: this.#issuer,
      ...claims,
      iat: Math.floor(now.getTime() / 1000),
      exp: Math.floor(now.getTime() / 1000) + lifetimeSeconds,
    })));
    const unsigned = `${header}.${payload}`;
    const signature = createHmac("sha256", this.#key).update(unsigned).digest("base64url");
    return `${unsigned}.${signature}`;
  }

  verify(token: string, now: Date): AccessTokenClaims | null {
    const [header, payload, signature, extra] = token.split(".");
    if (!header || !payload || !signature || extra) return null;
    const expected = createHmac("sha256", this.#key).update(`${header}.${payload}`).digest();
    let actual: Buffer;
    let parsed: unknown;
    try {
      actual = decodeBase64Url(signature);
      parsed = JSON.parse(decodeBase64Url(payload).toString("utf8"));
    } catch {
      return null;
    }
    if (!fixedEqual(expected, actual) || !parsed || typeof parsed !== "object") return null;
    const claims = parsed as Partial<AccessTokenClaims> & { iss?: string };
    const issuedAt = claims.iat;
    const expiresAt = claims.exp;
    if (
      claims.iss !== this.#issuer ||
      typeof claims.sub !== "string" ||
      typeof claims.sid !== "string" ||
      typeof claims.name !== "string" ||
      typeof claims.email !== "string" ||
      typeof claims.verified !== "boolean" ||
      typeof issuedAt !== "number" ||
      typeof expiresAt !== "number" ||
      !Number.isSafeInteger(issuedAt) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Math.floor(now.getTime() / 1000)
    ) return null;
    return {
      sub: claims.sub,
      sid: claims.sid,
      name: claims.name,
      email: claims.email,
      verified: claims.verified,
      iat: issuedAt,
      exp: expiresAt,
    };
  }
}

/** Encrypts the short-lived OAuth PKCE verifier at rest; never expose it to the renderer. */
export class SecretBox {
  readonly #key: Buffer;

  constructor(secret: string) {
    this.#key = Buffer.from(secret, "base64");
    if (this.#key.byteLength !== 32) {
      throw new Error("The OAuth encryption key must be exactly 32 bytes.");
    }
  }

  seal(value: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return [nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
  }

  open(value: string): string | null {
    const [nonceEncoded, tagEncoded, encryptedEncoded, extra] = value.split(".");
    if (!nonceEncoded || !tagEncoded || !encryptedEncoded || extra) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, decodeBase64Url(nonceEncoded));
      decipher.setAuthTag(decodeBase64Url(tagEncoded));
      return Buffer.concat([decipher.update(decodeBase64Url(encryptedEncoded)), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  }
}

type RateBucket = { count: number; resetAt: number };

/** Process-local protection for the control plane. Deployments can replace it with a shared limiter. */
export class FixedWindowRateLimiter {
  readonly #buckets = new Map<string, RateBucket>();
  constructor(readonly clock: () => Date = () => new Date()) {}

  consume(key: string, limit: number, windowSeconds: number): boolean {
    const now = this.clock().getTime();
    const bucket = this.#buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.#buckets.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return true;
    }
    if (bucket.count >= limit) return false;
    bucket.count += 1;
    return true;
  }
}
