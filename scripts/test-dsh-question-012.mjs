// 验证 $events waterfall：真实触发一次提问并作答
// 用法：node scripts/test-dsh-question-012.mjs   （会真实跑一轮 agent，较慢）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeApiClient, unwrap, exitCleanly } from '../src/dsh-client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const api = new NodeApiClient(undefined, 60000);
const step = (n, v) => console.log(`\n[${n}]`, typeof v === 'string' ? v : JSON.stringify(v).slice(0, 500));

const dir = path.join(ROOT, 'state', '_porttest');
fs.mkdirSync(dir, { recursive: true });
const created = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
const session = unwrap(await api.sessions.create({ workspaceId: created.workspace.workspaceId }), 'session.create');
step('session', session.sessionId);
api.trackSession(session.sessionId);

let pendingFrame = null;
const seen = [];
const abort = new AbortController();
const muxTask = (async () => {
  for await (const envelope of api.events.mux({}, abort.signal)) {
    const f = envelope.payload;
    seen.push(f.type);
    if (f.type === 'question/requested' || f.type === 'approval/requested') {
      pendingFrame = { envelope, frame: f };
      console.log('\n>>> 收到挂起请求');
      console.log('    envelope.rpcId =', envelope.rpcId);
      console.log('    frame =', JSON.stringify(f).slice(0, 700));
    }
    if (f.type === 'session/event' && f.sessionId === session.sessionId && f.event.type === 'turn/end' && pendingFrame) {
      console.log('    (turn/end，等待回答结束后应还有一轮)');
    }
  }
})().catch((e) => console.log('mux error:', e.message));

await new Promise((r) => setTimeout(r, 1500));

step('prompt', '请调用 ask_user_question 工具问我一个问题：题目「测试」，选项只有 A 和 B。必须调用该工具，不要自己回答。');
await api.sessions.prompt({
  sessionId: session.sessionId,
  mode: 'queue',
  content: [{ type: 'text', text: '请调用 ask_user_question 工具问我一个问题：题目「测试」，选项只有 A 和 B。必须调用该工具，不要自己回答。' }],
});

const deadline = Date.now() + 150000;
while (!pendingFrame && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));

if (!pendingFrame) {
  step('结果', '超时：没有收到 question/requested');
} else {
  const q = pendingFrame.frame.questions?.[0];
  step('问题内容', { id: q?.id, question: q?.question, options: (q?.options ?? []).map((o) => o.label) });
  const label = q?.options?.[0]?.label;
  step('作答', label);
  const receipt = await api.respond({
    type: 'client-response',
    rpcId: pendingFrame.envelope.rpcId,
    result: { ok: true, value: { sessionId: pendingFrame.frame.sessionId, answer: { answers: [{ id: q.id, selected: [label] }] } } },
  });
  step('回执', receipt);
  // 等 agent 继续跑完
  await new Promise((r) => setTimeout(r, 25000));
}

step('收到的帧类型', [...new Set(seen)]);
abort.abort();
await muxTask.catch(() => {});

try { await api.workspace.archiveSession({ sessionId: session.sessionId }); step('清理', '会话已归档'); } catch (e) { step('清理失败', e.message); }
try { await api.workspace.delete({ workspaceId: created.workspace.workspaceId }); step('清理', '工作区已删除'); } catch (e) { step('清理失败', e.message); }
api.close();
try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
exitCleanly(0);
