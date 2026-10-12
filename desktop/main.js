// saboro デスクトップ：Mac と Windows で、ターミナルなしに同期・生成を動かす常駐アプリ。
// 秘密は OS の仕組み（macOS キーチェーン / Windows DPAPI）で暗号化し、設定は画面の 3 手順だけ
import {app,BrowserWindow,Tray,Menu,shell,dialog,safeStorage,nativeImage} from 'electron';import {join,dirname} from 'node:path';import {fileURLToPath} from 'node:url';import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {spawn} from 'node:child_process';import {randomBytes} from 'node:crypto';
const here=dirname(fileURLToPath(import.meta.url)),repo=dirname(here);
const userData=app.getPath('userData'),docs=app.getPath('documents');
const root=join(docs,'saboro'),work=join(userData,'work'),browsers=join(userData,'pw-browsers');
const apiBase=process.env.COURSECUE_API||'https://coursecue.hrk-6888.workers.dev';
const single=app.requestSingleInstanceLock();if(!single)app.quit();
let win=null,tray=null,status='起動中…';
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
function openWindow(url){if(win&&!win.isDestroyed()){win.loadURL(url);win.show();win.focus();return}win=new BrowserWindow({width:1100,height:820,title:'saboro',webPreferences:{contextIsolation:true,sandbox:true}});win.loadURL(url);win.on('closed',()=>{win=null})}
function showStatus(text){status=text;if(win&&!win.isDestroyed()&&win.webContents.getURL().startsWith('data:'))win.loadURL(page(`<h1>saboro</h1><p>${text}</p>`));refreshTray()}
function refreshTray(){if(!tray)return;tray.setContextMenu(Menu.buildFromTemplate([{label:'saboro を開く',click:()=>openWindow(apiBase+'/')},{label:'はじめの設定',click:()=>openWindow('http://127.0.0.1:8766/setup')},{label:'資料のフォルダを開く',click:()=>shell.openPath(root)},{type:'separator'},{label:status,enabled:false},{type:'separator'},{label:'終了',click:()=>app.exit(0)}]));tray.setToolTip('saboro：'+status)}
// manabo 用のブラウザ（Chromium）を初回だけ取り込む
function ensureBrowser(){return new Promise((resolve,reject)=>{const marker=join(browsers,'.ready');if(existsSync(marker))return resolve();showStatus('manabo 用のブラウザを準備しています（初回だけ、数分かかります）…');const cli=join(repo.replace(/app\.asar$/,'app.asar.unpacked'),'node_modules/playwright/cli.js');const p=spawn(process.execPath,[cli,'install','chromium'],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',PLAYWRIGHT_BROWSERS_PATH:browsers},stdio:'ignore',windowsHide:true});p.on('error',reject);p.on('exit',c=>{if(c===0){mkdirSync(browsers,{recursive:true});writeFileSync(marker,new Date().toISOString());resolve()}else reject(Error('ブラウザの準備に失敗しました（'+c+'）'))})})}
async function start(){tray=new Tray(nativeImage.createFromPath(join(repo,'dist/icon-512.png')).resize({width:18,height:18}));refreshTray();openWindow(page('<h1>saboro</h1><p>起動中…</p>'));mkdirSync(root,{recursive:true});mkdirSync(work,{recursive:true});
Object.assign(process.env,{COURSECUE_ROOT:root,COURSECUE_WORK:work,COURSECUE_AUTO_UPDATE:'0',COURSECUE_VERSION:app.getVersion(),PLAYWRIGHT_BROWSERS_PATH:browsers,COURSECUE_API:apiBase});
try{await ensureBrowser();showStatus('サービスを起動しています…');await import(join(repo,'local/bridge.js'));showStatus('動作中');app.setLoginItemSettings({openAtLogin:true});const paired=!!secrets.get('manabo');openWindow(paired?apiBase+'/':'http://127.0.0.1:8766/setup')}catch(e){showStatus('起動に失敗：'+String(e.message).slice(0,120));dialog.showErrorBox('saboro を起動できません',String(e.message))}
try{const {default:updater}=await import('electron-updater');updater.autoUpdater.logger=null;updater.autoUpdater.checkForUpdatesAndNotify().catch(()=>{});setInterval(()=>updater.autoUpdater.checkForUpdatesAndNotify().catch(()=>{}),6*3600*1000)}catch{}}
app.on('second-instance',()=>openWindow(apiBase+'/'));
app.on('window-all-closed',()=>{});
app.on('activate',()=>openWindow(apiBase+'/'));
app.whenReady().then(start);
