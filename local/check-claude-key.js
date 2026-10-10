import {execFileSync} from 'node:child_process';import {dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';import Anthropic from '@anthropic-ai/sdk';
// キーチェーンに保存済みの Claude API キーが使えるかを確認する（キー自体は表示しない）
const binary=join(dirname(fileURLToPath(import.meta.url)),'keychain');
let key;try{key=execFileSync(binary,[],{input:JSON.stringify({op:'get',name:'anthropic-api-key'}),stdio:['pipe','pipe','ignore']}).toString().trim()}catch{}
if(!key){console.log('キーは保存されていません。npm run setup:claude-api で保存してください。');process.exit(1)}
try{await new Anthropic({apiKey:key,maxRetries:1}).models.list({limit:1});console.log(`OK：保存済みのキー（${key.slice(0,10)}…、${key.length}文字）は使えます。`)}catch(e){console.log(e instanceof Anthropic.AuthenticationError||e instanceof Anthropic.PermissionDeniedError?`NG：保存済みのキー（${key.slice(0,10)}…）は認証エラーで使えません。npm run setup:claude-api で入れ直してください。`:`確認できませんでした（${e.status||''} ${e.message}）`);process.exit(1)}
