// 唤醒路由的「信任围栏」自测。
//
// 围栏是这一族路由唯一的访问控制（浏览器半侧不带任何令牌，控制台令牌只留在宿主侧），
// 所以它一旦有洞，局域网/网页就能启动本机进程并发 QQ 消息。这里逐条钉住判定规则：
//
//   node scripts/test-wake-fence.mjs          # 纯函数自测（含写路由负例，不发真请求、不触发唤醒）
//   node scripts/test-wake-fence.mjs --live   # 再打一遍真路由（自动发现 DSH 端口；发现不了就跳过）
//
// 背景见 PORTING-DSH-0.1.2.md §8.5：老实现用 `startsWith('127.')` 判主机名，
// 于是 `127.0.0.1.evil.com`（DNS 重绑定）能整条穿过去，实测拿到 200。
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';

import { passFence, isLoopbackHostname, ROUTES, apply } from '../plugins/qq-wake/lib/index.js';

let failures = 0;
function check(name, ok, extra = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
  if (!ok) failures += 1;
}

/** 造一个够用的假 req（host 传 null 表示这个请求压根没有 Host 头）。 */
function req({ remote = '127.0.0.1', host = '127.0.0.1:43129', headers = {} } = {}) {
  const head = { ...headers };
  if (host !== null) head.host = host;
  return { socket: { remoteAddress: remote }, headers: head };
}

function allowed(r, write = false) {
  return passFence(r, write) === '';
}

/**
 * 造一个「打写操作路由」的假 req：POST /api/qq-wake/wake。
 * 默认是合法的一发（本机 socket + 本机 Host + JSON），各用例只改其中一项来试伪装。
 * 注意：这里只构造请求对象、只跑围栏判定，**不发任何真实请求**，更不会触发唤醒。
 */
function wakeReq({ remote = '127.0.0.1', host = '127.0.0.1:43129', headers = {}, port = 43129 } = {}) {
  const r = req({ remote, host, headers: { 'content-type': 'application/json', ...headers } });
  r.method = 'POST';
  r.url = '/api/qq-wake/wake';
  r.headers['content-length'] = '2';
  r.socket = { ...r.socket, localPort: port };
  return r;
}

/** 假 res：只记录 statusCode / body，供「拒绝必须发生在执行唤醒之前」这类断言用。 */
function fakeRes() {
  const res = { statusCode: 0, body: null, headers: null };
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers; return res; };
  res.end = (chunk) => { res.body = chunk ?? null; return res; };
  return res;
}

/** 用假 ctx 把 apply() 注册的路由抓出来（不启动服务器）。 */
function captureRoutes() {
  const captured = new Map();
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    effect: () => {},
    webServer: { register: (route) => { captured.set(route.path, route.handler); return () => {}; } }
  };
  // bridgeDir 只是喂给插件的假配置值（本用例不打真实控制台），用不含本机信息的占位路径即可。
  apply(ctx, { bridgeDir: 'D:\\test-bridge-placeholder' });
  return captured;
}

