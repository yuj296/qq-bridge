// 唤醒路由的「信任围栏」自测。
//
// 围栏是这一族路由唯一的访问控制（浏览器半侧不带任何令牌，控制台令牌只留在宿主侧），
// 所以它一旦有洞，局域网/网页就能启动本机进程并发 QQ 消息。这里逐条钉住判定规则：
//
//   node scripts/test-wake-fence.mjs          # 纯函数自测
//   node scripts/test-wake-fence.mjs --live   # 再打一遍真路由（自动发现 DSH 端口；发现不了就跳过）
//
// 背景见 PORTING-DSH-0.1.2.md §8.5：老实现用 `startsWith('127.')` 判主机名，
// 于是 `127.0.0.1.evil.com`（DNS 重绑定）能整条穿过去，实测拿到 200。
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';

import { passFence, isLoopbackHostname } from '../plugins/qq-wake/lib/index.js';

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

// ── 可选：打真路由 ───────────────────────────────────────────────────────────
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
  console.log(`\n=== 5. 真路由（127.0.0.1:${port || '未发现'}）===`);
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
