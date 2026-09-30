CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS access_tokens (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS access_tokens_account ON access_tokens(account_id);
CREATE TABLE IF NOT EXISTS account_sessions (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(account_id, session_id),
  UNIQUE(session_id)
);
