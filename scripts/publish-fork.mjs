// publish-fork.mjs —— 把本仓库的改动推到 GitHub 上的 fork（不依赖 git push）
//
// 为什么不用 git：某些受限环境（例如带沙箱的 agent 终端）里 git 的网络传输走不通
// （remote-https helper 需要命名管道）。这个脚本改走 GitHub 的 Git Data API
// （blobs → tree → commit → ref），一次提交推完所有改动，且**只上传真正变化的文件**。
//
// 用法：
//   node scripts/publish-fork.mjs                       # dry-run：只列出会新增/修改/删除的文件
//   node scripts/publish-fork.mjs --apply               # 真正提交
//   node scripts/publish-fork.mjs --apply --remote=yuj296/qq-bridge --upstream=Derpyu520/qq-bridge
//
// 令牌来源（按顺序，绝不写进仓库）：
//   1) 环境变量 GH_TOKEN
//   2) --token=xxx
//   3) --token-file=D:/path/to/token.txt
//
// 想给某个文件加提交信息？直接用默认的即可；本脚本刻意不做交互。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const APPLY = argv.includes('--apply');
const REMOTE = flag('remote', 'yuj296/qq-bridge');           // 目标 fork
const UPSTREAM = flag('upstream', 'Derpyu520/qq-bridge');    // 用于首次创建 fork
const MESSAGE = flag('message', '');

function resolveToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  const inline = flag('token', '');
  if (inline) return inline.trim();
  const file = flag('token-file', '');
  if (file && fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  throw new Error('没有找到 GitHub 令牌：请设 GH_TOKEN，或用 --token=/--token-file=');
}

const TOKEN = resolveToken();
const [OWNER, REPO] = REMOTE.split('/');

// 不上传的东西。注意不排除 */.bak —— src/dsh-client.0.1.1.js.bak 是上游原文件的
// 对照副本，AGENTS.md 与 PORTING 文档都引用它。带时间戳的备份（*.bak-*）仍排除。
const SKIP_DIRS = new Set(['node_modules', '.git', '.npm-cache', 'state', '.cache']);
const SKIP_FILE = [/^config\.json/, /\.bak-/, /\.log$/, /^_/, /^\.env/];

async function api(method, url, body) {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'publish-fork',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const gitBlobSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

function walk(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) out.push(...walk(path.join(dir, e.name), rel));
    } else if (!SKIP_FILE.some((re) => re.test(e.name))) {
      out.push(rel);
    }
  }
  return out;
}

const me = await api('GET', '/user');
console.log('令牌账号:', me.login);
if (me.login !== OWNER) {
  console.error(`❌ 令牌账号 ${me.login} 与目标 fork 的 owner ${OWNER} 不一致，中止（防止推到别人仓库）`);
  process.exit(1);
}

let fork;
try {
  fork = await api('GET', `/repos/${OWNER}/${REPO}`);
  console.log('目标仓库已存在:', fork.full_name);
} catch {
  console.log('创建 fork…');
  fork = await api('POST', `/repos/${UPSTREAM}/forks`, {});
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const again = await api('GET', `/repos/${OWNER}/${REPO}`);
      if (again.pushed_at) { fork = again; break; }
    } catch { /* 还没准备好 */ }
  }
  console.log('fork 已创建:', fork.full_name);
}

const BRANCH = fork.default_branch || 'main';
const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
const baseCommitSha = ref.object.sha;
const baseCommit = await api('GET', `/repos/${OWNER}/${REPO}/git/commits/${baseCommitSha}`);
const baseTreeSha = baseCommit.tree.sha;

const remoteTree = await api('GET', `/repos/${OWNER}/${REPO}/git/trees/${baseTreeSha}?recursive=1`);
const remote = new Map(remoteTree.tree.filter((t) => t.type === 'blob').map((t) => [t.path, t.sha]));

const localPaths = walk(REPO_ROOT);
const added = []; const modified = []; const unchanged = [];
for (const rel of localPaths) {
  const buf = fs.readFileSync(path.join(REPO_ROOT, rel));
  const sha = gitBlobSha(buf);
  if (!remote.has(rel)) added.push({ rel, buf });
  else if (remote.get(rel) !== sha) modified.push({ rel, buf });
  else unchanged.push(rel);
}
const localSet = new Set(localPaths);
const deleted = [...remote.keys()].filter((p) => !localSet.has(p));

console.log(`\n新增 ${added.length} / 修改 ${modified.length} / 删除 ${deleted.length} / 未变 ${unchanged.length}`);
for (const f of added) console.log(`   + ${f.rel}`);
for (const f of modified) console.log(`   M ${f.rel}`);
for (const f of deleted) console.log(`   - ${f}`);

if (!APPLY) { console.log('\n[dry-run] 加 --apply 才会提交。'); process.exit(0); }
if (!added.length && !modified.length && !deleted.length) { console.log('\n无改动。'); process.exit(0); }

const treeEntries = [];
for (const f of [...added, ...modified]) {
  const blob = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, { content: f.buf.toString('base64'), encoding: 'base64' });
  treeEntries.push({ path: f.rel, mode: '100644', type: 'blob', sha: blob.sha });
}
for (const p of deleted) treeEntries.push({ path: p, mode: '100644', type: 'blob', sha: null });

const tree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, { base_tree: baseTreeSha, tree: treeEntries });
const message = MESSAGE || `同步本地改动（${added.length} 新增 / ${modified.length} 修改 / ${deleted.length} 删除）`;
const commit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, { message, tree: tree.sha, parents: [baseCommitSha] });
await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });

console.log(`\n✅ 已提交 ${commit.sha.slice(0, 8)}: https://github.com/${OWNER}/${REPO}/tree/${BRANCH}`);