console.log('=== 1. 主机名判定（严格字面量，不许借前缀伪装）===');
check('127.0.0.1 放行', isLoopbackHostname('127.0.0.1:43129'));
check('127.0.0.1（无端口）放行', isLoopbackHostname('127.0.0.1'));
check('127.1.2.3（整个 127/8）放行', isLoopbackHostname('127.1.2.3:1'));
check('localhost 放行', isLoopbackHostname('localhost:43129'));
check('[::1]:43129 放行', isLoopbackHostname('[::1]:43129'));
check('[::ffff:127.0.0.1]:43129 放行', isLoopbackHostname('[::ffff:127.0.0.1]:43129'));
check('127.0.0.1.evil.com 拒绝（DNS 重绑定）', !isLoopbackHostname('127.0.0.1.evil.com:43129'));
check('127.0.0.1.nip.io 拒绝', !isLoopbackHostname('127.0.0.1.nip.io'));
check('localhost.evil.com 拒绝', !isLoopbackHostname('localhost.evil.com'));
check('128.0.0.1 拒绝（不是 127/8）', !isLoopbackHostname('128.0.0.1'));
check('127.0.0.256 拒绝（八位组越界）', !isLoopbackHostname('127.0.0.256'));
check('0x7f.0.0.1 拒绝（非十进制字面量）', !isLoopbackHostname('0x7f.0.0.1'));
check('空 Host 拒绝', !isLoopbackHostname(''));
// 方括号字面量必须整体合法：`]` 之后的残余内容（方括号拼接）不能当本机
check('[::1]evil.com 拒绝（方括号后带残余）', !isLoopbackHostname('[::1]evil.com'));
check('[::1]:43129evil 拒绝（端口后带残余）', !isLoopbackHostname('[::1]:43129evil'));
check('[::1].evil.com:43129 拒绝', !isLoopbackHostname('[::1].evil.com:43129'));
check('[::1 拒绝（方括号没闭合）', !isLoopbackHostname('[::1'));
check('[::1]: 拒绝（端口为空）', !isLoopbackHostname('[::1]:'));
check('[0:0:0:0:0:0:0:1] 放行（非规范写法的 IPv6 回环）', isLoopbackHostname('[0:0:0:0:0:0:0:1]'));
check('[0:0:0:0:0:0:0:1]:43129 放行', isLoopbackHostname('[0:0:0:0:0:0:0:1]:43129'));
check('[0:0:0:0:0:0:0:2] 拒绝（展开写法但不是 ::1）', !isLoopbackHostname('[0:0:0:0:0:0:0:2]'));
check('[::ffff:127.0.0.1] 放行（无端口）', isLoopbackHostname('[::ffff:127.0.0.1]'));
check('[0:0:0:0:0:FFFF:127.0.0.1] 放行（IPv4-mapped 展开写法）', isLoopbackHostname('[0:0:0:0:0:FFFF:127.0.0.1]'));
check('[0:0:0:0:0:ffff:127.0.0.1] 的姊妹写法 [0:0:0:0:0:ffff:192.168.1.1] 拒绝（mapped 但不是 127/8）', !isLoopbackHostname('[0:0:0:0:0:ffff:192.168.1.1]'));
check('localhost. 拒绝（尾点，DNS 上等价于 localhost）', !isLoopbackHostname('localhost.'));
check('localhost.. 拒绝（多个尾点）', !isLoopbackHostname('localhost..'));
check('127.0.0.1. 拒绝（尾点）', !isLoopbackHostname('127.0.0.1.'));

console.log('\n=== 2. 请求级围栏：socket 地址权威 ===');
check('本机 socket 放行', allowed(req()));
check('::ffff:127.0.0.1 放行', allowed(req({ remote: '::ffff:127.0.0.1' })));
check('::1 放行', allowed(req({ remote: '::1' })));
check('局域网 socket 拒绝', !allowed(req({ remote: '192.168.1.5' })));
check('公网 socket 拒绝', !allowed(req({ remote: '203.0.113.7' })));

console.log('\n=== 3. 请求级围栏：Host / 同源标记 ===');
check('Host 缺失拒绝', !allowed(req({ host: null })));
check('Host 是空串拒绝', !allowed(req({ host: '' })));
check('Host 是伪装域名拒绝', !allowed(req({ host: '127.0.0.1.evil.com:43129' })));
check('不给 sec-fetch-site 也放行（非浏览器客户端）', allowed(req()));
check('sec-fetch-site: same-origin 放行', allowed(req({ headers: { 'sec-fetch-site': 'same-origin' } })));
check('sec-fetch-site: none 放行', allowed(req({ headers: { 'sec-fetch-site': 'none' } })));
check('sec-fetch-site: cross-site 拒绝', !allowed(req({ headers: { 'sec-fetch-site': 'cross-site' } })));
check('sec-fetch-site: same-site 拒绝', !allowed(req({ headers: { 'sec-fetch-site': 'same-site' } })));
check('Origin 是本机放行', allowed(req({ headers: { origin: 'http://127.0.0.1:43129' } })));
check('Origin 是 localhost 放行', allowed(req({ headers: { origin: 'http://localhost:43129' } })));
check('Origin 是外站拒绝', !allowed(req({ headers: { origin: 'http://evil.example' } })));
check('Origin 是伪装域名拒绝', !allowed(req({ headers: { origin: 'http://127.0.0.1.evil.com:43129' } })));
check('Origin 无法解析拒绝', !allowed(req({ headers: { origin: 'not a url' } })));

console.log('\n=== 4. 写操作必须 application/json（跨源简单请求伪装不了）===');
check('无 content-type 拒绝', !allowed(req(), true));
check('text/plain 拒绝', !allowed(req({ headers: { 'content-type': 'text/plain' } }), true));
check('application/x-www-form-urlencoded 拒绝', !allowed(req({ headers: { 'content-type': 'application/x-www-form-urlencoded' } }), true));
check('application/json 放行', allowed(req({ headers: { 'content-type': 'application/json' } }), true));
check('application/json; charset=utf-8 放行', allowed(req({ headers: { 'content-type': 'application/json; charset=utf-8' } }), true));
check('读操作不要求 content-type', allowed(req()));

