# D1 の移行（migrations）

`server/schema.sql` は新しい表・索引を `IF NOT EXISTS` で作るだけで、既にある表は変わりません。既にある表に列を足す・型を変えるなどの変更は、ここに番号つきの SQL（`0001_add_xxx.sql` のように、4 桁の番号と内容）で置きます。

- `main` に入ると、公開の前に `npx wrangler d1 migrations apply coursecue-private --remote` が実行されます。適用済みの移行は D1 が覚えているので、1 回だけ実行されます。
- 新しい表は `server/schema.sql` に足します。既にある表への列の追加は、**移行にだけ**書きます（`schema.sql` の `CREATE TABLE` には足さない）。両方に書くと、新しく作った D1 で `schema.sql` の後に移行を当てたとき「同じ列がある」で失敗します。
- 公開では `schema.sql` → 移行の順に当てます。新しく作った D1 でも同じ順に当てれば今の形になります。
- 公開の前に D1 の時点（Time Travel の bookmark）を記録しています。戻すときは Actions のログの bookmark を使い、`npx wrangler d1 time-travel restore coursecue-private --bookmark=<bookmark>` を実行します。
