-- 旧構成（1 人用）。最初の利用者の状態はここから引き継ぐ
CREATE TABLE IF NOT EXISTS state (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, task TEXT, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', result TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status, created);
-- 利用者ごとの構成。接続キー（owner）と Mac の鍵（device）は SHA-256 だけを保存する
CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, owner_hash TEXT NOT NULL UNIQUE, device_hash TEXT NOT NULL UNIQUE, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS account_state (account TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS account_jobs (id TEXT PRIMARY KEY, account TEXT NOT NULL, kind TEXT NOT NULL, task TEXT, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', result TEXT, created TEXT NOT NULL, updated TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS account_jobs_status ON account_jobs(account, status, created);
-- 管理者画面（/admin.html）だけが使う表。利用者の画面・Mac からは読み書きできない
-- 利用者の管理用の情報：呼び名・プラン（api：saboro の API／byo：本人の AI／free：無料）・月額（税込・円）・状態（active／trial／stopped）・利用開始日・メモ
CREATE TABLE IF NOT EXISTS admin_users (account TEXT PRIMARY KEY, label TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL DEFAULT 'byo', price INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'trial', started TEXT, note TEXT NOT NULL DEFAULT '', updated TEXT NOT NULL);
-- 入金の記録（対象の月・金額は税込の円）
CREATE TABLE IF NOT EXISTS admin_payments (id TEXT PRIMARY KEY, account TEXT NOT NULL, month TEXT NOT NULL, amount INTEGER NOT NULL, method TEXT NOT NULL DEFAULT '', paid_on TEXT, note TEXT NOT NULL DEFAULT '', created TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS admin_payments_month ON admin_payments(month);
-- 費用（その月だけのもの、または毎月かかるもの。毎月のものは end_month の月まで）
CREATE TABLE IF NOT EXISTS admin_costs (id TEXT PRIMARY KEY, item TEXT NOT NULL, amount INTEGER NOT NULL, month TEXT NOT NULL, recurring INTEGER NOT NULL DEFAULT 0, end_month TEXT, note TEXT NOT NULL DEFAULT '', created TEXT NOT NULL);
-- 計算の設定（決済手数料率・消費税を引くか・1 ドルの円換算）
CREATE TABLE IF NOT EXISTS admin_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
