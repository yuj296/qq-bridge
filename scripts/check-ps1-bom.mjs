// 护栏：`tools/*.ps1` 必须保持 **UTF-8 with BOM**，`*.bat` 必须纯 ASCII。
//
//   node scripts/check-ps1-bom.mjs
//
// 为什么要有这支：
// Windows PowerShell 5.1 读**无 BOM** 的 UTF-8 `.ps1` 会按 GBK/ANSI 解析 —— 含中文的脚本会报
// 一堆莫名的语法错误（报错文本里能看到 `鎵嬪姩` 这类 UTF-8 被当 GBK 读的乱码），而且用 pwsh(7)
// 测不出来（它按 UTF-8 读）。本机踩过两次：
//   ① 手写脚本忘了加 BOM；
//   ② **改写文件后 BOM 被去掉** —— 2026-09-16 用编辑工具改了 dsh-qq-bot.ps1 的配置段，
//      两个 .ps1 的 BOM 静默消失，PowerShell 解析直接报 9 + 3 个语法错误。
// 所以"改完 .ps1 必须确认 BOM 还在"不能只靠记性，得有一支能跑的检查。
//
// 退出码：0 = 全部合规；1 = 有文件缺 BOM 或含非 ASCII。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOM = [0xEF, 0xBB, 0xBF];

/** 收集仓库根 + tools + scripts 下的 .ps1 / .bat（不递归 node_modules）。 */
function collect(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      collect(path.join(dir, entry.name), out);
    } else if (/\.(ps1|bat|cmd)$/i.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const targets = [...new Set([
  ...collect(path.join(ROOT, 'tools')),
  ...collect(path.join(ROOT, 'scripts')),
  ...fs.readdirSync(ROOT).filter((n) => /\.(bat|cmd)$/i.test(n)).map((n) => path.join(ROOT, n))
])].sort();

let failures = 0;
console.log(`=== .ps1 必须 UTF-8 with BOM，.bat/.cmd 必须纯 ASCII（${targets.length} 个文件）===`);
for (const file of targets) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const buf = fs.readFileSync(file);
  const hasBom = buf[0] === BOM[0] && buf[1] === BOM[1] && buf[2] === BOM[2];
  const isPs1 = /\.ps1$/i.test(file);
  if (isPs1) {
    if (hasBom) {
      console.log(`  ✓ ${rel}`);
    } else {
      failures += 1;
      console.log(`  ✗ ${rel}  —— 缺 UTF-8 BOM（PowerShell 5.1 会按 GBK 解析，中文脚本必炸）`);
    }
    continue;
  }
  const nonAscii = buf.findIndex((byte) => byte > 0x7F);
  if (nonAscii < 0) {
    console.log(`  ✓ ${rel}  （纯 ASCII）`);
  } else {
    failures += 1;
    console.log(`  ✗ ${rel}  —— 含非 ASCII 字节（偏移 ${nonAscii}）：.bat 里出现中文会按 GBK 解析，改成纯 ASCII 或换 .ps1`);
  }
}

console.log(failures === 0 ? '\n✅ 编码合规' : `\n❌ ${failures} 个文件编码不合规`);
process.exit(failures === 0 ? 0 : 1);
