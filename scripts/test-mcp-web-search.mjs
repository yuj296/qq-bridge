// 测试安全 Web Search / Fetch MCP server：
// - web_search：查一个网络用语/梗
// - web_fetch：抓取一个公开 URL 并检查是否返回正文
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = fileURLToPath(new URL('../src/mcp-web-search-safe.js', import.meta.url));
const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
const client = new Client({ name: 'bridge-test', version: '0.1.0' });

let failures = 0;
let skipped = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures += 1;
};
// 需要外网才成立的部分：外网可达性不是本仓库能保证的，所以记为「跳过」而不是失败 ——
// 但**必须显式说出来**，并用退出码 2 表示"有东西没验证"（2026-09-16 审计）。
const skip = (name, why) => {
  skipped += 1;
  console.log(`  ⚠️ 跳过：${name} —— ${why}`);
};

try {
  await client.connect(transport);
  check('Web Search MCP 连接成功', true);
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  check('暴露了 web_search 与 web_fetch', names.includes('web_search') && names.includes('web_fetch'), names.join(', '));

  try {
    const search = await client.callTool({ name: 'web_search', arguments: { query: 'DeepSeek娘 萌娘百科' } });
    const text = String(search.content?.[0]?.text ?? '');
    check('web_search 返回了内容', search.isError !== true && text.length > 20, text.slice(0, 80));
  } catch (error) {
    skip('web_search 真实查询', `外网/账号不可用：${error?.message ?? error}`);
  }

  try {
    const fetch = await client.callTool({
      name: 'web_fetch',
      arguments: { url: 'https://mobile.moegirl.org.cn/DeepSeek%E5%A8%98' }
    });
    const text = String(fetch.content?.[0]?.text ?? '');
    check('web_fetch 取回正文', fetch.isError !== true && text.length > 50, `${text.length} 字符`);
  } catch (error) {
    skip('web_fetch 真实抓取', `外网不可用：${error?.message ?? error}`);
  }

  // SSRF 边界：内网地址**必须**被拒绝 —— 这一条不需要外网，所以是硬断言。
  // 以前这里只打印一行「⚠️ 未被拒绝（异常！）」然后无条件 exit 0，边界坏了也没有红灯。
  const bad = await client.callTool({ name: 'web_fetch', arguments: { url: 'http://127.0.0.1/' } });
  check('内网地址被拒绝（SSRF 边界）', bad.isError === true, String(bad.content?.[0]?.text ?? '').slice(0, 80));
} catch (error) {
  const reason = String(error?.message ?? error);
  // 本机沙箱（workspace-write）不允许 spawn 子进程走 stdio 管道 → MCP 客户端连不上。
  // 这属于"环境不让跑"，不是测试失败：记为跳过（exit 2），既不冒充通过也不冒充失败。
  if (/EPERM|Access is denied/i.test(reason)) {
    console.log(`⚠️ 跳过（本机沙箱不允许 spawn MCP 子进程）：${reason}`);
    process.exit(2);
  }
  console.error('❌ 测试失败:', reason);
  process.exit(1);
}

console.log(`\n${failures === 0 ? (skipped === 0 ? '✅ 全部通过' : `⚠️ 通过，但有 ${skipped} 项跳过（未验证）`) : `❌ ${failures} 项失败`}`);
process.exit(failures > 0 ? 1 : (skipped > 0 ? 2 : 0));
