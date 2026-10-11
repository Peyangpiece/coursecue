export function chooseContent(entries,task){
 const norm=s=>String(s||'').normalize('NFKC').replace(/[\s・]/g,'');
 const round=new RegExp(`第0?${task.round}回`);
 const unique=[...new Map(entries.map(e=>[new URL(e.url).pathname.replace(/\/[a-f0-9]{32,}\/?$/i,'/'),e])).values()];
 const exact=unique.filter(e=>norm(e.title)===norm(task.title));
 if(exact.length===1)return exact[0];
 // 種類（レポート・クイズ・掲示板）が分かっていれば、同じ種類の候補に絞ってから、回番号と課題らしい語で探す
 const typeOf=u=>/\/quiz\//.test(u)?'クイズ':/\/board\//.test(u)?'掲示板':'レポート';
 const typed=task.type?unique.filter(e=>typeOf(e.url)===task.type):[];
 const pool=typed.length?typed:unique;
 const matches=pool.filter(e=>round.test(norm(e.title))&&/課題|レポート|提出|小テスト|クイズ|テスト|演習|ワーク|リアクション/.test(e.title));
 return matches.length===1?matches[0]:pool.length===1?pool[0]:null;
}
