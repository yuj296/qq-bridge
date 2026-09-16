// DSH Web API 客户端 —— 适配 DSH 0.1.2 gateway 协议
//
// 与 0.1.1（@deepseek-ai/dsh-host-apiproxy）的差异，本文件负责全部抹平：
//   1. 鉴权：0.1.2 起每次 Host API 调用都要先鉴权。启动令牌只以
//      `GET /?token=<token>` 的形式在根路径被接受（不在 /api 路径上，也不在
//      Authorization 头里），换回一个 dsh-auth-* 会话 cookie，之后每个请求
//      （含 /api/remote.mux 的 WebSocket 升级）都带该 cookie。
//   2. 一元 RPC：POST /api/<namespace>/<method>（斜杠，不是点），
//      body = { type:'client-request', rpcId, method, payload:{ args } }。
//   3. 服务端下行事件：老的全局 /api/events.mux 已不存在。会话事件改为
//      每个会话一条 `session/follow` 流；提问/审批改走 `$events` waterfall。
//   4. 流载体：/api/remote.mux WebSocket，
//      客户端发 { type:'open', streamId, endpoint, payload:{args} }，
//      服务端回 { type:'item'|'end'|'error', streamId, ... }。
//
// 本文件对外保留 0.1.1 版的调用面（sessions/workspace/settings/agentPresets/
// host/events.mux/respond）与返回契约（{ rpcId, result:{ ok, value|error } }），
// 因此 bridge.js 的业务逻辑基本无需改动。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const DEFAULT_BASE = 'http://127.0.0.1:3080';

/** 简易异步队列：把 push 式事件源转成 async iterator。 */
class AsyncQueue {
  #items = [];
  #waiters = [];
  #closed = false;
  #error = null;

  push(item) {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value: item, done: false });
    else this.#items.push(item);
  }

  close(error) {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error ?? null;
    for (const waiter of this.#waiters.splice(0)) {
      if (this.#error) waiter.reject(this.#error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.#items.length > 0) return Promise.resolve({ value: this.#items.shift(), done: false });
        if (this.#error) return Promise.reject(this.#error);
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
      },
    };
  }
}

/** DSH Desktop 把 `dsh web: <url>?token=…` 写进 harness.log；据此发现当前实例。 */
function harnessLogCandidates() {
  const out = [];
  const explicit = process.env.DSH_HARNESS_LOG;
  if (explicit) out.push(explicit);
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
  out.push(path.join(appData, 'dsh-desktop', 'logs', 'harness.log'));
  out.push(path.join(home, '.dsh', 'logs', 'harness.log'));
  return [...new Set(out)];
}

/**
 * 主机是不是「本机」：只认 IP 字面量回环（127.0.0.0/8、::1）与 localhost。
 *
 * 为什么必须校验：base 是从 harness.log 的**文本**里抠出来的，而日志路径可由
 * `DSH_HARNESS_LOG` / `cfg.dsh.harnessLog` 指向任意文件 —— 不校验就等于
 * 「把启动令牌与之后的会话 cookie 送到日志里写的任意地址」。
 */
function isLoopbackHost(hostname) {
  const h = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || h === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return false;
  return parts[0] === 127;
}

/** 从 harness.log 里取最后一次启动的 base 与 token。 */
function discoverHarness(logFile) {
  const file = logFile || harnessLogCandidates().find((p) => fs.existsSync(p));
  if (!file) return null;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let found = null;
  // token 限长 + 字符白名单：日志里出现超长无空白串时不至于把它整段当令牌。
  const re = /dsh web:\s*(https?:\/\/[^\s?]+)\/?\?token=([A-Za-z0-9_-]{8,512})/g;
  for (const match of text.matchAll(re)) {
    const base = match[1].replace(/\/+$/, '');
    let host = '';
    try { host = new URL(base).hostname; } catch { continue; }
    if (!isLoopbackHost(host)) continue; // 非本机地址一律不认
    found = { base, token: match[2], file };
  }
  return found;
}

/** 被放弃的会话多久内不再被自动订阅（避免「建流→失败→30s 后再来一遍」的循环）。 */
const UNTRACK_BACKOFF_MS = 5 * 60 * 1000;

