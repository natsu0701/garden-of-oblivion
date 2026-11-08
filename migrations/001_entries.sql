CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  owner_hash TEXT NOT NULL,
  seed BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS entries_created_idx ON entries (created_at DESC);
