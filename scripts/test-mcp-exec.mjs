// 测试 @snowluma/mcp 的 write 模式：模拟 DSH MCP 客户端完整握手
// （initialize → tools/list → tools/call），确认动作执行工具可用。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'config.json'), 'utf8'));
const endpoint = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000/').replace(/\/?$/, '/');
const token = cfg.snowluma?.accessToken || '';

const mcpEntry = fileURLToPath(new URL('../node_modules/@snowluma/mcp/dist/server.js', import.meta.url));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [mcpEntry],
  env: {
    SNOWLUMA_MCP_ENDPOINT: endpoint,
    SNOWLUMA_MCP_TOKEN: token,
    SNOWLUMA_MCP_MODE: 'write'
  }
});

const client = new Client({ name: 'bridge-test', version: '0.1.0' });
let failures = 0;
let skipped = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures += 1;
};
const skip = (name, why) => {
  skipped += 1;
  console.log(`  ⚠️ 跳过：${name} —— ${why}`);
};

try {
  await client.connect(transport);
  check('MCP 连接成功', true);

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  // 工具清单由本地 MCP server 提供，与 SnowLuma 在不在线无关 —— 所以是硬断言。
  // 以前这里只打印 ✅/❌ 然后无条件 exit 0：write 模式写坏（缺 invoke_action）也不会有红灯。
  check('write 模式暴露 query_action', names.includes('query_action'), `共 ${names.length} 个工具`);
  check('write 模式暴露 invoke_action', names.includes('invoke_action'));

  if (names.includes('query_action')) {
    try {
      const result = await client.callTool({ name: 'query_action', arguments: { action: 'get_login_info' } });
      const text = JSON.stringify(result);
      check('query_action(get_login_info) 有返回', text.length > 20, text.slice(0, 120));
    } catch (error) {
      skip('query_action 真实调用', `SnowLuma 未运行或未登录：${error?.message ?? error}`);
    }
  }
} catch (error) {
  const reason = String(error?.message ?? error);
  if (/EPERM|Access is denied/i.test(reason)) {
    console.log(`⚠️ 跳过（本机沙箱不允许 spawn MCP 子进程）：${reason}`);
    process.exit(2);
  }
  console.error('❌ MCP 测试失败:', reason);
  process.exit(1);
}

console.log(`\n${failures === 0 ? (skipped === 0 ? '✅ 全部通过' : `⚠️ 通过，但有 ${skipped} 项跳过（未验证）`) : `❌ ${failures} 项失败`}`);
process.exit(failures > 0 ? 1 : (skipped > 0 ? 2 : 0));
