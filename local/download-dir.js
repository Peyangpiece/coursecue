import {homedir} from 'node:os';import {execFile} from 'node:child_process';import {existsSync} from 'node:fs';import {resolve,relative,sep,join,basename,dirname} from 'node:path';import {rename,access,mkdir} from 'node:fs/promises';
// 資料のダウンロード先（画面の設定欄から変更できる）。ホームフォルダ内の、隠しフォルダ・ライブラリ以外に限る
export function checkDownloadDir(input,home=homedir()){const raw=String(input??'').trim();if(!raw)return '';if(raw.length>500)throw Error('フォルダのパスが長すぎます');const expanded=raw==='~'?home:raw.startsWith('~/')?join(home,raw.slice(2)):raw;if(!expanded.startsWith('/'))throw Error('フォルダは /Users/… または ~/… の形で入力してください');const full=resolve(expanded),rel=relative(home,full);if(rel.startsWith('..')||resolve(home,rel)!==full)throw Error('ホームフォルダの中のフォルダを指定してください');const parts=rel?rel.split(sep):[];if(parts.some(p=>p.startsWith('.')))throw Error('隠しフォルダは指定できません');if(parts[0]==='Library')throw Error('ライブラリフォルダは指定できません');return full}
// path が root の中にあるか
export const inside=(path,root)=>{const rel=relative(root,String(path||''));return !!path&&!rel.startsWith('..')&&!rel.startsWith(sep)&&rel!==''};
// Mac の「フォルダを選択」画面を出し、選んだフォルダのパスを返す（取り消したら null）。パスは引数で渡し、スクリプトに埋め込まない
// 常駐サービスから出す画面は前面に出ないことがあるため、まず Finder に画面を出させる（初回は「Finder の制御」の許可が必要）。
// 許可されなかったときは osascript 自身で画面を出す
const prompt='saboro：資料のダウンロード先のフォルダを選んでください';
const viaFinder=['on run argv','tell application "Finder"','activate',`set p to choose folder with prompt "${prompt}" default location (POSIX file (item 1 of argv) as alias)`,'end tell','return POSIX path of p','end run'];
const direct=['on run argv','activate',`set p to choose folder with prompt "${prompt}" default location (POSIX file (item 1 of argv))`,'return POSIX path of p','end run'];
const ask=(run,script,start,timeout)=>new Promise(resolve=>run('osascript',[...script.flatMap(l=>['-e',l]),start],{timeout},(err,stdout,stderr)=>resolve({err,out:String(stdout||'').trim(),text:String(err?.message||'')+String(stderr||err?.stderr||'')})));
export async function pickFolder(current,{run=execFile,home=homedir(),timeout=300000}={}){const start=current&&existsSync(current)?current:home;let r=await ask(run,viaFinder,start,timeout);if(r.err&&!/-128|User canceled|キャンセル/.test(r.text)&&!r.err.killed)r=await ask(run,direct,start,timeout);if(r.err){if(/-128|User canceled|キャンセル/.test(r.text))return null;if(r.err.killed)throw Error('フォルダの選択が時間切れになりました。もう一度押してください');throw Error('Mac でフォルダの選択画面を開けませんでした')}return r.out.replace(/\/$/,'')||null}
// 画面の「資料」から開くファイル。記録済みの資料（sha256 で指定）のうち、ダウンロード先の中にあるものだけ返す
export function openableMaterial(materials,id,root){if(!/^[0-9a-f]{64}$/.test(String(id||'')))return null;const m=(materials||[]).find(m=>m.sha256===id&&inside(m.path,root));return m&&existsSync(m.path)?m.path:null}

// 以前の同期で「名前 (2).pdf」として保存してしまった複製の候補：ダウンロード先の中の記録のうち「(n)」付きの名前のもの。元の名前のファイルのパスも返す
export function duplicateCandidates(materials,root){const out=[];for(const m of materials||[]){if(!inside(m.path,root))continue;const match=basename(m.path).match(/^(.+) \((\d+)\)(\.[^.]+)$/);if(!match)continue;out.push({record:m,base:join(dirname(m.path),match[1]+match[3])})}return out}
// ファイルをゴミ箱（~/.Trash）へ移す。同名があれば名前に番号を足す（上書きしない）
export async function trashFile(file,{home=homedir()}={}){const trash=join(home,'.Trash');await mkdir(trash,{recursive:true});const name=basename(file),ext=name.match(/\.[^.]+$/)?.[0]||'',stem=name.slice(0,name.length-ext.length);let target=join(trash,name),n=2;while(true){try{await access(target);target=join(trash,`${stem} ${n++}${ext}`)}catch{break}}await rename(file,target);return target}
