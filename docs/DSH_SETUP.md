# DSH 端安装说明（另一台设备）

> ⚠️ **本仓库已移植到 DSH 0.1.2（gateway 协议）。** 0.1.1 的
> `@deepseek-ai/dsh-host-apiproxy` 在 0.1.2-alpha.1 起被删除，安装流程与
> `setup-dsh.mjs` 的挂载方式都已改变。**先读
> [`PORTING-DSH-0.1.2.md`](../PORTING-DSH-0.1.2.md)**（协议差异、端点映射、
> DSH 端安装的新做法与实测结果）。下面第 4、5 步的说明已按 0.1.2 更新。

`qq-bridge` 仓库本身包含桥接、控制台和插件，但 **DSH 端的两个聊天模式（`qq-chat` / `qq-chat-v2`）以及 MCP 挂载** 不在仓库根目录，需要通过本说明安装到目标设备的 DSH 环境中。

## 安装步骤

在目标设备上：

1. **克隆/获取仓库**：

   ```bash
   git clone https://github.com/Derpyu520/qq-bridge.git
   cd qq-bridge
   ```

2. **安装依赖**：

   ```bash
   npm install
   ```

   > `postinstall` 会自动修补 `@snowluma/sdk` 的 ESM 打包 bug。

3. **创建配置文件**：

   ```bash
   cp config.example.json config.json
   ```

   > Windows CMD 用户请用：`copy config.example.json config.json`

   然后编辑 `config.json`，填写：

   - `snowluma.wsUrl` / `httpUrl`（例如 `ws://127.0.0.1:3001` / `http://127.0.0.1:3000`，分别对应 OneBot WebSocket 与 HTTP API 端口）
   - `snowluma.accessToken`
   - `ownerQQ`
   - `allow.private` / `allow.groups`

4. **运行 DSH 端安装脚本**：

   ```bash
   node scripts/setup-dsh.mjs            # 可加 --dry-run 先预览
   ```

   默认安装到 `web` profile；如果 DSH 使用其他 profile，可以传参：

   ```bash
   node scripts/setup-dsh.mjs <profile名>
   ```

   脚本会完成：

   - 安装 agent preset：`$DSH_HOME/.agent-presets/qq-chat`、`$DSH_HOME/.agent-presets/qq-chat-v2`
   - 在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`（**用户 patch 层**）挂载：
     - `mcp-snowluma`（`src/mcp-snowluma-safe.js`）
     - `mcp-snowluma-host`（`src/mcp-host-server.js`）
     - `mcp-web-search-safe`（`src/mcp-web-search-safe.js`）
     - `qq-mode-console` 插件（DSH 设置页的 qq-mode 卡片），用 `file://` specifier 直接引用
   - 创建本地 `state/mode.json`（`mode: reserved2`）作为 DSH settings 不可用时的兜底

   > **0.1.2 起不再改动 profile 的 `package.json`，也不需要 `dsh` CLI。**
   > 旧版会往 `package.json` 写 `link:` 依赖并追加 `dsh.profile.bundles`，
   > 再靠 `dsh plugin --profile <p> install` 安装；在 DSH Desktop 上这套会和
   > market 生成器打架、且 `dsh` CLI 往往不在 PATH，一旦 bundles 里登记了
   > 解析不到的 bundle，DSH 直接起不来。详见 PORTING-DSH-0.1.2.md 第 6 节。

   > 脚本可重复运行；会覆盖 `$DSH_HOME/.agent-presets/qq-chat*`、重建 patch 区块。
   > 写 `cordis.patch.yml` 前会自动备份为 `cordis.patch.yml.bak-<时间戳>`。
   > 已存在的 `state/mode.json` 会被保留（不覆盖用户设置）；全新安装才写入 `mode: reserved2`。
   > 移动/重新 clone 仓库后请重跑一次，否则 DSH 里的 MCP/插件绝对路径会指向旧位置。
   > 也可用环境变量指定 DSH 根目录：`DSH_HOME=/path/to/.dsh node scripts/setup-dsh.mjs <profile>`。

5. **生效方式（0.1.2：多数情况下无需重启）**：

   - **agent preset 立即生效**：DSH 的 preset 名单是按需从磁盘读取的，
     跑完脚本后新建会话就能在列表里看到 `QQ 聊天角色` / `QQ 聊天角色（二代仿真）`。
   - **profile 的 patch 层是 live reload**：MCP 与 `qq-mode` 卡片通常也会即时生效。
     可以用 `node scripts/dsh-status.mjs` 确认：
     `qq-mode` 命名空间是否出现、`pluginInventory` 里四个条目是否 `active`。
   - 若没看到 `mcp__snowluma__*` 工具或 qq-mode 设置卡片，重启一次 DSH。

   > 默认模式为 **`reserved2`（二代仿真）**。**装上 `qq-mode-console` 后，
   > 请在 DSH 设置页的 `qq-mode` 卡片切模式** —— 桥接控制台里的模式切换只写
   > `state/mode.json`，而 `refreshMode()` 优先读 DSH 设置，会在几秒后被覆盖。

