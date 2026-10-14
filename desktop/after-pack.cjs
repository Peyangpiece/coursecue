// electron-builder の afterPack：Mac のアプリに署名する（electron-builder 自身の署名は package.json の mac.identity: null で止めている）
// MAC_SIGN_IDENTITY（desktop.yml が用意する自分の証明書）があればそれで、なければ ad-hoc（-）で署名する。
// 毎回同じ証明書で署名すると、アプリの「指定要件」（designated requirement）が版をまたいで変わらないため、
// キーチェーンの「coursecue Safe Storage」に「常に許可」した許可が更新のあとも引き継がれる（ad-hoc は版ごとに変わるので毎回確認が出る）
const {execFileSync,spawnSync}=require('node:child_process');const path=require('node:path');
exports.default=async function afterPack(context){
 if(context.electronPlatformName!=='darwin')return;
 const app=path.join(context.appOutDir,`${context.packager.appInfo.productFilename}.app`),identity=process.env.MAC_SIGN_IDENTITY||'-',keychain=process.env.MAC_SIGN_KEYCHAIN;
 const run=(args,opts={})=>execFileSync('/usr/bin/codesign',args,{stdio:'inherit',...opts});
 run(['--force','--deep','--sign',identity,...(keychain?['--keychain',keychain]:[]),app]);
 run(['--verify','--deep','--strict','--verbose=2',app]);
 const info=spawnSync('/usr/bin/codesign',['-dv','--verbose=2',app],{encoding:'utf8'}).stderr||'';console.log(info.split('\n').filter(l=>/^(Identifier|Authority|Signature|TeamIdentifier)=/.test(l)).join('\n'));
 const req=spawnSync('/usr/bin/codesign',['-d','-r-',app],{encoding:'utf8'});console.log(((req.stdout||'')+(req.stderr||'')).split('\n').filter(l=>l.startsWith('designated')).join('\n'));
 console.log(`saboro: ${path.basename(app)} を ${identity==='-'?'ad-hoc':'自分の証明書'}で署名しました`);
 if(identity!=='-'&&/Signature=adhoc/.test(info))throw Error('証明書で署名したはずが ad-hoc のままです')}
