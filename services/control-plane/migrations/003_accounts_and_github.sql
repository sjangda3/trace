-- Trace account identity, one-time credentials, rotating device sessions, and GitHub links.
-- Existing development users remain valid and intentionally have no local credentials.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS password_hash TEXT,
  ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
  ON users (email)
  WHERE email IS NOT NULL;

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS github_installation_id BIGINT;

ALTER TABLE workspace_invites
  ADD COLUMN IF NOT EXISTS recipient_email TEXT;

CREATE TABLE IF NOT EXISTS auth_one_time_tokens (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('email-verification', 'password-reset')),
  user_id VARCHAR(128) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS auth_one_time_tokens_active_lookup
  ON auth_one_time_tokens (kind, token_hash)
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS device_sessions (
  id UUID PRIMARY KEY,
  user_id VARCHAR(128) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL CHECK (char_length(device_id) BETWEEN 1 AND 128),
  refresh_token_hash CHAR(64) NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  replaced_by_session_id UUID REFERENCES device_sessions(id),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS device_sessions_user_active
  ON device_sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS github_identities (
  user_id VARCHAR(128) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider_subject TEXT NOT NULL UNIQUE,
  login TEXT NOT NULL,
  linked_at TIMESTAMPTZ NOT NULL
);

-- GitHub user-to-server access is checked during OAuth and discarded. These
-- rows retain only the resulting authorization facts, never a GitHub token.
CREATE TABLE IF NOT EXISTS github_user_installations (
  user_id VARCHAR(128) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  installation_id BIGINT NOT NULL,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('User', 'Organization')),
  linked_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, installation_id)
);

CREATE TABLE IF NOT EXISTS github_user_repositories (
  user_id VARCHAR(128) NOT NULL,
  installation_id BIGINT NOT NULL,
  repository_id BIGINT NOT NULL,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  private BOOLEAN NOT NULL,
  PRIMARY KEY (user_id, installation_id, repository_id),
  FOREIGN KEY (user_id, installation_id)
    REFERENCES github_user_installations (user_id, installation_id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS github_oauth_transactions (
  id UUID PRIMARY KEY,
  user_id VARCHAR(128) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state_hash CHAR(64) NOT NULL UNIQUE,
  code_verifier_ciphertext TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS github_oauth_transactions_active_state
  ON github_oauth_transactions (state_hash)
  WHERE consumed_at IS NULL;
