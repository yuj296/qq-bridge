// qq-wake —— 宿主侧（DSH Node 进程）
//
// 只做两件事：注册 /api/qq-wake 路由族，并在路由里调用 wake.js 的唤醒流程。
// 浏览器半侧（./client）负责那个侧边栏按键，两者通过同源 fetch 通信 —— 控制台令牌
// 永远留在宿主侧，不下发到页面。
//
// 信任围栏：只接受本机（loopback）请求 + 同源标记。唤醒会启动进程并真的发一条 QQ
// 消息，虽然内容无害，但没有理由让局域网里的别人触发。
import net from 'node:net';
import { runWake, probeStatusSummary, readBridgeConfig, BRIDGE_DIR } from './wake.js';

/** 插件名（cordis 行的稳定标识）。 */
export const name = 'qq-wake';

/** 依赖的宿主服务：注册 HTTP 路由需要 webServer。 */
export const inject = ['webServer'];

/** 路由族前缀。 */
export const ROUTES = {
  status: '/api/qq-wake/status',
  wake: '/api/qq-wake/wake'
};

/**
 * 严格解析「点分十进制 IPv4」，且必须是 127/8。
 *
 * 这里**绝不能**用 `value.startsWith('127.')`：那样 `127.0.0.1.evil.com` 也会命中，
 * 于是「域名解析到 127.0.0.1」的 DNS 重绑定攻击就能带着
 * `Host: 127.0.0.1.evil.com` + `Origin: http://127.0.0.1.evil.com` 走进来 ——
 * 浏览器视角它是同源（sec-fetch-site 也是 same-origin），围栏全线放行。
 * 实测过：改之前这个请求拿到 200（见 PORTING §8.5）。
 * @param {string} value 待判定字符串
 */
function isLoopbackIpv4(value) {
  const matched = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!matched) return false;
  const octets = matched.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  return octets[0] === 127;
}

/** 取 Host / URL.host 里的裸主机名（去掉端口、拆掉 IPv6 方括号）。 */
function bareHostname(hostHeader) {
  const host = String(hostHeader ?? '').trim().toLowerCase();
  if (!host) return '';
  if (host.startsWith('[')) {
    // 方括号形式必须严格是 `[地址]` 或 `[地址]:端口`。
    // 以前只找 `]` 再切片，于是 `[::1]evil.com` 会被剥成 `::1` 直接放行 ——
    // 任何残余字符都不能容忍，剥不干净就返回空（= 判为非本机）。
    const matched = /^\[([0-9a-fA-F:.]+)\](?::\d+)?$/.exec(host);
    return matched ? matched[1] : '';
  }
  // 只有一个冒号才是「主机:端口」；多于一个是没加方括号的 IPv6 字面量。
  const first = host.indexOf(':');
  if (first < 0 || host.indexOf(':', first + 1) >= 0) return host;
  return host.slice(0, first);
}

/**
 * IPv6 地址 → 8 段 16 位数值（``::`` 展开、尾部 IPv4 写法按两段算）。
 * 解析不了返回 null。**判等必须走数值**：`0:0:0:0:0:0:0:1` 和 `::1` 是同一个地址，
 * 比字面量字符串会把非规范写法的回环地址判成外网。
 */
function ipv6Segments(value) {
  const parts = String(value ?? '').split('::');
  if (parts.length > 2) return null;
  const toSegments = (text) => {
    if (text === '') return [];
    const out = [];
    for (const piece of text.split(':')) {
      if (piece.includes('.')) {
        const octets = piece.split('.').map(Number);
        if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        out.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
        out.push(Number.parseInt(piece, 16));
      }
    }
    return out;
  };
  const head = toSegments(parts[0]);
  const tail = parts.length === 2 ? toSegments(parts[1]) : [];
  if (head === null || tail === null) return null;
  if (parts.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...new Array(fill).fill(0), ...tail];
}

/** IPv6 回环：归一化后逐段比较 —— `::1`、`0:0:0:0:0:0:0:1`、`::0.0.0.1` 都算。 */
function isLoopbackIpv6(value) {
  const segments = ipv6Segments(value);
  if (segments === null || segments.length !== 8) return false;
  // IPv4-mapped（::ffff:a.b.c.d）按内嵌的 IPv4 判，否则 127/8 会被当成外网。
  const isMapped = segments.slice(0, 5).every((n) => n === 0) && segments[5] === 0xffff;
  if (isMapped) return isLoopbackIpv4(`${segments[6] >> 8}.${segments[6] & 0xff}.${segments[7] >> 8}.${segments[7] & 0xff}`);
  return segments.slice(0, 7).every((n) => n === 0) && segments[7] === 1;
}

/** IPv4 回环 127/8、IPv6 回环 ::1（含零压缩与非规范写法）、IPv4-mapped ::ffff:127/8。 */
function isLoopbackAddress(address) {
  const value = String(address ?? '').trim().toLowerCase();
  if (!value) return false;
  if (net.isIPv6(value)) return isLoopbackIpv6(value);
  return isLoopbackIpv4(value);
}

/**
 * 主机头（或 Origin 的 host）是否**严格**指向本机。
 * 只认裸 IP 字面量与 `localhost`；`127.0.0.1.evil.com`、`localhost.evil.com`
 * 这类「借前缀伪装」的域名一律拒绝。
 */
export function isLoopbackHostname(hostHeader) {
  const bare = bareHostname(hostHeader);
  if (!bare) return false;
  if (bare === 'localhost') return true;
  return isLoopbackAddress(bare);
}

/**
 * 请求级信任围栏：socket 地址权威，另加 Host 与浏览器同源标记。
 * @param {import('node:http').IncomingMessage} req
 * @param {boolean} write 写操作额外要求 application/json（跨源简单请求无法伪装）。
 * @returns {string} 空串=放行；否则是拒绝原因（会被回成 403）。
 */
export function passFence(req, write) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return '只允许本机访问';
  if (!isLoopbackHostname(req.headers?.host)) return 'Host 不是本机';
  if (write) {
    // 只认「主类型恰好是 application/json」：用 includes 的话
    // `text/plain, application/json` 这种多值头也会被放过。
    const ctype = String(req.headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (ctype !== 'application/json') return '写操作必须是 application/json';
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
 * @param {object} [config] 插件配置：{ message?: string, bridgeDir?: string, snowlumaDir?: string, timeoutMs?: number }。
 */
export function apply(ctx, config = {}) {
  const logger = ctx?.logger ?? console;
  const bridgeDir = typeof config.bridgeDir === 'string' && config.bridgeDir.trim() !== ''
    ? config.bridgeDir.trim()
    : BRIDGE_DIR;
  const snowlumaDir = typeof config.snowlumaDir === 'string' && config.snowlumaDir.trim() !== ''
    ? config.snowlumaDir.trim()
    : undefined;
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
          // 只回摘要：桥接 /api/status 的整份响应（ownerQQ、白名单、activity 日志）不下发。
          const status = await probeStatusSummary(bridgeDir);
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
            snowlumaDir,
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
