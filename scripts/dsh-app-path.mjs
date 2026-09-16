// 解析 DSH Desktop 的应用目录 —— 测试脚本用它 require DSH 自带的 react / jsdom / schemastery。
//
// 为什么单独抽出来：以前这四个测试脚本各自写死了一条「C 盘用户目录下的 DSH 安装路径」，
// 既换机器就废，又会把本机用户名带进公开仓库（2026-09-16 审计实测：远端 fork 里真的带着它）。
//
// 解析顺序：显式环境变量 → 本机常见安装位置（LOCALAPPDATA / ProgramFiles）→ 找不到就返回空串。
// 调用方拿到空串时必须**显式**报告"跳过"，不要把缺依赖当成通过（见 AGENTS.md 坑 21）。

import fs from 'node:fs';
import path from 'node:path';

/** 候选目录（去重、去过空值），按优先级排列。 */
function candidates() {
  const list = [
    process.env.DSH_DESKTOP_APP,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'DSH Desktop', 'resources', 'app'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'DSH Desktop', 'resources', 'app'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'DSH Desktop', 'resources', 'app')
  ];
  return [...new Set(list.filter((item) => typeof item === 'string' && item.trim() !== ''))];
}

/**
 * @returns {string} DSH 应用目录的绝对路径；找不到返回 ''（调用方据此显式跳过）。
 */
export function resolveDshApp() {
  for (const dir of candidates()) {
    try {
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    } catch {
      // 单个候选不可读就试下一个（这里刻意不记日志：探测失败是常态，调用方会统一报告结果）
    }
  }
  return '';
}

/** 给"跳过"提示用的一句话：告诉使用者为什么跳、以及怎么让它跑起来。 */
export function dshAppHint() {
  return '找不到 DSH Desktop 应用目录（可用环境变量 DSH_DESKTOP_APP 指定，例如 ...\\DSH Desktop\\resources\\app）';
}

/**
 * 缺少 DSH 自带依赖时的统一出口 —— **跳过不等于通过**。
 * 退出码约定：0 = 通过；1 = 有断言失败；2 = 跳过（本支没有验证任何东西）。
 * 以前这里是 `process.exit(0)`，于是"拿不到 jsdom 就没跑"和"全绿"在调用方看来一模一样，
 * 而坑 19（设置页输入框打不进字）的唯一护栏正是其中之一（2026-09-16 审计）。
 * @param {string} reason 为什么跳过（会原样打印）。
 */
export function exitSkipped(reason) {
  console.log(`⚠️ 跳过（本支未验证任何东西）：${reason}`);
  console.log(`   ${dshAppHint()}`);
  process.exit(2);
}
