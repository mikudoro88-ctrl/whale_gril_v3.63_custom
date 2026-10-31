'use strict';

/**
 * 看图之后的「联网补充」：
 * 视觉模型只描述画面，但图里常有游戏、动漫角色、影视、梗、商品、软件、地点…
 * 这些不查一下根本看不懂。所以识别完先让聊天模型判断「有没有值得搜的」，
 * 有就提炼一个短查询词联网搜，再把结果补给聊天模型。
 */
const websearch = require('./websearch');

// 「这是一张…/图中是…」这类开场白
const LEAD_RE = /^(?:这|那)?(?:是|像)?(?:一)?(?:张|幅|个|段|份|部|位|只|条)?(?:图片|图像|照片|截图|画面|图|画)?(?:里|中|上|的)?(?:是|为|显示|呈现|有)?[：:，,、\s]*/i;
const STOP_TAIL = /[。！？!?；;\n]/;

const PROMPT = [
  '你是一个「看图搜索词提取器」。用户给你一段对图片的描述，你判断图里有没有必须联网查一下才能看懂的东西。',
  '',
  '只有图里出现了明确的【作品 / 角色 / 商品品牌 / 软件应用 / 地点 / 人物 / 赛事 / 游戏 / 梗的出处 / 专有名词】时，才输出查询词。',
  '纯风景、抽象图案、纯色或渐变壁纸、普通聊天截图、随手拍的食物或宠物、没有具体名字的画面 —— 一律只输出 NONE。',
  '',
  '输出规则：',
  '1. 只输出查询词本身，不要引号、不要解释、不要换行。',
  '2. 查询词不超过 12 个字，只写名字，用空格分隔 1~2 个专有名词，例如：原神 雷电将军 / 黑神话 悟空 / 崩坏星穹铁道。',
  '3. 不要写动作、颜色、场景、形容词（不要出现「主角战斗」「蓝色」「巨大」这类描述）。',
].join('\n');

// 以图搜图：trace.moe 覆盖动画截图（微信里纯图片最常见的就是番剧/表情包截图），
// 这类图靠文字描述根本认不出来，只能拿图本身去搜。
const TRACE_MOE = 'https://api.trace.moe/search?cutBorders&anilistInfo';

function withTimeout(ms) {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), ms);
  return { signal: ctl.signal, done: () => clearTimeout(timer) };
}

