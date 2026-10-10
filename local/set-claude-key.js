import {execFileSync} from 'node:child_process';import {dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';import readline from 'node:readline';
// Claude API キーをMacのキーチェーンに保存する（課題生成の3番目の手段で使用）。入力は画面に表示しない
const binary=join(dirname(fileURLToPath(import.meta.url)),'keychain');
const rl=readline.createInterface({input:process.stdin,output:process.stdout,terminal:true});rl._writeToOutput=s=>{if(s.includes('APIキー'))process.stdout.write(s)};
const key=(await new Promise(r=>rl.question('Claude APIキー（sk-ant-…）: ',r))).trim();rl.close();process.stdout.write('\n');if(!key){console.log('入力がないため中止しました。');process.exit(0)}
try{execFileSync(binary,[],{input:JSON.stringify({op:'set',name:'anthropic-api-key',value:key}),stdio:['pipe','ignore','pipe']})}catch{console.error('キーチェーンに保存できませんでした。先に npm run setup を実行してください。');process.exit(1)}
console.log('保存しました。Macサービスを再起動すると使われます。');
