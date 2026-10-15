// 「自分について」のアンケート（選ぶだけで答えられる簡単な質問）。画面（設定・最初の設定）とアプリ（回答の作成）で共有する
// 答え（state.settings.profileForm）は composeProfile で「学部：経営学部」のような文にまとめ、自由記述（state.settings.profile）と合わせて回答の作成に使う
(function(g){
const PROFILE_FIELDS=[
 {key:'faculty',label:'学部',type:'one',options:['国際学部','文学部','心理学部','法学部','経済学部','経営学部','総合政策学部','現代社会学部','工学部','スポーツ科学部','その他']},
 {key:'year',label:'学年',type:'one',options:['1年','2年','3年','4年','大学院','その他']},
 {key:'job',label:'アルバイト',type:'many',options:['していない','飲食','販売・接客','塾講師・家庭教師','事務','工場・倉庫','イベント・短期','その他']},
 {key:'club',label:'部活・サークル',type:'one',options:['入っていない','運動系','文化系','ボランティア','その他'],note:'名前（任意）'},
 {key:'interest',label:'興味のある分野',type:'many',options:['経営・マーケティング','経済・金融','法律・政治','国際・語学','心理・教育','社会・メディア','IT・データ','スポーツ・健康','文化・芸術','環境・地域']},
 {key:'future',label:'将来の希望',type:'one',options:['一般企業','公務員','教員','起業','進学','まだ決めていない','その他']},
 {key:'strength',label:'得意なこと',type:'many',options:['人と話す','コツコツ取り組む','計画を立てる','新しいことに挑戦する','チームで動く','一人で集中する','調べる・まとめる']}
];
// 答えを整える（知らない項目・選択肢は捨てる。補足は 40 字まで）
function cleanProfileForm(v){const out={};if(!v||typeof v!=='object')return out;for(const f of PROFILE_FIELDS){const x=v[f.key];if(f.type==='one'&&f.options.includes(x))out[f.key]=x;if(f.type==='many'&&Array.isArray(x)){const picked=[...new Set(x.filter(o=>f.options.includes(o)))];if(picked.length)out[f.key]=picked}const note=v[f.key+'Note'];if(typeof note==='string'&&note.trim())out[f.key+'Note']=note.trim().slice(0,40)}return out}
// 答えを「自分について」の文にまとめる（1 行 1 項目）
function composeProfile(v){const c=cleanProfileForm(v);return PROFILE_FIELDS.map(f=>{const x=c[f.key],note=c[f.key+'Note'];if(!x&&!note)return '';const value=[Array.isArray(x)?x.join('、'):x,note].filter(Boolean).join('（')+(x&&note?'）':'');return `${f.label}：${value}`}).filter(Boolean).join('\n')}
// 画面のアンケート（id の頭 pf-）と、画面から答えを読む
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function profileFormHtml(v){const c=cleanProfileForm(v);return PROFILE_FIELDS.map(f=>`<fieldset class="field pf"><legend>${esc(f.label)}${f.type==='many'?'（いくつでも）':''}</legend><div class="pf-options">${f.options.map(o=>`<label class="check"><input type="${f.type==='one'?'radio':'checkbox'}" name="pf-${f.key}" value="${esc(o)}"${(f.type==='one'?c[f.key]===o:(c[f.key]||[]).includes(o))?' checked':''}> ${esc(o)}</label>`).join(' ')}</div>${f.note||f.options.includes('その他')?`<input class="form-control pf-note" name="pf-${f.key}Note" maxlength="40" placeholder="${esc(f.note||'その他の場合は具体的に（任意）')}" value="${esc(c[f.key+'Note']||'')}">`:''}</fieldset>`).join('')}
function readProfileForm(root){const v={};for(const f of PROFILE_FIELDS){const picked=[...root.querySelectorAll(`input[name="pf-${f.key}"]:checked`)].map(e=>e.value);if(picked.length)v[f.key]=f.type==='one'?picked[0]:picked;const note=root.querySelector(`input[name="pf-${f.key}Note"]`);if(note&&note.value.trim())v[f.key+'Note']=note.value.trim()}return cleanProfileForm(v)}
g.ProfileForm={PROFILE_FIELDS,cleanProfileForm,composeProfile,profileFormHtml,readProfileForm};
})(typeof globalThis!=='undefined'?globalThis:window);