6. **验证是否装好**（不必启动 QQ）：

   ```bash
   node scripts/dsh-status.mjs          # preset / 命名空间 / 插件清单
   node scripts/test-preset-012.mjs     # preset 能否真实建会话并跑完一回合
   ```

## 验证是否装好

1. **DSH WebUI 设置页**：应能看到 `qq-mode` 配置卡片，可切换 `chat` / `closed-agent` / `reserved` / `reserved2`。
2. **新建会话时**：agent preset 列表中应能看到：
   - `QQ 聊天角色`（`qq-chat`）
   - `QQ 聊天角色（二代仿真）`（`qq-chat-v2`）
3. **工具列表**：QQ 会话中应能看到 `mcp__snowluma__*`、`mcp__snowluma-host__*`、`mcp__web-search-safe__*` 等工具；不应看到 `dev_*` 等开发工具。

以上三条都可以用 `node scripts/dsh-status.mjs` 一次性核对
（它会打印 preset 名单、设置命名空间、工作区和插件清单）。

## 常见问题

- **看不到 `qq-mode` 设置卡片**：跑 `node scripts/dsh-status.mjs` 看命名空间里有没有 `qq-mode`，
  以及 `pluginInventory` 里 `include:qq-mode-console` 是否 `active`。
  0.1.2 起该插件是挂在 `cordis.patch.yml` 的 `file://` 条目上，
  **不再涉及 profile 的 `package.json`**；条目在但不 active 时重启一次 DSH。
- **MCP 工具没有出现**：确认 `cordis.patch.yml` 中三个 MCP 条目的路径指向当前仓库，
  并确认 `pluginInventory` 里 `include:mcp-snowluma*` 是 `active`；必要时重启 DSH。
- **preset 没有出现**：确认 `$DSH_HOME/.agent-presets/qq-chat` 和 `qq-chat-v2` 存在
  （`DSH_HOME` 在 DSH Desktop 上是 `%APPDATA%\dsh-desktop\harness`）。
  preset 名单是按需从磁盘读取的，一般无需重启。
- **启动 DSH 报 `failed to parse overlay cordis.patch.yml: YAMLException`**：多为历史版脚本残留的空数组 `[]` 引发。重新运行最新版脚本（会自动剥离）即可，或手动删除该文件里独立成行的 `[]` 后重启 DSH。
- **启动 DSH 报 `cannot resolve profile bundle "qq-mode-console"`**：这是 **0.1.1 时代旧脚本**留下的状态 ——
  旧版会把 `qq-mode-console` 写进 profile 的 `dsh.profile.bundles` 却不一定装得上。
  0.1.2 适配版已不再这样挂载。修复：从 profile 的 `package.json` 里删掉
  `qq-mode-console` 依赖与 bundles 条目（照着 `cordis.patch.yml.bak-*` 备份比对），
  然后重跑 `node scripts/setup-dsh.mjs`。
- **发送消息报 `unauthorized` / HTTP 401**：`config.json` 的 `snowluma.accessToken` 与 SnowLuma 的 OneBot 实例 token 不一致。将 SnowLuma WebUI 中 HTTP 与 WebSocket 两端的 accessToken 设为相同，再填入 `config.json`，然后重启桥。
- **发送消息报 HTTP 426（Upgrade Required）**：说明 `config.json` 里的 `snowluma.httpUrl` 指向了 **WebSocket 端口**。`httpUrl` 必须是 OneBot 的 **HTTP API 地址**（例如 `http://127.0.0.1:3000`），而 `wsUrl` 才是 WebSocket 地址（例如 `ws://127.0.0.1:3001`）。请在 SnowLuma WebUI 的 OneBot 配置里分别确认 HTTP 和 WebSocket 的端口。也可以运行诊断脚本：
   ```bash
   node scripts/check-onebot-status.mjs
   ```
- **桥接报连不上 DSH / DSH 启动令牌未知**：DSH Desktop 每次启动都会换端口和启动令牌，
  客户端的默认行为是自动从 `%APPDATA%\dsh-desktop\logs\harness.log` 里最后一条
  `dsh web: <url>?token=…` 发现。若你的日志路径不同，在 `config.json` 里显式指定
  `dsh.baseUrl` 与 `dsh.token`（或设 `DSH_HARNESS_LOG` / `DSH_HARNESS_TOKEN` 环境变量）。
