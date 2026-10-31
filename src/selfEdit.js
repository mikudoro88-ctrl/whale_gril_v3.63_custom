'use strict';

/**
 * 让她自己改人格。
 *
 * 主人发一句「改人设：说话再毒一点，别老卖萌」→ 这里把当前人格 + 这句话交给模型，
 * 模型只负责「改写」，返回一份 JSON 补丁；字段白名单、长度上限、落盘、历史归档
 * 全部由本文件把关，模型无权写文件、也改不了管理员/安全相关配置。
 *
 * 生效位置：data/persona.json（和调教台、微信指令共用同一份存档），改完立即生效，
 * 重启也保留。每次修改前后各存一份到 data/persona-history/，可用「撤销人格」回滚。
 *
 * 注意 customPrompt：一旦 data/persona.json 里有整套人格提示词，persona.js 会
 * 走 custom 分支——personality/text/appearance 全部不再生效。所以这里检测到
 * customPrompt 非空时，只允许模型输出新的 customPrompt（否则改了也没用）。
 */
const fs = require('node:fs');
const path = require('node:path');
const personaStore = require('./personaStore');

// 只允许模型改这些字段：都是人格/说话方式，不涉及 Key、主人名单、网关、管理员魔咒
const FIELDS = {
  name: { max: 40, label: '名字' },
  age: { max: 3, label: '年龄', number: true },
  job: { max: 80, label: '职业/身份' },
  appearance: { max: 400, label: '外形' },
  personality: { max: 500, label: '性格' },
  background: { max: 500, label: '背景' },
  text: { max: 300, label: '说话方式补充' },
  customPrompt: { max: 6000, label: '整套人格提示词' },
};

const SYSTEM = `你在帮一个叫「鲸鲸」的微信聊天机器人改写她自己的拟人人格设定。
主人会提一句要求，你要把要求翻译成对她人格设定的具体修改。

只输出一个 JSON 对象，不要解释、不要 Markdown 代码块。键只能是下面这些（不用的键直接不写）：
- name       字符串，她的名字（一般别改）
- age        整数，1~120
- job        字符串，职业/身份，≤80 字
- appearance 字符串，外形，≤400 字
- personality 字符串，性格，≤500 字
- background 字符串，背景来历，≤500 字
- text       字符串，给模型的补充要求（说话方式、口癖、称呼），≤300 字
- customPrompt 字符串，整套人格提示词，≤6000 字

改写原则：
1. 保持「鲸鲸」这个身份：一只拟人化的鲸鱼娘，说话自然、口语化、像真人聊天。除非主人明确要换人设。
2. 只改主人要求相关的部分，其他方面尽量保持原样，不要顺手扩写一堆。
3. personality / text 用第二人称「你」或直接描述都行，但必须是能直接塞进系统提示词的陈述句，不要写「主人说……」。
4. 内容必须健康：不写性、不写违法犯罪、不写伤害他人的具体做法；主人要求明显越界时，返回 {"error":"越界原因"}。
5. 不要编造主人不知道的信息（真实姓名、住址、账号等），人物设定可以虚构但要通用。

示例：「说话再毒一点，别老卖萌」→ {"text":"回复别卖萌，不撒娇；被夸也别客气，可以损回去。语气短、直、带刺，但不骂脏字。"}`;

const CUSTOM_RULE = `【重要：当前启用的是「整套人格提示词」】
她现在的人格完全由下面这份 customPrompt 决定，personality / text / appearance 这些字段已经不生效了。
所以这次必须输出新的完整 customPrompt：保留原提示词里的身份、说话风格、四条底线和群聊规则，只按主人的要求改相关段落。
只输出 {"customPrompt": "改完的完整提示词"}，不要输出别的键。`;

function dirFor(config) {
  try {
    return path.join(config.paths.dataDir, 'persona-history');
  } catch {
    return '';
  }
}

