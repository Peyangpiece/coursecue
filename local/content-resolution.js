import {normalizeRounds} from './core.js';
export function chooseContent(entries,task){
 const norm=s=>normalizeRounds(s).replace(/[\s・]/g,'');
 const round=new RegExp(`第0?${task.round}回`);
 const unique=[...new Map(entries.map(e=>[new URL(e.url).pathname.replace(/\/[a-f0-9]{32,}\/?$/i,'/'),e])).values()];
 const exact=unique.filter(e=>norm(e.title)===norm(task.title));
 if(exact.length===1)return exact[0];
 // 種類（レポート・クイズ・掲示板）が分かっていれば、同じ種類の候補に絞ってから、回番号と課題らしい語で探す
 const typeOf=u=>/\/quiz\//.test(u)?'クイズ':/\/board\//.test(u)?'掲示板':'レポート';
 const typed=task.type?unique.filter(e=>typeOf(e.url)===task.type):[];
 const pool=typed.length?typed:unique;
 const matches=pool.filter(e=>round.test(norm(e.title))&&/課題|レポート|提出|小テスト|クイズ|テスト|演習|ワーク|リアクション/.test(e.title));
 if(matches.length===1)return matches[0];
 if(pool.length===1)return pool[0];
 // 「期限後提出用」などの別枠を除いて1つに絞れるなら、それ
 const onTime=(matches.length?matches:pool).filter(e=>!LATE.test(e.title));
 return onTime.length===1?onTime[0]:null;
}
// 期限後・再提出用の別枠（通常の提出先とは別に用意されるもの）
export const LATE=/期限後|遅延|遅れ|再提出|やむを得ない/;
