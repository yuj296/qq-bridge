// 表情包体系（二代仿真模式）——本地表情知识库与策略提示纯函数。
//
// 职责：
// - state/stickers.json 的读写与字段归一化
// - 把 SnowLuma `fetch_custom_face_detail` 返回的 QQ 收藏表情合并进本地库
// - 支持按 emoji_id / md5 / url 查找、按备注/本地笔记/标签搜索
// - 生成注入 AI 的“表情包策略/可用表情”摘要
//
// 设计原则：
// - QQ 账号的收藏表情是“源”，本地库是“AI 认知层”：保留 AI 学习到的含义/标签/使用次数，
//   不覆盖 QQ 的备注；QQ desc 为空时 AI 可以看图后用 qq_sticker_note 记录自己的理解。
// - 所有文本只做展示/提示，不执行任何本地操作。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeStickerEntry(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const id = String(entry.id || entry.emoji_id || entry.resId || '').trim();
  if (!id) return null;
  const tags = Array.isArray(entry.tags)
    ? entry.tags.map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 20)
    : [];
  return {
    id,
    resId: String(entry.resId || entry.emoji_id || id).trim(),
    url: String(entry.url || '').trim(),
    md5: String(entry.md5 || '').trim().toUpperCase(),
    desc: String(entry.desc ?? '').trim(),
    localNote: String(entry.localNote ?? '').trim(),
    tags,
    usage: String(entry.usage ?? '').trim(),
    source: entry.source === 'manual' ? 'manual' : (entry.source === 'ai' ? 'ai' : 'qq'),
    useCount: Math.max(0, Number(entry.useCount) || 0),
    lastUsedAt: Number(entry.lastUsedAt) || 0,
    lastContext: String(entry.lastContext ?? '').slice(0, 200),
    createdAt: String(entry.createdAt || nowIso()),
    updatedAt: String(entry.updatedAt || nowIso())
  };
}

/**
 * 读本地表情库，并**区分「读不出来」与「库是空的」**。
 *
 * 为什么必须区分（2026-09-16 审计实测复现）：以前这里把两者都返回 `[]`，而任何一次保存都会把
 * 内存里的空列表原子写回 —— `state/stickers.json` 一旦被写坏（断电、手编、磁盘故障），
 * 启动时静默变空、随后一次 saveStickerStoreSafe() 就把用户的收藏认知（备注/标签/使用次数）清零。
 * 现在读失败返回 `ok:false`，调用方据此进入**只读降级**：拒绝写回 + 记一条警告。
 *
 * @param {string} file 库文件路径。
 * @returns {{ok: boolean, entries: Array, reason: string, missing: boolean}}
 *   ok:false = 文件存在但读不出来 / 内容坏了（**不要写回**）；missing:true = 文件不存在（全新库，正常）。
 */
export function readStickerStore(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, entries: [], reason: '文件不存在（全新库）', missing: true };
    return { ok: false, entries: [], reason: `读文件失败：${error?.message ?? error}`, missing: false };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.trim() === '') return { ok: true, entries: [], reason: '空文件（全新库）', missing: true };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, entries: [], reason: `JSON 解析失败：${error?.message ?? error}`, missing: false };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, entries: [], reason: '内容不是数组（文件可能被写坏）', missing: false };
  }
  return { ok: true, entries: parsed.map(normalizeStickerEntry).filter(Boolean), reason: 'ok', missing: false };
}

/** 兼容旧用法：只要数组。**需要区分"坏了"与"空"时必须用 readStickerStore()。** */
export function loadStickerStore(file) {
  return readStickerStore(file).entries;
}

export function saveStickerStore(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

// 把 SnowLuma 返回的 QQ 收藏表情详情合并进本地库。
// 保留本地 AI 认知字段（localNote/tags/usage/useCount/lastUsedAt/lastContext），
// 只更新 QQ 侧字段（id/resId/url/md5/desc）。
export function mergeStickerLibrary(existing, fetched) {
  const out = existing.map(normalizeStickerEntry).filter(Boolean);
  const byId = new Map(out.map((e) => [e.id, e]));
  const fetchedIds = new Set();
  for (const item of Array.isArray(fetched) ? fetched : []) {
    const id = String(item?.emoji_id || item?.resId || item?.id || '').trim();
    if (id) fetchedIds.add(id);
  }
  for (const item of Array.isArray(fetched) ? fetched : []) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.emoji_id || item.resId || item.id || '').trim();
    if (!id) continue;
    const old = byId.get(id);
    const merged = normalizeStickerEntry({
      ...(old || {}),
      id,
      resId: String(item.resId || item.emoji_id || id).trim(),
      url: String(item.url || old?.url || '').trim(),
      md5: String(item.md5 || old?.md5 || '').trim().toUpperCase(),
      desc: String(item.desc ?? old?.desc ?? '').trim(),
      localNote: old?.localNote || '',
      tags: old?.tags || [],
      usage: old?.usage || '',
      source: old?.source || 'qq',
      useCount: old?.useCount || 0,
      lastUsedAt: old?.lastUsedAt || 0,
      lastContext: old?.lastContext || '',
      createdAt: old?.createdAt || nowIso(),
      updatedAt: nowIso()
    });
    if (!merged) continue;
    if (!byId.has(id)) {
      out.push(merged);
      byId.set(id, merged);
    } else {
      const idx = out.findIndex((e) => e.id === id);
      if (idx >= 0) out[idx] = merged;
    }
  }
  // 清理已被 QQ 端删除的收藏表情（保留手动/本地新增的非 qq 来源条目）。
  return out.filter((e) => e.source !== 'qq' || fetchedIds.has(e.id));
}

