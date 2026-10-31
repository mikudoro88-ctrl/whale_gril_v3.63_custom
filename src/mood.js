'use strict';
/**
 * 情绪微调：根据微信聊天上下文，让鲸鲸的「此刻情绪」自己变。
 *
 * 两条腿：
 *  1) 每条消息先做一次廉价的规则打分（不用调模型、零延迟）：被骂→烦/炸毛、被夸→开心、
 *     对方低落→关心、很短的敷衍回复→委屈、说困说晚安→困了……
 *  2) 累积到一定条数（或情绪已经很浓），异步让模型按最近十条聊天归纳一次，
 *     修正成一个更合理的情绪，不阻塞回复、失败就保持规则结果。
 *
 * 情绪会随时间自然衰减回「平静」：每 25 分钟降一档，最多到平静。
 * 状态存在 data/mood.json，按会话 key 分开（私聊一个、每个群一个）。
 */

const fs = require('fs');
const path = require('path');

const BASE = '平静';
const DECAY_MS = 25 * 60 * 1000; // 25 分钟降一档
const MAX_KEYS = 300;

const MOODS = {
  平静: { tone: '平稳的日常语气，该正经就正经' },
  开心: { tone: '语气轻快，愿意多说两句，可以带点小得意，但别自夸过头' },
  黏人: { tone: '想说话、想被回应，会主动找话头，偶尔撒个娇' },
  关心: { tone: '先关心对方的状态，语气软一点，别急着讲道理' },
  有点烦: { tone: '话短，语气有点不耐烦，但不是翻脸；不主动卖萌' },
  炸毛: { tone: '明显有火气：对主人是撒娇式抗议，对别人直接怼；骂完就收' },
  委屈: { tone: '话少，情绪往里收，嘴硬心软；对方哄一句就缓过来' },
  困了: { tone: '懒懒的，回复更短，偶尔带个哈欠感' },
};

// 规则打分：命中就给对应情绪加分（≥2 分才会真正切换）
const RULES = [
  { re: /(滚|闭嘴|烦死|废物|傻逼|傻|蠢|笨死|讨厌你|别烦|没用|去死|垃圾|恶心)/i, delta: { 有点烦: 2, 炸毛: 1 } },
  { re: /(可爱|喜欢你|爱你|好棒|厉害|乖|贴贴|抱抱|亲亲|想你|真好|牛啊|yyds|靠谱)/i, delta: { 开心: 2, 黏人: 1 } },
  { re: /(哈哈|嘿嘿|笑死|乐了|666|😂|🤣|😄)/, delta: { 开心: 1 } },
  { re: /(累不累|辛苦了|吃饭了吗|吃了吗|早点睡|注意身体|别熬夜|感冒|不舒服|多喝热水|照顾好自己)/, delta: { 关心: 3 } },
  { re: /(难过|不开心|想哭|委屈|emo|崩溃|好累|烦死|压力|失眠)/i, delta: { 关心: 3, 委屈: 1 } },
  { re: /(晚安|睡了|困了|好困|睡觉了)/, delta: { 困了: 2 } },
];

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

function fresh() {
  return { mood: BASE, intensity: 2, why: '', updatedAt: Date.now(), since: Date.now(), turns: 0, lastText: '' };
}

function stateFile() {
  return path.join(__dirname, '..', 'data', 'mood.json');
}

