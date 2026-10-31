'use strict';

/**
 * 简易联网检索：抓 Bing 网页结果（标题 / 链接 / 摘要）。
 * 只用 Node 内置 https，不依赖第三方库；失败返回空数组。
 */
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

function getText(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', Accept: 'text/html,*/*' } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return getText(new URL(res.headers.location, url).toString(), timeoutMs).then(resolve, reject);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function getJson(url, timeoutMs = 8000) {
  return getText(url, timeoutMs).then((body) => JSON.parse(body));
}

function stripTags(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(Number(n)); } catch { return ''; }
    });
}

// ---------------------------------------------------------------------------
// 浏览器兜底：HTTP 抓取拿不到相关结果时，开一次系统 Edge 的无头模式渲染搜索页。
// 只用 --dump-dom（不需要 Playwright/puppeteer），拿到的 DOM 交给 parseBing 解析。
// ---------------------------------------------------------------------------
const BROWSER_CANDIDATES = [
  process.env.WHALE_BROWSER || '',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

let cachedBrowser = null;
function findBrowser() {
  if (cachedBrowser !== null) return cachedBrowser;
  for (const p of BROWSER_CANDIDATES) {
    try {
      if (p && fs.existsSync(p)) { cachedBrowser = p; return p; }
    } catch (_) { /* 下一个 */ }
  }
  cachedBrowser = '';
  return '';
}

/** 用无头浏览器渲染一次 Bing 搜索页并解析。失败返回 []（绝不影响原流程） */
function browserSearchRaw(query, timeoutMs = 15000, logger = null) {
  const exe = findBrowser();
  if (!exe) return Promise.resolve([]);
  const q = String(query || '').trim().slice(0, 100);
  if (!q) return Promise.resolve([]);
  const url = 'https://cn.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-CN&count=10';
  const dir = path.join(os.tmpdir(), 'whale-search-' + process.pid + '-' + Date.now().toString(36));
  const args = [
    '--headless',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--user-data-dir=' + dir,
    '--dump-dom',
    url,
  ];
  return new Promise((resolve) => {
    const started = Date.now();
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* 建不了就让 Edge 自己报错 */ }
    execFile(exe, args, {
      timeout: Math.max(8000, timeoutMs),
      maxBuffer: 24 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout) => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
      if (err || !stdout) {
        if (logger) logger.warn('浏览器兜底搜索失败：' + (err && err.message ? err.message : '空输出'));
        return resolve([]);
      }
      const rows = parseBing(String(stdout)).filter((r) => r && r.title && !/bing\.com/i.test(r.url || ''));
      if (logger) {
        logger.info('浏览器兜底搜索：' + q + ' → ' + rows.length + ' 条（' + (Date.now() - started) + 'ms）');
      }
      resolve(rows);
    });
  });
}

const BROWSER_TTL_MS = 10 * 60 * 1000;
const browserCache = new Map();
const browserInFlight = new Map();

/** 带缓存与单飞的浏览器兜底：同一查询 10 分钟内只开一次 Edge，并发请求共用同一次执行 */
function browserSearch(query, timeoutMs = 15000, logger = null) {
  const key = String(query || '').trim().toLowerCase().slice(0, 100);
  if (!key) return Promise.resolve([]);
  const hit = browserCache.get(key);
  if (hit && Date.now() - hit.at < BROWSER_TTL_MS) return Promise.resolve(hit.rows);
  if (browserInFlight.has(key)) return browserInFlight.get(key);
  const task = browserSearchRaw(query, timeoutMs, logger).then(
    (rows) => {
      browserCache.set(key, { rows, at: Date.now() });
      browserInFlight.delete(key);
      return rows;
    },
    () => {
      browserInFlight.delete(key);
      return [];
    },
  );
  browserInFlight.set(key, task);
  return task;
}

