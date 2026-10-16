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
-- Stripe 連携：Stripe の顧客 ID と利用者の対応、利用者の分からない入金（管理者画面で割り当てる）
CREATE TABLE IF NOT EXISTS admin_stripe_customers (customer TEXT PRIMARY KEY, account TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admin_stripe_unmatched (id TEXT PRIMARY KEY, customer TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', month TEXT NOT NULL, amount INTEGER NOT NULL, paid_on TEXT, note TEXT NOT NULL DEFAULT '', created TEXT NOT NULL);
-- Stripe の定期支払い（サブスクリプション）の状態。定期支払いごと（解約して入り直した顧客は 2 件になる）。通知の時刻（event_at）より古い通知では上書きしない
CREATE TABLE IF NOT EXISTS admin_subscriptions (subscription TEXT PRIMARY KEY, customer TEXT NOT NULL, status TEXT NOT NULL, period_end INTEGER, cancel_at_period_end INTEGER NOT NULL DEFAULT 0, event_at INTEGER NOT NULL DEFAULT 0, updated TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS admin_subscriptions_customer ON admin_subscriptions(customer);
-- SaBoRo の AI（こちらの API キーで回答を作る。定期支払いが有効な人と、管理画面で登録した利用者だけ）
-- 使用量：1 回ごと。月の「課題生成」の回数が無料分（既定 60 回）を超えた後の回は billable=1 で、実費×上乗せ率の円（100 万分の 1 円単位）を charge_micro に持つ。
-- billed：Stripe の請求項目にした日（未請求は NULL）
CREATE TABLE IF NOT EXISTS ai_usage (id TEXT PRIMARY KEY, account TEXT NOT NULL, month TEXT NOT NULL, label TEXT NOT NULL, mode TEXT NOT NULL, model TEXT NOT NULL DEFAULT '', input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, billable INTEGER NOT NULL DEFAULT 0, charge_micro INTEGER NOT NULL DEFAULT 0, billed TEXT, created TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ai_usage_account_month ON ai_usage(account, month);
CREATE INDEX IF NOT EXISTS ai_usage_unbilled ON ai_usage(billable, billed);
-- Batch（急がない依頼）：依頼のキー（課題と設問・資料から作る）ごとに 1 件。結果は渡してから数日で消す
CREATE TABLE IF NOT EXISTS ai_requests (id TEXT PRIMARY KEY, account TEXT NOT NULL, key TEXT NOT NULL, label TEXT NOT NULL, batch_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', result TEXT, reason TEXT, created TEXT NOT NULL, updated TEXT NOT NULL, UNIQUE(account, key));
CREATE INDEX IF NOT EXISTS ai_requests_status ON ai_requests(status, updated);
-- 作っている最中の依頼（同時に作る数と 1 日の回数の上限を守るための予約）。作り終えたら消す。残ったもの（Worker が途中で止まったなど）は 30 分たてば数えず、定期実行で消す
CREATE TABLE IF NOT EXISTS ai_inflight (id TEXT PRIMARY KEY, account TEXT NOT NULL, created TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ai_inflight_account ON ai_inflight(account, created);
-- 出席コードの共有：同じ授業（manabo の授業 ID。なければ授業名）の利用者がその日に入れた出席コード。1 人 1 授業 1 日 1 件（入れ直せば上書き）。画面の入力に「他ユーザーの入力コード」として出す
CREATE TABLE IF NOT EXISTS attendance_codes (course TEXT NOT NULL, day TEXT NOT NULL, account TEXT NOT NULL, code TEXT NOT NULL, created TEXT NOT NULL, PRIMARY KEY(course, day, account));
-- Web Push：VAPID の鍵（id='vapid'。最初に使うとき 1 度だけ作る）と、利用者ごとの購読（端末の endpoint と鍵）
CREATE TABLE IF NOT EXISTS push_keys (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, account TEXT NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS push_subscriptions_account ON push_subscriptions(account);
