// scan-secrets.mjs —— 发布前自检：仓库里有没有会被误提交的敏感信息
//
// 用法：node scripts/scan-secrets.mjs
// 退出码：0 = 干净；1 = 有命中（不要提交）
//
// 为什么需要它：本仓库要跟 DSH 启动令牌、SnowLuma accessToken、QQ 号打交道，
// 这些东西散落在 config.json / state/ / 文档摘录里，很容易顺手写进文档或注释。
// （本项目真实发生过：移植文档里的日志摘录带出了主人的真实 QQ 号。）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'state', '.npm-cache']);

// 不该出现在任何「会入库的文件」里的东西。
// 注意：这里放的是**模式**，不是真实值；真实值从配置文件里读，避免本脚本自己变成泄露源。
const PATTERNS = [
  { name: 'DSH 启动令牌', re: /[?&]token=[A-Za-z0-9_-]{20,}/ },
  { name: '形如 SnowLuma accessToken 的长随机串', re: /\baccessToken"?\s*[:=]\s*"[A-Za-z0-9_-]{24,}"/ },
  // ⚠️ 源码里的路径字面量通常是**双反斜杠**（转义写法），只匹配单反斜杠会全部漏判。
  // 2026-09-16 审计实测：这条曾经对 4 个真实命中文件 test()=false，于是发布前自检报"干净"，
  // 本机路径就这样被推上了公开仓库。所以这里 \\{1,2} 两种写法都认。
  { name: '疑似本机绝对路径（发布版应避免）', re: /[A-Za-z]:\\{1,2}Users\\{1,2}[^\\\s"']+/ },
];

// 文档和示例配置里到处都是占位 QQ 号，别把它们当泄露。
const PLACEHOLDER_QQ = new Set(['10000', '10001', '10002', '10086', '12345', '123456', '1234567', '12345678', '123456789', '1234567890', '111111', '222222']);
function isPlaceholderQq(digits) {
  if (PLACEHOLDER_QQ.has(digits)) return true;
  if (/^(\d)\1+$/.test(digits)) return true;              // 全同数字 111…/222…
  let ascending = true;                                    // 顺序数字 1234…
  for (let i = 1; i < digits.length; i += 1) {
    if (digits.charCodeAt(i) !== digits.charCodeAt(i - 1) + 1) { ascending = false; break; }
  }
  return ascending;
}

// QQ 号要单独判：只报「不像占位符」的
const QQ_CONTEXT_RE = /\b(?:private|group):(\d{5,11})\b/g;


function collectSecretsFromConfig() {
  // 从 config.json 读出真实值（如果存在），用于精确匹配；读不到就跳过。
  const out = [];
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    for (const v of [cfg?.snowluma?.accessToken, cfg?.dsh?.token, String(cfg?.ownerQQ ?? '')]) {
      if (typeof v === 'string' && v.length >= 8) out.push(v);
    }
  } catch { /* 没有 config.json 就只跑模式匹配 */ }
  return out;
}

const secrets = collectSecretsFromConfig();

// 本机真实路径（从环境变量与 config.json 推导）—— 比上面那条通用模式更准，
// 能抓到 用户目录 / 仓库所在目录 / SnowLuma 安装目录 这类"只有这台机器才成立"的字符串。
// 同一个路径在源码里可能写成单反斜杠，也可能写成双反斜杠（转义），两种都要查。
// 标准/约定路径：不是本机隐私，出现在仓库里是正常的（SnowLuma 官方默认安装目录、Windows 系统目录）。
// 注意这里只放**约定**，不放仓库自身所在目录 —— 工作区路径仍应算本机信息。
const ALLOWED_LOCAL_PATH_RES = [
  /^[a-z]:\\snowluma(\\|$)/i,
  /^[a-z]:\\program files( \(x86\))?(\\|$)/i,
  /^[a-z]:\\windows(\\|$)/i
];
const isConventionalPath = (value) => ALLOWED_LOCAL_PATH_RES.some((re) => re.test(value));

function collectLocalPaths() {
  const out = new Set();
  const add = (value) => {
    const v = String(value ?? '').trim().replace(/[\\/]+$/, '');
    if (v.length >= 6 && /[\\/]/.test(v) && !isConventionalPath(v)) out.add(v);
  };
  add(ROOT);
  add(process.env.USERPROFILE);
  add(process.env.LOCALAPPDATA);
  add(process.env.APPDATA);
  add(process.env.ProgramFiles);
  add(process.env['ProgramFiles(x86)']);
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    for (const key of ['homeDir', 'launcherPath']) add(cfg?.snowluma?.[key]);
  } catch { /* 没有 config.json 就只靠环境变量 */ }
  return [...out];
}
const localPaths = collectLocalPaths();
/** 同一路径的两种写法（原样 + 双反斜杠转义），命中任一即算。 */
function pathVariants(value) {
  const escaped = value.replace(/\\/g, '\\\\');
  return escaped === value ? [value] : [value, escaped];
}

const hits = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full);
      continue;
    }
    if (/\.(png|jpg|jpeg|gif|webp|mp4|zip|node_modules)$/i.test(entry.name)) continue;
    // .gitignore 里已排除的东西不算问题（它们本来就不入库）
    if (/^config\.json/.test(rel) || /\.bak(-|$)/.test(rel) || rel.startsWith('state/')) continue;

    let text;
    try {
      if (fs.statSync(full).size > 5 * 1024 * 1024) continue;
      text = fs.readFileSync(full, 'utf8');
    } catch { continue; }

    for (const { name, re } of PATTERNS) {
      const m = re.exec(text);
      if (m) hits.push({ rel, line: text.slice(0, m.index).split('\n').length, name, sample: m[0].slice(0, 40) });
    }
    for (const m of text.matchAll(QQ_CONTEXT_RE)) {
      if (isPlaceholderQq(m[1])) continue;
      hits.push({ rel, line: text.slice(0, m.index).split('\n').length, name: '疑似真实 QQ 号', sample: m[0] });
    }
    for (const secret of secrets) {
      const idx = text.indexOf(secret);
      if (idx >= 0) hits.push({ rel, line: text.slice(0, idx).split('\n').length, name: 'config.json 中的真实凭据', sample: `${secret.slice(0, 6)}…` });
    }
    for (const localPath of localPaths) {
      const hit = pathVariants(localPath).find((variant) => text.includes(variant));
      if (hit !== undefined) {
        hits.push({ rel, line: text.slice(0, text.indexOf(hit)).split('\n').length, name: '本机路径（环境/配置推导）', sample: `${hit.slice(0, 30)}…` });
      }
    }
  }
}

walk(ROOT);

if (hits.length === 0) {
  console.log('✅ 未发现敏感信息（已跳过 .gitignore 排除项：config.json / state/ / *.bak）');
  process.exit(0);
}

console.error(`❌ 发现 ${hits.length} 处疑似敏感信息，先脱敏再提交：\n`);
for (const h of hits) console.error(`   ${h.rel}:${h.line}  [${h.name}]  ${h.sample}`);
console.error('\n提示：文档里的示例请用占位符（<ownerQQ>、<token>、<用户目录>）代替真实值。');
process.exit(1);
