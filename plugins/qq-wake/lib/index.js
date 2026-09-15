// qq-wake —— 宿主侧（DSH Node 进程）
//
// 只做两件事：注册 /api/qq-wake 路由族，并在路由里调用 wake.js 的唤醒流程。
// 浏览器半侧（./client）负责那个侧边栏按键，两者通过同源 fetch 通信 —— 控制台令牌
// 永远留在宿主侧，不下发到页面。
//
// 信任围栏：只接受本机（loopback）请求 + 同源标记。唤醒会启动进程并真的发一条 QQ
// 消息，虽然内容无害，但没有理由让局域网里的别人触发。
import { runWake, probeStatus, readBridgeConfig, BRIDGE_DIR } from './wake.js';

/** 插件名（cordis 行的稳定标识）。 */
export const name = 'qq-wake';

/** 依赖的宿主服务：注册 HTTP 路由需要 webServer。 */
export const inject = ['webServer'];

/** 路由族前缀。 */
export const ROUTES = {
  status: '/api/qq-wake/status',
  wake: '/api/qq-wake/wake'
};

/** IPv4 回环 127/8、IPv6 ::1、IPv4-mapped ::ffff:127/8。 */
function isLoopbackAddress(address) {
  const value = String(address ?? '');
  if (value === '::1') return true;
  if (value.startsWith('127.')) return true;
  const mapped = value.startsWith('::ffff:') ? value.slice(7) : '';
  return mapped.startsWith('127.');
}

/** 主机头是否指向本机。 */
function isLoopbackHostname(hostHeader) {
  const host = String(hostHeader ?? '').trim().toLowerCase();
  if (!host) return false;
  const bare = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host.split(':')[0];
  return bare === 'localhost' || bare === '::1' || bare.startsWith('127.');
}

/**
 * 请求级信任围栏：socket 地址权威，另加 Host 与浏览器同源标记。
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} write 写操作额外要求 application/json（跨源简单请求无法伪装）。
 */
function passFence(req, write) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return '只允许本机访问';
  if (!isLoopbackHostname(req.headers?.host)) return 'Host 不是本机';
  if (write) {
    const ctype = String(req.headers?.['content-type'] ?? '').toLowerCase();
    if (!ctype.includes('application/json')) return '写操作必须是 application/json';
  }
  const site = String(req.headers?.['sec-fetch-site'] ?? '');
  if (site && site !== 'same-origin' && site !== 'none') return '跨站请求被拒绝';
  const origin = req.headers?.origin;
  if (origin) {
    try {
      if (!isLoopbackHostname(new URL(String(origin)).host)) return '跨站请求被拒绝';
    } catch {
      return 'Origin 无法解析';
    }
  }
  return '';
}

/** 统一的 JSON 输出（控制台/宿主两边的信封都用 { ok, ... }）。 */
function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff'
  });
  res.end(JSON.stringify(body));
}

/** 读一个小 JSON 请求体。 */
async function readJsonBody(req, maxBytes = 8192) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  return JSON.parse(text);
}

/**
 * 注册唤醒路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx 宿主上下文（含 webServer）。
 * @param {object} [config] 插件配置：{ message?: string, bridgeDir?: string, timeoutMs?: number }。
 */
export function apply(ctx, config = {}) {
  const logger = ctx?.logger ?? console;
  const bridgeDir = typeof config.bridgeDir === 'string' && config.bridgeDir.trim() !== ''
    ? config.bridgeDir.trim()
    : BRIDGE_DIR;
  const message = typeof config.message === 'string' && config.message.trim() !== '' ? config.message.trim() : undefined;
  const timeoutMs = Number.isFinite(Number(config.timeoutMs)) && Number(config.timeoutMs) > 0
    ? Number(config.timeoutMs)
    : undefined;

  const routes = [
    {
      kind: 'exact',
      path: ROUTES.status,
      handler: async (req, res) => {
        const denied = passFence(req, false);
        if (denied) return writeJson(res, 403, { ok: false, error: denied });
        if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: '只支持 GET' });
        try {
          const status = await probeStatus(bridgeDir);
          writeJson(res, 200, { ok: true, ...status });
        } catch (error) {
          writeJson(res, 200, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      kind: 'exact',
      path: ROUTES.wake,
      handler: async (req, res) => {
        const denied = passFence(req, true);
        if (denied) return writeJson(res, 403, { ok: false, error: denied });
        if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: '只支持 POST' });
        let body = {};
        try {
          body = await readJsonBody(req);
        } catch (error) {
          return writeJson(res, 400, { ok: false, error: `请求体不合法：${error?.message ?? error}` });
        }
        // 允许单次覆盖文案，但只接受短字符串，避免被当成任意内容外发
        const override = typeof body?.message === 'string' ? body.message.trim().slice(0, 40) : '';
        try {
          readBridgeConfig(bridgeDir);   // 早失败：配置读不到就别去拉进程了
          const result = await runWake({
            send: body?.send !== false,
            message: override || message,
            timeoutMs,
            bridgeDir,
            log: (line) => logger.info(`[qq-wake] ${line}`)
          });
          logger.info(`[qq-wake] 唤醒结果 ok=${result.ok} ${result.error ?? ''}`.trim());
          writeJson(res, result.ok ? 200 : 503, result);
        } catch (error) {
          logger.warn?.(`[qq-wake] 唤醒异常: ${error?.stack ?? error}`);
          writeJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    }
  ];

  try {
    const disposers = routes.map((route) => ctx.webServer.register(route));
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try { dispose(); } catch {}
      }
    }, 'qq-wake: routes');
    logger.info?.(`[qq-wake] 路由已注册：${ROUTES.wake}`);
  } catch (error) {
    // 插件出错不能拖垮整个 DSH 启动
    logger.warn?.(`[qq-wake] 路由注册失败: ${error?.stack ?? error}`);
  }
}
