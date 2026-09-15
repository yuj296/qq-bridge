// QQ 机器人设置（host 半侧）
//
// 把 qq-bridge 的 config.json **整份**开放成一个 DSH settings 命名空间 `qq-mode`：
//   * 字段表在 lib/schema.js（唯一的真源）
//   * base 层 = 当前 config.json 的值 → 设置页里看到的就是真实生效值
//   * 用户在设置页改过的字段进 user 层 → 桥接进程每 5s 拉一次，深合并进自己的 cfg
//
// 所以：**设置页 > config.json**（只对改过的字段）。手改 config.json 后想让它生效，
// 要么重启 DSH（base 会重读），要么在设置页把那个字段「重置」回继承值。
//
// 机密（snowluma.accessToken / consoleToken / dsh.token）刻意不进 schema ——
// DSH 的设置协议必须 redactSecrets，桥接读不回来，放进设置页只会变成只写陷阱。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { buildSchema, GROUPS, FIELDS } from './schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 插件在 <repo>/plugins/qq-mode-console/lib/ 下。 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CONFIG_FILE = path.join(REPO_ROOT, 'config.json');
const DIAG = path.join(REPO_ROOT, 'state', 'qq-mode-plugin.log');

function diag(msg) {
  try {
    fs.mkdirSync(path.dirname(DIAG), { recursive: true });
    fs.appendFileSync(DIAG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

export const name = 'qq-mode-console';
export const inject = ['settings'];

export const QQMODE_NAMESPACE = 'qq-mode';

/** 只出现在 config.json、不进设置页的键（机密）。 */
const SECRET_KEYS = new Set(['accessToken', 'consoleToken', 'token']);
/** mode 不进 base：没在设置页选过，就沿用桥接控制台 / state/mode.json 的值。 */
const BASE_EXCLUDED = new Set(['mode']);

/** 组装 schema：字段表 + 模式选择。 */
export const QqBotSchema = buildSchema(z);

/**
 * 从 config.json 取 base 层：原样保留类型，剔除机密与 mode。
 * @returns {object} base 对象。
 */
function readBase() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (error) {
    diag(`读 config.json 失败：${error?.message ?? error}`);
    return {};
  }
  const strip = (value, depth) => {
    if (Array.isArray(value)) return value.slice();
    if (value === null || typeof value !== 'object') return value;
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (SECRET_KEYS.has(key)) continue;
      if (depth === 0 && BASE_EXCLUDED.has(key)) continue;
      out[key] = strip(child, depth + 1);
    }
    return out;
  };
  return strip(raw, 0);
}

export function apply(ctx, config = {}) {
  diag(`apply called, settings=${typeof ctx.settings}`);
  try {
    const settings = ctx.settings;
    if (!settings || typeof settings.register !== 'function') {
      diag('settings service unavailable');
      return;
    }
    const base = { ...readBase(), ...(config.base ?? {}) };
    const fields = FIELDS.length;
    const scope = settings.register(QQMODE_NAMESPACE, QqBotSchema, {
      base,
      applies: 'live'
    });
    diag(`registered ${QQMODE_NAMESPACE}（${fields} 个字段，base 来自 ${CONFIG_FILE}）scope=${typeof scope}`);
    console.log(`[qq-mode-console] active (namespace=${QQMODE_NAMESPACE}, fields=${fields}, groups=${Object.keys(GROUPS).length})`);
  } catch (error) {
    if (/already registered/i.test(String(error?.message ?? error))) {
      diag('qq-mode namespace already registered, skip');
      return;
    }
    diag(`register threw: ${error?.stack ?? error}`);
    throw error;
  }
}
