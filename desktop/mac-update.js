import {join} from 'node:path';
// Mac：新しい版の .dmg をアプリ自身がダウンロードする（「ダウンロード」を押したらすぐ始まり、ブラウザーや GitHub のページを経由しない）
// 名前は配布物と同じ saboro-<版>-mac-<CPU>.dmg にする（入れ替えたあと、installer-cleanup.js がゴミ箱に入れられるように）
// 途中のものは .download を付けて保存し、終わってから名前を変える（途中のファイルを .dmg として開いたり片付けたりしない）
export const macInstallerName=(version,arch)=>`saboro-${version}-mac-${arch==='arm64'?'arm64':'x64'}.dmg`;
export const macInstallerUrl=(version,arch)=>`https://github.com/Peyangpiece/SaBoRo/releases/download/v${version}/${macInstallerName(version,arch)}`;
// 落とした .dmg が配布物そのものかは、Release の latest-mac.yml（electron-updater が GitHub から HTTPS で読む版の情報）にある sha512（base64）で確かめる。
// files の url は名前だけのことも URL のこともある。値がなければ null（確かめられない .dmg は使わない）
export function installerDigest(files,name){const f=(Array.isArray(files)?files:[]).find(f=>String(f?.url||'').split('/').pop()===name);const d=String(f?.sha512||'').trim();return /^[A-Za-z0-9+/]{86}==$/.test(d)?d:null}
// fetch：ダウンロードに使う関数（Electron の net.fetch）。fs：exists・write（Response の本体を書き出す）・rename・remove・hash（ファイルの sha512 を base64 で）。onProgress：0〜1（大きさが分からないときは null）
// sha512：配布物の sha512（installerDigest）。「ダウンロード」フォルダに同じ名前のものがあっても、sha512 が合うときだけ使い、合わなければ消して落とし直す（ほかのアプリも書ける場所のため）
export async function downloadInstaller({version,arch,downloads,sha512,fetch,fs,onProgress=()=>{}}){
 if(!sha512)throw Error('新しい版を確かめるための値（sha512）が配布物の情報にありません');
 const file=join(downloads,macInstallerName(version,arch)),part=file+'.download';
 if(await fs.exists(file)){if((await fs.hash(file))===sha512)return file;await fs.remove(file)}
 const res=await fetch(macInstallerUrl(version,arch));
 if(!res.ok)throw Error(`ダウンロードできませんでした（${res.status}）`);
 const total=Number(res.headers.get('content-length'))||0;let got=0;onProgress(total?0:null);
 try{await fs.write(part,res.body,n=>{got+=n;onProgress(total?Math.min(got/total,1):null)});
  if(total&&got!==total)throw Error('ダウンロードが途中で切れました');
  if((await fs.hash(part))!==sha512)throw Error('ダウンロードした .dmg が配布物と一致しません（検証に失敗）');
  await fs.rename(part,file)}
 catch(e){await fs.remove(part).catch(()=>{});throw e}
 return file}
