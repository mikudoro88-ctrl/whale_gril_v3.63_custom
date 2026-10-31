'use strict';

/**
 * dshBridge —— 让鲸鲸借用 DSH（DeepSeek Harness）的看图/联网能力。
 *
 * 为什么要用 DSH 的 node 入口而不是 dsh.cmd：
 *   Node 20+ 在 Windows 上禁止直接 spawn .cmd（CVE-2024-27980 修复，报 spawn EINVAL），
 *   而 dsh.cmd 只是 `ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness.exe" --expose-internals <cli.js>`，
 *   所以这里直接以「Electron 当 node 用 + cli.js」的方式拉起，参数不会被 shell 二次解析。
 *
 * 两种用法：
 *   1) describeImage：单步看图，输出「主体/发型发色/服饰/画面文字/可检索特征」五行，
 *      实测 6 秒，和 deepseek-flash 的看图并行跑，不额外增加延迟；
 *   2) researchImage：疑难图兜底，最多 3 次工具调用（read_image + 2 次 web_search），
 *      输出「结论/依据/置信度」三行，实测 50 秒左右，超时自动放弃。
 *
 * 所有调用串行排队（避免同时起多个 agent 会话），并按图片内容做缓存。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const DEFAULT_EXE = 'D:\\dsh\\DeepSeek Harness.exe';
const DEFAULT_CLI = 'D:\\dsh\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js';
const MAX_CACHE = 300;

const describeCache = new Map();
const researchCache = new Map();
let queue = Promise.resolve();

function cfgOf(config) {
  return (config && config.dshBridge) || {};
}

function exeOf(config) {
  const c = cfgOf(config);
  return c.dshExe || DEFAULT_EXE;
}

function cliOf(config) {
  const c = cfgOf(config);
  return c.dshCli || DEFAULT_CLI;
}

function enabled(config) {
  const c = cfgOf(config);
  if (c.enabled === false) return false;
  // cli.js 在 app.asar 里，普通 node 的 existsSync 看不到它，只检查 Electron 主程序即可
  return fs.existsSync(exeOf(config)) && !!cliOf(config);
}

/** Key 优先级：config 指定 → DSH 落盘的鲸鲸 settings → 环境变量（不读 ~/.dsh）。 */
function apiKeyOf(config) {
  const c = cfgOf(config);
  if (c.apiKey) return String(c.apiKey);
  if (config && config.dshBridge && config.dshBridge._settingsKey) return String(config.dshBridge._settingsKey);
  const candidates = [
    path.join(process.cwd(), 'data', 'settings.json'),
    path.join(__dirname, '..', 'data', 'settings.json'),
  ];
  for (const p of candidates) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const k = (j && j.apiKey) || (j && j.keys && j.keys.deepseek) || '';
      if (k) return String(k);
    } catch (_) { /* 没有就继续 */ }
  }
  return process.env.DEEPSEEK_API_KEY || '';
}

function imageDirOf(config) {
  const c = cfgOf(config);
  return c.imageDir || path.join(process.cwd(), 'data', 'dsh-images');
}

function pruneDir(dir, keepMs) {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && now - st.mtimeMs > keepMs) fs.unlinkSync(p);
      } catch (_) { /* 单个文件删不掉不影响 */ }
    }
  } catch (_) { /* 目录不存在等忽略 */ }
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function remember(cache, key, value) {
  cache.set(key, value);
  if (cache.size > MAX_CACHE) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

/** 串行执行：同一时刻只跑一个 headless 会话，避免争抢。 */
function enqueue(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
}

function runDsh(config, task, timeoutMs) {
  const exe = exeOf(config);
  const cli = cliOf(config);
  const key = apiKeyOf(config);
  return new Promise((resolve) => {
    if (!key) {
      resolve({ ok: false, text: '', ms: 0, error: 'NO_API_KEY' });
      return;
    }
    const started = Date.now();
    const env = Object.assign({}, process.env, {
      DEEPSEEK_API_KEY: key,
      ELECTRON_RUN_AS_NODE: '1',
    });
    execFile(
      exe,
      ['--expose-internals', cli, '--profile', 'headless', task],
      { timeout: Math.max(5000, timeoutMs || 60000), maxBuffer: 8 * 1024 * 1024, windowsHide: true, env },
      (err, stdout, stderr) => {
        const ms = Date.now() - started;
        const out = String(stdout || '').trim();
        if (err && !out) {
          resolve({ ok: false, text: '', ms, error: String(err.message || err).slice(0, 200), stderr: String(stderr || '').slice(0, 400) });
          return;
        }
        resolve({ ok: !!out, text: out, ms, stderr: String(stderr || '').slice(0, 400) });
      }
    );
  });
}

const DESCRIBE_TASK = [
  '用 read_image 看这张图片：{img}',
  '直接输出 150 字内的画面描述，只要这五行，不要标题、不要解释、不要联网、不要猜作品名：',
  '主体：…',
  '发型发色：…',
  '服饰：…',
  '画面文字：…',
  '可检索特征：…',
].join('\n');

/**
 * 单步看图描述。返回 {text, ms}；不可用/失败返回 null 或 {text:''}。
 */
async function describeImage(config, { buffer, mime = 'image/jpeg' }) {
  if (!enabled(config)) return null;
  const c = cfgOf(config);
  if (c.describe === false) return null;
  if (!buffer || !buffer.length) return null;
  const hash = sha256(buffer);
  const cached = describeCache.get(hash);
  if (cached) return Object.assign({ cached: true }, cached);

  const dir = imageDirOf(config);
  fs.mkdirSync(dir, { recursive: true });
  pruneDir(dir, 10 * 60 * 1000);
  const ext = /png/i.test(mime) ? '.png' : /gif/i.test(mime) ? '.gif' : /webp/i.test(mime) ? '.webp' : '.jpg';
  const file = path.join(dir, 'dsh-' + hash.slice(0, 12) + ext);
  fs.writeFileSync(file, buffer);

  const timeoutMs = Number(c.describeTimeoutMs) || 40000;
  const task = DESCRIBE_TASK.replace('{img}', file);
  const r = await enqueue(() => runDsh(config, task, timeoutMs)).catch((e) => ({ ok: false, text: '', ms: 0, error: String(e && e.message) }));
  try { fs.unlinkSync(file); } catch (_) { /* 忽略 */ }

  if (!r || !r.ok) return { text: '', ms: (r && r.ms) || 0, error: (r && r.error) || 'empty' };
  const text = r.text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).join('\n');
  const value = { text, ms: r.ms };
  remember(describeCache, hash, value);
  return value;
}