/** 从模型输出里抠 JSON（容忍 ```json 包裹、前后废话） */
function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf('{');
  if (start < 0) return null;
  // 从第一个 { 开始做括号配对，字符串里的括号不算
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function currentPersona(config) {
  const P = (config && config.persona) || {};
  return {
    name: P.name || '',
    age: P.age || '',
    job: P.job || '',
    appearance: P.appearance || '',
    personality: P.personality || '',
    background: P.background || '',
    text: P.styleText || '',
    customPrompt: P.customPrompt || '',
  };
}

function buildRequest(config, instruction) {
  const cur = currentPersona(config);
  const customActive = Boolean(cur.customPrompt);
  const view = Object.entries(cur)
    .filter(([, v]) => v !== '' && v !== undefined)
    // customPrompt 最要紧，给足长度；其它字段截断就行
    .map(([k, v]) => `${k}: ${String(v).slice(0, k === 'customPrompt' ? 6000 : 1200)}`)
    .join('\n');
  const user = `【当前人格】\n${view}\n\n【主人的要求】\n${instruction}\n\n只输出 JSON。`;
  return { system: customActive ? SYSTEM + '\n\n' + CUSTOM_RULE : SYSTEM, turns: [{ role: 'user', content: user }], customActive };
}

/** 白名单 + 长度 + 数值校验；返回 { patch, changed } */
function validate(config, obj) {
  const cur = currentPersona(config);
  const patch = {};
  const changed = [];
  for (const [key, meta] of Object.entries(FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    let v = obj[key];
    if (meta.number) {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n)) continue;
      const fixed = Math.max(1, Math.min(120, n));
      if (String(fixed) === String(cur.age)) continue;
      patch.age = fixed;
      changed.push(key);
      continue;
    }
    v = String(v == null ? '' : v).trim();
    if (!v) continue;
    v = v.slice(0, meta.max);
    if (v === String(cur[key] || '')) continue;
    patch[key] = v;
    changed.push(key);
  }
  return { patch, changed, cur };
}

function summarize(patch, changed) {
  const names = changed.map((k) => FIELDS[k].label).join('、');
  // 展示一句改后的核心内容，让她回话时别只说「改好了」
  const hintKey = ['customPrompt', 'personality', 'text', 'appearance', 'job', 'background'].find((k) => patch[k]);
  let quote = '';
  if (hintKey) {
    const v = String(patch[hintKey]);
    quote = v.length > 48 ? v.slice(0, 48) + '…' : v;
  }
  return { names, hintKey, quote };
}

function archive(config, payload) {
  const dir = dirFor(config);
  if (!dir) return '';
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let file = path.join(dir, `edit-${stamp}.json`);
    let i = 1;
    while (fs.existsSync(file)) {
      file = path.join(dir, `edit-${stamp}-${i}.json`);
      i += 1;
    }
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
    // 只留最近 20 份，避免无限长
    const all = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    for (const f of all.slice(0, Math.max(0, all.length - 20))) {
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
    }
    return file;
  } catch {
    return '';
  }
}