export class NodeApiClient {
  constructor(baseUrl, timeoutMs = 30000) {
    this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 30000;
    this.explicitBase = String(baseUrl ?? '').trim() || null;
    this.explicitToken = process.env.DSH_HARNESS_TOKEN || null;
    this.harnessLog = null;
    this.logger = null;            // 由 bridge 通过 configure({ logger }) 注入（见 #warn）
    this.cookie = null;
    this.authBase = null;
    this.tracked = new Set();
    this.trackListeners = new Set();
    this.liveSessions = new Set(); // 已确认 session/follow 生效（能收到事件）的会话
    this.untrackedUntil = new Map(); // sessionId -> 退避截止时间（放弃订阅后的冷却期）
    this.readyWaiters = new Map(); // sessionId -> Set<resolve>：等 follow 生效的调用方
    this.mux = null;
    this.remoteClients = new Map(); // eventId -> { clientId, kind }
    this.remoteClientId = null;
    this.base = this.explicitBase || DEFAULT_BASE;
  }

  /**
   * 允许 bridge 显式指定令牌 / harness.log / 日志出口（都可选；默认自动发现 + console）。
   * `logger` 用来把内部告警接进桥接自己的日志（`state/bridge.log`）—— 不注入的话它们只会打到
   * 桥接 stdout，排查时在日志文件里看不到。
   */
  configure({ token, harnessLog, baseUrl, logger } = {}) {
    if (token) this.explicitToken = String(token);
    if (harnessLog) this.harnessLog = String(harnessLog);
    if (logger) this.logger = logger;
    if (baseUrl) {
      this.explicitBase = String(baseUrl).replace(/\/+$/, '');
      this.base = this.explicitBase;
    }
    return this;
  }

