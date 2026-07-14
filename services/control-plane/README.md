# Trace control plane

This directory is an independently runnable first slice of the provider-neutral Trace cloud control plane within the Trace repository. It owns workspace identity, membership, one-time invitations, and REST bootstrap state. It does not expose local filesystem paths or local macOS terminals.

## What is included

- TypeScript and Fastify with JSON Schema request validation and response serialization.
- Structured, request-correlated error responses.
- A repository interface shared by a serialized in-memory development adapter and a PostgreSQL adapter.
- An append-only SQL migration runner with checksums and an advisory lock.
- HMAC-SHA-256 invite-token hashes. A raw 256-bit invite token is returned once and is never persisted.
- Atomic invite redemption, membership limits, role checks, and workspace enumeration resistance.
- A narrow adapter that maps repository-bound bootstrap state to the shared collaboration protocol and validates every emitted snapshot envelope.
- Black-box HTTP and repository tests using Fastify injection and the Node.js test runner.

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

## Local in-memory run

The executable refuses to start an in-memory repository or development authentication unless each is explicitly enabled:

```bash
npm run build
TRACE_IN_MEMORY=1 \
TRACE_ENABLE_DEV_AUTH=1 \
npm start
```

It listens on `127.0.0.1:8787` by default. Development credentials use `Authorization: Bearer dev:<user-id>`. They have no signature and must never be exposed on a public interface.

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

The library entry point is `buildApp`. A production composition must inject a real `AuthProvider`, `PostgresControlPlaneRepository`, and stable `InviteTokenCodec`, then terminate TLS at a trusted edge. The included executable intentionally supports only the visibly unsafe development bearer provider so it cannot be mistaken for a production identity implementation.

## REST API

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | Public | Repository-backed readiness check. |
| `POST` | `/v1/workspaces` | Authenticated | Create a workspace; caller becomes owner. An optional GitHub repository binding makes protocol snapshots possible. |
| `POST` | `/v1/workspaces/:workspaceId/invites` | Owner | Create a one-time member invite. |
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
- Invites live from 5 minutes to 7 days; the default is 24 hours.
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

Before public deployment, provide the account/device authentication module described in `docs/CLOUD_ARCHITECTURE.md`, terminate TLS, apply per-identity rate limits, configure PostgreSQL TLS and backups, place the invite pepper in KMS-backed secret storage, and connect audit/telemetry sinks. Do not use the development bearer provider as a temporary public authentication system.
