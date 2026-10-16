import {execFileSync} from 'node:child_process';import {dirname,join} from 'node:path';import {readFileSync} from 'node:fs';import {createPublicKey,verify} from 'node:crypto';
// 公開版の署名：公開（.github/workflows/deploy.yml）のとき、GitHub の Secrets の秘密鍵（DEPLOY_SIGNING_KEY。Ed25519）で公開したコミット番号に署名し、Worker が DEPLOYED_SIG として知らせる。
// Mac サービスは local/deploy-key.pub の公開鍵（1 行に 1 つ。鍵を替えるときは新しい行を足し、古い鍵で署名した公開を一度はさむ）で確かめ、署名が合うコミットにだけ早送りする。
// リポジトリや deployed ブランチ・Worker に書き込めても、秘密鍵がなければ Mac は更新しない（local/deploy-key.js）
export function readDeployKeys(repo){try{return readFileSync(join(repo,'local/deploy-key.pub'),'utf8').split('\n').map(l=>l.trim()).filter(l=>l&&!l.startsWith('#'))}catch{return []}}
export function verifyDeployed({sha,signature,keys}){if(!/^[0-9a-f]{40}$/.test(String(sha||''))||!signature||!Array.isArray(keys)||!keys.length)return false;const sig=Buffer.from(String(signature),'base64');if(sig.length!==64)return false;
 return keys.some(k=>{try{return verify(null,Buffer.from(sha),createPublicKey({key:Buffer.from(k,'base64'),format:'der',type:'spki'}),sig)}catch{return false}})}
// テストと公開に成功したコミット（GitHub の deployed ブランチ）まで早送りで更新する。target（クラウドが知らせた公開版のコミット番号）と signature（その署名）が公開鍵で確かめられ、
// deployed ブランチがそのコミットを指しているときだけ進む。git・npm は時間切れを設ける（止まると処理の確認やダイアログの応答まで止まるため）
// 依存関係の入れ替え（npm ci）はパッケージのスクリプトを動かさない（Mac サービスが使う依存関係にスクリプトは要らない。ブラウザは setup で別に入れる）
// 戻り値：'updated'（再起動が必要）/ 'current'（最新）/ 'skipped:理由'
export function updateToDeployed({repo,npm=join(dirname(process.execPath),'npm'),remote='origin',branch='deployed',target,signature,keys=readDeployKeys(repo)}){const git=(...args)=>execFileSync('git',args,{cwd:repo,stdio:['ignore','pipe','pipe'],timeout:2*60*1000}).toString().trim();
 const head=git('rev-parse','HEAD');if(!target)return 'skipped:公開版の知らせがありません';if(target===head)return 'current';
 if(!keys.length)return 'skipped:公開版の署名を確かめる鍵（local/deploy-key.pub）がありません';if(!verifyDeployed({sha:target,signature,keys}))return 'skipped:公開版の署名を確かめられません';
 git('fetch','--quiet',remote,branch);if(git('rev-parse','FETCH_HEAD')!==target)return 'skipped:公開の記録（deployed）待ち';
 if(git('status','--porcelain','--untracked-files=no'))return 'skipped:ローカルに変更があります';try{git('merge-base','--is-ancestor','HEAD',target)}catch{return 'skipped:公開版と履歴が分岐しています'}
 const depsChanged=git('diff','--name-only','HEAD',target).split('\n').includes('package-lock.json');git('merge','--ff-only','--quiet',target);
 if(depsChanged){const install=()=>execFileSync(npm,['ci','--no-audit','--no-fund','--ignore-scripts'],{cwd:repo,stdio:'ignore',timeout:15*60*1000});try{install()}catch{git('reset','--hard','--quiet',head);try{install()}catch{}return 'skipped:依存関係を更新できないため元に戻しました'}}return 'updated'}
// クラウドが知らせる公開版（deployed）と手元の版を比べ、更新を試すか決める。
// 公開直後は deployed ブランチへの記録が数秒遅れるので、違う間は retryMs ごとに試す
export function shouldUpdate({deployed,head,running,lastTry=0,now=Date.now(),retryMs=30000}){if(!deployed||!head||running)return false;if(!/^[0-9a-f]{7,40}$/i.test(deployed))return false;if(deployed.startsWith(head)||head.startsWith(deployed))return false;return now-lastTry>=retryMs}
