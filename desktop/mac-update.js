import {join} from 'node:path';
// Mac：新しい版の .dmg をアプリ自身がダウンロードする（「ダウンロード」を押したらすぐ始まり、ブラウザーや GitHub のページを経由しない）
// 名前は配布物と同じ saboro-<版>-mac-<CPU>.dmg にする（入れ替えたあと、installer-cleanup.js がゴミ箱に入れられるように）
// 途中のものは .download を付けて保存し、終わってから名前を変える（途中のファイルを .dmg として開いたり片付けたりしない）
export const macInstallerName=(version,arch)=>`saboro-${version}-mac-${arch==='arm64'?'arm64':'x64'}.dmg`;
export const macInstallerUrl=(version,arch)=>`https://github.com/Peyangpiece/SaBoRo/releases/download/v${version}/${macInstallerName(version,arch)}`;
// fetch：ダウンロードに使う関数（Electron の net.fetch）。fs：exists・write（Response の本体を書き出す）・rename・remove。onProgress：0〜1（大きさが分からないときは null）
export async function downloadInstaller({version,arch,downloads,fetch,fs,onProgress=()=>{}}){
 const file=join(downloads,macInstallerName(version,arch)),part=file+'.download';
 if(await fs.exists(file))return file;
 const res=await fetch(macInstallerUrl(version,arch));
 if(!res.ok)throw Error(`ダウンロードできませんでした（${res.status}）`);
 const total=Number(res.headers.get('content-length'))||0;let got=0;onProgress(total?0:null);
 try{await fs.write(part,res.body,n=>{got+=n;onProgress(total?Math.min(got/total,1):null)});
  if(total&&got!==total)throw Error('ダウンロードが途中で切れました');
  await fs.rename(part,file)}
 catch(e){await fs.remove(part).catch(()=>{});throw e}
 return file}
