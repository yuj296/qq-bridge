// DSH 侧状态一览：preset / settings 命名空间 / 工作区 / 插件清单
// 用法：node scripts/dsh-status.mjs [--json]
import { NodeApiClient, unwrap, exitCleanly } from '../src/dsh-client.js';

const asJson = process.argv.includes('--json');
const api = new NodeApiClient(undefined, 30000);

const presets = unwrap(await api.agentPresets.list({}), 'agentPresets.list');
const settings = unwrap(await api.settings.describe({}), 'settings.describe');
const workspaces = unwrap(await api.workspace.list({}), 'workspace.list');
let inventory = null;
try {
  inventory = unwrap(await api.callUnary('pluginInventory/list', {}), 'pluginInventory/list');
} catch (e) {
  inventory = { error: e.message };
}

if (asJson) {
  console.log(JSON.stringify({
    presets: presets.presets.map((p) => ({ id: p.id, trust: p.trust, name: p.name, broken: p.broken })),
    namespaces: settings.namespaces.map((n) => n.ns),
    workspaces: workspaces.items.map((w) => ({ title: w.title, sessions: w.sessionIds.length })),
    inventory,
  }, null, 2));
} else {
  console.log('=== agent presets ===');
  for (const p of presets.presets) {
    console.log(`  ${p.id.padEnd(14)} trust=${String(p.trust).padEnd(6)} ${p.name ?? ''}${p.broken ? '  ⚠ BROKEN: ' + p.broken : ''}`);
  }
  console.log('\n=== settings 命名空间 (' + settings.namespaces.length + ') ===');
  const ns = settings.namespaces.map((n) => n.ns);
  console.log('  ' + ns.join(', '));
  console.log('\n  qq-mode 已注册:', ns.includes('qq-mode') ? '✅ 是' : '❌ 否');
  console.log('\n=== 工作区 ===');
  for (const w of workspaces.items) console.log(`  ${w.title} (${w.sessionIds.length} 个会话)`);
  console.log('\n=== 插件清单 ===');
  const entries = inventory?.entries;
  if (Array.isArray(entries)) {
    console.log(`  共 ${entries.length} 个条目；下面是 qq-bridge 相关与未启用的：`);
    for (const e of entries) {
      const mine = /qq-mode|qq-wake|snowluma|web-search-safe|mcp-client/i.test(String(e.moduleName ?? '') + String(e.entryId ?? ''));
      if (!mine && e.enabled !== false) continue;
      const flag = e.enabled === false ? '❌未启用' : `✅${e.fiberPhase ?? ''}`;
      console.log(`  ${flag.padEnd(12)} ${String(e.entryId).padEnd(28)} ${e.moduleName}`);
    }
  } else {
    console.log('  ' + JSON.stringify(inventory).slice(0, 1500));
  }
}

api.close();
exitCleanly(0);
