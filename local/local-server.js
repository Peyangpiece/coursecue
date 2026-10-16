// このパソコンの中だけのサービス（127.0.0.1:8766）に届いた要求を受け付けるか。
// Host が違う（DNS rebinding）要求と、別のオリジンからの POST は断る。GET でも、別のサイトのページから呼ばれたもの（<img>・fetch・リンク。ブラウザが Sec-Fetch-Site: cross-site を付ける）は断る。
// 例外は、saboro の画面（クラウド）から使うもの：/open（「資料」を開く）・/owned（接続用リンクの確認）・/ping（サービスの有無の確認）
// 戻り値：受け付けるなら null、断るなら HTTP の状態（403）
const HOSTS=['127.0.0.1:8766','localhost:8766'],ORIGINS=['http://127.0.0.1:8766','http://localhost:8766'],CROSS_SITE_OK=['/open','/owned','/ping'];
export function requestAllowed({method,url,headers={}}){if(!HOSTS.includes(headers.host))return 403;if(method==='POST'&&!ORIGINS.includes(headers.origin))return 403;const path=String(url||'').split('?')[0];if(headers['sec-fetch-site']==='cross-site'&&!CROSS_SITE_OK.includes(path))return 403;return null}
