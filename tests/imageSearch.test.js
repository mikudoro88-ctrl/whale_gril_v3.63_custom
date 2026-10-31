'use strict';

// 看图联网补充的小工具函数（不联网，纯字符串/相关性逻辑）
const test = require('node:test');
const assert = require('node:assert/strict');

const imageSearch = require('../src/imageSearch');

test('tidyQuery：去掉引号和描述性尾巴，最多 16 字', () => {
  assert.equal(imageSearch.tidyQuery('「原神」雷电将军 主角 立绘'), '原神 雷电将军');
  assert.equal(imageSearch.tidyQuery('《黑神话：悟空》 游戏截图'), '黑神话 悟空 游戏截图'.replace(' 游戏截图', ''));
  assert.equal(imageSearch.tidyQuery('  原神   雷电将军  '), '原神 雷电将军');
  assert.equal(imageSearch.tidyQuery('查询词：崩坏星穹铁道'), '崩坏星穹铁道');
  const long = imageSearch.tidyQuery('一个非常非常长的查询词超过十六个字限制');
  assert.ok(long.length <= 16, '长查询词要被截断');
});

test('buildQuery：优先引号里的专有名词', () => {
  assert.equal(imageSearch.buildQuery('这是一张《黑神话：悟空》的游戏截图'), '黑神话 悟空');
  assert.equal(imageSearch.buildQuery('图中是一名叫「雷电将军」的角色'), '雷电将军');
  assert.equal(imageSearch.buildQuery(''), '');
});

test('buildQuery：剥掉「这是一张…」这类开场白', () => {
  const q = imageSearch.buildQuery('这是一张游戏截图，画面中央是主角在战斗。');
  assert.ok(!q.startsWith('这是一张'), '不该保留开场白，实际：' + q);
  assert.ok(q.includes('游戏截图') || q.includes('画面中央'), '要保留正题，实际：' + q);
});

test('relevant：搜索结果要看得出跟查询词有关系', () => {
  const junk = { title: '黑（汉语文字）_百度百科', snippet: '黑，汉语一级字，拼音 hēi' };
  const good = { title: '黑神话：悟空_百度百科', snippet: '《黑神话：悟空》是西游题材单机游戏' };
  assert.equal(imageSearch.relevant('黑神话 悟空', junk), false);
  assert.equal(imageSearch.relevant('黑神话 悟空', good), true);
  assert.equal(imageSearch.relevant('原神 雷电将军', { title: '雷电将军 - 原神 WIKI', snippet: '' }), true);
});

test('looksSearchable：普通聊天截图/风景不硬搜', () => {
  assert.equal(imageSearch.looksSearchable('微信聊天截图 对方说晚上吃什么'), false);
  assert.equal(imageSearch.looksSearchable('一张纯蓝色渐变壁纸'), false);
  assert.equal(imageSearch.looksSearchable('《崩坏星穹铁道》的角色立绘'), true);
  assert.equal(imageSearch.looksSearchable('iPhone 16 Pro 的产品图'), true); // 英文型号算专有名词信号
});

test('enrich：关掉开关就直接不搜', async () => {
  const config = { vision: { webSearch: { enabled: false } } };
  const out = await imageSearch.enrich(config, '《黑神话：悟空》的游戏截图', {});
  assert.equal(out, null);
});

test('enrich：描述太短不搜', async () => {
  const config = { vision: { webSearch: { enabled: true } } };
  const out = await imageSearch.enrich(config, '图', {});
  assert.equal(out, null);
});
