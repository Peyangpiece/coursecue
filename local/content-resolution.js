export function chooseContent(entries,task){
 const norm=s=>String(s||'').normalize('NFKC').replace(/[\s・]/g,'');
 const round=new RegExp(`第0?${task.round}回`);
 const unique=[...new Map(entries.map(e=>[new URL(e.url).pathname.replace(/\/[a-f0-9]{32,}\/?$/i,'/'),e])).values()];
 const exact=unique.filter(e=>norm(e.title)===norm(task.title));
 if(exact.length===1)return exact[0];
 const matches=unique.filter(e=>round.test(norm(e.title))&&/課題/.test(e.title));
 return matches.length===1?matches[0]:unique.length===1?unique[0]:null;
}