// Mac：落とした .dmg で「アプリケーション」の saboro を自動で入れ替える。
// saboro を終了したあとに動く小さなシェルスクリプトが、終了を待つ → .dmg を自分の作業用フォルダに写して sha512 を確かめる → 見えない形でつなぐ
// → 同じ CFBundleIdentifier の saboro を隣に書き出して版と署名を確かめる → いまの saboro と入れ替える → .dmg を外す → 新しい saboro を開く。
// どこかで失敗したら元の saboro のまま開き直す（元に戻せないときは何もしない）
// 「ダウンロード」フォルダの .dmg はほかのアプリも書き換えられるので、確かめたあとに差し替えられないよう、写したものを確かめてそのまま使う
// 署名：新しい版の署名が壊れていないこと（ad-hoc でも検査できる）。いまの saboro が証明書で署名されていれば、新しい版も同じ証明書（Authority）であること
// 開き直した saboro は update-expected.json で入れ替わったかを確かめ、入れ替わっていなければ手動の手順を案内する
// コマンドは環境変数で差し替えられる（テスト用）
export const appBundle=exe=>{const i=String(exe).lastIndexOf('.app/');return i<0?null:String(exe).slice(0,i+4)};
// 自動で入れ替えられる場所か：.dmg の中（/Volumes）や、移動せずに開いたとき（App Translocation）の読み取り専用の場所は不可。置き場所と本体に書き込めること
export function canReplace(bundle,writable){return !!bundle&&bundle.endsWith('.app')&&!bundle.startsWith('/Volumes/')&&!bundle.includes('/AppTranslocation/')&&writable(bundle.slice(0,bundle.lastIndexOf('/'))||'/')&&writable(bundle)}
// 引数：$1 終わるのを待つ saboro のプロセス番号、$2 .dmg、$3 入れ替える saboro.app、$4 新しい版、$5 更新の記録のファイル、$6 .dmg の sha512（base64）
export const replaceScript=`pid=$1 dmg=$2 app=$3 want=$4 log=$5 sum=$6
HDIUTIL=\${HDIUTIL:-/usr/bin/hdiutil} PLIST=\${PLIST:-/usr/libexec/PlistBuddy} DITTO=\${DITTO:-/usr/bin/ditto} OPEN=\${OPEN:-/usr/bin/open} XATTR=\${XATTR:-/usr/bin/xattr} CODESIGN=\${CODESIGN:-/usr/bin/codesign} OPENSSL=\${OPENSSL:-/usr/bin/openssl} WAIT=\${WAIT:-120}
say(){ printf '%s\\t%s\\t%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" >> "$log"; }
n=0; while kill -0 "$pid" 2>/dev/null; do n=$((n+1)); if [ "$n" -gt "$WAIT" ]; then say ERROR "saboro が終了しないため、新しい版に入れ替えられません"; exit 1; fi; sleep 0.5; done
work=$(mktemp -d "\${TMPDIR:-/tmp}/saboro-update.XXXXXX") || { say ERROR "作業用のフォルダを作れません"; "$OPEN" "$app"; exit 1; }
mnt=$work/mnt copy=$work/installer.dmg
attached=
fail(){ say ERROR "$1"; if [ -n "$attached" ]; then "$HDIUTIL" detach "$mnt" -quiet; fi; rm -rf "$work" "$app.new"; "$OPEN" "$app"; exit 1; }
[ -n "$sum" ] || fail ".dmg を確かめるための値がありません"
cp "$dmg" "$copy" || fail ".dmg を写せません"
got=$("$OPENSSL" dgst -sha512 -binary "$copy" | "$OPENSSL" base64 -A)
[ "$got" = "$sum" ] || fail ".dmg が配布物と一致しません（検証に失敗。落とし直してください）"
mkdir "$mnt" || fail "作業用のフォルダを作れません"
"$HDIUTIL" attach -nobrowse -readonly -noautoopen -mountpoint "$mnt" "$copy" >/dev/null 2>&1 || fail ".dmg を開けません"
attached=1
id=$("$PLIST" -c "Print :CFBundleIdentifier" "$app/Contents/Info.plist" 2>/dev/null)
[ -n "$id" ] || fail "いまの saboro の CFBundleIdentifier を読めません"
src=; for a in "$mnt"/*.app; do if [ -d "$a" ] && [ "$("$PLIST" -c "Print :CFBundleIdentifier" "$a/Contents/Info.plist" 2>/dev/null)" = "$id" ]; then src=$a; break; fi; done
[ -n "$src" ] || fail ".dmg の中に saboro（$id）が見つかりません"
rm -rf "$app.new"
"$DITTO" "$src" "$app.new" || fail "新しい版を書き出せません"
got=$("$PLIST" -c "Print :CFBundleShortVersionString" "$app.new/Contents/Info.plist" 2>/dev/null)
[ "$got" = "$want" ] || fail "書き出した版が $want ではありません（$got）"
"$CODESIGN" --verify --deep --strict "$app.new" >/dev/null 2>&1 || fail "新しい版の署名が壊れています"
have=$("$CODESIGN" -dvv "$app" 2>&1 | grep '^Authority=')
new=$("$CODESIGN" -dvv "$app.new" 2>&1 | grep '^Authority=')
if [ -n "$have" ] && [ "$have" != "$new" ]; then fail "新しい版の署名（証明書）がいまの saboro と違います"; fi
rm -rf "$app.old"
mv "$app" "$app.old" || fail "いまの saboro を入れ替えられません"
if ! mv "$app.new" "$app"; then mv "$app.old" "$app"; fail "新しい版に入れ替えられません"; fi
rm -rf "$app.old"
"$XATTR" -dr com.apple.quarantine "$app" 2>/dev/null
"$HDIUTIL" detach "$mnt" -quiet; rm -rf "$work"
say INFO "$want に入れ替えました"
"$OPEN" "$app"
`;
