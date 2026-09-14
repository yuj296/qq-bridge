// 验证 agent preset 能真实建会话并完成一个回合（默认 qq-chat）。
//
// 这是 setup-dsh.mjs 之后的冒烟测试：preset 挂载失败、或 MCP/工具被 preset 挡住，
// 都会在这里表现为建会话报错或回合跑不完。
//
// 用法：node scripts/test-preset-012.mjs [presetId]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeApiClient, unwrap, createTurnCollector, exitCleanly } from '../src/dsh-client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRESET = process.argv[2] ?? 'qq-chat';

const api = new NodeApiClient(undefined, 60000);

const roster = unwrap(await api.agentPresets.list({}), 'agentPresets.list');
const known = roster.presets.find((p) => p.id === PRESET);
if (!known) {
  console.error(`❌ preset "${PRESET}" 不在 DSH 的 preset 名单里。`);
  console.error('   已有:', roster.presets.map((p) => p.id).join(', '));
  console.error('   先跑 node scripts/setup-dsh.mjs 安装。');
  exitCleanly(1);
}
if (known.broken) {
  console.error(`❌ preset "${PRESET}" 在 DSH 侧已标记为无法加载: ${known.broken}`);
  exitCleanly(1);
}
console.log(`✅ preset 存在: ${PRESET} (trust=${known.trust}, name=${known.name ?? ''})`);

const created = unwrap(await api.sessions.create({ agentPreset: PRESET }), 'session.create');
const sid = created.sessionId;
console.log(`✅ 建会话成功: ${sid} (回显 agentPreset=${created.agentPreset})`);
api.trackSession(sid);

const collector = createTurnCollector();
let finished = null;
const types = [];
const abort = new AbortController();
const mux = (async () => {
  for await (const env of api.events.mux({}, abort.signal)) {
    const f = env.payload;
    if (f.type !== 'session/event' || f.sessionId !== sid) continue;
    types.push(f.event.type);
    const ended = collector.push(f.event);
    if (ended && !finished) { finished = ended; break; }
  }
})().catch((e) => console.log('mux:', e.message));

const accepted = unwrap(await api.sessions.prompt({
  sessionId: sid, mode: 'queue', content: [{ type: 'text', text: '只回复两个字：收到' }],
}), 'session.prompt');
console.log('✅ prompt 已接受:', JSON.stringify(accepted));

const deadline = Date.now() + 120000;
while (!finished && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
abort.abort();
await mux.catch(() => {});

let ok = false;
if (finished) {
  ok = String(finished.reason?.kind ?? finished.reason) === 'completed' && Boolean(finished.text?.trim());
  console.log(`${ok ? '✅' : '⚠️'} 回合结束 reason = ${finished.reason?.kind ?? finished.reason}`);
  console.log('🤖 agent 回复:', JSON.stringify(finished.text));
} else {
  console.log('❌ 超时未收到 turn/end');
}
console.log('   收到的完整事件类型:', [...new Set(types)].join(', '));
if (!types.includes('turn/start')) console.log('   ⚠️ 没收到 turn/start —— follow 流可能没赶上回合开始');

try { await api.workspace.archiveSession({ sessionId: sid }); console.log('已归档测试会话'); } catch (e) { console.log('归档失败:', e.message); }
api.close();
exitCleanly(ok ? 0 : 1);
