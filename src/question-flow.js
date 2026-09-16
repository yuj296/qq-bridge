// 「agent 向人提问」在两个方向上用到的纯函数：把提问渲染成 QQ 文本、把 QQ 回复解析成答案。
//
// 为什么单独成模块：
//   1. 这两件事是纯字符串处理，能脱离 DSH / QQ / 桥接进程直接单测
//      （护栏：scripts/test-question-relay.mjs）；
//   2. 「序号 / 选项原文 / 自定义文字」三种回法的规则只写一处，免得展示端和解析端漂移。
//
// 约定（与设置页字段说明、AGENTS.md 保持一致）：
//   - 单问题：回 `2` = 选中第 2 个选项；回选项原文也算选中；回别的文字 = 自定义回答。
//   - 多问题：用 `|` 分隔逐题对应，每段可以是序号、原文或自定义文字。
//   - 序号是「该题自己选项表」里的 1 起序号（每题独立从 1 开始）。

// 长度上限默认都是 0 = **不截断**：手机上要能看懂「这个方案到底是什么」，
// 所以问题正文、选项名、选项说明一律原样发出（用户 2026-09-15 明确要求「写清楚」）。
// 想限制长度就在调用处传 optionLabelMax / questionMax / optionDescMax（正数 = 截断到这么多字）。
export const DEFAULT_OPTION_LABEL_MAX = 0;
export const DEFAULT_QUESTION_MAX = 0;
export const DEFAULT_OPTION_DESC_MAX = 0;

const FULLWIDTH_DIGITS = '０１２３４５６７８９';

/** 全角数字转半角（手机上很容易打出全角）。 */
function toHalfWidthDigits(text) {
  return String(text ?? '').replace(/[０-９]/g, (ch) => String(FULLWIDTH_DIGITS.indexOf(ch)));
}

