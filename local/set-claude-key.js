import {execFileSync} from 'node:child_process';import {dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';import Anthropic from '@anthropic-ai/sdk';
// Claude API キーをMacのキーチェーンに保存する（課題生成の3番目の手段で使用）
// 対話入力では文字を * で表示する。`pbpaste | npm run setup:claude-api` のようにクリップボードから渡すこともできる
const binary=join(dirname(fileURLToPath(import.meta.url)),'keychain');
async function readPiped(){let s='';for await(const c of process.stdin)s+=c;return s}
function readMasked(label){return new Promise(resolve=>{process.stdout.write(label);let key='';process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{for(const ch of chunk.replace(/\x1b\[20[01]~/g,'')){if(ch==='\r'||ch==='\n'){process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');resolve(key);return}if(ch==='\x03'){process.stdout.write('\n');process.exit(130)}if(ch==='\x7f'||ch==='\b'){if(key){key=key.slice(0,-1);process.stdout.write('\b \b')}continue}if(ch>=' '){key+=ch;process.stdout.write('*')}}})})}
const key=(process.stdin.isTTY?await readMasked('Claude APIキー（sk-ant-…）を貼り付けて Enter: '):await readPiped()).trim();
if(!key){console.log('入力がないため中止しました。');process.exit(0)}
if(!/^sk-ant-\S+$/.test(key)){console.error('APIキーの形式ではありません（sk-ant- で始まる1行の文字列）。保存しませんでした。');process.exit(1)}
// 保存前に Anthropic へ問い合わせて、使えるキーか確かめる
try{await new Anthropic({apiKey:key,maxRetries:1}).models.list({limit:1})}catch(e){if(e instanceof Anthropic.AuthenticationError||e instanceof Anthropic.PermissionDeniedError){console.error('このキーは Claude API で使えません（認証エラー）。console.anthropic.com の「API Keys」で作成したキーを使ってください。保存しませんでした。');process.exit(1)}if(e instanceof Anthropic.APIConnectionError){console.error('Anthropic に接続できず、キーを確認できませんでした。ネットワークを確認してやり直してください。保存しませんでした。');process.exit(1)}console.error(`キーを確認できませんでした（${e.status||''} ${e.message}）。保存しませんでした。`);process.exit(1)}
try{execFileSync(binary,[],{input:JSON.stringify({op:'set',name:'anthropic-api-key',value:key}),stdio:['pipe','ignore','pipe']})}catch{console.error('キーチェーンに保存できませんでした。先に npm run setup を実行してください。');process.exit(1)}
console.log(`保存しました（${key.slice(0,10)}…、${key.length}文字）。Macサービスを再起動すると使われます。`);
