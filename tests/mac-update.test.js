import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {macInstallerName,macInstallerUrl,downloadInstaller} from '../desktop/mac-update.js';import {usedInstaller} from '../desktop/installer-cleanup.js';
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
test('アプリ：新しい版の案内とメニューバーの「新しい版をダウンロード」は、ページを開かずにその場でダウンロードする',()=>{const main=readFileSync('desktop/main.js','utf8');
 assert.match(main,/buttons:\['今すぐダウンロード','あとで'\][^\n]*if\(r\.response===0\)downloadMacUpdate\(version\)/);assert.match(main,/label:`新しい版 \$\{newer\} をダウンロード`,click:\(\)=>downloadMacUpdate\(newer\)/);
 assert.match(main,/ダウンロード中…/,'ダウンロード中はメニューバーに進み具合を出す');assert.match(main,/shell\.openPath\(file\)/,'落としたら .dmg を開く');assert.match(main,/macDownloadPage/,'落とせなければダウンロードのページを案内する')});