// 通过 emoji_id / md5 / url（支持模糊：去掉大小写、尾斜杠、URL 查询）查找。
export function findSticker(entries, ref) {
  const raw = String(ref ?? '').trim();
  if (!raw) return null;
  const id = raw;
  const md5 = raw.toUpperCase();
  const urlNormalized = raw.replace(/\/+$/, '').replace(/^https?:\/\//i, '');
  return (Array.isArray(entries) ? entries : []).find((e) => {
    if (!e) return false;
    if (e.id === id || e.resId === id) return true;
    if (e.md5 && e.md5 === md5) return true;
    const eUrl = String(e.url || '').replace(/\/+$/, '').replace(/^https?:\/\//i, '');
    // 只认「归一化后完全相等」：原来的双向 includes 会让残缺 URL / 短串命中错误的表情，
    // 而调用方会拿这个 id 去改真实 QQ 备注（写操作，改错了很难发现）。
    if (eUrl && urlNormalized && eUrl === urlNormalized) return true;
    return false;
  }) || null;
}

// 格式化给 AI 看的表情列表；query 会匹配 desc/localNote/tags/usage/id/md5。
export function formatStickerList(entries, query = '', limit = 48) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const q = String(query ?? '').trim().toLowerCase();
  const filtered = q
    ? list.filter((e) => {
        const haystack = [e.desc, e.localNote, e.usage, e.id, e.resId, e.md5, ...(e.tags || [])].join(' ').toLowerCase();
        return haystack.includes(q);
      })
    : list;
  const max = Math.max(1, Math.min(500, Number(limit) || 48));
  const items = filtered.slice(0, max).map((e) => ({
    id: e.id,
    resId: e.resId,
    md5: e.md5,
    url: e.url,
    desc: e.desc || '',
    localNote: e.localNote || '',
    tags: e.tags || [],
    usage: e.usage || '',
    useCount: e.useCount || 0,
    lastUsedAt: e.lastUsedAt || 0,
    source: e.source || 'qq'
  }));
  return {
    total: list.length,
    matched: filtered.length,
    truncated: filtered.length > max,
    stickers: items
  };
}

// 生成注入 AI 的“可用表情包”摘要（不暴露完整 URL，避免上下文爆炸）。
export function buildStickerContext(entries, max = 8) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  if (!list.length) return '';
  const top = [...list]
    .sort((a, b) => (b.useCount || 0) - (a.useCount || 0) || ((b.desc || b.localNote) ? 1 : 0) - ((a.desc || a.localNote) ? 1 : 0))
    .slice(0, Math.max(1, Math.min(30, Number(max) || 8)));
  const lines = top.map((e) => {
    const label = e.desc || e.localNote || '（无备注，可先看图）';
    const extra = e.tags?.length ? ` [${e.tags.join('/')}]` : '';
    const used = e.useCount ? `（用过${e.useCount}次）` : '';
    return `- ${label}${extra}${used}`;
  });
  return `【可用表情包】你的 QQ 收藏表情里有 ${list.length} 个表情（以下为常用/有备注的 ${top.length} 个，完整列表请用 qq_list_stickers 查看）：\n${lines.join('\n')}`;
}

// 二代仿真模式下的“真人发表情包”策略提示。
// 这是软策略：AI 仍自主判断是否使用，桥接不强制。
export function buildStickerStrategyHint() {
  return [
    '【表情包策略：像真人一样用，不刷屏】',
    '- 合适时机：被戳中笑点/槽点、接梗、怼人、赞同、自嘲、安慰、无语、赢了/输了、告别/晚安、别人发了表情时回一张，都可以自然用。',
    '- 频率：普通闲聊不用每条都配；大约每 3~5 轮来一张就够，热闹/玩梗时可以更密，但不要连续刷屏。',
    '- 选择：优先用备注（desc）和你的记忆（localNote/tags）能准确对上语境的；没有备注/不确定的表情，先 qq_get_sticker_image 看图再决定，不要瞎发。',
    '- 发送：用 qq_send_sticker；一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话先用 qq_send_message / qq_reply 作为单独气泡发出，再单独发表情。需要引用时传 replyToMessageId。',
    '- 不要：在严肃/正式/敏感话题硬塞表情；不要每次都用同一个；不要一条消息里塞多个表情；不要把文字和表情混在同一个气泡里；不要把表情包当回复的唯一内容（偶尔可以，但别让对方觉得你在敷衍）。',
    '- 学习：看到新表情不确定含义时，先用 qq_get_sticker_image 看图，再用 qq_sticker_note 记下你的理解，下次就能更准地选。'
  ].join('\n');
}

// 把 AI 本地认知（note/tags/usage）更新到一条表情记录上，并返回新数组。
export function applyStickerNote(entries, id, patch = {}) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    localNote: patch.note !== undefined ? String(patch.note ?? '').trim() : target.localNote,
    tags: Array.isArray(patch.tags) ? patch.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : target.tags,
    usage: patch.usage !== undefined ? String(patch.usage ?? '').trim() : target.usage,
    source: patch.source || target.source || 'ai',
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}

// 记录一次“使用”，返回新数组。
export function markStickerUsed(entries, id, context = '') {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    useCount: (target.useCount || 0) + 1,
    lastUsedAt: Date.now(),
    lastContext: String(context || '').slice(0, 200),
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}