function parseBing(html) {
  const out = [];
  const blocks = String(html || '').split(/<li class="b_algo"/).slice(1);
  for (const block of blocks) {
    const linkMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const url = decodeEntities(linkMatch[1]);
    const title = stripTags(linkMatch[2]);
    const pMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = pMatch ? stripTags(pMatch[1]) : '';
    if (title || snippet) out.push({ title, url, snippet });
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * 时效过滤：问「最新 / 现在出到几 / 今年」这类问题时，把明显过期的结果剔掉。
 * 实测「苹果现在出到几了」会同时返回 2026 的预测文和「2007-2025 iPhone 全线回顾」，
 * 模型看到旧文就答旧型号（把 iPhone 18 说成 16）。
 * 注意：**不要**简单给查询加年份——实测加了反而把「1 天前」的新结果挤掉。
 */
const TIME_SENSITIVE_RE = /(最新|现在|今年|目前|当前|出到几|第几代|什么型号|哪个版本|多少钱|什么价|行情|发布会|刚出|新出)/;

function parseSnippetAgeDays(snippet) {
  const s = String(snippet || '');
  const rel = s.match(/(\d+)\s*(分钟|小时|天|周)之前/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = { 分钟: 1 / 1440, 小时: 1 / 24, 天: 1, 周: 7 }[rel[2]] || 1;
    return n * unit;
  }
  const abs = s.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日/);
  if (abs) {
    const t = new Date(Number(abs[1]), Number(abs[2]) - 1, Number(abs[3])).getTime();
    if (!Number.isNaN(t)) return (Date.now() - t) / 86400000;
  }
  return null;
}

function isTimeSensitive(query) {
  return TIME_SENSITIVE_RE.test(String(query || ''));
}

function dropStaleResults(query, results, { maxAgeDays = 550 } = {}) {
  if (!TIME_SENSITIVE_RE.test(String(query || ''))) return results;
  const fresh = [];
  for (const r of results) {
    const age = parseSnippetAgeDays(r.snippet || r.title || '');
    if (age !== null && age > maxAgeDays) continue; // 明显过期，丢掉
    fresh.push(r);
  }
  // 全被判过期（说明判断依据不可靠）就保留原始结果，别把她弄成「搜不到」
  return fresh.length ? fresh : results;
}

async function search(query, { limit = 5, timeoutMs = 8000, logger = null, browser = false } = {}) {
  const q = String(query || '').trim().slice(0, 100);
  if (!q) return [];
  const url = 'https://cn.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-CN&count=10';
  try {
    const [bing, sogou] = await Promise.all([
      getText(url, timeoutMs).then(parseBing).catch(() => []),
      sogouSearch(q, timeoutMs).catch(() => []),
    ]);
    const mergeRows = (lists) => {
      const merged = [];
      const seen = new Set();
      for (const r of lists.flat()) {
        const key = String(r.url || '') + '|' + String(r.title || '');
        if (!r.title || seen.has(key)) continue;
        seen.add(key);
        merged.push(r);
      }
      return merged;
    };
    let merged = mergeRows([bing, sogou]);
    let good = merged.filter((r) => relevantToQuery(q, r));
    // HTTP 抓取一条相关的都没有（Bing 给了填充页/搜狗也没命中）→ 用浏览器渲染一次再判断
    if (!good.length && browser) {
      const dom = await browserSearch(q, Math.max(15000, timeoutMs), logger).catch(() => []);
      if (dom.length) {
        merged = mergeRows([dom]);
        good = merged.filter((r) => relevantToQuery(q, r));
      }
    }
    // 一条相关的都没有时退回原始结果（宁可用旧行为，也别让她「搜不到」）
    const scored = (good.length ? good : merged).map((r) => {
      const low = (String(r.title || '') + ' ' + String(r.snippet || '')).toLowerCase();
      const hits = queryTokens(q).filter((t) => low.includes(t)).length;
      return { r, hits };
    });
    scored.sort((a, b) => b.hits - a.hits);
    const list = dropStaleResults(q, scored.map((x) => x.r));
    return list.slice(0, limit);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 查询相关度 + 多引擎兜底
// Bing 中文站对日文/长尾查询常返回「没有结果」页，里面塞的是无关填充内容
// （实测搜「ヤニねこ 佐藤ヤニ子」拿到 MC百科、搜「緑髪 猫耳」拿到汉语字典），
// 于是并行再抓一份搜狗，合并后只保留与查询词元真正相关的条目。
// ---------------------------------------------------------------------------

function queryTokens(query) {
  const q = String(query || '').trim();
  if (!q) return [];
  const out = new Set();
  for (const w of q.split(/[^A-Za-z0-9]+/)) {
    if (w.length >= 3) out.add(w.toLowerCase());
  }
  for (const seg of q.split(/[^0-9A-Za-z\u3040-\u30ff\u3400-\u9fff]+/)) {
    const s = seg.trim();
    if (!s) continue;
    if (s.length <= 4) out.add(s);
    for (let i = 0; i + 2 <= s.length; i += 1) out.add(s.slice(i, i + 2));
  }
  return [...out];
}

function relevantToQuery(query, item) {
  const tokens = queryTokens(query);
  if (!tokens.length) return true;
  const text = String((item && item.title) || '') + ' ' + String((item && item.snippet) || '');
  const low = text.toLowerCase();
  return tokens.some((t) => low.includes(t));
}

function parseSogou(html) {
  const out = [];
  const blocks = String(html || '').split(/<div[^>]+class="(?:vrwrap|rb|vrwrap-news)[^"]*"/).slice(1);
  for (const block of blocks) {
    const h = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    if (!h) continue;
    const linkMatch = h[1].match(/<a[^>]+href="([^"]+)"/i);
    const url = linkMatch ? decodeEntities(linkMatch[1]) : '';
    const title = stripTags(h[1]);
    if (!title) continue;
    const snipMatch = block.match(/class="(?:str_info|space-txt|fz-mid|text-layout)[^"]*"[^>]*>([\s\S]*?)<\/(?:div|p|span)>/i);
    const snippet = snipMatch ? stripTags(snipMatch[1]) : '';
    out.push({ title, url, snippet });
    if (out.length >= 10) break;
  }
  return out;
}

async function sogouSearch(query, timeoutMs = 8000) {
  const url = 'https://www.sogou.com/web?query=' + encodeURIComponent(query);
  const html = await getText(url, timeoutMs);
  return parseSogou(html);
}

async function searchText(query, opts = {}) {
  const list = await search(query, opts);
  if (!list.length) return '';
  return list
    .map((r, i) => `${i + 1}. ${r.title || '（无标题）'}\n   ${r.snippet || ''}\n   ${r.url || ''}`)
    .join('\n');
}

/** 今日头条热榜（真实当前热点） */
async function hotNews(limit = 10, timeoutMs = 8000) {
  try {
    const raw = await getText('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc', timeoutMs);
    const data = JSON.parse(raw);
    const list = Array.isArray(data.data) ? data.data : [];
    return list.slice(0, limit).map((item) => ({
      title: String(item.Title || '').trim(),
      url: String(item.Url || '').trim(),
      hot: Number(item.HotValue) || 0,
    })).filter((x) => x.title);
  } catch {
    return [];
  }
}

async function hotNewsText(limit = 8) {
  const list = await hotNews(limit);
  if (!list.length) return '';
  return list.map((x, i) => `${i + 1}. ${x.title}`).join('\n');
}

// ---------------------------------------------------------------------------
// 天气：只靠 Bing 摘要答不准（常常只有「多云」没有温度，还容易搜到别的城市），
// 所以单独接 open-meteo（免费、不要 key、支持中文地名）。
// ---------------------------------------------------------------------------

const WMO = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
  45: '有雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
  56: '冻毛毛雨', 57: '强冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '强阵雨', 82: '暴雨',
  85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷暴伴冰雹',
};

function wmoText(code) {
  const n = Number(code);
  return WMO[n] || (Number.isFinite(n) ? '天气代码' + n : '未知');
}

/** 按本机公网 IP 猜城市（没配 city 时用；拿不到就返回空，不影响别的） */
let _ipCity = { value: '', at: 0 };
async function ipCity(timeoutMs = 6000) {
  const now = Date.now();
  if (_ipCity.value && now - _ipCity.at < 6 * 3600 * 1000) return _ipCity.value;
  try {
    const j = await getJson('https://ipinfo.io/json', timeoutMs);
    const city = String((j && j.city) || '').trim();
    if (city) {
      _ipCity = { value: city, at: now };
      return city;
    }
  } catch { /* 拿不到就算了 */ }
  return '';
}

/** 地名 → 经纬度（找不到返回 null） */
async function geocodeCity(city, timeoutMs = 8000) {
  const name = String(city || '').trim();
  if (!name) return null;
  const url =
    'https://geocoding-api.open-meteo.com/v1/search?name=' +
    encodeURIComponent(name) +
    '&count=1&language=zh&format=json';
  try {
    const j = await getJson(url, timeoutMs);
    const r = Array.isArray(j.results) && j.results[0];
    if (!r) return null;
    return {
      name: r.name || name,
      admin1: r.admin1 || '',
      latitude: r.latitude,
      longitude: r.longitude,
      timezone: r.timezone || 'Asia/Shanghai',
    };
  } catch {
    return null;
  }
}

/** 当前天气 + 今明两天（返回给模型看的一段中文） */
async function weatherText(city, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) || 8000;
  const place = await geocodeCity(city, timeoutMs);
  if (!place) return '';
  const url =
    'https://api.open-meteo.com/v1/forecast?latitude=' + place.latitude +
    '&longitude=' + place.longitude +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m' +
    '&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max' +
    '&timezone=' + encodeURIComponent(place.timezone) +
    '&forecast_days=2';
  try {
    const j = await getJson(url, timeoutMs);
    const cur = j.current || {};
    const d = j.daily || {};
    const day = (i) => ({
      date: (d.time || [])[i] || '',
      max: (d.temperature_2m_max || [])[i],
      min: (d.temperature_2m_min || [])[i],
      code: (d.weather_code || [])[i],
      rain: (d.precipitation_probability_max || [])[i],
    });
    const today = day(0);
    const tomorrow = day(1);
    const lines = [];
    lines.push(`【${place.name}${place.admin1 && place.admin1 !== place.name ? '（' + place.admin1 + '）' : ''} 实时天气】`);
    if (cur.temperature_2m != null) {
      lines.push(
        `现在 ${cur.temperature_2m}°C（体感 ${cur.apparent_temperature}°C，${wmoText(cur.weather_code)}，` +
        `湿度 ${cur.relative_humidity_2m}%，风 ${cur.wind_speed_10m} km/h）`
      );
    }
    if (today.max != null) {
      lines.push(`今天 ${wmoText(today.code)}，${today.min}~${today.max}°C，降水概率 ${today.rain ?? 0}%`);
    }
    if (tomorrow.max != null) {
      lines.push(`明天 ${wmoText(tomorrow.code)}，${tomorrow.min}~${tomorrow.max}°C，降水概率 ${tomorrow.rain ?? 0}%`);
    }
    lines.push('（数据源 open-meteo，按预报时间当地时区）');
    return lines.join('\n');
  } catch {
    return '';
  }
}

module.exports = {
  browserSearch,
  findBrowser,
  dropStaleResults,
  isTimeSensitive,
  parseSnippetAgeDays,
  search,
  searchText,
  parseBing,
  parseSogou,
  hotNews,
  hotNewsText,
  geocodeCity,
  ipCity,
  weatherText,
  wmoText,
};