const RESEARCH_TASK = [
  '任务：识别这张图片里的角色或作品出处：{img}',
  '规则：最多用 1 次 read_image、最多 {maxSearch} 次 web_search，不要 web_fetch，总工具调用不超过 {maxTools} 次；查不到就说查不到，绝不编造。',
  '方法（很重要）：',
  '1) 不要相信任何「以图搜图」结论——同人图的以图搜图很容易误配成某部动画的截图，只能当线索，不能当答案。',
  '2) 用画面特征去搜：发色发型、耳朵/尾巴、服装（校服/领带/格裙…）、道具（烟、眼镜、武器）、画风；',
  '   中文和日文各搜一次，日文用「緑髪 猫耳 制服 タバコ アニメ キャラ」这种关键词堆法。',
  '3) 优先看萌娘百科 / ピクシブ百科事典 / 维基百科 / AniList 的条目；两个独立来源说法一致才算「中」。',
  '4) 参考线索（可能不准，必须自己核实，对不上就明确说不符）：{hint}',
  '最后只输出三行（不要别的）：',
  '结论：…',
  '依据：…',
  '置信度：高/中/低',
].join('\n');

function parseResearch(text) {
  const out = { conclusion: '', evidence: '', confidence: '', raw: text };
  const m1 = text.match(/结论[：:]\s*([^\n]+)/);
  const m2 = text.match(/依据[：:]\s*([^\n]+)/);
  const m3 = text.match(/置信度[：:]\s*(高|中|低)/);
  if (m1) out.conclusion = m1[1].trim();
  if (m2) out.evidence = m2[1].trim();
  if (m3) out.confidence = m3[1];
  if (!out.conclusion) {
    const first = text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] || '';
    out.conclusion = first.slice(0, 120);
  }
  return out;
}

/**
 * 疑难图兜底：让 DSH 做一次「看图 + 受限联网核对」。
 */
async function researchImage(config, { buffer, mime = 'image/jpeg', hint = '' }) {
  if (!enabled(config)) return null;
  const c = cfgOf(config);
  if (c.fallback === false) return null;
  if (!buffer || !buffer.length) return null;
  const maxSearch = Math.max(1, Math.min(5, Number(c.maxSearches) || 4));
  const hash = sha256(buffer) + ':s' + maxSearch;
  const cached = researchCache.get(hash);
  if (cached) return Object.assign({ cached: true }, cached);

  const dir = imageDirOf(config);
  fs.mkdirSync(dir, { recursive: true });
  pruneDir(dir, 10 * 60 * 1000);
  const ext = /png/i.test(mime) ? '.png' : '.jpg';
  const file = path.join(dir, 'dsh-r-' + hash.slice(0, 12) + ext);
  fs.writeFileSync(file, buffer);

  const timeoutMs = Number(c.fallbackTimeoutMs) || 100000;
  const task = RESEARCH_TASK
    .replace('{img}', file)
    .replace('{hint}', String(hint || '（无）').slice(0, 300))
    .replace('{maxSearch}', String(maxSearch))
    .replace('{maxTools}', String(maxSearch + 1));
  const r = await enqueue(() => runDsh(config, task, timeoutMs)).catch((e) => ({ ok: false, text: '', ms: 0, error: String(e && e.message) }));
  try { fs.unlinkSync(file); } catch (_) { /* 忽略 */ }

  if (!r || !r.ok) return { ok: false, ms: (r && r.ms) || 0, error: (r && r.error) || 'empty' };
  const parsed = parseResearch(r.text);
  parsed.ok = true;
  parsed.ms = r.ms;
  remember(researchCache, hash, parsed);
  return parsed;
}

function status(config) {
  const c = cfgOf(config);
  return {
    enabled: enabled(config),
    describe: c.describe !== false,
    fallback: c.fallback !== false,
    dshExe: exeOf(config),
    hasKey: !!apiKeyOf(config),
    describeCache: describeCache.size,
    researchCache: researchCache.size,
  };
}

module.exports = { describeImage, researchImage, status, enabled, parseResearch };
