// 最小假的 SnowLuma / OneBot v11 服务端 —— 用于在没有 QQ 的情况下端到端验证桥接。
//
// 用途：在 ws://127.0.0.1:3001 起一个 OneBot v11 正向 WebSocket 服务端，
// 连接建立后注入一条来自 owner 的私聊消息，并打印桥接回发到 QQ 的内容。
//
// 用法：
//   node scripts/fake-onebot.mjs                     # 默认 150 秒后汇总退出
//   FAKE_PROMPT="你好" FAKE_RUN_MS=60000 node scripts/fake-onebot.mjs
//
// 配套：config.json 里 snowluma.wsUrl 指到 ws://127.0.0.1:3001、
// snowluma.httpUrl 指到 http://127.0.0.1:3000，ownerQQ 与 FAKE_OWNER_QQ 一致，
// 且该 QQ 在 allow.private 白名单里。
import http from 'node:http';
import { WebSocketServer } from 'ws';

const BOT_QQ = Number(process.env.FAKE_BOT_QQ ?? 20002);
const OWNER_QQ = Number(process.env.FAKE_OWNER_QQ ?? 10001);
const PROMPT = process.env.FAKE_PROMPT ?? '只回复两个字：收到';
const RUN_MS = Number(process.env.FAKE_RUN_MS ?? 150000);
const INJECT_DELAY_MS = Number(process.env.FAKE_INJECT_DELAY_MS ?? 4000);

const ts = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(ts(), '[fake-onebot]', ...a);

const httpServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    log('HTTP API <-', req.method, req.url, body.slice(0, 160));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } }));
  });
});
httpServer.listen(3000, '127.0.0.1', () => log('HTTP API 监听 127.0.0.1:3000'));

function apiData(action) {
  if (action === 'get_login_info') return { user_id: BOT_QQ, nickname: '小鲸鱼' };
  if (action === 'send_private_msg' || action === 'send_msg') return { message_id: Math.floor(Math.random() * 1e6) };
  if (action === 'get_group_list' || action === 'get_friend_list' || action === 'get_group_member_list') return [];
  if (action === 'get_version_info') return { app_name: 'fake-onebot', app_version: '1.0.0' };
  return {};
}

const seen = { api: [], events: 0, replies: [] };

const wss = new WebSocketServer({ port: 3001, host: '127.0.0.1' });
wss.on('listening', () => log('OneBot WS 监听 127.0.0.1:3001'));

wss.on('connection', (ws, req) => {
  log('✅ bridge 已连上:', req.url);
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.echo === undefined) { seen.events += 1; return; }
    seen.api.push(msg.action);
    const isSend = /^send_/.test(String(msg.action));
    if (isSend) {
      const text = JSON.stringify(msg.params?.message ?? msg.params ?? '');
      seen.replies.push(text);
      log('📤 桥接发往 QQ 的消息:', text.slice(0, 240));
    } else {
      log('   API <-', msg.action, JSON.stringify(msg.params ?? {}).slice(0, 120));
    }
    ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: apiData(msg.action), echo: msg.echo }));
  });
  ws.on('close', () => log('bridge 断开连接'));
  ws.on('error', (e) => log('WS 错误:', e.message));

  setTimeout(() => {
    const evt = {
      post_type: 'message', message_type: 'private', sub_type: 'friend',
      message_id: 1, user_id: OWNER_QQ, self_id: BOT_QQ,
      time: Math.floor(Date.now() / 1000),
      sender: { user_id: OWNER_QQ, nickname: '主人' },
      message: [{ type: 'text', data: { text: PROMPT } }],
      raw_message: PROMPT, font: 0,
    };
    log(`注入私聊消息（来自 owner ${OWNER_QQ}）: ${PROMPT}`);
    ws.send(JSON.stringify(evt));
  }, INJECT_DELAY_MS);
});

setTimeout(() => {
  console.log('');
  log('===== 汇总 =====');
  log('收到的事件数:', seen.events);
  log('收到的 API 调用:', [...new Set(seen.api)].join(', ') || '(无)');
  log('桥转发回 QQ 的消息数:', seen.replies.length);
  seen.replies.forEach((r, i) => log(`  [${i}]`, r.slice(0, 300)));
  process.exit(seen.replies.length > 0 ? 0 : 1);
}, RUN_MS);
