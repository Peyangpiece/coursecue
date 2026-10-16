// 課題の種類による判定。画面（課題の詳細）とアプリで共有する
// 「高度な生成」（高性能なモデルで、出力の上限を広げて作る）を出す課題：Word・PDF などのファイルで提出する課題、期末・中間レポートなどの名前の課題、字数の指定が 1000 字以上の課題
(function (g) {
  const FILE =
      /(word|ワード|pdf|docx?|excel|エクセル|パワーポイント|pptx?|powerpoint)[^。\n]{0,30}(提出|アップロード|添付)|(ファイル|file)[^。\n]{0,20}(提出|アップロード|添付)/i,
    NAME =
      /期末レポート|中間レポート|最終レポート|期末課題|中間課題|最終課題|ターム\s*レポート|学期末レポート|卒業論文|小論文|論文/;
  // 「1000字以上」「1,000文字程度」「2000〜3000字」など、数字のあとに 字・文字 が続く（「以内」「程度」も含む）。全角の数字も読む
  const COUNT = /(\d[\d,，]{2,})\s*(字|文字)/g;
  const toNumber = s =>
    Number(
      String(s)
        .replace(/[,，]/g, '')
        .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    );
  function wordCount(text) {
    let max = 0;
    for (const m of String(text || '')
      .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .matchAll(COUNT))
      max = Math.max(max, toNumber(m[1]));
    return max;
  }
  function advancedEligible(t) {
    if (!t || t.type === 'クイズ') return false;
    const text = [t.title, t.description, t.deadlineText].filter(Boolean).join('\n');
    return NAME.test(text) || FILE.test(text) || wordCount(text) >= 1000;
  }
  g.TaskRules = {advancedEligible, wordCount};
})(typeof globalThis !== 'undefined' ? globalThis : window);
