import {readFileSync} from 'node:fs';
// ソースの文を調べるテストの道具：Prettier で空白・改行の入り方が変わっても、同じ字句の並びなら合うようにする
export const src = file => readFileSync(file, 'utf8');
export const esc = s => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const TOKEN = /'[^']*'|"[^"]*"|[\p{L}\p{N}_]+|\s+|./gsu,
  word = /^[\p{L}\p{N}_]+$/u;
// 空白を詰めて書いたコードの断片（if(a)b(c) など）を、字句のあいだにどんな空白・改行があっても合う正規表現の文字列にする。
// 文字列リテラルの中はそのまま。語と語のあいだ（const x など）は 1 つ以上の空白
export function loose(dense) {
  let out = '',
    prev = '';
  for (const t of dense.match(TOKEN).filter(t => !/^\s+$/.test(t))) {
    if (prev) out += word.test(prev) && word.test(t) ? '\\s+' : '\\s*';
    out += esc(t);
    prev = t;
  }
  return out;
}
// rx('if(a)b', /[\s\S]{0,99}?/, 'c()')：文字列は上の断片、RegExp はその部分だけ正規表現のまま使う
export const rx = (...parts) => new RegExp(parts.map(p => (p instanceof RegExp ? p.source : loose(p))).join(''));
export const find = (s, ...parts) => s.search(rx(...parts));
export const findLast = (s, ...parts) => {
  let i = -1;
  for (const m of s.matchAll(new RegExp(rx(...parts).source, 'g'))) i = m.index;
  return i;
};
