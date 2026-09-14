// 端到端验证：新 dsh-client 对着真实 DSH Desktop 跑通全链路
// 用法：node scripts/test-dsh-012.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeApiClient, unwrap, createTurnCollector, exitCleanly } from '../src/dsh-client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const api = new NodeApiClient(undefined, 60000);
const step = (n, v) => console.log(`\n[${n}]`, typeof v === 'string' ? v : JSON.stringify(v).slice(0, 400));

step('resolveBase', api.resolveBase());
await api.authenticate();
step('auth', `cookie=${String(api.cookie).split('=')[0]}  (base=${api.base})`);

const host = unwrap(await api.host.describe({}), 'host.describe');
step('host.describe(存活探测)', `ok, ${host.presets?.length ?? '?'} presets`);

const settings = unwrap(await api.settings.describe({}), 'settings.describe');
step('settings.describe', { namespaces: settings.namespaces.length, hasQqMode: settings.namespaces.some((n) => n.ns === 'qq-mode') });

const presets = unwrap(await api.agentPresets.list({}), 'agentPresets.list');
step('agentPresets.list', presets.presets.map((p) => p.id));

const wsList = unwrap(await api.workspace.list({}), 'workspace.list');
step('workspace.list', wsList.items.map((w) => `${w.title}(${w.workspaceId.slice(0, 8)})`));

// 隔离的测试工作区
const dir = path.join(ROOT, 'state', '_porttest');
fs.mkdirSync(dir, { recursive: true });
const created = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
step('workspace.create', { created: created.created, id: created.workspace.workspaceId.slice(0, 8) });

const session = unwrap(await api.sessions.create({ workspaceId: created.workspace.workspaceId }), 'session.create');
step('session.create', session);

api.trackSession(session.sessionId);

// 事件流
const frames = [];
const collector = createTurnCollector();
let finished = null;
const muxAbort = new AbortController();
const muxTask = (async () => {
  for await (const envelope of api.events.mux({}, muxAbort.signal)) {
    const frame = envelope.payload;
    if (frame.type !== 'session/event' || frame.sessionId !== session.sessionId) continue;
    frames.push(frame.event.type);
    const ended = collector.push(frame.event);
    if (ended && !finished) { finished = ended; break; }
  }
})().catch((e) => console.log('  mux error:', e.message));

await new Promise((r) => setTimeout(r, 1500)); // 等 session/follow 建立

step('prompt', '...');
const accepted = await api.sessions.prompt({
  sessionId: session.sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: '只回复两个字：收到' }],
});
step('prompt result', accepted.result);

const deadline = Date.now() + 120000;
while (!finished && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
muxAbort.abort();
await muxTask.catch(() => {});

step('事件类型', [...new Set(frames)]);
step('turn 结束', finished ? { reason: finished.reason?.kind ?? finished.reason, text: JSON.stringify(finished.text) } : '超时未收到 turn/end');

// 清理
try { unwrap(await api.workspace.archiveSession({ sessionId: session.sessionId }), 'archive'); step('清理', '会话已归档'); } catch (e) { step('清理失败', e.message); }
try { await api.workspace.delete({ workspaceId: created.workspace.workspaceId }); step('清理', '工作区已删除'); } catch (e) { step('清理失败', e.message); }
api.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
exitCleanly(0);
