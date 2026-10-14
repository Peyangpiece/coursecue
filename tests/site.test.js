import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync,readdirSync} from 'node:fs';
// ホームページ（site/）：アプリと切り分けた静的なサイト。載せるのは書く必要のあるものだけ（特定商取引法に基づく表記・個人情報保護法で公表が必要な事項・サービスの説明と料金）
const dir='site/public',page=f=>readFileSync(`${dir}/${f}`,'utf8'),pages=readdirSync(dir).filter(f=>f.endsWith('.html'));
test('特定商取引法に基づく表記に、Stripe の案内で必須の 11 項目がある',()=>{const h=page('tokushoho.html');for(const k of ['販売事業者名','運営責任者','所在地','電話番号','メールアドレス','販売価格','商品代金以外の必要料金','支払方法','支払時期','サービスの提供時期','返品・キャンセル（お客様のご都合による場合）','返品・キャンセル（サービスの不具合による場合）'])assert.match(h,new RegExp(`<th>${k.replace(/[()（）]/g,'.')}</th>`),k);assert.match(h,/月額 2,500円（税込）/)});
test('どのページからも、特定商取引法に基づく表記・プライバシーポリシーへリンクする',()=>{for(const f of pages){const h=page(f);for(const l of ['/tokushoho.html','/privacy.html'])assert.ok(h.includes(`href="${l}"`),`${f} → ${l}`)}});
test('プライバシーポリシーに、個人情報保護法で公表が必要な事項（事業者・利用目的・安全管理措置・開示等の手続・苦情の申出先）がある',()=>{const h=page('privacy.html');for(const k of ['事業者','利用目的','安全管理のための措置','開示等の請求・苦情のお申し出'])assert.match(h,new RegExp(`<h2>${k}</h2>`),k);assert.match(h,/chukyo\.saboro@gmail\.com/)});
test('アプリとは完全に切り分ける：アプリの公開先・API・画面の資源を参照せず、スクリプトも動かさない',()=>{for(const f of [...pages,'site.css']){const h=page(f);assert.doesNotMatch(h,/coursecue|\/api\/|app\.js|saboro\.css|<script/i,f)}assert.match(page('_headers'),/script-src 'none'/);
 const cfg=readFileSync('site/wrangler.jsonc','utf8');assert.match(cfg,/"name": "saboro-site"/);assert.doesNotMatch(cfg,/"main"|d1_databases/,'Worker のコードもデータベースも持たない')});
