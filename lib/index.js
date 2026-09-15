// qq-bridge —— bundle 宿主入口（DSH Node 进程）
//
// 这是「qq-bridge 作为一个 DSH 插件包」的宿主行：package.json 里的
// `dsh.bundle.patch` 指向同目录的 cordis.patch.yml，那里面会插入本行
// （id: qq-bridge-host，name: 'qq-bridge'）以及两个 UI 插件行。
//
// 它刻意保持**零依赖、绝不抛异常**：宿主启动阶段任何抛出都会让整个
// harness 起不来（见 AGENTS.md 的坑）。目前它只做一件有用的事 ——
// 启动时检查 config.json 是否存在，缺了就打印一条中文提示，
// 免得用户面对「什么都没发生」猜半天。
//
// 真正的业务：QQ ↔ DSH 桥接是独立进程（src/bridge.js），由侧边栏「唤醒」
// 按键（plugins/qq-wake）或 start.bat 拉起；MCP 工具由三个 mcp-*.js 提供。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 插件名（cordis 行的稳定标识）。 */
export const name = 'qq-bridge';

/** 不依赖任何宿主服务：只读一个文件、打一条日志。 */
export const inject = [];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 挂载时的第一件事：确认配置在不在，并给出可执行的下一步提示。
 * 任何异常都在内部吞掉 —— 宿主插件不允许把启动流程带崩。
 */
export function apply(ctx) {
  try {
    const configPath = path.join(ROOT, 'config.json');
    if (fs.existsSync(configPath)) {
      ctx?.logger?.info?.(`[qq-bridge] 已加载（${ROOT}）；机器人由侧边栏「唤醒」按键或 start.bat 启动`);
    } else {
      ctx?.logger?.warn?.(
        `[qq-bridge] 没找到 ${configPath} —— 先复制 config.example.json 为 config.json 并填 ownerQQ/白名单；`
        + '完整步骤见 INSTALL.md'
      );
    }
  } catch {
    /* 宿主插件里的异常一律吞掉 */
  }
}
