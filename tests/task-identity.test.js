import test from 'node:test';
import assert from 'node:assert/strict';
import {taskIdentity, mergeTasks} from '../local/task-identity.js';
test('URLトークンが変化しても同じ教材を統合し回答を保持', () => {
  const a = {
      id: 'a',
      course: 0,
      url: 'https://example.com/content/123/quiz/first/',
      answer: '保存した回答',
      status: 'draft'
    },
    b = {id: 'b', course: 0, url: 'https://example.com/content/123/quiz/second/', answer: '別の回答', status: 'ready'};
  assert.equal(taskIdentity(a.url, 0), taskIdentity(b.url, 0));
  const m = mergeTasks([a, b, {...b, id: 'c', url: 'https://example.com/content/456/quiz/other/'}]);
  assert.equal(m.tasks.length, 2);
  assert.equal(m.tasks[0].answer, '保存した回答');
  assert.equal(m.archived[0].answer, '別の回答');
});
