import {spawn,execFileSync} from 'node:child_process';import {dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';import {access,constants} from 'node:fs/promises';import {ensureAccount} from './account.js';
// 一度だけ実行するセットアップ：キーチェーン補助の作成 → 利用者の登録 → ブラウザの用意 → Mac サービスの登録 → 設定画面を開く
const repo=dirname(dirname(fileURLToPath(import.meta.url))),apiBase=process.env.COURSECUE_API||'https://coursecue.hrk-6888.workers.dev';
const step=s=>console.log('▶ '+s);
const run=(cmd,args,opts={})=>new Promise((resolve,reject)=>{const p=spawn(cmd,args,{cwd:repo,stdio:'inherit',...opts});p.on('error',reject);p.on('exit',c=>c===0?resolve():reject(Error(`${cmd} ${args.join(' ')} が失敗しました（${c}）`)))});
step('キーチェーン補助を用意');const binary=join(repo,'local/keychain');try{await access(binary,constants.X_OK)}catch{execFileSync('/usr/bin/swiftc',[join(repo,'local/keychain.swift'),'-o',binary],{stdio:'inherit'})}
const vault=(op,name,value)=>{try{return execFileSync(binary,[],{input:JSON.stringify({op,name,value}),stdio:['pipe','pipe','pipe']}).toString()}catch{return null}};
step('利用者を登録');const account=await ensureAccount({vault,apiBase});console.log(account.status==='registered'?'  新しい接続キーと Mac の鍵を作り、クラウドに登録しました':'  登録済みの鍵を使います');
step('manabo 用のブラウザを用意');await run(join(repo,'node_modules/.bin/playwright'),['install','chromium']);
if(process.argv.includes('--no-agent')){console.log('Mac サービスの登録は省きました（npm start で起動できます）');process.exit(0)}
step('Mac サービスを登録');await run(process.execPath,[join(repo,'local/install-agent.js')]);
step('設定画面を開く');await new Promise(r=>setTimeout(r,2500));spawn('open',['http://127.0.0.1:8766/setup'],{stdio:'ignore',detached:true}).unref();
console.log('\n完了。開いた画面で manabo の ID・パスワードを保存し、AI を連携し、「saboroを接続」を押してください。');
