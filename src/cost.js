'use strict';

/**
 * DeepSeek-V4.1-Flash（deepseek-flash）费用估算。
 *
 * 官方价格（元 / 百万 tokens，2026-10 文档）：
 *   - 输入（缓存未命中）：空闲 1 元，高峰 2 元
 *   - 输入（缓存命中）  ：空闲 0.02 元，高峰 0.04 元
 *   - 输出              ：空闲 4 元，高峰 8 元
 * 高峰时段：北京时间周一至周五 9:00-12:00、14:00-18:00（法定节假日除外，这里不排节假日）。
 *
 * config.json 里可以改：
 *   "pricing": { "enabled": true, "inputMiss": 1, "inputHit": 0.02, "output": 4,
 *                "peakMultiplier": 2, "currency": "元" }
 */
const DEFAULT_PRICE = {
  enabled: true,
  inputMiss: 1,
  inputHit: 0.02,
  output: 4,
  peakMultiplier: 2,
  currency: '元',
};

function prices(config) {
  const p = (config && config.pricing) || {};
  return {
    enabled: p.enabled !== false,
    inputMiss: Number(p.inputMiss) > 0 ? Number(p.inputMiss) : DEFAULT_PRICE.inputMiss,
    inputHit: Number(p.inputHit) > 0 ? Number(p.inputHit) : DEFAULT_PRICE.inputHit,
    output: Number(p.output) > 0 ? Number(p.output) : DEFAULT_PRICE.output,
    peakMultiplier: Number(p.peakMultiplier) > 0 ? Number(p.peakMultiplier) : DEFAULT_PRICE.peakMultiplier,
    currency: typeof p.currency === 'string' && p.currency ? p.currency : DEFAULT_PRICE.currency,
  };
}

/** 北京时间周一~周五 9:00-12:00 / 14:00-18:00 算高峰 */
function isPeak(when) {
  const t = new Date((when instanceof Date ? when.getTime() : Number(when) || Date.now()) + 8 * 3600 * 1000);
  const day = t.getUTCDay(); // 0=周日
  if (day === 0 || day === 6) return false;
  const minutes = t.getUTCHours() * 60 + t.getUTCMinutes();
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60);
}

/**
 * 用「本条消息前后的用量差」算钱。
 * usage = { input, output, cacheHit, cacheMiss }
 */
function estimate(config, usage, when) {
  const p = prices(config);
  if (!p.enabled || !usage) return 0;
  const peak = isPeak(when);
  const mul = peak ? p.peakMultiplier : 1;
  const input = Math.max(0, Number(usage.input) || 0);
  const output = Math.max(0, Number(usage.output) || 0);
  let hit = Math.max(0, Number(usage.cacheHit) || 0);
  let miss = Math.max(0, Number(usage.cacheMiss) || 0);
  if (!hit && !miss) {
    // 没给缓存字段就全按未命中算（偏保守，宁可贵一点）
    miss = input;
  } else if (hit + miss < input) {
    miss += input - hit - miss;
  }
  const cost =
    (hit / 1e6) * p.inputHit * mul +
    (miss / 1e6) * p.inputMiss * mul +
    (output / 1e6) * p.output * mul;
  return cost;
}

/** 金额格式化：太小就多给几位小数，别全显示成 0 */
function format(cost, config) {
  const p = prices(config);
  const n = Number(cost) || 0;
  if (n <= 0) return '';
  let body;
  if (n >= 1) body = n.toFixed(2);
  else if (n >= 0.01) body = n.toFixed(3);
  else body = n.toFixed(4);
  // 只显示数字，不带「元」等货币字样（p.currency 仍保留在配置里，方便以后要单位时改回来）
  return '（' + body + '）';
}

/** 直接在回复末尾拼一行费用，例如：「（0.0031元）」 */
function line(config, usage, when) {
  const text = format(estimate(config, usage, when), config);
  return text ? '\n' + text : '';
}

module.exports = { estimate, format, line, isPeak, prices };
