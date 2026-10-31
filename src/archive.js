'use strict';

/**
 * 记忆分层：私聊档案 / 群档案 / 群友印象。
 * 数据写在 data/archives.json，和 store.json 同目录。
 * 全部用规则打分，不额外调模型，所以不花 token、也不增加回复延迟。
 */
const fs = require('node:fs');
const path = require('node:path');

let FILE = '';
let DATA = { private: {}, group: {} };
let dirty = false;
let timer = null;

function load(file) {
  if (!file || FILE === file) return;
  FILE = file;
  DATA = { private: {}, group: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8').replace(/^\uFEFF/, ''));
    if (raw && typeof raw === 'object') {
      DATA = { private: raw.private && typeof raw.private === 'object' ? raw.private : {}, group: raw.group && typeof raw.group === 'object' ? raw.group : {} };
    }
  } catch (err) {
    if (err.code !== 'ENOENT') { /* 解析失败就当空档案，不影响聊天 */ }
  }
}

function flush() {
  if (!dirty || !FILE) return;
  dirty = false;
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ version: 1, private: DATA.private, group: DATA.group }));
  } catch (err) { /* 写不进去也不影响回复 */ }
}

function saveLater() {
  dirty = true;
  if (timer) return;
  timer = setTimeout(() => { timer = null; flush(); }, 2000);
  if (timer.unref) timer.unref();
}

const SELF_RE = /[\u4e00-\u9fa5A-Za-z]/;
const FACT_VERB = /(是|在|做|住|养|有|喜欢|讨厌|准备|要|想|学|考|搬|换|吃|玩|看|干|用|叫|加班|熬夜|失眠|上班|上课|下班|考试|面试|出差|旅游|搬家|减肥|健身|写|修|买|卖|养猫|养狗|睡觉|早起|请假|放假|开学|作业|项目|代码|论文|健身)/;
const TOPIC_WORDS = ['工作', '上班', '加班', '考试', '学习', '论文', '项目', '搬家', '旅游', '游戏', '动漫', '电影', '音乐', '健身', '减肥', '熬夜', '失眠', '恋爱', '分手', '家里', '父母', '猫', '狗', '饭', '外卖', '房租', '工资', '面试', '编程', '代码', '摄影', '画图', '放假', '开学', '作业'];
const BAD_RE = /(傻|蠢|笨|滚|烦|闭嘴|废物|垃圾|讨厌你|恶心|无语)/;
const GOOD_RE = /(可爱|厉害|牛|喜欢|谢谢|靠谱|真棒|爱你|辛苦|好看|不错)/;

function pickFacts(text) {
  return String(text || '')
    .split(/[，。！？!?；;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 4 && s.length <= 40 && s.includes('\u6211') && SELF_RE.test(s) && FACT_VERB.test(s))
    .slice(0, 2);
}

function topicsOf(text) {
  const t = String(text || '');
  return TOPIC_WORDS.filter((w) => t.includes(w)).slice(0, 3);
}

function bump(file, { key, chatType, senderId, senderName, text, isGroup }) {
  load(file);
  if (!key) return;
  const uid = String(senderId || senderName || 'unknown').slice(0, 64);
  const name = String(senderName || uid).slice(0, 24);
  const now = Date.now();
  const group = isGroup || chatType === 'group';
  if (!group) {
    const p = DATA.private[key] || (DATA.private[key] = { facts: [], topics: {}, at: 0, name });
    p.name = name;
    p.at = now;
    for (const f of pickFacts(text)) if (!p.facts.includes(f)) p.facts.push(f);
    for (const w of topicsOf(text)) p.topics[w] = (p.topics[w] || 0) + 1;
    if (p.facts.length > 12) p.facts = p.facts.slice(-12);
    saveLater();
    return;
  }
  const g = DATA.group[key] || (DATA.group[key] = { topics: {}, members: {}, at: 0 });
  g.at = now;
  for (const w of topicsOf(text)) g.topics[w] = (g.topics[w] || 0) + 1;
  const m = g.members[uid] || (g.members[uid] = { name, count: 0, impression: '' });
  m.name = name;
  m.count = (m.count || 0) + 1;
  m.at = now;
  const trimmed = String(text || '').trim();
  if (BAD_RE.test(trimmed)) m.impression = '嘴比较冲';
  else if (GOOD_RE.test(trimmed)) m.impression = '爱夸人';
  else if (/[？?]$/.test(trimmed)) m.impression = '爱提问';
  saveLater();
}

function top(obj) {
  return Object.entries(obj || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, v]) => (v > 1 ? k + '×' + v : k))
    .join('、');
}

function snapshot(file, key, chatType, limit = 600) {
  load(file);
  if (!key) return '';
  const lines = [];
  if (chatType === 'group') {
    const g = DATA.group[key];
    if (g) {
      const tp = top(g.topics);
      if (tp) lines.push('【群里常聊】' + tp);
      const ms = Object.values(g.members || {})
        .sort((a, b) => (b.count || 0) - (a.count || 0))
        .slice(0, 4)
        .map((m) => m.name + (m.impression ? '（' + m.impression + '）' : ''))
        .filter(Boolean);
      if (ms.length) lines.push('【群里的人】' + ms.join('、'));
    }
  } else {
    const p = DATA.private[key];
    if (p) {
      if (Array.isArray(p.facts) && p.facts.length) lines.push('【TA 说过】' + p.facts.slice(-6).join('；'));
      const tp = top(p.topics);
      if (tp) lines.push('【常聊】' + tp);
    }
  }
  const out = lines.join('\n');
  return out.length > limit ? out.slice(0, limit) + '…' : out;
}

module.exports = { bump, snapshot, flush };
