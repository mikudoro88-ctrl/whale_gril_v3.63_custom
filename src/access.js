'use strict';

/**
 * 允许范围：白名单 + 逐聊天权限，降低误触发。
 * config.json → access:
 * {
 *   "enabled": true,
 *   "mode": "all" | "whitelist",
 *   "chats": {
 *     "wechat:g:123@chatroom": { "mode": "chat" | "full" | "off" }
 *   }
 * }
 * mode=all 时全部允许，chats 里 mode=off 的会话照样不回；
 * mode=whitelist 时只有 chats 里列出的会话才回（mode=off 的仍然不回）。
 */
function check(config, msg) {
  const a = (config && config.access) || {};
  if (a.enabled === false) return { ok: true, reason: 'disabled' };
  const key = String((msg && (msg.chatKey || msg.key)) || '');
  const chatId = String((msg && msg.chatId) || '');
  const chats = a.chats || {};
  const rule = chats[key] || chats[chatId] || null;
  if (rule) {
    const m = String(rule.mode || '').toLowerCase();
    if (m === 'off' || m === 'block' || m === 'none') return { ok: false, reason: 'chat_off' };
    if (m === 'chat' || m === 'full' || m === 'on') {
      return { ok: true, reason: 'chat_listed', full: m === 'full' };
    }
  }
  const mode = String(a.mode || 'all').toLowerCase();
  if (mode === 'whitelist') return { ok: false, reason: 'not_listed' };
  return { ok: true, reason: 'default' };
}

module.exports = { check };
