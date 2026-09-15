// 唤醒流程自测（不经过 DSH，直接跑宿主侧逻辑）
//
//   node scripts/test-wake.mjs                 # 完整跑一遍（会真的给管理员发一条 QQ 消息）
//   node scripts/test-wake.mjs --no-send       # 只把链路拉起来/探活，不发消息
//   node scripts/test-wake.mjs --status        # 只看状态，不动任何东西
//
// 注意：沙箱里别用 PowerShell 管道捕获本脚本输出（命名管道会被拦），裸跑即可。

import { runWake, probeStatus } from '../plugins/qq-wake/lib/wake.js';

const argv = process.argv.slice(2);
const noSend = argv.includes('--no-send');
const statusOnly = argv.includes('--status');

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const log = (line) => console.log(`${stamp()} ${line}`);

// 不能在 await 完成后的同一个 tick 里 process.exit()：libuv 会断言
// （UV_HANDLE_CLOSING，退出码 -1073740791）。推迟一个 tick 再退。
const exitCleanly = (code) => {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 100).unref?.();
};

if (statusOnly) {
  const status = await probeStatus();
  console.log(JSON.stringify({
    supervisor: status.supervisor,
    bridge: status.bridge.ok ? 'ok' : status.bridge.error,
    onebot: status.onebot.ok ? status.onebot.login : status.onebot.error,
    awake: status.awake
  }, null, 2));
  exitCleanly(status.awake ? 0 : 1);
} else {
  log(`开始唤醒流程（send=${!noSend}）…`);
  const result = await runWake({ send: !noSend, log });
  for (const step of result.steps) log(`  ${step.ok ? '✓' : '✗'} ${step.name}：${step.detail ?? ''}`);
  log(result.ok ? `✅ 唤醒成功${result.skippedSend ? '（未发消息）' : `，已发送：${result.message}`}` : `❌ 唤醒失败：${result.error}`);
  exitCleanly(result.ok ? 0 : 1);
}
