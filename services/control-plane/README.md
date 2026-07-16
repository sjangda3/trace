# Trace control plane

This directory is the provider-neutral Trace cloud control plane within the Trace repository. It owns account identity, rotating device sessions, GitHub identity links, workspace membership, one-time invitations, and REST bootstrap state. It does not expose local filesystem paths or local macOS terminals.

## What is included

- TypeScript and Fastify with JSON Schema request validation and response serialization.
- Structured, request-correlated error responses.
- A repository interface shared by a serialized in-memory development adapter and a PostgreSQL adapter.
- An append-only SQL migration runner with checksums and an advisory lock.
- HMAC-SHA-256 invite-token hashes. A raw 256-bit invite token is returned once and is never persisted.
- Atomic invite redemption, membership limits, role checks, and workspace enumeration resistance.
- A narrow adapter that maps repository-bound bootstrap state to the shared collaboration protocol and validates every emitted snapshot envelope.
- Black-box HTTP and repository tests using Fastify injection and the Node.js test runner.
- Self-hosted email/password accounts with Argon2id password hashes, expiring one-time verification/reset tokens, HMAC-hashed refresh tokens, and access-token/session checks on every authenticated request.
- Resend delivery through a provider boundary, with deterministic in-memory delivery used by tests.
- Browser-based GitHub OAuth with state validation and PKCE; only the linked GitHub identity is retained. The desktop's local GitHub credential is never sent to this service.
- GitHub App installation/repository selection through a cloud-side broker. The private key and installation credentials remain server-side.

The legacy-named `/room-snapshot` route contains workspace metadata, members, and the initial fenced code-control record. It is a REST bootstrap response, not a collaboration-protocol `SnapshotEnvelope`. WebSockets, room event mutation, presence, worker scheduling, and sandbox provisioning are deliberately outside this slice.

## Requirements

- Node.js 20.10 or newer.
- PostgreSQL 16 or newer for durable use.

Install and verify from this directory:

```bash
npm install
npm run typecheck
npm test
```

The install resolves the repository-local `@trace/collaboration-protocol` package through the declared file dependency; build that package before packaging or deploying the service from a source checkout.

An optional real-PostgreSQL contract test is available after applying migrations to a disposable database:

```bash
TEST_DATABASE_URL="postgresql://trace:password@127.0.0.1/trace_test" \
npm run test:postgres
```

## Local development run

The executable refuses to start an in-memory repository or development authentication unless each is explicitly enabled:

```bash
npm run build
TRACE_IN_MEMORY=1 \
TRACE_ENABLE_DEV_AUTH=1 \
npm start
```

It listens on `127.0.0.1:8787` by default. Development credentials use `Authorization: Bearer dev:<user-id>`. They have no signature and must never be exposed on a public interface. Development bearer auth deliberately bypasses the account routes; use the test suite for deterministic account-flow coverage.

## PostgreSQL run

Create a stable invite-token pepper and keep it in a secret manager:

```bash
openssl rand -base64 32
```

Then build and migrate:

```bash
npm run build
DATABASE_URL="postgresql://trace:password@127.0.0.1/trace" \
npm run migrate
```

For local PostgreSQL integration testing, the development authentication provider can still be enabled explicitly:

```bash
DATABASE_URL="postgresql://trace:password@127.0.0.1/trace" \
TRACE_INVITE_TOKEN_PEPPER="<base64-secret>" \
TRACE_ENABLE_DEV_AUTH=1 \
npm start
```

Run migrations before starting a new application version. Applied migration checksums are stored in `control_plane_schema_migrations`; never edit an applied migration. Add a new numbered migration instead.

## Production account configuration

Run migrations first, terminate TLS at a trusted edge, and provide these values through your secret manager—not the desktop renderer or repository:

```bash
DATABASE_URL=postgresql://trace:password@db/trace
TRACE_PUBLIC_URL=https://trace.example.com
TRACE_INVITE_TOKEN_PEPPER='<base64 32+ byte secret>'
TRACE_ACCESS_TOKEN_SIGNING_KEY='<base64 32+ byte secret>'
TRACE_REFRESH_TOKEN_PEPPER='<base64 32+ byte secret>'
TRACE_ACTION_TOKEN_PEPPER='<base64 32+ byte secret>'
TRACE_OAUTH_ENCRYPTION_KEY='<base64 exactly-32-byte secret>'
TRACE_RESEND_API_KEY=re_...
TRACE_RESEND_FROM='Trace <accounts@example.com>'
TRACE_GITHUB_OAUTH_CLIENT_ID=... # the Trace GitHub App's Client ID
TRACE_GITHUB_OAUTH_CLIENT_SECRET=... # the Trace GitHub App's client secret
TRACE_GITHUB_OAUTH_CALLBACK_URL=https://trace.example.com/v1/github/link/callback
TRACE_GITHUB_APP_ID=...
TRACE_GITHUB_APP_SLUG=trace
TRACE_GITHUB_APP_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\n...'
```

`TRACE_GITHUB_OAUTH_CALLBACK_URL` defaults to the callback under `TRACE_PUBLIC_URL`. These OAuth values are the GitHub App's user-to-server web-flow credentials: Trace uses the short-lived GitHub user token only in the callback to verify accessible installations and repositories, then discards it. It retains the GitHub identity plus short-lived, non-secret access facts (10 minutes), never a GitHub or desktop credential. The executable accepts production account traffic only with PostgreSQL. `TRACE_ENABLE_DEV_AUTH=1` remains an explicitly local, loopback-only escape hatch.

