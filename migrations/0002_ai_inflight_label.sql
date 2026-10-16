-- 作っている最中の依頼に、処理の種類・作り方・月を持たせる（月の無料分の回数と高度な生成の回数も、予約の 1 文で原子的に数えるため。server/worker.js の reserveAi）
ALTER TABLE ai_inflight ADD COLUMN label TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_inflight ADD COLUMN mode TEXT NOT NULL DEFAULT '';
ALTER TABLE ai_inflight ADD COLUMN month TEXT NOT NULL DEFAULT '';
