'use strict';
// 情绪微调模块的单元测试：规则打分 / 时间衰减 / 提示词片段 / 模型归纳解析
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const mood = require('../src/mood');

function cleanState() {
  try { fs.unlinkSync(mood.stateFile()); } catch { /* 本来就没有 */ }
}

test.beforeEach(() => cleanState());
test.after(() => cleanState());

test('被骂 → 有点烦/炸毛', () => {
  const e = mood.bump({}, 'wechat:u:test', '你怎么这么笨，闭嘴吧');
  assert.ok(['有点烦', '炸毛'].includes(e.mood), `实际：${e.mood}`);
  assert.ok(e.intensity >= 2);
});

test('被夸 → 开心或黏人', () => {
  const e = mood.bump({}, 'wechat:u:test', '你今天好可爱，好想抱抱');
  assert.ok(['开心', '黏人'].includes(e.mood), `实际：${e.mood}`);
});

test('对方低落 → 关心', () => {
  const e = mood.bump({}, 'wechat:u:test', '我今天好难过，想哭');
  assert.ok(['关心', '委屈'].includes(e.mood), `实际：${e.mood}`);
});

test('主人只回一个字 → 委屈', () => {
  const e = mood.bump({}, 'wechat:u:test', '嗯', { isMaster: true });
  assert.strictEqual(e.mood, '委屈');
});

test('没情绪线索的消息不会乱改情绪', () => {
  const e = mood.bump({}, 'wechat:u:test', '明天下午三点开会');
  assert.strictEqual(e.mood, '平静');
  assert.strictEqual(e.intensity, 2);
});

test('时间衰减：30 分钟后回到平静', () => {
  let e = mood.bump({}, 'wechat:u:test', '你是不是傻，闭嘴');
  assert.notStrictEqual(e.mood, '平静');
  const later = { ...e, updatedAt: Date.now() - 31 * 60 * 1000 };
  const d = mood.decay(later);
  assert.strictEqual(d.mood, '平静');
});

test('line() 平静时为空，有情绪时带强度', () => {
  assert.strictEqual(mood.line({ mood: '平静', intensity: 2 }), '');
  const e = mood.bump({}, 'wechat:u:test', '闭嘴，烦死');
  const text = mood.line(e);
  assert.match(text, /此刻情绪/);
  assert.match(text, /强度 \d\/5/);
  assert.match(text, /不要口头汇报心情/);
});

test('needsRefresh：消息攒够 6 条才让模型归纳', () => {
  let e = mood.bump({}, 'wechat:u:test', '在吗');
  for (let i = 0; i < 4; i += 1) e = mood.bump({}, 'wechat:u:test', `第${i}句`);
  assert.strictEqual(mood.needsRefresh(e), false, `turns=${e.turns}`);
  for (let i = 0; i < 2; i += 1) e = mood.bump({}, 'wechat:u:test', `补充${i}`);
  assert.strictEqual(mood.needsRefresh(e), true, `turns=${e.turns}`);
});

test('refresh 能解析模型 JSON 并落盘', async () => {
  const fakeLlm = {
    async complete() {
      return '```json\n{"mood":"开心","intensity":4,"why":"对方刚夸了她"}\n```';
    },
  };
  const next = await mood.refresh({
    config: {},
    llm: fakeLlm,
    key: 'wechat:u:test',
    turns: [
      { role: 'user', name: '狗修金', text: '你今天好可爱' },
      { role: 'assistant', text: '真的假的' },
    ],
  });
  assert.ok(next);
  assert.strictEqual(next.mood, '开心');
  assert.strictEqual(next.intensity, 4);
  assert.strictEqual(next.source, 'llm');
  assert.strictEqual(mood.describe({}, 'wechat:u:test').mood, '开心');
});

test('refresh 遇到乱输出时保留原情绪', async () => {
  const before = mood.bump({}, 'wechat:u:test', '闭嘴，烦');
  const fakeLlm = { async complete() { return '我不知道该说什么'; } };
  const next = await mood.refresh({ config: {}, llm: fakeLlm, key: 'wechat:u:test', turns: [{ role: 'user', text: 'x' }] });
  assert.strictEqual(next, null);
  assert.strictEqual(mood.describe({}, 'wechat:u:test').mood, before.mood);
});

test('reset 能把情绪清回平静', () => {
  mood.bump({}, 'wechat:u:test', '你怎么这么笨');
  const r = mood.reset({}, 'wechat:u:test');
  assert.strictEqual(r.mood, '平静');
});
