// DSH 设置页 → 桥接 cfg 的合并规则（纯函数，便于单测）
//
// 只有「用户在设置页里显式改过的字段」才覆盖运行中的配置，也就是说：
//
//   设置页里改过的字段  >  config.json（磁盘）  =  桥接控制台改的值  >  代码默认值
//
// 为什么不是「把设置页解析出的整个值（base + user）盖上去」：
// 命名空间的 base 层是 **DSH 启动那一刻的 config.json 快照**，它在进程里冻结了。
// 如果拿 base+user 整体覆盖，那么运行期间由**桥接控制台**改的东西（白名单、黑话、
// 社交参数……它们会写 config.json 并更新内存里的 cfg）会在下一次轮询（5 秒后）
// 被那个陈旧快照**悄悄改回去** —— 用户看到的就是「控制台改了没用」。
// 所以这里只认 user 层，并且额外处理「设置页里撤销」的情况：撤销 = 回到磁盘上的值。
//
// 相关的坑与证据见 AGENTS.md §5.2 与 PORTING-DSH-0.1.2.md。

/** 是普通对象（不是数组、不是 null）吗。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 把 source 深合并进 target（就地改 target），返回改动的叶子路径列表。
 * - 数组整族替换（白名单这种不能逐项合并）
 * - 对象递归合并（只覆盖 source 里出现的键）
 * - undefined / null 一律跳过（null 不作为「清空」指令，避免误删配置）
 * @param {object} target 被改的对象（一般是运行中的 cfg）。
 * @param {object} source 覆盖层（设置页的 user 层）。
 * @param {string} [pathPrefix] 递归时的路径前缀。
 * @returns {string[]} 发生变化的叶子路径。
 */
export function mergeInto(target, source, pathPrefix = '') {
  const changed = [];
  if (!isPlainObject(source) || !isPlainObject(target)) return changed;
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) continue;
    const where = pathPrefix ? `${pathPrefix}.${key}` : key;
    const current = target[key];
    if (Array.isArray(value)) {
      if (JSON.stringify(current) !== JSON.stringify(value)) {
        target[key] = structuredClone(value);
        changed.push(where);
      }
    } else if (isPlainObject(value)) {
      if (!isPlainObject(current)) target[key] = {};
      changed.push(...mergeInto(target[key], value, where));
    } else if (current !== value) {
      target[key] = value;
      changed.push(where);
    }
  }
  return changed;
}

/**
 * 摊平一棵树的所有叶子路径（数组算叶子）。
 * @param {object} tree 设置页 user 层。
 * @param {string[]} [trail] 递归用。
 * @returns {Set<string>} 叶子路径集合。
 */
export function leafPaths(tree, trail = []) {
  const out = new Set();
  if (!isPlainObject(tree)) return out;
  for (const [key, value] of Object.entries(tree)) {
    const path = [...trail, key];
    if (isPlainObject(value)) for (const leaf of leafPaths(value, path)) out.add(leaf);
    else out.add(path.join('.'));
  }
  return out;
}

/**
 * 从 source（一般是重新读出来的 config.json）把一个路径的值搬回 target。
 * 源里没有这个键就删掉 target 上的键（真正"回到默认"）。
 * @param {object} target 运行中的 cfg。
 * @param {object} source 磁盘上的配置。
 * @param {string[]} segments 路径分段。
 * @returns {boolean} 是否发生了变化。
 */
export function restorePath(target, source, segments) {
  if (segments.length === 0) return false;
  const key = segments[segments.length - 1];
  let targetParent = target;
  let sourceParent = source;
  for (const segment of segments.slice(0, -1)) {
    if (!isPlainObject(targetParent)) return false;
    targetParent = targetParent[segment];
    if (isPlainObject(sourceParent)) sourceParent = sourceParent[segment];
    else sourceParent = undefined;
  }
  if (!isPlainObject(targetParent)) return false;
  const sourceHas = isPlainObject(sourceParent) && Object.prototype.hasOwnProperty.call(sourceParent, key);
  if (!sourceHas) {
    if (Object.prototype.hasOwnProperty.call(targetParent, key)) {
      delete targetParent[key];
      return true;
    }
    return false;
  }
  const wanted = structuredClone(sourceParent[key]);
  if (JSON.stringify(targetParent[key]) === JSON.stringify(wanted)) return false;
  targetParent[key] = wanted;
  return true;
}

/**
 * 一次完整的设置覆盖：撤销上一轮里已被移除的项 → 施加本轮的 user 层。
 *
 * @param {object} options
 * @param {object} options.target 运行中的 cfg（就地修改）。
 * @param {object} options.user 设置命名空间的 user 层（只含用户显式改过的字段）。
 * @param {Set<string>} [options.applied] 上一轮施加过的叶子路径；用于识别"撤销"。
 * @param {object|null} [options.freshConfig] 重新从磁盘读出的 config.json（撤销时用它还原）。
 * @returns {{applied: Set<string>, changed: string[], revoked: string[]}}
 */
export function applyOverrides({ target, user, applied, freshConfig }) {
  const next = leafPaths(user);
  const previous = applied instanceof Set ? applied : new Set();
  const revoked = [...previous].filter((path) => !next.has(path));
  const changed = [];

  if (revoked.length > 0 && freshConfig !== null && freshConfig !== undefined) {
    for (const path of revoked) {
      if (restorePath(target, freshConfig, path.split('.'))) changed.push(path);
    }
  }

  changed.push(...mergeInto(target, user));
  return { applied: next, changed, revoked: revoked.length > 0 ? revoked : [] };
}
