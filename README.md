# CourseCue

授業別の課題・提出状況・要対応タスクを管理するUI。

## 公開先
- Cloudflare: https://coursecue.hrk-6888.workers.dev
- Firebase Hosting: https://coursecue-2026.web.app
- Firebase project: coursecue-2026

## 開発・公開
`npm install` 後、`npm run preview` でローカル表示。
`npm run deploy:cloudflare` / `npm run deploy:firebase` で各サービスに公開。
公式CLIのログイン済みアカウントを使用。認証トークンはリポジトリに保存しない。

## 現在の範囲
課題・授業一覧、検索、状態フィルター、要対応リスト、下書き編集・ダウンロード、設定UI、Firebase SDKの初期化。
表示データはサンプル。編集内容と設定はブラウザ内保存。
Firebase Auth・データベース同期、manaboの自動ログイン・回答・提出、Macキーチェーン連携は未実装。
パスワードは保存・送信しない。実際の授業資料や本人の経験は公開データに含めない。
