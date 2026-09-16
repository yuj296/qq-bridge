// 共享的敏感信息审计正则：桥接回复、MCP 发送、审批/提问文本等统一使用，避免两处维护不一致。
//
// 2026-09-15 补强（审计发现）：原先只认「关键词 + 赋值」一种形态，实测 15 个样本只命中 6 个 ——
// `sk-…`、`ghp_…`、`github_pat_…`、`AKIA…`、JWT、`-----BEGIN … PRIVATE KEY-----`、
// `~/.ssh/…`、`%APPDATA%\…` 这些**裸密钥与家目录写法全部漏过**。而它决定两件事：
//   ① 非管理员会话的回复要不要脱敏；② `/api/send/*` 的消息能不能发出去。
//
// 拆成多条独立规则再由 source 拼成一个总正则（等价于「任一命中」）：
// 单条巨大正则手写括号极易出错（改这一版时就写出过 Unmatched ')' ），拆开更好维护。
const SENSITIVE_PATTERNS = [
  // ── 本机/网络路径 ────────────────────────────────────────────────────────
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|]+/,          // C:\... / C:/...
  /\\\\([^\\]+\\\\)+/,                                    // \\server\share
  /(?<![A-Za-z0-9])(?:\/home\/|\/Users\/|\/etc\/|\/var\/)[^\s"'<>|]*/,
  /(?<![\w])~[\\/][^\s"'<>|]*/,                           // ~/.ssh/id_rsa
  /%[A-Za-z_]+%[\\/][^\s"'<>|]*/,                         // %APPDATA%\...
  // ── 关键词 + 赋值（需带赋值关系，避免误伤正常聊天） ──────────────────────
  /(?:token|密码|密钥|口令|password|passwd|secret|api[_-]?key|authorization|bearer|access[_-]?key|credential)(?:\s*(?:[:=：]|是|为)\s*[^\s，。；、]{3,}|\s+[A-Za-z0-9_\-./]{3,})/,
  // ── 裸密钥（前缀型，都带左边界防误判，例如 task-runner-… 不该命中 sk-） ──
  /(?<![A-Za-z0-9])(?:sk|rk|pk)-[A-Za-z0-9_-]{20,}/,      // OpenAI 等
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}/,           // GitHub PAT
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}/,
  /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}/,                     // AWS
  /(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{10,}/,         // Slack
  /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // ── 腾讯 CDN 下载签名（图片链接里的 rkey 是短期凭据，不该外发） ──────────
  /(?<![A-Za-z0-9])(?:rkey|fileid|skey|p_skey)=[A-Za-z0-9_-]{8,}/
];

export const SENSITIVE_RE = new RegExp(SENSITIVE_PATTERNS.map((re) => `(?:${re.source})`).join('|'), 'i');