  /** 内部告警出口：bridge 注入 logger 就走它，否则退回 console。 */
  #warn(message) {
    const line = `[dsh-client] ${message}`;
    if (this.logger && typeof this.logger.warn === 'function') this.logger.warn(line);
    else console.warn(line);
  }

  resolveBase() {
    // 配置里等于出厂默认端口时，优先用自动发现的实例（DSH Desktop 每次重启都会换端口）。
    const discovered = discoverHarness(this.harnessLog);
    if (discovered) {
      if (!this.explicitBase || this.explicitBase === DEFAULT_BASE) this.base = discovered.base;
      if (!this.explicitToken) this.token = discovered.token;
    }
    if (this.explicitToken) this.token = this.explicitToken;
    return this.base;
  }

  /** 令牌换 cookie；401 时会自动重新发现令牌（DSH 重启后令牌会变）。 */
  async authenticate(force = false) {
    const base = this.resolveBase();
    if (!force && this.cookie && this.authBase === base) return this.cookie;
    const token = this.token;
    if (!token) {
      let portHint = '未知';
      try { portHint = new URL(base).port || '默认端口'; } catch {}
      throw new Error(
        `DSH 启动令牌未知（目标端口 ${portHint}）：请设置 dsh.token，或确保 harness.log 可读、`
        + `且其中最后一条 dsh web: 记录的地址是本机回环（已尝试：${harnessLogCandidates().join(', ')}）`,
      );
    }
    const response = await fetch(`${base}/?token=${encodeURIComponent(token)}`, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const setCookie = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    const cookie = setCookie.map((value) => value.split(';')[0]).join('; ');
    if (!cookie) {
      throw new Error(`DSH 鉴权失败：GET ${base}/?token=… 返回 HTTP ${response.status} 且未下发会话 cookie`);
    }
    this.cookie = cookie;
    this.authBase = base;
    return cookie;
  }

  async #post(pathname, body) {
    const base = this.resolveBase();
    await this.authenticate();
    const headers = { 'content-type': 'application/json' };
    if (this.cookie) headers.cookie = this.cookie;
    const response = await fetch(new URL(pathname, base), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      // 不跟随重定向：POST 体里是 prompt / 工具参数，跟着 30x 走会把 body 与
      // 会话 cookie 一起送到别的源。
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 401) {
      // cookie 失效（DSH 重启 / 令牌轮换）：重新换一次再试一遍。
      await this.authenticate(true);
      const retryHeaders = { 'content-type': 'application/json' };
      if (this.cookie) retryHeaders.cookie = this.cookie;
      return fetch(new URL(pathname, base), {
        method: 'POST',
        headers: retryHeaders,
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    }
    return response;
  }

  /**
   * 一元调用。返回 { rpcId, result:{ ok:true, value } | { ok:false, error } }，
   * 与 0.1.1 版 AbstractApiClient.callUnary 的返回契约一致（unwrap 可直接用）。
   */
  async callUnary(endpoint, args = {}, signal) {
    const rpcId = crypto.randomUUID();
    const message = { type: 'client-request', rpcId, method: endpoint, payload: { args } };
    const response = await this.#post(`/api/${endpoint}`, message);
    if (response.status === 404) {
      throw new Error(
        `transport failure for /api/${endpoint}: HTTP 404（该端点在本 DSH 版本不存在或已改名）`,
      );
    }
    if (!response.ok) throw new Error(`transport failure for /api/${endpoint}: HTTP ${response.status}`);
    let full;
    try {
      full = await response.json();
    } catch (error) {
      throw new Error(`transport failure for /api/${endpoint}: 响应不是 JSON（${error?.message ?? error}）`);
    }
    if (full?.type !== 'server-response' || typeof full.rpcId !== 'string') {
      throw new Error(`transport failure for /api/${endpoint}: 响应信封非法`);
    }
    if (full.rpcId !== rpcId) {
      throw new Error(`rpcId mismatch for ${endpoint}: sent ${rpcId}, got ${full.rpcId}`);
    }
    return { rpcId: full.rpcId, result: full.result };
  }

  // ---------------------------------------------------------------- 流载体

  #muxSocket() {
    if (this.mux && this.mux.ws.readyState === WebSocket.OPEN) return this.mux;
    if (this.mux) {
      try {
        this.mux.ws.terminate();
      } catch {}
    }
    const streams = new Map();
    const wsUrl = new URL('/api/remote.mux', this.resolveBase());
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(wsUrl, { headers: this.cookie ? { cookie: this.cookie } : {} });
    const mux = { ws, streams };
    ws.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      // 帧形状校验：JSON.parse 对 "null"/"0" 也会成功，之后访问 message.streamId
      // 就会在事件回调里抛 TypeError —— 那会把整个进程带走。
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      const stream = streams.get(message.streamId);
      if (!stream) return;
      if (message.type === 'item') stream.queue.push({ value: message.value });
      else if (message.type === 'end') stream.queue.close();
      else if (message.type === 'error') {
        stream.queue.close(
          new Error(`DSH 流 ${stream.endpoint} 失败：${message.error?.code}: ${message.error?.message}`),
        );
      }
    });
    ws.on('close', () => {
      for (const stream of streams.values()) stream.queue.close(new Error('DSH 流载体已断开（/api/remote.mux）'));
      streams.clear();
      if (this.mux === mux) this.mux = null;
    });
    ws.on('error', (error) => {
      for (const stream of streams.values()) stream.queue.close(error);
      streams.clear();
      if (this.mux === mux) this.mux = null;
    });
    // 握手被 401 拒掉（DSH 重启后 cookie 必然失效）：把 cookie 作废，
    // 这样下一次 openStream 的 authenticate() 会重新换一个；否则会拿着死 cookie
    // 无限重连，表现成「一元调用正常、消息/提问全收不到」的半死状态。
    ws.on('unexpected-response', (_req, res) => {
      if (res?.statusCode === 401) {
        this.cookie = null;
        this.authBase = null;
      }
      try { res?.resume?.(); } catch {}
    });
    this.mux = mux;
    return mux;
  }

  /** 打开一条流式 Remote，返回 async iterator（产出每个 item 的 value）。 */
  async *openStream(endpoint, args = {}, signal) {
    await this.authenticate();
    const mux = this.#muxSocket();
    const streamId = crypto.randomUUID();
    const queue = new AsyncQueue();
    mux.streams.set(streamId, { queue, endpoint });
    const onAbort = () => {
      try {
        mux.ws.send(JSON.stringify({ type: 'cancel', streamId }));
      } catch {}
      queue.close();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const send = () => {
      try {
        mux.ws.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }));
      } catch {
        queue.close(new Error('DSH 流载体不可写（/api/remote.mux 未就绪或已断开）'));
      }
    };
    if (mux.ws.readyState === WebSocket.OPEN) send();
    else mux.ws.once('open', send);
    try {
      for await (const item of queue) yield item.value;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      // socket 在 CONNECTING 期间被关掉时，这个 once('open') 会一直挂在死 socket 上
      // （每条失败的 follow 累积一个监听器），所以退出一律摘掉。
      try { mux.ws.off?.('open', send); } catch {}
      mux.streams.delete(streamId);
      try {
        if (mux.ws.readyState === WebSocket.OPEN) mux.ws.send(JSON.stringify({ type: 'cancel', streamId }));
      } catch {}
    }
  }

  /** 取一次流的首个匹配项后立即关闭（用于把流式 baseline 当作一次性读取）。 */
  async #firstOf(endpoint, args, predicate) {
    const abort = new AbortController();
    try {
      for await (const value of this.openStream(endpoint, args, abort.signal)) {
        if (!predicate || predicate(value)) return value;
      }
      return null;
    } finally {
      abort.abort();
    }
  }

  // ------------------------------------------------------- 会话事件多路复用

  /** 登记需要接收事件的 DSH 会话（bridge 建会话/恢复会话时调用）。 */
  trackSession(sessionId) {
    const id = String(sessionId ?? '');
    if (!id || this.tracked.has(id)) return;
    this.tracked.add(id);
    for (const listener of this.trackListeners) listener(id, true);
  }

  untrackSession(sessionId) {
    const id = String(sessionId ?? '');
    if (!this.tracked.delete(id)) return;
    // liveSessions 必须一起删：它缓存的是「follow 已生效」，留着会让
    // waitForSessionReady 直接放行 prompt，而 follow 其实已经没了 →
    // 开头的 turn/start 丢失（= 回复不发到 QQ 的那个已知失败模式）。
    this.liveSessions.delete(id);
    // 退避：被放弃的会话（多半已归档）短时间内别再被 discovery 重新订阅。
    this.untrackedUntil.set(id, Date.now() + UNTRACK_BACKOFF_MS);
    this.#settleReadyWaiters(id, false);
    for (const listener of this.trackListeners) listener(id, false);
  }

  /** 该会话的 follow 流是否已生效（事件能收到了）。 */
  isSessionLive(sessionId) {
    return this.liveSessions.has(String(sessionId ?? ''));
  }

  /**
   * 等某个被登记会话的 follow 流生效，最多等 timeoutMs。
   *
   * 为什么需要：DSH 0.1.2 的会话事件是按会话订阅的，`session/follow` 从发起到真正
   * 生效有一个往返。若在这之前就投 prompt，开头的 `turn/start` 会落在 follow 建立
   * 之前的窗口里，collector 就收不到完整的回合（实测表现为只收到 turn/end、
   * 收不到 turn/start）。sessions.prompt 内部会自动等这道闸门。
   *
   * @returns 是否已就绪（超时返回 false，不抛错）
   */
  async waitForSessionReady(sessionId, timeoutMs = 5000) {
    const id = String(sessionId ?? '');
    if (!id) return false;
    if (this.liveSessions.has(id)) return true;
    if (!this.tracked.has(id)) return false; // 没登记就永远不会 follow，别白等
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.readyWaiters.get(id)?.delete(done);
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), Math.max(1, timeoutMs));
      const waiters = this.readyWaiters.get(id) ?? new Set();
      waiters.add(done);
      this.readyWaiters.set(id, waiters);
    });
  }

  #markSessionLive(sessionId) {
    const id = String(sessionId);
    this.liveSessions.add(id);
    this.#settleReadyWaiters(id, true);
  }

  #settleReadyWaiters(sessionId, ok) {
    const waiters = this.readyWaiters.get(sessionId);
    if (!waiters) return;
    this.readyWaiters.delete(sessionId);
    for (const done of [...waiters]) done(ok);
  }

  /**
   * 周期性地把 DSH 里所有会话都纳入事件订阅。
   *
   * 用途：像「任务完成通知」这种全局特性，需要看到你在 DSH 里自己开的那些
   * 编码会话的 turn/end —— 而桥接默认只订阅它自己建的 QQ 会话。
   *
   * 子代理会话（有 parentSessionId）不订阅：它们的事件属于父回合内部，
   * 单独通知只会变成噪音。
   *
   * @param intervalMs 重新扫描会话列表的间隔
   */
  startSessionDiscovery(intervalMs = 30000) {
    if (this.discoveryTimer) return;
    const tick = async () => {
      try {
        const response = await this.sessions.list({});
        if (!response?.result?.ok) return;
        const now = Date.now();
        for (const item of response.result.value?.items ?? []) {
          if (item?.parentSessionId) continue;
          const id = item?.sessionId;
          if (!id) continue;
          // 刚被放弃的会话先别订（见 untrackSession 的退避说明），否则会形成
          // 「每 30 秒重新订阅一个已归档会话」的重连风暴。
          const until = this.untrackedUntil.get(id);
          if (until !== undefined) {
            if (until > now) continue;
            this.untrackedUntil.delete(id);
          }
          this.trackSession(id);
        }
      } catch {
        // DSH 没起来 / 重启中：下一轮再试
      }
    };
    void tick();
    this.discoveryTimer = setInterval(tick, Math.max(5000, intervalMs));
    this.discoveryTimer.unref?.();
  }

  stopSessionDiscovery() {
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
  }

  /**
   * 兼容 0.1.1 的全局事件流：把 (a) 提问/审批的 $events waterfall 与
   * (b) 每个被登记会话的 session/follow 事件，合并成同一种信封
   * { rpcId, payload: <frame> } 产出。
   */
  events = {
    mux: (payload, signal, onOpen) => this.#muxAll(onOpen, signal),
  };

  async *#muxAll(onOpen, externalSignal) {
    const queue = new AsyncQueue();
    const root = new AbortController();
    // abort 必须同时关掉 queue：否则生成器会永远挂在 `for await (const frame of queue)`
    // 上，finally 不执行、调用方的 `await muxTask` 也永远不返回（实测会把测试脚本挂死）。
    root.signal.addEventListener('abort', () => queue.close(), { once: true });
    if (externalSignal) {
      if (externalSignal.aborted) root.abort();
      else externalSignal.addEventListener('abort', () => root.abort(), { once: true });
    }
    const sessionPumps = new Map(); // sessionId -> AbortController

    // mux 启动时就已登记的会话（桥接重启后从 state/sessions.json 恢复的）只收实时事件：
    // 回放它们的 snapshot 会把历史回合重新走一遍，可能导致旧回复被重复发到 QQ。
    // 反之，mux 运行期间才登记的会话是桥接刚建的：follow 若比第一回合建得慢，
    // 事件会全落进 snapshot，此时必须回放，否则会漏掉第一轮。
    const restored = new Set(this.tracked);
    // 本次 mux 的 follow 还没建立，旧的"已生效"结论作废。
    this.liveSessions.clear();

    // onOpen 必须等各条流真正接上再回调：调用方（self-test / 桥接）据此决定
    // 何时投 prompt，早回调会漏掉开头的 turn 事件。
    const sessionReady = new Set();
    let eventsReady = false;
    let openedOnce = false;
    const fireOpen = () => {
      if (openedOnce) return;
      openedOnce = true;
      onOpen?.();
    };
    const maybeOpen = () => {
      if (openedOnce || !eventsReady) return;
      for (const id of this.tracked) if (!sessionReady.has(id)) return;
      fireOpen();
    };
    const openFallback = setTimeout(fireOpen, 8000);

    // 每个会话一条 session/follow；断了就退避重连，不影响其它会话。
    const pumpSession = (sessionId) => {
      if (sessionPumps.has(sessionId)) return;
      const controller = new AbortController();
      sessionPumps.set(sessionId, controller);
      root.signal.addEventListener('abort', () => controller.abort(), { once: true });
      let failures = 0;
      void (async () => {
        while (!controller.signal.aborted && !root.signal.aborted) {
          let gotItem = false;
          try {
            for await (const value of this.openStream(
              'session/follow',
              { request: { address: { kind: 'session', sessionId }, maxMessages: 20 } },
              controller.signal,
            )) {
              gotItem = true;
              // 首个 item 是 snapshot，说明这条 follow 已经生效（可以安全投 prompt 了）。
              if (!sessionReady.has(sessionId)) {
                sessionReady.add(sessionId);
                this.#markSessionLive(sessionId);
                maybeOpen();
              }
              if (value?.type === 'event') {
                queue.push({ rpcId: 'event', payload: { type: 'session/event', sessionId, event: value.event } });
                continue;
              }
              if (value?.type === 'snapshot' && !restored.has(sessionId)) {
                // 新会话的 follow 若比第一回合建立得慢，事件会全落在 snapshot 里；
                // 回放它，否则桥接漏掉第一轮（chunks 是流式增量，跳过。
                // 重启恢复的会话在上面的 restored 分支里被排除，不受影响）。
                for (const rec of value.records ?? []) {
                  if (rec?.type !== 'event') continue;
                  queue.push({ rpcId: 'snapshot', payload: { type: 'session/event', sessionId, event: rec.event } });
                }
              }
            }
          } catch {
            // 流断开（DSH 重启、会话归档等）：落到下面统一退避重连。
          }
          if (controller.signal.aborted || root.signal.aborted) break;
          // 反复拿不到任何数据（例如会话已归档、id 失效）：别 2 秒一次无限重连，
          // 退避几次之后直接放弃这个会话。
          failures = gotItem ? 0 : failures + 1;
          if (failures >= 5) {
            // 放弃订阅 = 该会话的 turn/end 再也不回来 → 它的回复永远不会转发到 QQ。
            // 以前这里是完全静默的，排查时只能看到下游那句"回复没转发到 QQ"（2026-09-16 审计）。
            this.#warn(`会话 ${sessionId} 连续 ${failures} 次没拿到任何事件，已放弃订阅（该会话的回复将不再经此链路回来）`);
            this.untrackSession(sessionId);
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, Math.min(2000 * failures, 15000)));
        }
        sessionPumps.delete(sessionId);
      })();
    };

    const stopSession = (sessionId) => sessionPumps.get(sessionId)?.abort();

    const onTrack = (sessionId, tracked) => (tracked ? pumpSession(sessionId) : stopSession(sessionId));
    this.trackListeners.add(onTrack);
    for (const sessionId of this.tracked) pumpSession(sessionId);

    // $events 是关键通道（提问/审批）：它一断就让整条 mux 结束，
    // 由 bridge 的外层重连循环整体重建，避免无声失聪。
    const eventsTask = (async () => {
      try {
        for await (const value of this.openStream('$events', {}, root.signal)) {
          if (value?.type === 'ready') {
            this.remoteClientId = value.clientId;
            eventsReady = true;
            maybeOpen();
            continue;
          }
          if (value?.type === 'cancel') {
            // 该请求已经在别处被回答了（最典型的是用户在 DSH GUI 里直接点了审批），
            // 网关会推一帧 cancel。这里必须把挂起撤下来，否则上层会拿着一个
            // 已经失效的审批空等超时，之后回复还会报错。
            const known = this.remoteClients.get(value.eventId);
            if (known) {
              this.remoteClients.delete(value.eventId);
              queue.push({
                rpcId: value.eventId,
                payload: { type: 'pending/cancelled', sessionId: known.sessionId ?? null },
              });
            }
            continue;
          }
          if (value?.type !== 'waterfall') continue;
          this.#forwardWaterfall(queue, value);
        }
        if (!root.signal.aborted) throw new Error('DSH $events 流已结束');
      } catch (error) {
        if (!root.signal.aborted) queue.close(error instanceof Error ? error : new Error(String(error)));
      }
    })();

    try {
      for await (const frame of queue) yield frame;
    } finally {
      clearTimeout(openFallback);
      root.abort();
      this.trackListeners.delete(onTrack);
      await eventsTask.catch((error) => {
        // $events 流收尾时的异常以前被完全吞掉：通道为什么断在日志里看不到（2026-09-16 审计）。
        this.#warn(`$events 流收尾异常（已忽略）：${error?.message ?? error}`);
      });
    }
  }

  /** 把 $events 的 waterfall 请求翻译成 0.1.1 版的 question/approval 帧。 */
  #forwardWaterfall(queue, value) {
    const eventId = value.eventId;
    const clientId = this.remoteClientId;
    if (!eventId || !clientId) return;
    const sessionId = value.agentId ?? value.request?.sessionId ?? null;
    if (value.event === 'user-questions/request') {
      this.remoteClients.set(eventId, { clientId, kind: 'question', sessionId });
      queue.push({
        rpcId: eventId,
        payload: { type: 'question/requested', sessionId, questions: value.request?.questions ?? [] },
      });
      return;
    }
    if (value.event === 'approval/request') {
      this.remoteClients.set(eventId, { clientId, kind: 'approval', sessionId });
      queue.push({
        rpcId: eventId,
        payload: {
          type: 'approval/requested',
          sessionId,
          approvalId: value.request?.approvalId ?? eventId,
          toolName: value.request?.toolName ?? '',
          reason: value.request?.reason,
        },
      });
      return;
    }
    // 其它 waterfall（例如计划评审）本桥接不处理：交还给服务端顺延给下一个 answerer。
    void this.#settleRemoteEvent(eventId, clientId, { kind: 'next' });
  }

  /**
   * 放弃处理某个挂起请求，交还给服务端顺延给下一个 answerer。
   *
   * 用途：审批请求同时被桥接和 DSH GUI 收到（网关把 waterfall 广播给所有客户端）。
   * 桥接发到 QQ 后如果一直没人回，不应该"拒绝"——那等于替用户做了决定，
   * 还会把 GUI 那边的审批权一起吃掉。改成 next，GUI 就仍然能回答。
   *
   * @returns 是否确实放弃了一个挂起请求
   */
  async delegatePending(rpcId) {
    const id = String(rpcId ?? '');
    const known = this.remoteClients.get(id);
    if (!known) return false;
    // 先发再删：POST 失败时本地挂起仍在，调用方还能重试；
    // 反过来（先删后发）一旦失败就永久失去这个挂起。
    await this.#settleRemoteEvent(id, known.clientId, { kind: 'next' });
    this.remoteClients.delete(id);
    return true;
  }

  async #settleRemoteEvent(eventId, clientId, outcome) {
    const response = await this.callUnary('$events/result', { clientId, eventId, outcome });
    return response;
  }

  /**
   * 兼容 0.1.1 的 respond：bridge 用旧形状回执
   *   question → result.value = { sessionId, answer: { answers } }
   *   approval → result.value = { sessionId, approvalId, outcome }
   * 这里翻译成 0.1.2 的 waterfall outcome。
   */
  async respond(message) {
    const rpcId = message?.rpcId;
    const value = message?.result?.value;
    if (!rpcId) throw new Error('respond: 缺少 rpcId');
    if (message?.result?.ok === false) {
      const known = this.remoteClients.get(rpcId);
      this.remoteClients.delete(rpcId);
      if (known) {
        await this.#settleRemoteEvent(rpcId, known.clientId, {
          kind: 'rejected',
          error: { name: 'Error', message: String(message.result.error?.message ?? 'client rejected') },
        });
      }
      return { accepted: true };
    }
    const known = this.remoteClients.get(rpcId);
    if (!known) throw new Error(`respond: 未知的挂起请求 ${rpcId}（可能已超时或被取消）`);
    if (known.kind === 'question') {
      const answer = value?.answer ?? { answers: [] };
      // 先发再删：失败时保留挂起，调用方还能重试。
      await this.#settleRemoteEvent(rpcId, known.clientId, { kind: 'result', value: answer });
      this.remoteClients.delete(rpcId);
      return { accepted: true };
    }
    // 审批 outcome 只认协议定义的值：别的值宁可报错，也不要静默降级成「拒绝」
    // —— 那等于替用户做了决定（与「不替用户作答」的不变量相反）。
    const outcome = value?.outcome === 'allowed-once' ? 'allowed-once'
      : value?.outcome === 'rejected' ? 'rejected'
        : null;
    if (!outcome) throw new Error(`respond: 未知的审批 outcome ${JSON.stringify(value?.outcome)}`);
    await this.#settleRemoteEvent(rpcId, known.clientId, { kind: 'result', value: outcome });
    this.remoteClients.delete(rpcId);
    return { accepted: true };
  }

  // ------------------------------------------------------- 兼容调用面

  sessions = {
    create: (request = {}) => this.callUnary('session/create', { request }),
    prompt: async (request = {}) => {
      // 先等该会话的 follow 流生效再投递：否则这一轮开头的 turn/start 会漏掉，
      // 上层 createTurnCollector 就拼不出完整回合（详见 waitForSessionReady）。
      if (request.sessionId) await this.waitForSessionReady(request.sessionId, 5000);
      return this.callUnary('session/prompt', {
        request: {
          requestId: crypto.randomUUID(),
          sessionId: request.sessionId,
          mode: request.mode === 'steer' ? 'steer' : 'queue',
          content: Array.isArray(request.content) ? request.content : [],
          ...(request.clientTimeZone ? { clientTimeZone: request.clientTimeZone } : {}),
        },
      });
    },
    selectModel: (request = {}) => this.callUnary('session/selectModel', { request }),
    cancel: (request = {}) => this.callUnary('session/cancel', { request }),
    rename: (request = {}) => this.callUnary('session/rename', { request }),
    list: (request = {}) => this.callUnary('session/list', { _request: request }),
  };

  workspace = {
    create: (request = {}) => this.callUnary('workspace/create', { request }),
    rename: (request = {}) => this.callUnary('workspace/rename', { request }),
    delete: (request = {}) => this.callUnary('workspace/delete', { request }),
    archiveSession: (request = {}) => this.callUnary('workspace/archiveSession', { request }),
    // 0.1.2 没有 workspace/list：取 workspace/follow 的 baseline 当一次性读取。
    list: async () => {
      const baseline = await this.#firstOf('workspace/follow', {}, (value) => value?.type === 'baseline');
      return { rpcId: crypto.randomUUID(), result: { ok: true, value: { items: baseline?.value?.items ?? [] } } };
    },
  };

  settings = {
    describe: () => this.callUnary('settings/describe', {}),
  };

  agentPresets = {
    list: () => this.callUnary('agentPresets/list', {}),
  };

  host = {
    // 0.1.2 没有 host/describe；bridge 只用它做 DSH 存活探测，这里换成真实轻量调用。
    describe: () => this.callUnary('agentPresets/list', {}),
  };

  close() {
    if (this.mux) {
      try {
        // 用 terminate 而不是 close：优雅关闭的握手会和进程退出抢跑，
        // 在 Windows 上触发 libuv 断言（async.c: UV_HANDLE_CLOSING）。
        this.mux.ws.terminate();
      } catch {}
      this.mux = null;
    }
  }
}

