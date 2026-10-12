-- 旧構成（1 人用）。最初の利用者の状態はここから引き継ぐ
CREATE TABLE IF NOT EXISTS state (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, task TEXT, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', result TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, created);
-- 利用者ごとの構成。接続キー（owner）と Mac の鍵（device）は SHA-256 だけを保存する
CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL UNIQUE, device_hash TEXT NOT NULL UNIQUE, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS account_state (account TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS account_jobs (id TEXT PRIMARY KEY, account TEXT NOT NULL, kind TEXT NOT NULL, task TEXT, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', result TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS account_jobs_status ON account_jobs(account, status, created);