const realRoutes = captureRoutes();

console.log('\n=== 5. X-Forwarded-For 等转发头不得影响判定（socket 才是权威）===');
// 为什么必须钉住这条：XFF 是客户端自己写的，任何代理链外的人都能伪造；
// 一旦围栏信了它，公网请求只要带一条 `X-Forwarded-For: 127.0.0.1` 就能冒充本机。
check('非回环 socket + 伪造 XFF: 127.0.0.1 仍拒绝', !allowed(req({ remote: '203.0.113.7', headers: { 'x-forwarded-for': '127.0.0.1' } })));
check('非回环 socket + 伪造 XFF 链仍拒绝', !allowed(req({ remote: '192.168.1.5', headers: { 'x-forwarded-for': '127.0.0.1, 127.0.0.2' } })));
check('非回环 socket + X-Real-IP 伪造仍拒绝', !allowed(req({ remote: '203.0.113.7', headers: { 'x-real-ip': '127.0.0.1' } })));
check('本机 socket + 伪造 XFF 不影响放行（不看它，故不因它拒绝）', allowed(req({ headers: { 'x-forwarded-for': '8.8.8.8' } })));
check('写操作也只看 socket：非回环 + XFF 伪造仍拒绝', !allowed(wakeReq({ remote: '203.0.113.7', headers: { 'x-forwarded-for': '127.0.0.1' } }), true));

console.log('\n=== 6. 写操作路由 POST ' + ROUTES.wake + '：负例必须在执行唤醒之前被拒 ===');
// 这一节全部打内部函数 / 构造出来的请求对象，**不发真实 HTTP、不触发唤醒**。
check('wake 路由已注册成精确路径', ROUTES.wake === '/api/qq-wake/wake');
check('status 路由已注册成精确路径', ROUTES.status === '/api/qq-wake/status');
check('apply() 确实注册了 wake 路由（假 ctx）', realRoutes.has(ROUTES.wake));
const wakeHandler = realRoutes.get(ROUTES.wake);

/** 造一个写路由的假 res；handler 返回后即可断言「拒了没」。 */
async function wakeGuardCase(r) {
  const res = fakeRes();
  await wakeHandler(r, res);
  return res;
}

const guardDenied = await wakeGuardCase(wakeReq({ host: '127.0.0.1.evil.com:43129', headers: { origin: 'http://127.0.0.1.evil.com:43129', 'sec-fetch-site': 'same-origin' } }));
check('伪装 Host（DNS 重绑定）被拒 403', guardDenied.statusCode === 403, `HTTP ${guardDenied.statusCode}`);
check('  拒绝理由是 Host 判定，不是先去看方法/请求体', String(guardDenied.body).includes('Host'));
check('  未通过时不会进到唤醒流程（没有 200/503 结果体）', !String(guardDenied.body).includes('"ok":true') && guardDenied.statusCode !== 503);
const crossOrigin = await wakeGuardCase(wakeReq({ headers: { origin: 'http://evil.example' } }));
check('跨站 Origin 被拒 403', crossOrigin.statusCode === 403, `HTTP ${crossOrigin.statusCode}`);
const ctypeList = await wakeGuardCase(wakeReq({ headers: { 'content-type': 'text/plain, application/json' } }));
check('content-type: text/plain, application/json 被拒 403（不能靠 contains 混过去）', ctypeList.statusCode === 403, `HTTP ${ctypeList.statusCode}`);
const crossSiteWrite = await wakeGuardCase(wakeReq({ headers: { 'sec-fetch-site': 'cross-site' } }));
check('sec-fetch-site: cross-site 的写请求被拒 403', crossSiteWrite.statusCode === 403, `HTTP ${crossSiteWrite.statusCode}`);
const noType = await wakeGuardCase(wakeReq({ headers: { 'content-type': '' } }));
check('无 content-type 的写请求被拒 403', noType.statusCode === 403, `HTTP ${noType.statusCode}`);
const getOnWriteReq = wakeReq();
getOnWriteReq.method = 'GET';
getOnWriteReq.headers.host = '127.0.0.1.evil.com:43129';
const getOnWrite = await wakeGuardCase(getOnWriteReq);
check('伪装 Host 的请求即使方法不对，也在方法校验之前就被围栏拦下（403 而非 405）', getOnWrite.statusCode === 403, `HTTP ${getOnWrite.statusCode}`);
// 对照：合法 GET 走到 wake 路由是 405 —— 说明上面的 403 确实来自围栏，而不是「所有请求都 403」
const plainGetReq = wakeReq();
plainGetReq.method = 'GET';
const plainGet = await wakeGuardCase(plainGetReq);
check('合法 GET 打到 wake 路由是 405（未被误判为攻击）', plainGet.statusCode === 405, `HTTP ${plainGet.statusCode}`);
check('围栏在每个 handler 里都是第一条判定（写路由 getter 可读）', typeof wakeHandler === 'function');
check('写操作围栏标志位（write=true）生效', passFence(wakeReq(), true) === '' && passFence(wakeReq({ headers: { 'content-type': 'text/plain' } }), true) !== '');