function load() {
  try {
    const raw = fs.readFileSync(stateFile(), 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function save(all) {
  try {
    const keys = Object.keys(all);
    if (keys.length > MAX_KEYS) {
      keys
        .sort((a, b) => Number(all[b].updatedAt || 0) - Number(all[a].updatedAt || 0))
        .slice(MAX_KEYS)
        .forEach((k) => delete all[k]);
    }
    const file = stateFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(all, null, 2), 'utf8');
  } catch {
    /* 情绪存不下来不该影响聊天 */
  }
}

/** 时间衰减：每 25 分钟降一档，直到回到平静 */
function decay(entry, nowMs = Date.now()) {
  const e = { ...fresh(), ...(entry || {}) };
  const gap = nowMs - Number(e.updatedAt || nowMs);
  if (gap < DECAY_MS) return e;
  const steps = Math.min(6, Math.floor(gap / DECAY_MS));
  const down = { 炸毛: '有点烦', 有点烦: BASE, 委屈: BASE, 开心: BASE, 黏人: BASE, 关心: BASE, 困了: BASE };
  let mood = e.mood;
  let intensity = clamp(e.intensity, 1, 5);
  for (let i = 0; i < steps; i += 1) {
    intensity = Math.max(1, intensity - 1);
    if (mood !== BASE && intensity <= 1) {
      mood = down[mood] || BASE;
      intensity = mood === BASE ? 2 : 2;
      if (mood === BASE) break;
    } else if (mood !== BASE && i % 2 === 1) {
      mood = down[mood] || BASE;
      if (mood === BASE) intensity = 2;
    }
  }
  e.mood = mood;
  e.intensity = intensity;
  e.updatedAt = nowMs;
  e.decayed = true;
  return e;
}

/**
 * 每条消息调一次：规则打分 → 更新情绪 → 落盘 → 返回当前状态
 * @param {object} config 运行时配置
 * @param {string} key 会话 key（wechat:u:xxx / wechat:g:xxx / web:u:xxx）
 * @param {string} text 这条消息的文本
 * @param {{isMaster?:boolean, fight?:boolean, chatType?:string}} opts
 */
function bump(config, key, text, opts = {}) {
  const all = load();
  const nowMs = Date.now();
  const e = decay(all[key] || fresh(), nowMs);
  const t = String(text || '').trim();

  e.turns = Number(e.turns || 0) + 1;
  if (t) e.lastText = t.slice(0, 60);

  const delta = {};
  for (const rule of RULES) {
    if (!t || !rule.re.test(t)) continue;
    for (const [mood, score] of Object.entries(rule.delta)) {
      delta[mood] = (delta[mood] || 0) + score;
    }
  }
  // 主人只回一两个字、又没标点：像在敷衍她
  if (opts.isMaster && t && t.length <= 2 && !/[!?？!~～。…]/.test(t)) {
    delta['委屈'] = (delta['委屈'] || 0) + 2;
  }
  // 正在对喷
  if (opts.fight) delta['炸毛'] = (delta['炸毛'] || 0) + 4;

  const ranked = Object.entries(delta)
    .filter(([mood, score]) => MOODS[mood] && score >= 2)
    .sort((a, b) => b[1] - a[1]);

  if (ranked.length) {
    const [mood, score] = ranked[0];
    if (e.mood === mood) {
      e.intensity = clamp(clamp(e.intensity, 1, 5) + 1, 1, 5);
      e.why = e.source === 'llm' ? e.why : `刚才这句有点${mood}`;
    } else {
      e.mood = mood;
      e.intensity = clamp(1 + Math.floor(score / 2) + (opts.fight ? 2 : 0), 1, 5);
      e.since = nowMs;
      e.why = `刚才这句有点${mood}`;
      e.source = 'rule';
    }
  }

  e.updatedAt = nowMs;
  all[key] = e;
  save(all);
  return e;
}

/** 累积够多消息、或者情绪已经很浓 → 值得让模型看一眼 */
function needsRefresh(e) {
  if (!e) return false;
  const turns = Number(e.turns || 0);
  if (turns >= 6) return true;
  return e.mood !== BASE && Number(e.intensity || 0) >= 4 && turns >= 3;
}

/** 让模型按最近聊天归纳情绪（异步，失败不影响回复） */
async function refresh({ config, llm, key, turns = [], logger } = {}) {
  try {
    if (!llm || typeof llm.complete !== 'function') return null;
    const list = (turns || []).filter((m) => m && m.text).slice(-10);
    if (!list.length) return null;
    const transcript = list
      .map((m) => `${m.role === 'assistant' ? '鲸鲸' : (m.name || '对方')}：${String(m.text).replace(/\s+/g, ' ').slice(0, 90)}`)
      .join('\n');
    const system = [
      '你是情绪感知器，只做一件事：读微信聊天记录，判断「鲸鲸」现在最接近的情绪。',
      `情绪只能从这里选一个：${Object.keys(MOODS).join(' / ')}。`,
      '强度 1~5：1=几乎没情绪，3=明显，5=情绪很浓（真生气/很黏/很开心）。',
      '规则：对方在哄她、夸她→开心或黏人；她在被骂/被冷落→有点烦、炸毛或委屈；',
      '对方心情差→关心；对方在开玩笑、接梗→开心；对方说困了/晚安→困了；没明显起伏→平静。',
      '只输出一行 JSON，不要解释、不要代码块：{"mood":"平静","intensity":2,"why":"不超过20字的原因"}',
    ].join('\n');
    const answer = await llm.complete({
      system,
      turns: [{ role: 'user', content: '最近的聊天记录：\n' + transcript }],
      maxTokens: 400,
    });
    const text = String(answer || '');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('没有 JSON');
    const obj = JSON.parse(m[0]);
    const mood = MOODS[obj.mood] ? obj.mood : '';
    if (!mood) throw new Error('情绪名不认识：' + obj.mood);
    const intensity = clamp(obj.intensity || 2, 1, 5);
    const all = load();
    const nowMs = Date.now();
    const e = decay(all[key] || fresh(), nowMs);
    e.mood = mood;
    e.intensity = intensity;
    e.why = String(obj.why || '').slice(0, 40);
    e.updatedAt = nowMs;
    e.source = 'llm';
    e.turns = 0;
    if (mood === BASE) e.since = nowMs;
    all[key] = e;
    save(all);
    if (logger) logger.info(`[mood] 模型归纳：${mood}（${intensity}/5）${e.why ? ' — ' + e.why : ''}`);
    return e;
  } catch (err) {
    if (logger) logger.warn('[mood] 情绪归纳失败，保持规则结果：' + ((err && err.message) || err));
    return null;
  }
}

/** 生成要拼进系统提示词的一段话（平静时返回空串） */
function line(entry, opts = {}) {
  const e = decay(entry || fresh());
  if (!e || e.mood === BASE || !MOODS[e.mood]) return '';
  const info = MOODS[e.mood];
  const level = clamp(e.intensity, 1, 5);
  const tail = level >= 4
    ? '情绪比较浓，但要守分寸：不真翻脸、不带脏字、不迁怒无关的人。'
    : '别把情绪演过头，一两句就能带出来。';
  return '【此刻情绪（不要口头汇报心情、不要说「我现在心情…」，只在语气和话量里体现）】' +
    `你现在是「${e.mood}」（强度 ${level}/5）。${info.tone}。${tail}` +
    (e.why ? `\n（缘由，仅供你自己参考，别说出来：${e.why}）` : '');
}

/** 查一个会话的情绪状态 */
function describe(config, key) {
  const all = load();
  const e = decay(all[key] || fresh());
  return {
    key,
    mood: e.mood,
    intensity: clamp(e.intensity, 1, 5),
    why: e.why || '',
    source: e.source || 'default',
    updatedAt: e.updatedAt,
    minutesAgo: Math.max(0, Math.round((Date.now() - Number(e.updatedAt || Date.now())) / 60000)),
    lastText: e.lastText || '',
  };
}

/** 列出最近有情绪的会话（管理用） */
function list(config, limit = 20) {
  const all = load();
  return Object.keys(all)
    .map((key) => describe(config, key))
    .filter((x) => x.mood !== BASE || x.intensity >= 3)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, limit);
}

/** 只读取一组情绪（含时间衰减），不写盘；给调试台预览用 */
function peek(config, key) {
  const all = load();
  const entry = all[key];
  if (!entry) return null;
  return decay(entry, Date.now());
}

/** 手动重置某个会话的情绪 */
function reset(config, key) {
  const all = load();
  if (key) {
    all[key] = fresh();
    save(all);
    return describe(config, key);
  }
  save({});
  return { mood: BASE, intensity: 2 };
}

module.exports = {
  BASE,
  MOODS,
  bump,
  decay,
  needsRefresh,
  refresh,
  line,
  peek,
  describe,
  list,
  reset,
  stateFile,
};
