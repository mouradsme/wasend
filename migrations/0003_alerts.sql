CREATE TABLE IF NOT EXISTS alert_settings (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  email TEXT NOT NULL DEFAULT '',
  slack_webhook_url TEXT NOT NULL DEFAULT '',
  delay_minutes INTEGER NOT NULL DEFAULT 5,
  updated_at INTEGER NOT NULL
);