/** 把 RpcResponse 的结果槽解出来；业务错误直接抛出。 */
export function unwrap(response, label) {
  // 信封缺字段（DSH 版本漂移 / 端口被别的进程顶替）时要给可读错误：
  // 直接访问 response.result.ok 会抛 TypeError，在初始化路径上会把桥接打挂。
  const result = response?.result;
  if (!result || typeof result !== 'object') {
    throw new Error(`${label} failed: 响应缺少 result 信封（DSH 版本不匹配？）`);
  }
  if (result.ok) return result.value;
  const code = result.error?.code ?? 'unknown';
  const message = result.error?.message ?? '（无错误详情）';
  throw new Error(`${label} failed: ${code}: ${message}`);
}

/** 在会话事件流里收集一次 turn 的 assistant 文本（按 turn 分组）。 */
export function createTurnCollector() {
  const turns = new Map(); // turn -> { text }
  return {
    /** 处理一条 session/event，返回该事件是否终结了一个 turn（此时可取最终文本）。 */
    push(event) {
      // 事件形状也可能畸形（协议漂移 / 端口被别的进程顶替）：缺 data 就直接忽略。
      // 这个函数跑在事件流循环里，抛 TypeError 会把进程带走。
      if (!event || typeof event !== 'object' || !event.data || typeof event.data !== 'object') return null;
      if (event.type === 'turn/start') {
        turns.set(event.data.turn, { text: '' });
        return null;
      }
      if (event.type === 'assistant/chunk') {
        // 忽略流式分块：assistant/message 携带同一内容的完整组装文本，
        // 两者都累加会导致回复文本翻倍（曾因此把「收到」发成「收到收到」）。
        return null;
      }
      if (event.type === 'assistant/message') {
        const t = turns.get(event.data.turn);
        if (!t) return null;
        for (const block of event.data.message?.content ?? []) {
          if (block?.type === 'text' && typeof block.text === 'string') t.text += block.text;
        }
        return null;
      }
      if (event.type === 'turn/end') {
        const t = turns.get(event.data.turn);
        turns.delete(event.data.turn);
        if (!t) return null;
        return { turn: event.data.turn, reason: event.data.reason, text: t.text };
      }
      return null;
    },
    has(turn) {
      return turns.has(turn);
    },
  };
}

/** 从 assistant 消息的 ContentBlock[] 中提取纯文本。 */
export function blocksToText(content) {
  return (content ?? [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

/**
 * 干净退出。不要在 await 完成的同一个 tick 里直接 `process.exit()`：
 * 那会和 undici 在途的异步句柄抢跑，在 Windows / Node 24 上触发
 * libuv 断言 `async.c: UV_HANDLE_CLOSING`（实测 exit code 变成 -1073740791）。
 * 推迟一个 tick 即可规避。
 */
export function exitCleanly(code = 0) {
  setTimeout(() => process.exit(code), 50);
}
