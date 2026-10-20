import test from 'node:test';
import assert from 'node:assert/strict';
import '../dist/task-rules.js';
import {ADVANCED_MODEL, ADVANCED_LIMIT, PRICES, costUsd} from '../server/ai.js';
import {src, rx} from './source.js';
// 高度な生成：高性能なモデル（Opus）で出力の上限を広げて作る。出す課題の判定（画面とアプリで共有）、月 3 回まで無料・4 回目以降は有料
const {advancedEligible, wordCount} = globalThis.TaskRules;
test('出す課題：Word・PDF などのファイルで提出する課題、期末・中間レポートなどの名前、字数の指定が 1000 字以上。クイズや短い課題には出さない', () => {
  const t = (title, description = '', type = 'レポート') => ({title, description, type});
  assert.equal(advancedEligible(t('第3回 課題', 'Wordファイルで提出してください')), true);
  assert.equal(advancedEligible(t('第3回 課題', 'PDF 形式でアップロードすること')), true);
  assert.equal(advancedEligible(t('第3回 課題', 'ファイルを添付して提出')), true);
  assert.equal(advancedEligible(t('期末レポート')), true);
  assert.equal(advancedEligible(t('中間レポートの提出')), true);
  assert.equal(advancedEligible(t('最終課題')), true);
  assert.equal(advancedEligible(t('第3回 課題', '1000字以上で論じなさい')), true);
  assert.equal(advancedEligible(t('第3回 課題', '1,200文字程度')), true);
  assert.equal(advancedEligible(t('第3回 課題', '２０００字以内')), true, '全角の数字');
  assert.equal(advancedEligible(t('第3回 課題', '800字程度で述べよ')), false);
  assert.equal(advancedEligible(t('第3回 課題', '感想を書いてください')), false);
  assert.equal(advancedEligible(t('期末レポート', '', 'クイズ')), false, 'クイズには出さない');
  assert.equal(advancedEligible(null), false);
  assert.equal(wordCount('1,000字以上 2000文字以内'), 2000);
  assert.equal(wordCount('第3回'), 0);
});
test('クラウド：高度な生成は Opus 5.5（料金表あり）で、価格は Sonnet の 2 倍', () => {
  assert.equal(ADVANCED_MODEL, 'claude-opus-5-5');
  assert.deepEqual(PRICES['claude-opus-5-5'], {input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5});
  assert.equal(costUsd({input_tokens: 100000, output_tokens: 20000}, {model: 'claude-opus-5-5'}), 0.8);
  assert.equal(ADVANCED_LIMIT, 3);
  const ai = src('server/ai.js');
  assert.match(ai, rx('params(d.text,d.schema,advanced?ADVANCED_TOKENS:MAX_TOKENS,advanced?ADVANCED_MODEL:MODEL)'));
  assert.match(
    ai,
    rx(
      "if(advanced&&status.advanced.used>=ADVANCED_LIMIT&&!status.overage)return json({error:'advanced_limit'},403,origin);"
    )
  );
  assert.match(ai, rx('advancedLimit:advanced&&!status.overage?ADVANCED_LIMIT:null'));
  assert.match(
    ai,
    rx("(stats.count>=s.included||(mode==='advanced'&&(stats.advanced||0)>=ADVANCED_LIMIT))"),
    '4 回目以降は 60 回の中でも請求'
  );
});
test('画面：判定に合う課題（か途切れた課題）に「高度な生成を使う」を出し、無料分を使い切ったら請求できる人だけ「（有料）」で出す。確認の文で Opus と費用を説明する。PC は高度な生成を作り直す', () => {
  const app = src('dist/app.js');
  assert.match(
    app,
    rx(
      "if(!key||aiRule(t).forbidden||t.type==='クイズ')return false;if(!t.advancedOffer&&!(typeof TaskRules==='object'&&TaskRules.advancedEligible(t)))return false;const a=advancedUsage(t);return a.used<a.limit||!!a.paid;"
    )
  );
  assert.match(app, rx("return a.used<a.limit?`高度な生成を使う（${a.used}/${a.limit}）`:'高度な生成を使う（有料）';"));
  assert.match(
    app,
    /高性能なモデル（Opus）で、出力の上限を広げて作ります。高度な生成は月 \$\{a\.limit\} 回まで月額に含み/
  );
  assert.match(app, /この回は実際にかかった費用の 1\.5 倍を使用料として請求します/);
  assert.match(src('dist/index.html'), /<script src="\.\/task-rules\.js\?v=sp-1"><\/script>/);
  assert.match(
    src('local/manabo.js'),
    rx('let generated=advanced?null:t.generationKey===generationKey&&t.generation?t.generation:')
  );
});