The Electron app additionally needs `TRACE_CONTROL_PLANE_URL=https://trace.example.com` at launch. Electron main stores the opaque refresh credential with `safeStorage`; the renderer receives only public account state and account commands.

## REST API

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | Public | Repository-backed readiness check. |
| `POST` | `/v1/auth/sign-up` | Public | Create an email/password account and send verification email. |
| `POST` | `/v1/auth/sign-in` | Public | Start a rotating desktop session. |
| `POST` | `/v1/auth/verify-email` | Public | Consume an expiring verification token. |
| `POST` | `/v1/auth/resend-verification` | Public | Generic resend response, rate limited. |
| `POST` | `/v1/auth/request-password-reset` | Public | Generic reset response, rate limited. |
| `POST` | `/v1/auth/confirm-password-reset` | Public | Consume reset token, replace password, revoke sessions. |
| `POST` | `/v1/auth/refresh` | Public | Rotate a desktop refresh session. |
| `POST` | `/v1/auth/sign-out` | Public | Revoke the supplied device refresh session. |
| `GET` | `/v1/auth/session` | Access token | Read public account/session state. |
| `POST` | `/v1/github/link/start` | Verified user | Start browser OAuth with PKCE. |
| `GET` | `/v1/github/link/callback` | Public | Validate state, exchange code, and retain GitHub identity/access facts without a credential. |
| `GET` | `/v1/github/app/installations` | Verified linked user | List GitHub App installations accessible to that user. |
| `GET` | `/v1/github/app/installations/:id/repositories` | Verified linked user | List repositories available to that installation. |
| `POST` | `/v1/workspaces` | Authenticated | Create a workspace; caller becomes owner. An optional GitHub repository binding makes protocol snapshots possible. |
| `POST` | `/v1/workspaces/:workspaceId/invites` | Owner | Create an email-addressed one-time member invite and copyable link. |
| `POST` | `/v1/invites/redeem` | Authenticated | Atomically consume an invite and join its workspace. |
| `GET` | `/v1/workspaces/:workspaceId/members` | Member | List invited workspace members. |
| `GET` | `/v1/workspaces/:workspaceId/room-snapshot` | Member | Read the legacy-named REST bootstrap response. |

Create a workspace:

```bash
curl -sS http://127.0.0.1:8787/v1/workspaces \
  -H 'authorization: Bearer dev:alice' \
  -H 'content-type: application/json' \
  --data '{"name":"Compiler team","repository":{"provider":"github","owner":"example","name":"compiler","defaultBranch":"main"}}'
```

The `repository` field is optional for REST compatibility. An unbound workspace remains usable by the current REST routes, but the protocol adapter refuses to invent a repository and will not emit a wire snapshot for it.

## Collaboration protocol boundary

`createInitialSnapshotEnvelope()` is the only control-plane boundary that creates the shared wire shape. It explicitly maps the stable membership ID, room sequence, structured workspace editor control, client lease state, and GitHub repository binding; currently unsupported presence, annotations, and recovery drafts are emitted as empty arrays. The result must pass the shared package's `validateSnapshotEnvelope()` runtime validator before it is returned.

The room sequence maps to both `SnapshotEnvelope.sequence` and `RoomSnapshot.snapshotVersion`. The opaque cursor is deterministically encoded as `room:<room-id>:sequence:<decimal-sequence>`; clients must still treat it as opaque. This adapter is not a WebSocket implementation and does not authorize or accept protocol commands.

Create an invite as its owner:

```bash
curl -sS http://127.0.0.1:8787/v1/workspaces/WORKSPACE_UUID/invites \
  -H 'authorization: Bearer dev:alice' \
  -H 'content-type: application/json' \
  --data '{"expiresInSeconds":86400}'
```

Redeem the returned token as another user:

```bash
curl -sS http://127.0.0.1:8787/v1/invites/redeem \
  -H 'authorization: Bearer dev:bob' \
  -H 'content-type: application/json' \
  --data '{"token":"RETURNED_ONE_TIME_TOKEN"}'
```

Errors have one stable shape and do not expose validator or database details:

```json
{
  "error": {
    "code": "OWNER_REQUIRED",
    "message": "Workspace owner access is required.",
    "requestId": "req-4"
  }
}
```

## Bounds and invariants

- Request bodies are limited to 16 KiB and reject unknown JSON fields.
- Workspace names contain 1–80 characters after trimming.
- Access tokens live for 15 minutes. Refresh sessions rotate and expire after 30 days; replaying an old refresh token revokes the session family.
- Verification and reset links live for 24 hours. Invites live from 5 minutes to 7 days; the default is 7 days.
- A workspace has at most 20 active invites and 50 members in this slice.
- Memberships have stable room member IDs distinct from account user IDs; the REST response intentionally continues to expose only the existing user-facing member fields.
- Only an owner can create an invite. An invite grants `member`, never `owner`.
- Invalid, expired, and consumed invite tokens share one response.
- An existing member cannot consume and burn an unused invite.
- Nonmembers receive the same workspace-not-found response as an unknown workspace.
- Concurrent redemptions serialize so exactly one new member can consume a token.
- Repository records are cloned by the in-memory adapter to prevent mutation by reference.
- PostgreSQL transactions and constraints repeat the role, limit, uniqueness, and membership checks rather than trusting the HTTP handler alone.

## Production boundary

Before public deployment, configure PostgreSQL TLS/backups, place the signing keys and peppers in KMS-backed secret storage, provision the verified Resend sender and GitHub callback domain, apply a shared edge rate limiter, and connect audit/telemetry sinks. Do not use the development bearer provider as a temporary public authentication system.
