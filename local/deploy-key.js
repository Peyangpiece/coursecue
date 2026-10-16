#!/usr/bin/env node
import {generateKeyPairSync,createPrivateKey,createPublicKey,sign} from 'node:crypto';import {readFileSync,appendFileSync,existsSync} from 'node:fs';import {dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';
// 公開版の署名鍵（Ed25519）。Mac サービスの自動更新は、この鍵で署名された公開版にだけ進む（local/auto-update.js）。
//   npm run deploy-key                 … 鍵の組を新しく作る。公開鍵を local/deploy-key.pub に足す（コミットする）。秘密鍵は画面に出すので GitHub の Secrets の DEPLOY_SIGNING_KEY に入れる（ファイルには残さない）
//   node local/deploy-key.js sign <sha> … 公開（deploy.yml）で使う。環境変数 DEPLOY_SIGNING_KEY の秘密鍵でコミット番号に署名して base64 で出す。公開鍵が local/deploy-key.pub になければ止める
const repo=dirname(dirname(fileURLToPath(import.meta.url))),pubFile=join(repo,'local/deploy-key.pub');
export const keysOf=text=>String(text||'').split('\n').map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'));
export function makeDeployKey(){const {publicKey,privateKey}=generateKeyPairSync('ed25519');return {publicKey:publicKey.export({type:'spki',format:'der'}).toString('base64'),privateKey:privateKey.export({type:'pkcs8',format:'pem'})}}
export function signDeployed(sha,privatePem,keys){if(!/^[0-9a-f]{40}$/.test(String(sha||'')))throw Error('コミット番号（40 桁）ではありません');const key=createPrivateKey(String(privatePem||'').trim()+'\n');if(key.asymmetricKeyType!=='ed25519')throw Error('Ed25519 の秘密鍵ではありません');
 const pub=createPublicKey(key).export({type:'spki',format:'der'}).toString('base64');if(!keysOf(keys.join?keys.join('\n'):keys).includes(pub))throw Error('この秘密鍵に対する公開鍵が local/deploy-key.pub にありません（npm run deploy-key で作った公開鍵をコミットしてください）');
 return sign(null,Buffer.from(sha),key).toString('base64')}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){const cmd=process.argv[2];
 if(cmd==='sign'){try{const pem=process.env.DEPLOY_SIGNING_KEY;if(!pem)throw Error('GitHub の Secrets に DEPLOY_SIGNING_KEY（npm run deploy-key で作る秘密鍵）がありません。無いと Mac サービスは公開版に更新しません');
   process.stdout.write(signDeployed(process.argv[3],pem,existsSync(pubFile)?keysOf(readFileSync(pubFile,'utf8')):[])+'\n')}catch(e){console.error('::error::公開版に署名できません：'+e.message);process.exit(1)}}
 else if(cmd==='new'||!cmd){const {publicKey,privateKey}=makeDeployKey();appendFileSync(pubFile,(existsSync(pubFile)&&!readFileSync(pubFile,'utf8').endsWith('\n')?'\n':'')+publicKey+'\n');
  console.log(`公開鍵を ${pubFile} に足しました（コミットしてください）。\n次の秘密鍵を GitHub の Secrets の DEPLOY_SIGNING_KEY に入れてください（ファイルには残していません。ここにしか出ません）：\n\n${privateKey}`)}
 else{console.error('使い方：node local/deploy-key.js [new|sign <sha>]');process.exit(2)}}