async function traceMoe(cfg, imageBase64, mime, minSimOverride) {
  const raw = String(imageBase64 || '').replace(/^data:[^,]+,/, '');
  if (!raw || raw.length < 64) return null;
  const minSim = Number(minSimOverride) || Number(cfg.traceMinSimilarity) || 0.7;
  const box = withTimeout(Math.max(2000, Math.min(12000, Number(cfg.traceTimeoutMs) || 8000)));
  try {
    const buf = Buffer.from(raw, 'base64');
    const fd = new FormData();
    fd.append('image', new Blob([buf], { type: /^image\//.test(String(mime)) ? mime : 'image/jpeg' }), 'image.jpg');
    const res = await fetch(TRACE_MOE, { method: 'POST', body: fd, signal: box.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const top = (data && data.result && data.result[0]) || null;
    if (!top || Number(top.similarity) < minSim) return null;
    const title = (top.anilist && top.anilist.title) || {};
    const name = title.native || title.romaji || title.english || '';
    if (!name) return null;
    return { title: String(name), episode: top.episode || null, similarity: Number(top.similarity) };
  } catch (_) {
    return null;
  } finally {
    box.done();
  }
}

const FEATURE_PROMPT = [
  '你是一个「画面特征关键词提取器」。用户给你一段图片描述，图里没有明确的专有名词（作品/品牌/人物）。',
  '请输出 2~4 个最能描述画面主体的关键词，用来搜索相似内容或了解图里的东西。',
  '只输出关键词，空格分隔，不超过 12 个字，不要标点，不要写「图片/照片/一张」这类废词，不要堆形容词。',
  '示例：银发少女 铃铛 动漫插画 / 蓝色抽象 曲面 立体图案 / 猫咪 纸箱 睡觉',
].join('\n');

async function featureQuery(llm, description) {
  try {
    const raw = await safeComplete(llm, {
      system: FEATURE_PROMPT,
      turns: [{ role: 'user', content: String(description || '').slice(0, 1200) }],
      maxTokens: 2048,
    });
    const q = tidyQuery(String(raw || '').trim());
    if (!q || /^none$/i.test(q)) return '';
    return q;
  } catch (_) {
    return '';
  }
}

function clean(text) {
  return String(text || '').replace(/\r/g, '\n').replace(/[ \t]+/g, ' ').trim();
}

function clamp(s, n) {
  const t = String(s || '').trim();
  return t.length > n ? t.slice(0, n) : t;
}

function tidyQuery(s) {
  let q = String(s || '')
    .replace(/[「」『』“”"'《》【】\r\n]/g, ' ')
    .replace(/[，,、：:。！？!?；;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  q = q.replace(/^(?:搜索词|查询词|关键词)[:：\s]*/i, '').trim();
  // 模型偶尔会写出「原神 雷电将军 主角」这类尾巴，去掉纯描述性尾巴词
  const TAIL_NOISE = /(主角|战斗|画面|场景|背景|颜色|巨大|特写|全身|半身|立绘|截图|壁纸|照片|图片)$/;
  let parts = q.split(' ').filter(Boolean);
  while (parts.length > 1 && TAIL_NOISE.test(parts[parts.length - 1])) parts.pop();
  q = parts.join(' ');
  return clamp(q, 16);
}

/** 规则兜底：从描述里抠查询词 */
function buildQuery(description) {
  const raw = clean(description);
  if (!raw) return '';
  const quoted = raw.match(/[「『“"《【]([^」』”"》】]{2,24})[」』”"》】]/);
  if (quoted && quoted[1].trim()) return tidyQuery(quoted[1]);
  let q = raw.replace(LEAD_RE, '').trim();
  const first = q.split(STOP_TAIL)[0] || q;
  q = first.replace(/^[，,、：:\s]+/, '').trim();
  if (!q) q = raw.replace(LEAD_RE, '').trim();
  return tidyQuery(q);
}

/** 规则兜底时，只有带「专有名词信号」才敢搜，免得搜出一堆废话 */
function looksSearchable(q) {
  const s = String(q || '');
  if (!s) return false;
  if (/[A-Za-z]{2,}/.test(s)) return true;
  if (/《|「|『|【/.test(s)) return true;
  return /(游戏|动漫|动画|角色|人物|电影|电视剧|综艺|明星|偶像|品牌|产品|型号|版本|战队|选手|主播|软件|应用|网站|地名|景点|赛事|联赛|漫画|小说)/.test(s);
}

/** 中文字符二元组，用来快速判断搜索结果跟查询词有没有关系 */
function bigrams(s) {
  const out = new Set();
  const t = String(s || '').replace(/[\s\p{P}]/gu, '');
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  for (const w of String(s || '').split(/\s+/)) {
    if (/^[A-Za-z0-9]{2,}$/.test(w)) out.add(w.toLowerCase());
  }
  return out;
}

function relevant(query, item) {
  const q = bigrams(query);
  if (!q.size) return true;
  const hay = String((item && item.title) || '') + ' ' + String((item && item.snippet) || '');
  const h = hay.toLowerCase();
  for (const g of q) {
    if (h.includes(g)) return true;
  }
  return false;
}

/**
 * @returns {Promise<{query:string,hits:number,text:string,source:string}|null>}
 */
async function enrich(config, description, opts = {}) {
  const desc = clean(description);
  const cfg = (config && config.vision && config.vision.webSearch) || {};
  if (cfg.enabled === false) return null;
  if (!desc || desc.length < 4) return null;
  const limit = Math.max(1, Math.min(5, Number(cfg.limit) || 3));
  const timeoutMs = Math.max(1000, Math.min(15000, Number(cfg.timeoutMs) || 6000));
  const llm = opts.llm;

  let query = '';
  let source = 'rule';
  let modelSkip = false;
  // 1) 先用聊天模型判断「值不值得搜」并提炼查询词（最懂梗和专有名词）
  if (cfg.useModel !== false && llm && !llm.isMock && typeof llm.complete === 'function') {
    try {
      const raw = await safeComplete(llm, {
        system: PROMPT,
        turns: [{ role: 'user', content: clamp(desc, 1500) }],
        // deepseek-flash 会先花几十个 token 推理，给 40 会被截断成空正文，给足额度
        maxTokens: 2048,
      });
      const reply = String(raw || '').trim();
      if (/^none\b/i.test(reply) || reply === '') {
        modelSkip = true;
      } else {
        const q = tidyQuery(reply);
        if (q.length >= 2) {
          query = q;
          source = 'model';
        }
      }
    } catch {
      /* 模型提炼失败就走规则 */
    }
  }
  // 2) 图里认不出名字时：先用图本身去搜（trace.moe 认番剧截图），再用画面特征关键词搜
  let reverse = null;
  if (!query && modelSkip && opts.imageBase64 && cfg.reverseSearch !== false) {
    reverse = await traceMoe(cfg, opts.imageBase64, opts.mime);
    if (reverse) {
      query = tidyQuery(reverse.title + (reverse.episode ? ' 第' + reverse.episode + '集' : ''));
      source = 'reverse';
    }
  }
  if (!query && modelSkip && cfg.descSearch !== false && llm && !llm.isMock && typeof llm.complete === 'function') {
    const fq = await featureQuery(llm, desc);
    if (fq) {
      query = fq;
      source = 'desc';
    }
  }
  // 3) 实在没法子才走规则兜底（保守：只搜看起来像专有名词的）
  if (!query) {
    const guess = buildQuery(desc);
    if (!guess || guess.length < 2 || !looksSearchable(desc)) {
      return null;
    }
    query = guess;
    source = 'rule';
  }

  // 3) 先按完整查询词搜，搜不到相关的就退到第一个专有名词再搜一次
  const attempts = [query];
  const firstToken = query.split(' ')[0];
  if (firstToken && firstToken !== query && firstToken.length >= 2) attempts.push(firstToken);
  const tokens = query.split(' ').filter((t) => t.length >= 2);
  if (tokens.length > 2) attempts.push(tokens.slice(0, 2).join(' '));
  const uniq = [...new Set(attempts)];

  let kept = [];
  let usedQuery = query;
  for (const q of uniq) {
    let list = [];
    try {
      list = await websearch.search(q, { limit, timeoutMs });
    } catch {
      list = [];
    }
    if (!Array.isArray(list) || !list.length) continue;
    // 只留跟查询词有交集的，避免「黑神话」被搜成汉字「黑」这种噪音
    const rows = list.filter((r) => (source === 'desc' ? relevantStrict(q, r, 2) : relevant(q, r)));
    if (rows.length) {
      kept = rows;
      usedQuery = q;
      break;
    }
  }
  const reverseLine = reverse
    ? '【以图搜图：疑似动画《' + reverse.title + '》' + (reverse.episode ? '第' + reverse.episode + '集' : '') + '，相似度 ' + (reverse.similarity * 100).toFixed(0) + '%】'
    : '';
  if (!kept.length) {
    if (!reverseLine) return { query: usedQuery, hits: 0, text: '', source };
    return {
      query: usedQuery,
      hits: 0,
      text: ['', reverseLine, '（按图搜到的出处，仅供参考；不要原文念出来）'].join('\n'),
      source,
    };
  }
  const lines = kept.slice(0, limit).map((r, i) => {
    const title = String((r && r.title) || '（无标题）').trim();
    const snip = String((r && r.snippet) || '').replace(/\s+/g, ' ').trim();
    return snip ? `${i + 1}. ${title} — ${snip}` : `${i + 1}. ${title}`;
  });
  const head = source === 'reverse'
    ? '【联网补充（以图搜图「' + usedQuery + '」+ 网页）】'
    : source === 'desc'
      ? '【按画面特征搜的「' + usedQuery + '」（仅供参考，可能不准）】'
      : '【联网补充（收图时顺手搜了「' + usedQuery + '」）】';
  const text = ['', reverseLine, head, ...lines,
    '（这些是搜索结果，帮你理解图里的东西；不要原文念出来，也别把它们当成对方说的话）'
  ].filter((x, i) => !(x === '' && i === 0)).join('\n');
  return { query: usedQuery, hits: kept.length, text, source };
}

function relevantStrict(query, item, minHits = 2) {
  const q = bigrams(query);
  if (!q.size) return false;
  const hay = (String((item && item.title) || '') + ' ' + String((item && item.snippet) || '')).toLowerCase();
  let hits = 0;
  for (const g of q) {
    if (hay.includes(g)) hits += 1;
    if (hits >= minHits) return true;
  }
  return false;
}

// ─────────────────────────── 识图核对 ───────────────────────────
// 目标：宁可说「不确定」，也不要自信地报错作品名。
// 流程：① 以图搜图（动画截图最可靠）→ ② 让模型给候选 → ③ 逐个用搜索核对
// 候选名字 + 画面特征词 是否同时出现在结果里 → ④ 只有核对通过才下结论。

const IDENT_PROMPT = [
  '你在做「看图认人」。给你一段对图片的描述，你要根据画面特征判断这最可能是哪个动漫/游戏/作品里的哪个角色。',
  '规则：',
  '1. 只输出 JSON，不要解释、不要 markdown 代码块。格式：{"candidates":[{"name":"作品名 角色名","why":"依据"}]}',
  '2. 最多 3 个候选，按可能性从高到低。',
  '3. 必须真的像才给；只是「气质像」「同类型」一律不要。拿不准就输出 {"candidates":[]}。',
  '4. 不要把风格相似的作品硬凑进来，也不要只写角色名不写作品。',
].join('\n');

const QUERY_PROMPT = [
  '你在帮人查「这张图里的角色/作品到底是什么」。给你一段画面描述和已经提取的特征词，请给出 1~2 条适合丢进搜索引擎的查询。',
  '要求：',
  '1. 一条中文、一条日文（日本动画的识别资料日文最全），每行一条，只输出查询本身，不要编号不要解释。',
  '2. 查询里要包含最独特的特征组合（发色+发型+耳朵/服装/道具），例如：緑髪 猫耳 タバコ 女子高生 アニメ',
  '3. 不要写「这是什么动漫」这类废话查询。',
].join('\n');

const EXTRACT_PROMPT = [
  '下面是一组搜索结果（标题 — 摘要）。请判断这些结果里出现了哪些可能的「作品名 角色名」组合。',
  '规则：',
  '1. 只输出 JSON：{"candidates":[{"name":"作品名 角色名"}]}，最多 4 个；没有就输出 {"candidates":[]}',
  '2. 只抽搜索结果里真的出现过的名字，不要自己编。',
  '3. 名字要和给出的画面特征对得上；明显不相干的不要放。',
].join('\n');

// 画面特征词库：用来核对「候选名字」和「这张图」是不是同一个东西
const FEATURE_RE = /(绿|青|蓝|银|白|黑|紫|粉|金|红|橙|棕)色?(?:的)?(?:头发|发|短发|长发|刘海)|(?:短|长|凌乱|蓬松|微卷|直)发|猫耳|猫耳朵|兽耳|兔耳|狐狸耳|狼耳|尾巴|校服|制服|水手服|白衬衫|衬衫|领带|格子裙|百褶裙|裙子|外套|毛衣|和服|浴衣|眼镜|眼罩|绷带|面具|帽子|发箍|头饰|角|符文|法杖|镰刀|长剑|刀|枪|弓|烟|香烟|叼烟|手办|手|耳环|项链|项链/g;

function featureWords(description) {
  const found = String(description || '').match(FEATURE_RE) || [];
  const out = [];
  for (const w of found) {
    const t = String(w).trim();
    if (t.length >= 2 && out.indexOf(t) < 0) out.push(t);
    if (out.length >= 4) break;
  }
  return out;
}

function nameKey(s) {
  return String(s || '').toLowerCase().replace(/[\s\p{P}]/gu, '');
}

/** 搜索结果里同时提到候选名 + 至少一个画面特征 → 算一条核对证据 */
/** 只看「名字」是否出现在结果里（不要求同时出现特征词） */
function nameOnly(candidate, item) {
  const hay = nameKey(String((item && item.title) || '') + ' ' + String((item && item.snippet) || ''));
  if (!hay) return false;
  const nameTokens = String(candidate || '')
    .split(/\s+/)
    .map((t) => nameKey(t))
    .filter((t) => t.length >= 2);
  return nameTokens.some((t) => hay.indexOf(t) >= 0);
}

function corroborates(candidate, features, item) {
  const hay = nameKey(String((item && item.title) || '') + ' ' + String((item && item.snippet) || ''));
  if (!hay) return false;
  const nameTokens = String(candidate || '')
    .split(/\s+/)
    .map((t) => nameKey(t))
    .filter((t) => t.length >= 2);
  const hasName = nameTokens.some((t) => hay.indexOf(t) >= 0);
  if (!hasName) return false;
  if (!features.length) return true;
  return features.some((f) => hay.indexOf(nameKey(f)) >= 0);
}

async function searchSafe(q, limit, timeoutMs, browser = false) {
  try {
    return await websearch.search(q, { limit, timeoutMs, browser });
  } catch (_) {
    return [];
  }
}

/**
 * 识图核对：返回给聊天模型的证据块（纯文本），失败返回 null。
 * @returns {Promise<{text:string,query:string,hits:number,source:string,confidence:string}|null>}
 */
// ---------------------------------------------------------------------------
// AniList 结构化核对（免费、无 key、GraphQL）
// 网页搜索噪声大的时候，用它确认「这个作品名真的存在」。
// ---------------------------------------------------------------------------
const ANILIST = 'https://graphql.anilist.co';

function anilistNorm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\-_·:：!！?？'"“”‘’()（）\[\]【】,.，。、]/g, '');
}

async function anilistMedia(name, timeoutMs) {
  const q = String(name || '').trim();
  if (q.length < 2) return null;
  const box = withTimeout(Math.max(2000, Math.min(12000, Number(timeoutMs) || 8000)));
  const body = JSON.stringify({
    query: 'query($s:String){Page(perPage:5){media(search:$s){id title{romaji native english}type}}}',
    variables: { s: q },
  });
  try {
    const res = await fetch(ANILIST, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body,
      signal: box.signal,
    });
    const json = await res.json();
    box.done();
    const list = (json && json.data && json.data.Page && json.data.Page.media) || [];
    const target = anilistNorm(q);
    for (const m of list) {
      const titles = [m.title && m.title.romaji, m.title && m.title.native, m.title && m.title.english]
        .filter(Boolean)
        .map(anilistNorm);
      // 「作品名 角色名」这种候选，只要作品名部分能对上就算命中
      const hit = titles.some((t) => t && (t.includes(target) || target.includes(t) && t.length >= 2));
      if (hit) {
        return {
          id: m.id,
          romaji: (m.title && m.title.romaji) || '',
          native: (m.title && m.title.native) || '',
          type: m.type || '',
        };
      }
    }
    return null;
  } catch (_) {
    box.done();
    return null;
  }
}

/**
 * 调聊天模型的安全封装：deepseek-flash 是推理模型，预算小时会把 token 全花在
 * 思考链上、正文为空（LlmError 空泡泡）。这里保证预算 ≥2048，空了翻倍重试一次。
 */
// ---------------------------------------------------------------------------
// SauceNAO 以图搜图（网页端点，不用 API key、按 IP 限流，所以只在真要认图时调一次）
// 覆盖漫画/插画/同人图这些 trace.moe（只认动画帧）认不出来的图。
// ---------------------------------------------------------------------------
const SAUCENAO = 'https://saucenao.com/search.php';

function cleanReverseTitle(t) {
  return String(t || '')
    .replace(/_/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function sauceNao(imageBase64, mime, timeoutMs) {
  const raw = String(imageBase64 || '').replace(/^data:[^,]+,/, '');
  if (!raw || raw.length < 64) return [];
  const box = withTimeout(Math.max(6000, Math.min(20000, Number(timeoutMs) || 12000)));
  try {
    const buf = Buffer.from(raw, 'base64');
    const fd = new FormData();
    fd.append('db', '999');
    fd.append('output_type', '0');
    fd.append('numres', '8');
    fd.append('file', new Blob([buf], { type: String(mime || 'image/jpeg') }), 'image.jpg');
    const res = await fetch(SAUCENAO, {
      method: 'POST',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
      },
      body: fd,
      signal: box.signal,
    });
    const html = await res.text();
    box.done();
    if (/Daily Search Limit|rate limit|Too many/i.test(html)) return [];
    const out = [];
    const chunks = String(html).split(/<div class="result[ "]/).slice(1);
    for (const chunk of chunks) {
      const simM = chunk.match(/resultsimilarityinfo[^>]*>([\d.]+)%/i);
      const titleM = chunk.match(/class="resulttitle"[^>]*>([\s\S]{0,300}?)<\/div>/i);
      const idxM = chunk.match(/title="Index #\d+: ([^"]{0,120})"/i);
      if (!simM || !titleM) continue;
      const similarity = Number(simM[1]) || 0;
      const title = cleanReverseTitle(stripHtml(titleM[1]));
      if (!title) continue;
      out.push({ title, similarity, index: idxM ? idxM[1] : '' });
      if (out.length >= 5) break;
    }
    return out;
  } catch (_) {
    box.done();
    return [];
  }
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

async function safeComplete(llm, opts) {
  if (!llm || typeof llm.complete !== 'function') return '';
  // 这些调用是「机械转 JSON」：给候选、提炼查询词、从搜索结果抽名字。
  // 开思考实测要 21~31 秒/次，而且预算被思考链吃光后 JSON 会被截断甚至返回空 → 关掉思考。
  const opts0 = Object.assign({ noThink: true }, opts || {});
  const budget = Math.max(2048, Number(opts0.maxTokens) || 0);
  try {
    const out = await llm.complete(Object.assign({}, opts0, { maxTokens: budget }));
    if (String(out || '').trim()) return String(out);
  } catch (_) { /* 空正文/超长：下面翻倍重试 */ }
  try {
    const out2 = await llm.complete(Object.assign({}, opts0, { maxTokens: Math.min(4096, budget * 2) }));
    return String(out2 || '');
  } catch (_) {
    return '';
  }
}

async function identify(config, description, opts = {}) {
  // 浏览器兜底很贵（每次 2~5 秒），一次识图最多用 1 次
  let browserBudget = 1;
  const searchMaybe = async (q, limit, timeoutMs) => {
    const useBrowser = browserBudget > 0;
    if (useBrowser) browserBudget -= 1;
    return searchSafe(q, limit, timeoutMs, useBrowser);
  };
  const cfg = (config && config.vision && config.vision.webSearch) || {};
  if (cfg.enabled === false || cfg.identify === false) return null;
  const desc = clean(description);
  if (desc.length < 4) return null;
  const llm = opts.llm;
  const limit = Math.max(1, Math.min(5, Number(cfg.limit) || 3));
  const timeoutMs = Math.max(1000, Math.min(15000, Number(cfg.timeoutMs) || 6000));
  const features = featureWords(desc);

  // ① 以图搜图：trace.moe（动画帧）+ SauceNAO（插画/漫画）并行。
  //    结果只是「候选种子」，不当定论——单一图搜结果经常张冠李戴
  //    （实测把绿发猫耳同人图认成《沉默魔女》第3集，相似度只有 0.789）。
  let traceSeed = null;
  let sauceSeed = null;
  if (opts.imageBase64 && cfg.reverseSearch !== false) {
    // 图搜种子门槛比「下结论」低：0.75 就收进候选池，但结论必须过网页/AniList 交叉核对，
    // 核不上就只说「疑似」，不再像以前那样 0.78 的相似度也报「可信」。
    const minSim = Math.min(Number(cfg.traceMinSimilarity) || 0.9, 0.75);
    const [tm, sauceList] = await Promise.all([
      traceMoe(cfg, opts.imageBase64, opts.mime, minSim).catch(() => null),
      sauceNao(opts.imageBase64, opts.mime, cfg.sauceTimeoutMs).catch(() => []),
    ]);
    if (tm && tm.title) {
      traceSeed = { name: String(tm.title), origin: 'trace', sim: Number(tm.similarity) || 0, episode: tm.episode || '' };
    }
    const top = (sauceList || []).find((s) => s && s.similarity >= 70);
    if (top && top.title) {
      sauceSeed = { name: String(top.title), origin: 'sauce', sim: Number(top.similarity) || 0, index: top.index || '' };
    }
  }
  const seeds = [traceSeed, sauceSeed].filter(Boolean);
  const nameMatch = (a, b) => {
    const x = anilistNorm(a);
    const y = anilistNorm(b);
    if (!x || !y) return false;
    return x.indexOf(y) >= 0 || y.indexOf(x) >= 0;
  };

  // ② 候选来源一：图搜种子（最硬的线索，但必须核对过才认）
  let candidates = seeds.map((s) => s.name);

  // ③ 候选来源二：模型凭描述给（认得就快，认错后面要靠核对挡住）
  if (llm && !llm.isMock && typeof llm.complete === 'function') {
    try {
      const raw = await safeComplete(llm, {
        system: IDENT_PROMPT,
        turns: [{ role: 'user', content: clamp(desc, 1500) }],
        maxTokens: 2048,
      });
      const m = String(raw || '').match(/\{[\s\S]*\}/);
      if (m) {
        const j2 = JSON.parse(m[0]);
        const arr = Array.isArray(j2 && j2.candidates) ? j2.candidates : [];
        for (const c of arr) {
          const n = String((c && c.name) || '').trim();
          if (n.length >= 2 && n.length <= 40 && candidates.indexOf(n) < 0) candidates.push(n);
        }
      }
    } catch (_) { /* 猜不出不影响后续 */ }
  }
  candidates = candidates.slice(0, 4);

  // ④ 候选来源三：拿「画面特征」去搜一圈，让模型从真实搜索结果里抽候选
  //    这是「不认识也能查出来」的关键一步：搜索结果接地气，比模型空想准
  let evidenceQueries = [];
  let discovered = false;
  if (features.length && cfg.descSearch !== false) {
    try {
      const queryRaw = await safeComplete(llm, {
        system: QUERY_PROMPT,
        turns: [{ role: 'user', content: clamp(desc, 1200) + '\n\n已提取特征：' + features.join(' ') }],
        maxTokens: 2048,
      });
      evidenceQueries = String(queryRaw || '')
        .split(/\r?\n/)
        .map((x) => x.replace(/^[-*\d.、\s]+/, '').trim())
        .filter((x) => x.length >= 2 && x.length <= 40)
        .slice(0, 2);
    } catch (_) {
      evidenceQueries = [];
    }
    if (evidenceQueries.length) {
      const found = await Promise.all(evidenceQueries.map((q) => searchMaybe(q, 5, timeoutMs)));
      const rows = [].concat(...found).filter(Boolean);
      if (rows.length) {
        discovered = true;
        const rowText = rows
          .slice(0, 10)
          .map((r, idx) => (idx + 1) + '. ' + String((r && r.title) || '') + ' — ' + String((r && r.snippet) || '').replace(/\s+/g, ' ').slice(0, 120))
          .join('\n');
        try {
          const raw2 = await safeComplete(llm, {
            system: EXTRACT_PROMPT + '\n\n画面特征：' + features.join('、'),
            turns: [{ role: 'user', content: clamp(rowText, 1500) }],
            maxTokens: 2048,
          });
          const m2 = String(raw2 || '').match(/\{[\s\S]*\}/);
          if (m2) {
            const j3 = JSON.parse(m2[0]);
            const arr2 = Array.isArray(j3 && j3.candidates) ? j3.candidates : [];
            for (const c of arr2) {
              const n = String((c && c.name) || '').trim();
              if (n.length >= 2 && n.length <= 40 && candidates.indexOf(n) < 0) candidates.push(n);
            }
            candidates = candidates.slice(0, 4);
          }
        } catch (_) { /* 抽取失败不影响后面的核对 */ }
      }
    }
  }

  // ⑤ 并行核对每个候选：网页搜索（候选名+画面特征）+ AniList 结构化条目
  if (candidates.length) {
    const checks = await Promise.all(
      candidates.map(async (name) => {
        const q = features.length ? name + ' ' + features.slice(0, 2).join(' ') : name;
        const [rows, ani] = await Promise.all([
          searchMaybe(q, limit, timeoutMs),
          anilistMedia(name, timeoutMs).catch(() => null),
        ]);
        const ok = rows.filter((r) => corroborates(name, features, r));
        return { name, q, rows: ok, checked: rows.length, ani };
      })
    );

    const scored = checks
      .map((c) => {
        const nameHits = c.rows.filter((r) => nameOnly(c.name, r)).length;
        const featHits = c.rows.filter((r) => corroborates(c.name, features, r)).length;
        const seed = seeds.find((s) => nameMatch(s.name, c.name)) || null;
        const score = nameHits + featHits * 2 + (c.ani ? 3 : 0) + (seed ? 2 : 0) + (seed ? Math.round(seed.sim * 2) : 0);
        return { name: c.name, q: c.q, rows: c.rows, nameHits, featHits, ani: c.ani, seed, score };
      })
      .sort((a, b) => b.score - a.score);

    // 认的门槛（每个结论都必须有网页/结构化证据，图搜只是加分项）：
    //   AniList 有条目 且 命中 ≥1 个画面特征；或 网页命中 ≥2 个画面特征。
    const passed = scored.filter((c) => (c.ani && c.featHits >= 1) || c.featHits >= 2);
    const bestSeed = seeds.slice().sort((a, b) => b.sim - a.sim)[0] || null;

    if (passed.length) {
      const best = passed[0];
      const evid = best.rows.slice(0, 2).map((r, i) => {
        const t = String((r && r.title) || '（无标题）').replace(/\s+/g, ' ').trim();
        const sn = String((r && r.snippet) || '').replace(/\s+/g, ' ').trim().slice(0, 90);
        return sn ? (i + 1) + '. ' + t + ' — ' + sn : (i + 1) + '. ' + t;
      });
      if (best.ani) {
        const label = best.ani.native || best.ani.romaji;
        const extra = best.ani.romaji && best.ani.native ? '（' + best.ani.romaji + '）' : '';
        evid.unshift('AniList 收录了这部作品：《' + label + '》' + extra);
      }
      const bits = [];
      if (best.ani) bits.push('AniList 有条目' + (best.ani.type ? '（' + best.ani.type + '）' : ''));
      if (best.nameHits) bits.push(best.nameHits + ' 条搜索结果提到这个名字');
      if (best.featHits) bits.push('其中 ' + best.featHits + ' 条同时命中画面特征');
      const seed = best.seed || bestSeed;
      const seedLine = seed
        ? '【以图搜图：' + (seed.origin === 'trace' ? '疑似动画《' + seed.name + '》' : '出处《' + seed.name + '》')
          + (seed.episode ? ' 第' + seed.episode + '集' : '')
          + (seed.index ? '（' + seed.index + '）' : '')
          + '，相似度 ' + Math.round((seed.sim || 0) * (seed.origin === 'trace' ? 100 : 1)) + '%'
          + ' —— 已用网页证据交叉核对】'
        : '';
      const confidence = seed ? (best.ani || best.featHits >= 2 ? 'high' : 'medium') : 'low';
      const headline = seed
        ? '【识图结论（图搜 + 网页核对：' + bits.join('，') + '）】'
        : '【识图：可能是（没搜到图片出处，仅供参考）】';
      const tail = seed
        ? '（这是「以图搜图 + 网页交叉核对」对上的结论；如果和画面明显不符，以你看到的画面为准。）'
        : '（注意：这是按画面特征猜的，没有以图搜图核实。说话时要带「可能/不太确定」的语气，绝对不要当成定论。）';
      const others = passed.slice(1).map((c) => c.name);
      const text = [
        headline,
        (seed ? '很可能是：' : '可能是：') + best.name + (features.length ? '（画面特征：' + features.join('、') + '）' : ''),
        seedLine,
        '依据：',
        ...evid,
        others.length ? '（另外还搜到：' + others.join(' / ') + '，可能性较低）' : '',
        tail,
      ].filter(Boolean).join('\n');
      return {
        text,
        query: best.q,
        hits: best.rows.length,
        source: seed ? 'verified' : 'guess',
        confidence,
      };
    }

    // 图搜给了种子，但网页核对不上 → 只能算疑似，明确提示可能认错
    if (bestSeed) {
      const simText = bestSeed.origin === 'trace'
        ? '相似度 ' + Math.round((bestSeed.sim || 0) * 100) + '%'
        : 'SauceNAO 相似度 ' + Math.round(bestSeed.sim || 0) + '%';
      const tried = scored.map((c) => c.name).slice(0, 4).join(' / ');
      const text = [
        '【识图：疑似（以图搜图没被网页证据核实，可能是认错）】',
        '以图搜图说：'
          + (bestSeed.origin === 'trace' ? '疑似动画《' + bestSeed.name + '》' : '出处《' + bestSeed.name + '》')
          + (bestSeed.episode ? ' 第' + bestSeed.episode + '集' : '')
          + '（' + simText + '），但网页里没找到能和画面特征对上的证据。',
        '（说话时必须带「可能是/我不太确定」，不要说成定论；对方否认就直接认错，改描述画面或问出处。）',
        tried ? '（另外核对过：' + tried + '）' : '',
      ].filter(Boolean).join('\n');
      return {
        text,
        query: bestSeed.name,
        hits: 0,
        source: traceSeed ? 'reverse' : 'sauce',
        confidence: 'low',
      };
    }
  }

  // 什么线索都没对上
  if (!candidates.length) {
    return {
      text: '【识图：以图搜图、模型判断和特征搜索都没得到可核对的作品/角色】\n'
        + '（没有可靠出处。别硬猜作品名或角色名，直接说你不确定。如果对方只是想聊聊画面，就聊画面本身。）',
      query: evidenceQueries[0] || '',
      hits: 0,
      source: 'none',
      confidence: 'none',
    };
  }
  const tried = candidates.slice(0, 4).join(' / ');
  return {
    text: '【识图：候选（' + tried + '）在搜索结果里都对不上，查不到可靠出处】\n'
      + '（别强行说是哪部作品。可以说「我不太确定」，或者描述画面、问对方出自哪。绝对不要编作品名。）',
    query: candidates[0],
    hits: 0,
    source: discovered ? 'unverified' : 'none',
    confidence: 'low',
  };
}

module.exports = { buildQuery, enrich, tidyQuery, looksSearchable, relevant, relevantStrict, traceMoe, featureQuery, identify, featureWords, corroborates, anilistMedia, sauceNao };
