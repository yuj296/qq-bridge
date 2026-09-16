// 测试桥接自带的 snowluma-host MCP server（status/start/stop）
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = fileURLToPath(new URL('../src/mcp-host-server.js', import.meta.url));

const transport = new StdioClientTransport({ command: process.execPath, args: [entry] });
const client = new Client({ name: 'bridge-test', version: '0.1.0' });

let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures += 1;
};

try {
  await client.connect(transport);
  check('snowluma-host MCP 连接成功', true);
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  // 这三个工具是 agent 控制 SnowLuma 的唯一入口，少了任何一个都该红灯（以前只打印工具清单）。
  const missing = ['snowluma_status', 'start_snowluma', 'stop_snowluma'].filter((n) => !names.includes(n));
  check('暴露了 status / start / stop 三个工具', missing.length === 0, missing.length ? `缺 ${missing.join(', ')}` : names.join(', '));

  // status 无论网关在不在线都应返回结构化文本（网关离线时内容是 ok:false 的说明，不是异常）。
  const status = await client.callTool({ name: 'snowluma_status', arguments: {} });
  const text = String(status.content?.[0]?.text ?? '');
  check('snowluma_status 返回了结构化内容', text.length > 10, text.slice(0, 100).replace(/\s+/g, ' '));
} catch (error) {
  const reason = String(error?.message ?? error);
  if (/EPERM|Access is denied/i.test(reason)) {
    console.log(`⚠️ 跳过（本机沙箱不允许 spawn MCP 子进程）：${reason}`);
    process.exit(2);
  }
  console.error('❌ 测试失败:', reason);
  process.exit(1);
}

console.log(failures === 0 ? '\n✅ 全部通过' : `\n❌ ${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
