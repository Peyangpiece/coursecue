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
// Mac：落とした .dmg で「アプリケーション」の saboro を自動で入れ替える。
// saboro を終了したあとに動く小さなシェルスクリプトが、終了を待つ → .dmg を見えない形でつなぐ → 新しい saboro を隣に書き出して版を確かめる
// → いまの saboro と入れ替える → .dmg を外す → 新しい saboro を開く。どこかで失敗したら元の saboro のまま開き直す（元に戻せないときは何もしない）
// 開き直した saboro は update-expected.json で入れ替わったかを確かめ、入れ替わっていなければ手動の手順を案内する
// コマンドは環境変数で差し替えられる（テスト用）
export const appBundle=exe=>{const i=String(exe).lastIndexOf('.app/');return i<0?null:String(exe).slice(0,i+4)};
// 自動で入れ替えられる場所か：.dmg の中（/Volumes）や、移動せずに開いたとき（App Translocation）の読み取り専用の場所は不可。置き場所と本体に書き込めること
export function canReplace(bundle,writable){return !!bundle&&bundle.endsWith('.app')&&!bundle.startsWith('/Volumes/')&&!bundle.includes('/AppTranslocation/')&&writable(bundle.slice(0,bundle.lastIndexOf('/'))||'/')&&writable(bundle)}
// 引数：$1 終わるのを待つ saboro のプロセス番号、$2 .dmg、$3 入れ替える saboro.app、$4 新しい版、$5 更新の記録のファイル
export const replaceScript=`pid=$1 dmg=$2 app=$3 want=$4 log=$5
HDIUTIL=\${HDIUTIL:-/usr/bin/hdiutil} PLIST=\${PLIST:-/usr/libexec/PlistBuddy} DITTO=\${DITTO:-/usr/bin/ditto} OPEN=\${OPEN:-/usr/bin/open} XATTR=\${XATTR:-/usr/bin/xattr} WAIT=\${WAIT:-120}
say(){ printf '%s\\t%s\\t%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >> "$log"; }
n=0; while kill -0 "$pid" 2>/dev/null; do n=$((n+1)); if [ "$n" -gt "$WAIT" ]; then say ERROR "saboro が終了しないため、新しい版に入れ替えられません"; exit 1; fi; sleep 0.5; done
mnt=$(mktemp -d "\${TMPDIR:-/tmp}/saboro-update.XXXXXX") || { say ERROR "作業用のフォルダを作れません"; "$OPEN" "$app"; exit 1; }
attached=
fail(){ say ERROR "$1"; if [ -n "$attached" ]; then "$HDIUTIL" detach "$mnt" -quiet; fi; rmdir "$mnt" 2>/dev/null; rm -rf "$app.new"; "$OPEN" "$app"; exit 1; }
"$HDIUTIL" attach -nobrowse -readonly -noautoopen -mountpoint "$mnt" "$dmg" >/dev/null 2>&1 || fail ".dmg を開けません"
attached=1
src=; for a in "$mnt"/*.app; do if [ -d "$a" ]; then src=$a; break; fi; done
[ -n "$src" ] || fail ".dmg の中に saboro が見つかりません"
rm -rf "$app.new"
"$DITTO" "$src" "$app.new" || fail "新しい版を書き出せません"
got=$("$PLIST" -c "Print :CFBundleShortVersionString" "$app.new/Contents/Info.plist" 2>/dev/null)
[ "$got" = "$want" ] || fail "書き出した版が $want ではありません（$got）"
rm -rf "$app.old"
mv "$app" "$app.old" || fail "いまの saboro を入れ替えられません"
if ! mv "$app.new" "$app"; then mv "$app.old" "$app"; fail "新しい版に入れ替えられません"; fi
rm -rf "$app.old"
"$XATTR" -dr com.apple.quarantine "$app" 2>/dev/null
"$HDIUTIL" detach "$mnt" -quiet; rmdir "$mnt" 2>/dev/null
say INFO "$want に入れ替えました"
"$OPEN" "$app"
`;
