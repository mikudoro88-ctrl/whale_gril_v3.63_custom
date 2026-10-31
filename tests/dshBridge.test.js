'use strict';
const test = require('node:test');
const assert = require('node:assert');
const dsh = require('../src/dshBridge.js');

test('parseResearch：标准三行', () => {
  const r = dsh.parseResearch('结论：ヤニねこ 佐藤ヤニ子\n依据：绿发猫耳叼烟\n置信度：中');
  assert.equal(r.conclusion, 'ヤニねこ 佐藤ヤニ子');
  assert.equal(r.evidence, '绿发猫耳叼烟');
  assert.equal(r.confidence, '中');
});

test('parseResearch：格式歪了也能拿到结论', () => {
  const r = dsh.parseResearch('应该是《楓と鈴》吧\n随便说说\n置信度：低');
  assert.equal(r.conclusion, '应该是《楓と鈴》吧');
  assert.equal(r.confidence, '低');
});

test('status：关掉开关后 enabled=false', () => {
  const cfg = { dshBridge: { enabled: false, dshExe: 'D:\\dsh\\DeepSeek Harness.exe', dshCli: 'x.js' } };
  assert.equal(dsh.status(cfg).enabled, false);
});

test('status：默认可读，包含 describe/fallback 开关', () => {
  const cfg = { dshBridge: { dshExe: 'D:\\dsh\\DeepSeek Harness.exe', dshCli: 'C:\\fake\\cli.js' } };
  const st = dsh.status(cfg);
  assert.equal(st.describe, true);
  assert.equal(st.fallback, true);
  assert.ok(st.dshExe.indexOf('DeepSeek Harness.exe') > 0);
});

test('describeImage：开关关掉时直接返回 null（不调 DSH）', async () => {
  const cfg = { dshBridge: { enabled: false } };
  const r = await dsh.describeImage(cfg, { buffer: Buffer.from('x') });
  assert.equal(r, null);
});