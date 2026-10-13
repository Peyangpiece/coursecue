// saboro デスクトップ：Mac と Windows で、ターミナルなしに同期・生成を動かす常駐アプリ。
// 秘密は OS の仕組み（macOS キーチェーン / Windows DPAPI）で暗号化し、設定は画面の 3 手順だけ
import {app,BrowserWindow,Tray,Menu,shell,dialog,safeStorage,nativeImage} from 'electron';import {join,dirname} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {spawn,execFileSync} from 'node:child_process';import {createServer} from 'node:net';import {homedir} from 'node:os';import {randomBytes} from 'node:crypto';
const here=dirname(fileURLToPath(import.meta.url)),repo=dirname(here);
const userData=app.getPath('userData'),docs=app.getPath('documents');
const root=join(docs,'saboro'),work=join(userData,'work'),browsers=join(userData,'pw-browsers');
const apiBase=process.env.COURSECUE_API||'https://coursecue.hrk-6888.workers.dev';
const single=app.requestSingleInstanceLock();if(!single)app.quit();
let win=null,tray=null,status='起動中…',ready=false,newer=null;
// 暗号化した秘密の保存（safeStorage：macOS はキーチェーン、Windows は DPAPI）
const secretsFile=join(userData,'secrets.json');
function loadSecrets(){try{return JSON.parse(readFileSync(secretsFile,'utf8'))}catch{return {}}}
const secrets={get(name){const all=loadSecrets();if(!all[name])return null;try{return safeStorage.decryptString(Buffer.from(all[name],'base64'))}catch{return null}},set(name,value){if(!safeStorage.isEncryptionAvailable())return null;const all=loadSecrets();all[name]=safeStorage.encryptString(String(value)).toString('base64');mkdirSync(userData,{recursive:true});writeFileSync(secretsFile,JSON.stringify(all),{mode:0o600});return ''}};
// 接続キーと Mac/PC の鍵を作ってクラウドに登録する（初回だけ）
async function register(){const next={owner:randomBytes(32).toString('hex'),device:randomBytes(32).toString('hex')};const r=await fetch(apiBase+'/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(next)});if(!r.ok)throw Error(`クラウドへの登録に失敗しました（${r.status}）`);if(secrets.set('owner',next.owner)===null||secrets.set('device',next.device)===null)throw Error('秘密を保存できません');return next}
async function pickFolder(current){const r=await dialog.showOpenDialog(win||undefined,{title:'資料のダウンロード先のフォルダ',defaultPath:current||root,properties:['openDirectory','createDirectory']});return r.canceled?null:r.filePaths[0]}
globalThis.saboroPlatform={name:process.platform,secrets,openPath:f=>shell.openPath(f),trash:async f=>{await shell.trashItem(f);return 'trash'},pickFolder,register,restart:()=>{app.relaunch();app.exit(0)},version:app.getVersion()};
// 画面：まず設定（Mac/PC 内のサービスが出す画面）。「saboroを接続」で saboro 本体へ移る
function page(html){return 'data:text/html;charset=utf-8,'+encodeURIComponent(`<!doctype html><html lang="ja"><meta charset="utf-8"><style>body{font:15px -apple-system,"Segoe UI",sans-serif;color:#233b32;background:#f7f8f5;margin:60px auto;max-width:460px;padding:20px;line-height:1.8}</style>${html}`)}
// 開く画面：サービスの起動前は状況、設定前は「はじめの設定」、設定後は接続キー付きで saboro 本体（/pair が #connect= を付けて移す）
// 接続キーなしで saboro 本体を開くと「個人用」の画面（アプリのダウンロードの案内）になってしまう
function home(){return !ready?page(`<h1>saboro</h1><p>${status}</p>`):secrets.get('manabo')?'http://127.0.0.1:8766/pair':'http://127.0.0.1:8766/setup'}
// 開いている画面は差し替えずに前に出す（起動時の activate で起動中の画面や設定の画面を上書きしない）
function focusWindow(){if(!app.isReady())return;if(Date.now()-lastCheck>10*60*1000)checkUpdate();if(win&&!win.isDestroyed()){if(win.isMinimized())win.restore();win.show();win.focus()}else openWindow(home())}
function openWindow(url){if(win&&!win.isDestroyed()){win.loadURL(url);win.show();win.focus();return}win=new BrowserWindow({width:1100,height:820,title:'saboro',webPreferences:{contextIsolation:true,sandbox:true}});win.webContents.setWindowOpenHandler(openLink);win.loadURL(url);win.on('closed',()=>{win=null})}
// 開いた直後は読み込みが終わる前で getURL() が空になる。空のときも状況の画面とみなして書き換える（書き換えないと「起動中…」のまま止まって見える）
function showStatus(text){status=text;const shown=win&&!win.isDestroyed()?win.webContents.getURL():null;if(shown!==null&&(shown===''||shown.startsWith('data:')))win.loadURL(page(`<h1>saboro</h1><p>${text}</p>`));refreshTray()}
function refreshTray(){if(!tray)return;tray.setContextMenu(Menu.buildFromTemplate([{label:'saboro を開く',click:()=>openWindow(home())},{label:'設定',click:()=>openWindow('http://127.0.0.1:8766/setup')},{label:'資料のフォルダを開く',click:()=>shell.openPath(root)},{type:'separator'},newer?{label:`新しい版 ${newer} をダウンロード`,click:()=>shell.openExternal(releasePage)}:{label:'新しい版を確認',click:()=>checkUpdate(true)},{type:'separator'},{label:status,enabled:false},{type:'separator'},{label:'終了',click:()=>app.exit(0)}]));tray.setToolTip('saboro：'+status)}
// 新しいウィンドウで開くリンク：「はじめの設定」はこの画面で開き、それ以外（ダウンロード・manabo・「ブラウザで開く」など）は既定のブラウザで開く
function openLink({url}){if(url==='http://127.0.0.1:8766/setup')openWindow(url);else if(/^https?:\/\//.test(url))shell.openExternal(url);return {action:'deny'}}
// 以前に入れた Mac サービス（launchd の jp.coursecue.bridge）や手で動かしたサービス（npm start）が同じポート（8766）を使っていると起動できないため、確認してから止める
// 設定ファイルを消しただけでは launchd に読み込まれたまま動き続けるので、読み込み状態とポートを使っているプロセスも見る
const agentLabel='jp.coursecue.bridge',agentFile=join(homedir(),'Library/LaunchAgents',agentLabel+'.plist');
const run=(cmd,args)=>{try{return execFileSync(cmd,args,{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()}catch{return ''}};
const portPids=()=>run('/usr/sbin/lsof',['-nP','-t','-iTCP:8766','-sTCP:LISTEN']).split('\n').filter(Boolean);
const command=pid=>run('/bin/ps',['-o','command=','-p',pid]);
async function stopOldAgent(){if(process.platform!=='darwin')return;const domain=`gui/${process.getuid()}/${agentLabel}`,loaded=existsSync(agentFile)||run('/bin/launchctl',['print',domain])!=='',pids=portPids().filter(pid=>/local\/bridge\.js/.test(command(pid)));if(!loaded&&!pids.length)return;const r=await dialog.showMessageBox({type:'warning',buttons:['止めて続ける','終了'],defaultId:0,cancelId:1,message:'以前に入れた saboro の Mac サービスが動いています',detail:'アプリと同時には動かせないため、Mac サービスを止めてアプリに切り替えます。manabo の ID とパスワードは「はじめの設定」で入れ直してください。'});if(r.response!==0){app.exit(0);return}run('/bin/launchctl',['bootout',domain]);if(existsSync(agentFile))await shell.trashItem(agentFile).catch(()=>{});for(const pid of pids){try{process.kill(Number(pid),'SIGTERM')}catch{}}}
function portFree(){return new Promise(resolve=>{const s=createServer().once('error',()=>resolve(false)).once('listening',()=>s.close(()=>resolve(true))).listen(8766,'127.0.0.1')})}
async function waitPort(){for(let i=0;i<20;i++){if(await portFree())return;await new Promise(r=>setTimeout(r,250))}const who=process.platform==='darwin'?portPids().map(command).filter(Boolean).join('、').slice(0,160):'';throw Error('ポート 8766 を別のアプリが使っています'+(who?`（${who}）`:'')+'。そのアプリを終了してから開き直してください。')}
// manabo 用のブラウザ（Chromium）を初回だけ取り込む
function ensureBrowser(){return new Promise((resolve,reject)=>{const marker=join(browsers,'.ready');if(existsSync(marker))return resolve();showStatus('manabo 用のブラウザを準備しています（初回だけ、数分かかります）…');const cli=join(repo.replace(/app\.asar$/,'app.asar.unpacked'),'node_modules/playwright/cli.js');const p=spawn(process.execPath,[cli,'install','chromium'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',PLAYWRIGHT_BROWSERS_PATH:browsers},stdio:'ignore',windowsHide:true});p.on('error',reject);p.on('exit',c=>{if(c===0){mkdirSync(browsers,{recursive:true});writeFileSync(marker,new Date().toISOString());resolve()}else reject(Error('ブラウザの準備に失敗しました（'+c+'）'))})})}
async function start(){tray=new Tray(nativeImage.createFromPath(join(repo,'dist/icon-512.png')).resize({width:18,height:18}));refreshTray();openWindow(page('<h1>saboro</h1><p>起動中…</p>'));
Object.assign(process.env,{COURSECUE_ROOT:root,COURSECUE_WORK:work,COURSECUE_AUTO_UPDATE:'0',COURSECUE_VERSION:app.getVersion(),PLAYWRIGHT_BROWSERS_PATH:browsers,COURSECUE_API:apiBase});
// Windows の import() は C:\ で始まるパスを受け付けないので file:// の URL にして読み込む。フォルダの作成もここで行い、失敗したら理由を出す
try{mkdirSync(root,{recursive:true});mkdirSync(work,{recursive:true});await stopOldAgent();await ensureBrowser();showStatus('サービスを起動しています…');await waitPort();await import(pathToFileURL(join(repo,'local/bridge.js')).href);ready=true;showStatus('動作中');app.setLoginItemSettings({openAtLogin:true});openWindow(home())}catch(e){showStatus('起動に失敗：'+String(e.message).slice(0,120));dialog.showErrorBox('saboro を起動できません',String(e.message))}
// 新しい版の確認（起動時・1 時間ごと・画面を前に出したとき（前の確認から 10 分以上たっていれば）・メニューの「新しい版を確認」）。
// Windows は自動で入れ替える。Mac は Apple の署名がないと入れ替えられないので、ダウンロードはせず知らせるだけにする
try{const {default:updater}=await import('electron-updater'),u=updater.autoUpdater;u.logger=null;if(process.platform==='darwin')u.autoDownload=false;checkUpdate=async(manual=false)=>{lastCheck=Date.now();try{if(process.platform!=='darwin'){await u.checkForUpdatesAndNotify();if(manual)dialog.showMessageBox({type:'info',message:'新しい版を確認しました',detail:'新しい版があれば、裏でダウンロードして、終了するときに入れ替えます。'});return}const r=await u.checkForUpdates(),v=r?.updateInfo?.version;if(v&&isNewer(v,app.getVersion()))await announce(v,manual);else if(manual)dialog.showMessageBox({type:'info',message:'saboro は最新の版です',detail:`いまの版は ${app.getVersion()} です。`})}catch(e){console.error('saboro: 新しい版を確認できません',e.message);if(manual)dialog.showMessageBox({type:'warning',message:'新しい版を確認できませんでした',detail:String(e.message||e).split('\n')[0].slice(0,200)})}};checkUpdate();setInterval(()=>checkUpdate(),3600*1000)}catch{}}
let checkUpdate=async()=>{},lastCheck=0;
const releasePage='https://github.com/Peyangpiece/SaBoRo/releases/latest';
const isNewer=(a,b)=>{const x=String(a).split('.').map(Number),y=String(b).split('.').map(Number);for(let i=0;i<3;i++){if((x[i]||0)!==(y[i]||0))return (x[i]||0)>(y[i]||0)}return false};
// 新しい版を知らせる：メニューバーに「新しい版をダウンロード」を出し、案内の画面は版ごとに 1 回だけ出す
async function announce(version,manual=false){newer=version;refreshTray();const file=join(userData,'update-notified.json');let seen='';try{seen=JSON.parse(readFileSync(file,'utf8')).version}catch{}if(seen===version&&!manual)return;try{writeFileSync(file,JSON.stringify({version}))}catch{}const r=await dialog.showMessageBox({type:'info',buttons:['ダウンロードのページを開く','あとで'],defaultId:0,cancelId:1,message:`saboro の新しい版 ${version} があります`,detail:`いまの版は ${app.getVersion()} です。Mac では自動で入れ替わらないので、saboro を終了してから、新しい版の .dmg を「アプリケーション」に入れ直してください。設定や資料はそのまま残ります。あとで入れるときは、メニューバーの saboro から「新しい版をダウンロード」を選べます。`});if(r.response===0)shell.openExternal(releasePage)}
// 2 つ目に起動したときは、1 つ目の画面を前に出すだけで終わる（app.quit() はすぐには終わらないため、その間に start が動くと、1 つ目が使っているポートで「起動に失敗」と出る）
if(single){app.on('second-instance',focusWindow);app.on('window-all-closed',()=>{});app.on('activate',focusWindow);app.whenReady().then(start)}
