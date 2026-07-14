ALTER TABLE workspaces
  ADD COLUMN repository_provider varchar(16),
  ADD COLUMN repository_owner varchar(39),
  ADD COLUMN repository_name varchar(100),
  ADD COLUMN repository_default_branch varchar(255),
  ADD CONSTRAINT workspaces_repository_binding_coherent CHECK (
    (
      repository_provider IS NULL
      AND repository_owner IS NULL
      AND repository_name IS NULL
      AND repository_default_branch IS NULL
    )
    OR (
      repository_provider = 'github'
      AND repository_owner IS NOT NULL
      AND repository_name IS NOT NULL
      AND repository_default_branch IS NOT NULL
    )
  ),
  ADD CONSTRAINT workspaces_repository_owner_format CHECK (
    repository_owner IS NULL
    OR repository_owner ~ '^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$'
  ),
  ADD CONSTRAINT workspaces_repository_name_format CHECK (
    repository_name IS NULL
    OR (
      repository_name ~ '^[A-Za-z0-9._-]+$'
      AND left(repository_name, 1) <> '.'
      AND right(repository_name, 4) <> '.git'
    )
  ),
  ADD CONSTRAINT workspaces_repository_default_branch_present CHECK (
    repository_default_branch IS NULL OR btrim(repository_default_branch) <> ''
  );

ALTER TABLE workspace_members ADD COLUMN member_id uuid;

UPDATE workspace_members SET member_id = gen_random_uuid() WHERE member_id IS NULL;

ALTER TABLE workspace_members
  ALTER COLUMN member_id SET NOT NULL,
  ADD CONSTRAINT workspace_members_member_id_unique UNIQUE (member_id);

ALTER TABLE control_records
  ADD COLUMN holder_client_id varchar(128),
  ADD COLUMN lease_expires_at timestamptz;

-- Version 001 could persist a user-only holder or a typing deadline without
-- the client lease required by the wire protocol. There is no safe client ID
-- to invent during an upgrade, so release those legacy controls and advance
-- both counters before installing the stricter invariants.
UPDATE control_records
   SET holder_user_id = NULL,
       holder_client_id = NULL,
       lease_expires_at = NULL,
       typing_count = 0,
       typing_until = NULL,
       version = version + 1,
       fence = fence + 1
 WHERE holder_user_id IS NOT NULL
    OR typing_count <> 0
    OR typing_until IS NOT NULL;

ALTER TABLE control_records
  ADD CONSTRAINT control_records_holder_client_format CHECK (
    holder_client_id IS NULL
    OR holder_client_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$'
  ),
  ADD CONSTRAINT control_records_lease_coherent CHECK (
    (
      holder_user_id IS NULL
      AND holder_client_id IS NULL
      AND lease_expires_at IS NULL
    )
    OR (
      holder_user_id IS NOT NULL
      AND holder_client_id IS NOT NULL
      AND lease_expires_at IS NOT NULL
    )
  ),
  ADD CONSTRAINT control_records_typing_bounded CHECK (typing_count <= 100),
  ADD CONSTRAINT control_records_typing_coherent CHECK (
    (typing_count = 0 AND typing_until IS NULL)
    OR (typing_count > 0 AND typing_until IS NOT NULL AND holder_user_id IS NOT NULL)
  );
