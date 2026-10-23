export type SqlMigration = {
  id: string;
  sql: string;
};

export const STORAGE_MIGRATIONS: SqlMigration[] = [
  {
    id: "001_initial_storage",
    sql: `
      CREATE TABLE IF NOT EXISTS fortexa_wallets (
        user_id TEXT PRIMARY KEY,
        public_key TEXT NOT NULL,
        source TEXT NOT NULL,
        provider TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fortexa_audit_entries (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL,
        payload JSONB NOT NULL
      );

      CREATE INDEX IF NOT EXISTS fortexa_audit_entries_user_ts_idx
      ON fortexa_audit_entries (user_id, timestamp DESC);

      CREATE TABLE IF NOT EXISTS fortexa_usage (
        user_id TEXT PRIMARY KEY,
        spent_xlm DOUBLE PRECISION NOT NULL,
        tool_calls INTEGER NOT NULL,
        last_updated TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fortexa_policy_state (
        id SMALLINT PRIMARY KEY,
        version INTEGER NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        policy JSONB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fortexa_policy_history (
        version INTEGER PRIMARY KEY,
        updated_at TIMESTAMPTZ NOT NULL,
        updated_by TEXT,
        policy JSONB NOT NULL
      );
    `,
  },
  {
    id: "002_audit_hash_chain",
    sql: `
      ALTER TABLE fortexa_audit_entries
        ADD COLUMN IF NOT EXISTS entry_hash TEXT;

      CREATE INDEX IF NOT EXISTS fortexa_audit_entries_entry_hash_idx
        ON fortexa_audit_entries (entry_hash)
        WHERE entry_hash IS NOT NULL;
    `,
  },
  {
    id: "003_submit_idempotency",
    sql: `
      CREATE TABLE IF NOT EXISTS fortexa_submit_idempotency (
        user_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        xdr_hash TEXT NOT NULL,
        result JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (user_id, idempotency_key)
      );
    `,
  },
  {
    id: "004_wallet_expiration",
    sql: `
      ALTER TABLE fortexa_wallets
        ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
    `,
  },
  {
    id: "005_audit_chain_sequence",
    sql: `
      ALTER TABLE fortexa_audit_entries
        ADD COLUMN IF NOT EXISTS chain_sequence BIGINT;

      WITH ordered_entries AS (
        SELECT id,
          ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY timestamp ASC, id ASC) AS sequence
        FROM fortexa_audit_entries
      )
      UPDATE fortexa_audit_entries AS entries
      SET chain_sequence = ordered_entries.sequence
      FROM ordered_entries
      WHERE entries.id = ordered_entries.id
        AND entries.chain_sequence IS NULL;

      CREATE UNIQUE INDEX IF NOT EXISTS fortexa_audit_entries_user_sequence_idx
        ON fortexa_audit_entries (user_id, chain_sequence);
    `,
  },
];
