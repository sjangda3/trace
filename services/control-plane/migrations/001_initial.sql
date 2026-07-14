CREATE TABLE users (
  id varchar(128) PRIMARY KEY,
  display_name varchar(256) NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT users_id_format CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'),
  CONSTRAINT users_display_name_present CHECK (btrim(display_name) <> '')
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  room_id uuid NOT NULL UNIQUE,
  name varchar(80) NOT NULL,
  state varchar(24) NOT NULL,
  room_sequence bigint NOT NULL DEFAULT 0,
  created_by_user_id varchar(128) NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  CONSTRAINT workspaces_name_present CHECK (btrim(name) <> ''),
  CONSTRAINT workspaces_state_known CHECK (state IN ('created')),
  CONSTRAINT workspaces_room_sequence_nonnegative CHECK (room_sequence >= 0)
);

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id varchar(128) NOT NULL REFERENCES users(id),
  role varchar(16) NOT NULL,
  joined_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, user_id),
  CONSTRAINT workspace_members_role_known CHECK (role IN ('owner', 'member'))
);

CREATE INDEX workspace_members_user_id_idx ON workspace_members (user_id, workspace_id);

CREATE UNIQUE INDEX workspace_members_single_owner_idx
  ON workspace_members (workspace_id)
  WHERE role = 'owner';

CREATE TABLE workspace_invites (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  role varchar(16) NOT NULL DEFAULT 'member',
  created_by_user_id varchar(128) NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  redeemed_at timestamptz,
  redeemed_by_user_id varchar(128) REFERENCES users(id),
  CONSTRAINT workspace_invites_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT workspace_invites_role_member_only CHECK (role = 'member'),
  CONSTRAINT workspace_invites_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT workspace_invites_redemption_pair CHECK (
    (redeemed_at IS NULL AND redeemed_by_user_id IS NULL)
    OR (redeemed_at IS NOT NULL AND redeemed_by_user_id IS NOT NULL)
  )
);

CREATE INDEX workspace_invites_active_idx
  ON workspace_invites (workspace_id, expires_at)
  WHERE redeemed_at IS NULL;

CREATE TABLE control_records (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  resource_kind varchar(16) NOT NULL,
  resource_id varchar(64) NOT NULL,
  holder_user_id varchar(128),
  version bigint NOT NULL DEFAULT 0,
  fence bigint NOT NULL DEFAULT 0,
  typing_count integer NOT NULL DEFAULT 0,
  typing_until timestamptz,
  PRIMARY KEY (workspace_id, resource_kind, resource_id),
  CONSTRAINT control_records_resource_kind_known CHECK (resource_kind IN ('code', 'terminal')),
  CONSTRAINT control_records_counters_nonnegative CHECK (
    version >= 0 AND fence >= 0 AND typing_count >= 0
  ),
  CONSTRAINT control_records_holder_is_member FOREIGN KEY (workspace_id, holder_user_id)
    REFERENCES workspace_members (workspace_id, user_id)
);

CREATE TABLE room_events (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  room_sequence bigint NOT NULL,
  operation_id varchar(128) NOT NULL,
  actor_user_id varchar(128) NOT NULL REFERENCES users(id),
  event_type varchar(80) NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, room_sequence),
  UNIQUE (workspace_id, operation_id),
  CONSTRAINT room_events_sequence_positive CHECK (room_sequence > 0),
  CONSTRAINT room_events_operation_id_present CHECK (btrim(operation_id) <> ''),
  CONSTRAINT room_events_event_type_present CHECK (btrim(event_type) <> ''),
  CONSTRAINT room_events_payload_object CHECK (jsonb_typeof(payload) = 'object')
);
