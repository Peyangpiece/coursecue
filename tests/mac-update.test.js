import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {macInstallerName,macInstallerUrl,downloadInstaller,appBundle,canReplace,replaceScript} from '../desktop/mac-update.js';import {execFileSync} from 'node:child_process';import {mkdtempSync,mkdirSync,writeFileSync,existsSync,readdirSync,chmodSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {usedInstaller} from '../desktop/installer-cleanup.js';
// Mac：「ダウンロード」を押したらアプリ自身が新しい版の .dmg を落とす。名前は配布物と同じにして、入れ替えたあとの片付けの対象にする
const body=chunks=>new ReadableStream({start(c){for(const x of chunks)c.enqueue(new TextEncoder().encode(x));c.close()}});
function fakeFs(existing=[]){const files=new Map(existing.map(f=>[f,'old'])),calls=[];return {files,calls,fs:{exists:async f=>files.has(f),
 write:async(f,stream,onChunk)=>{calls.push('write '+f);let s='';for await(const c of stream){onChunk(c.length);s+=new TextDecoder().decode(c)}files.set(f,s)},
 rename:async(a,b)=>{calls.push(`rename ${a} → ${b}`);files.set(b,files.get(a));files.delete(a)},remove:async f=>{calls.push('remove '+f);files.delete(f)}}}}
const res=(chunks,{status=200,length}={})=>({ok:status<300,status,headers:new Headers(length===undefined?{'content-length':String(chunks.join('').length)}:length?{'content-length':String(length)}:{}),body:body(chunks)});
test('名前と URL は配布物と同じ（Apple シリコンは arm64、それ以外は x64）。落としたものは入れ替えたあと片付けの対象になる',()=>{
 assert.equal(macInstallerName('1.0.30','arm64'),'saboro-1.0.30-mac-arm64.dmg');assert.equal(macInstallerName('1.0.30','x64'),'saboro-1.0.30-mac-x64.dmg');
 assert.equal(macInstallerUrl('1.0.30','arm64'),'https://github.com/Peyangpiece/SaBoRo/releases/download/v1.0.30/saboro-1.0.30-mac-arm64.dmg');
 assert.equal(usedInstaller(macInstallerName('1.0.30','arm64'),'1.0.30'),true);assert.equal(usedInstaller(macInstallerName('1.0.30','arm64')+'.download','1.0.30'),false,'途中のものは片付けない')});
test('「ダウンロード」フォルダに .download の名前で落とし、終わってから .dmg にする。進み具合を 0〜1 で知らせる',async()=>{const {files,calls,fs}=fakeFs(),progress=[],urls=[];
 const file=await downloadInstaller({version:'1.0.30',arch:'arm64',downloads:'/Users/me/Downloads',fs,fetch:async u=>{urls.push(u);return res(['abc','def'])},onProgress:p=>progress.push(p)});
 assert.equal(file,'/Users/me/Downloads/saboro-1.0.30-mac-arm64.dmg');assert.deepEqual(urls,[macInstallerUrl('1.0.30','arm64')]);assert.equal(files.get(file),'abcdef');
 assert.deepEqual(calls,['write /Users/me/Downloads/saboro-1.0.30-mac-arm64.dmg.download','rename /Users/me/Downloads/saboro-1.0.30-mac-arm64.dmg.download → /Users/me/Downloads/saboro-1.0.30-mac-arm64.dmg']);assert.deepEqual(progress,[0,0.5,1])});
test('すでに落としてあればそのまま使う。大きさが分からなければ進み具合は null',async()=>{let {fs}=fakeFs(['/d/saboro-1.0.30-mac-x64.dmg']);let fetched=0;
 assert.equal(await downloadInstaller({version:'1.0.30',arch:'x64',downloads:'/d',fs,fetch:async()=>{fetched++}}),'/d/saboro-1.0.30-mac-x64.dmg');assert.equal(fetched,0);
 ({fs}=fakeFs());const progress=[];await downloadInstaller({version:'1.0.30',arch:'x64',downloads:'/d',fs,fetch:async()=>res(['ab'],{length:0}),onProgress:p=>progress.push(p)});assert.deepEqual(progress,[null,null])});
test('失敗（見つからない・途中で切れた）は理由を投げ、途中のファイルは消す（.dmg は作らない）',async()=>{let {files,fs}=fakeFs();
 await assert.rejects(downloadInstaller({version:'9.9.9',arch:'arm64',downloads:'/d',fs,fetch:async()=>res([],{status:404})}),/ダウンロードできませんでした（404）/);assert.equal(files.size,0);
 ({files,fs}=fakeFs());await assert.rejects(downloadInstaller({version:'1.0.30',arch:'arm64',downloads:'/d',fs,fetch:async()=>res(['abc'],{length:10})}),/途中で切れました/);assert.equal(files.size,0)});
test('アプリ：新しい版の案内とメニューバーの「更新」は、その場でダウンロードし、書き込める場所なら終了して自動で入れ替える（できなければ .dmg を開いて案内）',()=>{const main=readFileSync('desktop/main.js','utf8');
 assert.match(main,/buttons:\['今すぐ更新','あとで'\][^\n]*if\(r\.response===0\)downloadMacUpdate\(version\)/);assert.match(main,/label:`新しい版 \$\{newer\} に更新`,click:\(\)=>downloadMacUpdate\(newer\)/);
 assert.match(main,/ダウンロード中…/,'ダウンロード中はメニューバーに進み具合を出す');assert.match(main,/if\(canReplace\(bundle,writable\)\)\{expectUpdate\(version\);[^\n]*spawn\('\/bin\/sh',\['-c',replaceScript,'sh',String\(process\.pid\),file,bundle,version,updateLogFile\],\{detached:true,stdio:'ignore'\}\)\.unref\(\);app\.quit\(\)/);
 assert.match(main,/shell\.openPath\(file\)/,'自動で入れ替えられなければ .dmg を開く');assert.match(main,/macDownloadPage/,'落とせなければダウンロードのページを案内する');assert.match(main,/自動で入れ替えられませんでした/,'入れ替わらなかったら次の起動で手動の手順を案内する')});
test('自動で入れ替えられる場所：「アプリケーション」など書き込める場所だけ（.dmg の中・移動せずに開いた場所・書き込めない場所は不可）',()=>{const all=()=>true;
 assert.equal(appBundle('/Applications/saboro.app/Contents/MacOS/saboro'),'/Applications/saboro.app');assert.equal(appBundle('/usr/bin/node'),null);
 assert.equal(canReplace('/Applications/saboro.app',all),true);assert.equal(canReplace('/Users/me/Applications/saboro.app',all),true);
 assert.equal(canReplace('/Volumes/saboro 1.0.30/saboro.app',all),false);assert.equal(canReplace('/private/var/folders/x/T/AppTranslocation/ABC/d/saboro.app',all),false);assert.equal(canReplace(null,all),false);
 assert.equal(canReplace('/Applications/saboro.app',d=>d!=='/Applications'),false,'置き場所に書き込めない（管理者でない利用者など）');assert.equal(canReplace('/Applications/saboro.app',d=>d!=='/Applications/saboro.app'),false)});
// 入れ替えのスクリプトを、hdiutil・PlistBuddy・ditto・open を差し替えて実際に動かす（.dmg の中身はフォルダで代用）
function sandbox({dmgVersion='1.0.30'}={}){const d=mkdtempSync(join(tmpdir(),'saboro-replace-')),bin=join(d,'bin'),calls=join(d,'calls.txt'),log=join(d,'update.log'),image=join(d,'image'),app=join(d,'Applications','saboro.app');
 for(const dir of [bin,join(image,'saboro.app','Contents'),join(app,'Contents')])mkdirSync(dir,{recursive:true});
 writeFileSync(join(image,'saboro.app','Contents','Info.plist'),dmgVersion);writeFileSync(join(app,'Contents','Info.plist'),'1.0.29');writeFileSync(join(d,'saboro-1.0.30-mac-arm64.dmg'),'');
 const stub=(name,body)=>{const f=join(bin,name);writeFileSync(f,'#!/bin/sh\n'+body+'\n');chmodSync(f,0o755);return f};
 const env={...process.env,TMPDIR:d,WAIT:'20',
  HDIUTIL:stub('hdiutil',`echo "hdiutil $1" >> "${calls}"; if [ "$1" = attach ]; then cp -R "${image}/." "$6"; else rm -rf "$2"/*; fi`),
  PLIST:stub('plist','cat "$3"'),DITTO:stub('ditto','cp -R "$1" "$2"'),OPEN:stub('open',`echo "open $1" >> "${calls}"`),XATTR:stub('xattr','true')};
 const run=pid=>execFileSync('/bin/sh',['-c',replaceScript,'sh',String(pid),join(d,'saboro-1.0.30-mac-arm64.dmg'),app,'1.0.30',log],{env,encoding:'utf8'});
 const read=f=>existsSync(f)?readFileSync(f,'utf8'):'';return {d,app,run,calls:()=>read(calls).trim().split('\n'),log:()=>read(log),version:()=>read(join(app,'Contents','Info.plist'))}}
test('入れ替えのスクリプト：saboro の終了を待ってから、新しい版に入れ替えて開き直す（作業用のものは残さない）',()=>{const s=sandbox();const pid=execFileSync('/bin/sh',['-c','sleep 1 >/dev/null 2>&1 & echo $!'],{encoding:'utf8'}).trim();const t=Date.now();
 s.run(pid);assert.ok(Date.now()-t>=500,'終了を待つ');assert.equal(s.version(),'1.0.30');assert.deepEqual(s.calls(),['hdiutil attach','hdiutil detach',`open ${s.app}`]);assert.match(s.log(),/INFO\t1\.0\.30 に入れ替えました/);
 assert.deepEqual(readdirSync(join(s.d,'Applications')),['saboro.app'],'.new・.old は残さない');assert.equal(readdirSync(s.d).some(f=>f.startsWith('saboro-update.')),false,'つないだ場所も片付ける')});
test('入れ替えのスクリプト：.dmg の中身が別の版なら入れ替えず、元の saboro を開き直して理由を記録する',()=>{const s=sandbox({dmgVersion:'1.0.28'});
 assert.throws(()=>s.run(999999));assert.equal(s.version(),'1.0.29');assert.deepEqual(readdirSync(join(s.d,'Applications')),['saboro.app']);assert.deepEqual(s.calls(),['hdiutil attach','hdiutil detach',`open ${s.app}`]);assert.match(s.log(),/ERROR\t書き出した版が 1\.0\.30 ではありません（1\.0\.28）/)});
test('Mac の新しい版の案内：版ごとに 1 回出す（前の版の案内から 24 時間待たない）。saboro を前面に出してから出す（ほかのアプリの裏に隠れないように）',()=>{const main=readFileSync('desktop/main.js','utf8'),fn=main.slice(main.indexOf('async function announce('));
 assert.match(fn,/if\(!manual&&seen\.version===version\)return;/);assert.doesNotMatch(fn.slice(0,fn.indexOf('\n')),/24\*3600/,'別の版の案内のあと 24 時間は出さない、という制限はしない');assert.match(fn,/app\.focus\(\{steal:true\}\);const r=await dialog\.showMessageBox/)});