/** 压成单行：只用于「来源」这种本来就该一行的短文本。 */
function collapse(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 正文规范化：统一换行、去掉行尾空白、把 3 个以上连续换行压成 1 个空行。
 * 保留换行是有意的：方案说明常是分点写的（「好处…／代价…」），压成一行在手机上很难读。
 * max > 0 才截断；默认 0 = 完整发出。
 */
function tidy(text, max = 0) {
  const s = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (max > 0 && s.length > max) return `${s.slice(0, max)}…`;
  return s;
}

/** 宽松比较用的归一化：忽略大小写、空白与常见标点。 */
function looseKey(text) {
  return toHalfWidthDigits(text)
    .toLowerCase()
    .replace(/[\s、。,，.；;：:!！?？「」“‘"'（）()\[\]【】]/g, '');
}

/**
 * 这一段回答文本命中第几个选项。
 * @returns {number} 选项下标（0 起）；-1 表示没命中（当作自定义回答）。
 */
export function matchOptionIndex(options, text) {
  const list = Array.isArray(options) ? options : [];
  if (list.length === 0) return -1;
  const key = looseKey(text);
  if (!key) return -1;
  for (let i = 0; i < list.length; i += 1) {
    if (looseKey(list[i]?.label) === key) return i;
  }
  return -1;
}

/** 单题解析：返回 { answer } 或 { error }。 */
function parseOne(question, raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { error: '回答是空的' };
  const options = Array.isArray(question?.options) ? question.options : [];
  const digits = toHalfWidthDigits(text).trim();
  const m = /^(\d{1,2})$/.exec(digits);
  if (m) {
    const n = Number(m[1]);
    if (options.length === 0) return { error: '这题没有选项，请直接回你的答案' };
    if (n < 1 || n > options.length) {
      return { error: `序号 ${n} 超范围了（这题只有 ${options.length} 个选项）` };
    }
    return { answer: { id: question.id, selected: [String(options[n - 1]?.label ?? '')] } };
  }
  const hit = matchOptionIndex(options, text);
  if (hit >= 0) return { answer: { id: question.id, selected: [String(options[hit]?.label ?? '')] } };
  return { answer: { id: question.id, selected: [], custom: text } };
}

/**
 * 把主人的一条 QQ 回复解析成 DSH 要的 answers 数组。
 * @param {Array} questions DSH 提问帧里的 questions。
 * @param {string} text 主人的回复原文。
 * @returns {{ok: true, answers: Array} | {ok: false, error: string}}
 */
export function parseQuestionAnswer(questions, text) {
  const list = Array.isArray(questions) ? questions.filter(Boolean) : [];
  if (list.length === 0) return { ok: false, error: '这次没有需要回答的问题' };
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, error: '回答是空的，请重新回复' };
  if (list.length === 1) {
    const one = parseOne(list[0], raw);
    if (one.error) return { ok: false, error: one.error };
    return { ok: true, answers: [one.answer] };
  }
  const parts = raw.split(/[|｜]/).map((s) => s.trim());
  if (parts.length !== list.length) {
    const sample = list.map((q, i) => String(Math.min(i + 1, Math.max(1, (q.options ?? []).length)) || 1)).join('|');
    return {
      ok: false,
      error: `这次有 ${list.length} 个问题，要用 | 分隔逐个回答（例如 ${sample}）`
    };
  }
  const answers = [];
  for (let i = 0; i < list.length; i += 1) {
    const one = parseOne(list[i], parts[i]);
    if (one.error) return { ok: false, error: `第 ${i + 1} 题：${one.error}` };
    answers.push(one.answer);
  }
  return { ok: true, answers };
}

/**
 * 渲染要发到 QQ 的提问消息。
 *
 * @param {object} entry 挂起项：{ questions, origin?, queueAhead? }
 * @param {object} [options]
 *   - sanitize: (text) => string  脱敏回调（非管理员会话用；转发给管理员时不脱敏）
 *   - optionLabelMax / optionDescMax / questionMax：截断长度（0 或不传 = 不截断）
 *   - header / footer：覆盖首行与末行提示
 * @returns {string}
 */
export function formatQuestionMessage(entry, options = {}) {
  const sanitize = typeof options.sanitize === 'function' ? options.sanitize : (s) => String(s ?? '');
  const limit = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback);
  const labelMax = limit(options.optionLabelMax, DEFAULT_OPTION_LABEL_MAX);
  const questionMax = limit(options.questionMax, DEFAULT_QUESTION_MAX);
  const descMax = limit(options.optionDescMax, DEFAULT_OPTION_DESC_MAX);
  const questions = (Array.isArray(entry?.questions) ? entry.questions : []).filter(Boolean);
  const origin = entry?.origin ? `（来自 DSH 会话：${collapse(sanitize(entry.origin))}）` : '';
  // 「前面还有几条」既可以挂在 entry 上，也可以当渲染参数传（桥接走后者：
  // 入队那一刻才知道排第几）。两处都认，免得调用方猜。
  const aheadRaw = options.queueAhead ?? entry?.queueAhead;
  const queueAhead = Number(aheadRaw) > 0 ? Number(aheadRaw) : 0;

  const head = options.header
    ?? (questions.length > 1
      ? `❓ agent 需要你回答${origin}，共 ${questions.length} 个问题：`
      : `❓ agent 需要你回答${origin}：`);

  const body = [];
  questions.forEach((q, qi) => {
    const text = tidy(sanitize(q?.question ?? ''), questionMax) || '（无题面）';
    body.push(questions.length > 1 ? `【${qi + 1}】${text}` : text);
    const opts = Array.isArray(q?.options) ? q.options : [];
    opts.forEach((o, oi) => {
      const label = tidy(sanitize(o?.label ?? ''), labelMax) || '（无选项名）';
      // 选项名多行时按序号列对齐（理论上少见，但别让它顶到行首破坏层级）。
      body.push(`  ${oi + 1}. ${label.replace(/\n/g, '\n     ')}`);
      // 选项的详细说明（方案到底怎么做、代价是什么）原样发出来 —— 只给个「方案 A」
      // 等于让人闭眼选。缩进 5 格跟序号列对齐。
      const desc = tidy(sanitize(o?.description ?? ''), descMax);
      if (desc) body.push(desc.split('\n').map((line) => `     ${line}`).join('\n'));
    });
  });

  let footer;
  if (options.footer !== undefined) {
    footer = String(options.footer);
  } else if (questions.length > 1) {
    footer = '逐题用 | 分隔回答（回序号或原文都行，例如 1|2）';
  } else if ((questions[0]?.options ?? []).length > 0) {
    footer = `回 1~${questions[0].options.length} 选一个，或直接回你的答案`;
  } else {
    footer = '直接回复你的答案即可';
  }
  if (queueAhead > 0) footer += `（前面还有 ${queueAhead} 个待回答，我一个一个来）`;

  return [head, ...body, footer].filter((line) => line !== '').join('\n');
}
