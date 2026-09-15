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
    '自启守护心跳（可选件，默认不装；不装就是空的）': status.supervisor.at || '（无）',
    bridge: status.bridge.ok ? 'ok' : status.bridge.error,
    onebot: status.onebot.ok ? status.onebot.login : status.onebot.error,
    awake: status.awake
  }, null, 2));
  exitCleanly(status.awake ? 0 : 1);
} else if (argv.includes('--guards')) {
  // 「守护规则」自测：并发唤醒只能跑一次；链路没起来时缺 SnowLuma 要干净失败。
  let failures = 0;
  const check = (name, ok, extra = '') => {
    console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
    if (!ok) failures += 1;
  };
  log('守护规则自测…');

  const first = runWake({ send: false, log: () => {} });
  const second = runWake({ send: false, log: () => {} });
  check('并发调用复用同一次唤醒（单飞锁）', first === second);

  const result = await first;
  check('这一次唤醒成功（说明当前链路是通的）', result.ok === true, result.error ?? '');

  const third = runWake({ send: false, log: () => {} });
  check('上一轮结束后锁已释放，可以再唤醒', third !== first);
  await third;

  const status = await probeStatus();
  if (status.onebot.ok) {
    log('  · OneBot 正在跑，跳过「SnowLuma 目录不存在」那条（它只在链路没起来时才走）');
  } else {
    const bad = await runWake({
      send: false,
      snowlumaDir: 'D:\\definitely-not-here',
      timeoutMs: 5000,
      log: () => {}
    });
    check('SnowLuma 目录不存在 → 干净失败（不崩不卡）', bad.ok === false && /找不到/.test(bad.error ?? ''), bad.error ?? '');
  }

  log(failures === 0 ? '✅ 守护规则全部通过' : `❌ ${failures} 项失败`);
  exitCleanly(failures === 0 ? 0 : 1);
} else {
  log(`开始唤醒流程（send=${!noSend}）…`);
  const result = await runWake({ send: !noSend, log });
  for (const step of result.steps) log(`  ${step.ok ? '✓' : '✗'} ${step.name}：${step.detail ?? ''}`);
  log(result.ok ? `✅ 唤醒成功${result.skippedSend ? '（未发消息）' : `，已发送：${result.message}`}` : `❌ 唤醒失败：${result.error}`);
  exitCleanly(result.ok ? 0 : 1);
}
