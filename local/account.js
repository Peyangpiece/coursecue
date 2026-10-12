import {randomBytes} from 'node:crypto';
// 利用者の登録：接続キー（owner）と Mac の鍵（device）を作ってクラウドに登録し、キーチェーンに保存する。
// すでに両方あれば何もしない（最初の利用者は旧トークンのまま）。登録に失敗したら保存しない
export async function ensureAccount({vault,apiBase,fetchFn=fetch,random=()=>randomBytes(32).toString('hex')}){const owner=vault('get','owner'),device=vault('get','device');if(owner&&device)return {status:'existing'};const next={owner:random(),device:random()};const r=await fetchFn(apiBase+'/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(next)});if(!r.ok)throw Error(`クラウドへの登録に失敗しました（${r.status}）`);const {id}=await r.json();if(vault('set','owner',next.owner)===null||vault('set','device',next.device)===null)throw Error('キーチェーンに保存できませんでした');return {status:'registered',id}}