/** 真正执行一次「让她自己改」：调模型 → 校验 → 落盘 → 返回回话文本 */
async function run({ config, llm, logger }, instruction) {
  const text = String(instruction || '').trim();
  if (!text) return { ok: false, changed: [], message: '想让我怎么改？说「改人设：说话毒一点」这种。' };
  if (llm.isMock) {
    return { ok: false, changed: [], message: '现在是演示模式（没接模型），改不了。先接上模型再说。' };
  }
  const first = buildRequest(config, text);
  let raw = '';
  try {
    raw = await llm.complete({ system: first.system, turns: first.turns });
  } catch (err) {
    logger && logger.warn('自我修改人格：模型调用失败 ' + (err && err.message));
    return { ok: false, changed: [], message: '我自己脑子里刚打结了，没改成。等会儿再让我试试。' };
  }
  let obj = extractJson(raw);
  // 启用整套提示词时，模型常常只回 personality —— 那样改了不生效，追问一次
  if (first.customActive && obj && !obj.error && !obj.customPrompt) {
    logger && logger.warn('自我修改人格：自定义提示词生效中但模型没给 customPrompt，追问一次');
    try {
      raw = await llm.complete({
        system: first.system,
        turns: [
          ...first.turns,
          { role: 'assistant', content: String(raw).slice(0, 2000) },
          { role: 'user', content: '不对，你现在用的是整套人格提示词，只改 personality 不会生效。重新输出：{"customPrompt": "改完之后的完整提示词"}，必须包含 customPrompt。' },
        ],
      });
      obj = extractJson(raw);
    } catch { /* 追问失败就用第一次的 */ }
  }
  if (!obj) {
    logger && logger.warn('自我修改人格：模型没输出 JSON：' + String(raw).slice(0, 120));
    return { ok: false, changed: [], message: '我试着改了但没写明白，这次算了吧。' };
  }
  if (obj.error) {
    return { ok: false, changed: [], message: '这个我不太合适改：' + String(obj.error).slice(0, 60) };
  }
  const { patch, changed } = validate(config, obj);
  if (first.customActive && !changed.includes('customPrompt')) {
    return { ok: false, changed: [], message: '我现在的人格是整段提示词在管的，刚才没改到那份提示词，所以等于没改。再说一次？' };
  }
  if (!changed.length) {
    return { ok: false, changed: [], message: '看了一圈，好像没什么可改的。' };
  }
  const { names, quote } = summarize(patch, changed);
  const before = personaStore.summary(config);
  personaStore.save(config, patch);
  const after = personaStore.summary(config);
  const file = archive(config, { at: new Date().toISOString(), instruction: text, patch, changed, before, after });
  logger && logger.info(`自我修改人格：${changed.join(',')}（${file ? path.basename(file) : '未归档'}）`);
  const tail = quote ? `现在——「${quote}」` : '';
  return {
    ok: true,
    changed,
    message: `改好了：${names}。${tail}${changed.includes('customPrompt') ? '（整套人格提示词被替换了，想回退就说「撤销人格」）' : ''}`,
  };
}

/** 撤销上一次自我修改（把修改前的整份存档写回去） */
function undo(config, logger) {
  const dir = dirFor(config);
  if (!dir) return { ok: false, message: '没有可撤销的记录。' };
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return { ok: false, message: '没有可撤销的记录。' };
  }
  if (!files.length) return { ok: false, message: '没有可撤销的记录。' };
  for (let i = files.length - 1; i >= 0; i -= 1) {
    const file = path.join(dir, files[i]);
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      if (!data || !data.before) continue;
      personaStore.save(config, data.before);
      fs.unlinkSync(file);
      logger && logger.info('自我修改人格：已撤销 ' + files[i]);
      return { ok: true, message: '好，退回到上一次改动之前了。' };
    } catch {
      continue;
    }
  }
  return { ok: false, message: '记录读不出来，没撤销成功。' };
}

/** 现在的人格长什么样（给「查看人设」用） */
function describe(config) {
  const cur = currentPersona(config);
  const lines = [];
  if (cur.name) lines.push(`名字：${cur.name}`);
  if (cur.age) lines.push(`年龄：${cur.age}`);
  if (cur.job) lines.push(`身份：${cur.job}`);
  if (cur.personality) lines.push(`性格：${cur.personality.slice(0, 80)}`);
  if (cur.text) lines.push(`说话方式：${cur.text.slice(0, 60)}`);
  if (cur.customPrompt) lines.push(`自定义提示词：已启用（${cur.customPrompt.length} 字，优先于上面的设定）`);
  return lines.join('\n') || '现在就是出厂设定，没有额外改动。';
}

module.exports = { run, undo, describe, extractJson, validate, buildRequest, FIELDS, SYSTEM, CUSTOM_RULE };