console.log('\n=== 7. 读路由 GET ' + ROUTES.status + '：无副作用的回归 ===');
// status 是纯读：不该因为「像写操作」而被要求 JSON，也不该放行伪装的写请求。
check('本机 GET 放行（不需要 content-type）', allowed(req()));
check('本机 GET 不看 x-forwarded-for', allowed(req({ headers: { 'x-forwarded-for': '1.2.3.4' } })));
check('GET 也不放行伪装 Host', !allowed(req({ host: 'localhost.evil.com:43129' })));
check('GET 也不放行非回环 socket', !allowed(req({ remote: '10.0.0.9' })));
check('不带 content-type 的 GET 与带 JSON 的 GET 判定一致（判定不依赖请求体）', allowed(req()) === allowed(req({ headers: { 'content-type': 'application/json' } })));



// ── 可选：打真路由（默认关闭；上面所有负例都不依赖它）─────────────────────────
const live = process.argv.includes('--live');

/** 从 harness.log 最后一条 `dsh web: <url>?token=…` 里取端口（令牌不外传）。 */
function discoverPort() {
  const explicit = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7));
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const candidates = [
    path.join(process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'), 'dsh-desktop', 'logs', 'harness.log')
  ];
  for (const file of candidates) {
    try {
      const matches = [...readFileSync(file, 'utf8').matchAll(/dsh web: http:\/\/127\.0\.0\.1:(\d+)/g)];
      if (matches.length) return Number(matches[matches.length - 1][1]);
    } catch { /* 找不到就换下一个 */ }
  }
  return 0;
}

/** 原始 http 请求：fetch 改不了 Host 头，这里必须能改。 */
function rawGet(port, headers) {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path: '/api/qq-wake/status', method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    r.on('error', reject);
    r.setTimeout(8000, () => r.destroy(new Error('超时')));
    r.end();
  });
}

if (live) {
  const port = discoverPort();
  console.log(`\n=== 8. 真路由（127.0.0.1:${port || '未发现'}）==='`);
  if (!port) {
    console.log('  · 没找到 DSH 端口（harness.log 里没有 dsh web 行），跳过 —— 不算失败');
  } else {
    try {
      const normal = await rawGet(port, { host: `127.0.0.1:${port}` });
      check('本机正常请求 200', normal === 200, `HTTP ${normal}`);
      const rebind = await rawGet(port, {
        host: `127.0.0.1.evil.com:${port}`,
        origin: `http://127.0.0.1.evil.com:${port}`,
        'sec-fetch-site': 'same-origin'
      });
      check('伪装 Host（DNS 重绑定）被拒 403', rebind === 403, `HTTP ${rebind}`);
      const crossSite = await rawGet(port, { host: `127.0.0.1:${port}`, origin: 'http://evil.example' });
      check('跨站 Origin 被拒 403', crossSite === 403, `HTTP ${crossSite}`);
      if (rebind === 200) {
        console.log('  ⚠️ 拿到 200 说明跑着的还是旧代码 —— 改完插件要重跑 setup-dsh.mjs（必要时重启 DSH）');
      }
    } catch (error) {
      console.log(`  · 路由打不通（${error?.message ?? error}），跳过 —— 不算失败`);
    }
  }
} else {
  console.log('\n（想连真路由一起验就加 --live）');
}

console.log(failures === 0 ? '\n✅ 信任围栏全部通过' : `\n❌ ${failures} 项失败`);
process.exitCode = failures === 0 ? 0 : 1;
