-- SaBoRo の AI の使用量に「作成できたか」を足す（1：できた、0：出力が上限で途切れた・拒否された・出力なし）
-- 作成できなかった回は、月額に含む回数に数えず、超過分としても請求しない（処理の費用は運営者が持ち、無料分の実費の上限には数える）
ALTER TABLE ai_usage ADD COLUMN ok INTEGER NOT NULL DEFAULT 1;
