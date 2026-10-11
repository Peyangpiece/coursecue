import {homedir} from 'node:os';import {resolve,relative,sep,join} from 'node:path';
// 資料のダウンロード先（画面の設定欄から変更できる）。ホームフォルダ内の、隠しフォルダ・ライブラリ以外に限る
export function checkDownloadDir(input,home=homedir()){const raw=String(input??'').trim();if(!raw)return '';if(raw.length>500)throw Error('フォルダのパスが長すぎます');const expanded=raw==='~'?home:raw.startsWith('~/')?join(home,raw.slice(2)):raw;if(!expanded.startsWith('/'))throw Error('フォルダは /Users/… または ~/… の形で入力してください');const full=resolve(expanded),rel=relative(home,full);if(rel.startsWith('..')||resolve(home,rel)!==full)throw Error('ホームフォルダの中のフォルダを指定してください');const parts=rel?rel.split(sep):[];if(parts.some(p=>p.startsWith('.')))throw Error('隠しフォルダは指定できません');if(parts[0]==='Library')throw Error('ライブラリフォルダは指定できません');return full}
// path が root の中にあるか
export const inside=(path,root)=>{const rel=relative(root,String(path||''));return !!path&&!rel.startsWith('..')&&!rel.startsWith(sep)&&rel!==''};
