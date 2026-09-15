// QQ 机器人设置 —— 字段表（**这里是唯一的真源**）
//
// 每行 = 一个可在 DSH 设置页里改的项：
//   [路径, 类型, '标签', '详细说明']
// 类型：string / text(多行) / int / number / bool / numbers(逗号分隔的数字) /
//       strings(逗号分隔的文本) / enum(第 5 项给候选值数组)
//
// 路径 = config.json 的嵌套路径。桥接会把设置页解析出的值**深合并**进自己的 cfg，
// 所以路径必须和 config.json 对齐（详见 src/bridge.js 的 applySettingsOverrides）。
//
// 「详细说明」会原样显示在设置页里：写清楚 它控制什么 / 单位 / 取值范围 / 默认值 /
// 调大调小会怎样。使用者是照着这句话改数字的，别写成黑话。
//
// 不含的项（永远只认 config.json）：
//   snowluma.accessToken / consoleToken / dsh.token —— 都是机密，DSH 的设置协议
//   会把 role('secret') 字段从返回里抹掉，桥接读不回来，索性不放进设置页。

/** 分组：展示顺序 + 中文名 + 这一组是干什么的。 */
export const GROUPS = {
  core: { order: 1, title: '基本', desc: '身份、准入、会话、控制台。这里的项改错后果最直接。' },
  notify: { order: 2, title: '通知', desc: '什么情况下手机会收到消息 —— 嫌吵就调这几个阈值。' },
  allow: { order: 3, title: '白名单（谁能跟它说话）', desc: '空白名单 + allowAllWhenEmpty 关闭 = 谁都不理。黑名单优先于白名单。' },
  deny: { order: 4, title: '黑名单', desc: '命中黑名单的会话一律不处理，优先级高于白名单。' },
  slang: { order: 5, title: '黑话学习', desc: '它会把群里看不懂的新词攒起来，够了就让 DSH 去研究并收录，之后聊天时会用上。' },
  social: { order: 6, title: '一代仿真（social）', desc: '早期模式：按概率决定要不要接话、要不要主动找人。' },
  socialV2: { order: 7, title: '二代仿真（socialV2）', desc: '现在实际在用的模式 —— AI 自己决定什么时候说话、什么时候潜水，这里是它的边界与配额。' },
  dsh: { order: 8, title: '模型与 DSH 接线', desc: '机器人跑在哪个模型上、连的是哪个 DSH。改完通常下一回合生效。' },
  snowluma: { order: 9, title: 'SnowLuma 接线（高级）', desc: 'QQ 客户端 ↔ 桥接之间的管道。地址填错会直接连不上，改完要重启桥接。' },
  security: { order: 10, title: '安全', desc: '拦截/越权时的行为。' }
};

export const FIELDS = [
  // ── 基本 ──────────────────────────────────────────────────────────────
  ['mode', 'enum', '运行模式',
    '决定机器人整体怎么跑。留空 = 沿用桥接控制台里的设置（推荐）。chat = 普通聊天；closed-agent = 封闭 agent，只服务你自己的私聊；reserved / reserved2 = 仿真模式（reserved2 是现在实际在用的那套，AI 自己决定什么时候说话）。在这里选过之后，它会覆盖控制台的选择。',
    ['chat', 'closed-agent', 'reserved', 'reserved2']],
  ['ownerQQ', 'int', '管理员 QQ',
    '填**你本人的 QQ 号**（不是机器人号）。桥接靠它判断"谁是主人"：只有这个号能批复权限、能收到审批转发；填错了你的消息会被当成普通群友处理。'],
  ['sessionCwd', 'string', 'QQ 会话工作目录',
    '机器人跟人聊天时用的工作目录（agent 的文件操作、相对路径都基于它）。留空 = 用 DSH 默认工作区。'],
  ['agentPreset', 'string', '一代模式的人格 preset',
    'chat / closed-agent 模式下新建 QQ 会话时用哪套 DSH agent preset，例如 qq-chat。改完只影响**之后新建**的会话，已经开着的会话不变。'],
  ['workspaceTitle', 'string', '工作区名称',
    '这些 QQ 会话在 DSH 里归到哪个工作区名下 —— 就是 DSH 侧边栏工作区列表里显示的那个名字。'],
  ['ackMessage', 'string', '先回一句（可选）',
    '收到消息后立刻先回一句固定的话（例如"在的"），用来告诉对方"看到了、马上回"。留空 = 不回，直接等正式回复。经常发会显得敷衍，一般别开。'],
  ['sendDelayMs', 'int', '发送前延迟（毫秒）',
    '每条消息发出去之前额外等多久，用来模拟"打字需要时间"，避免秒回显得像机器人。默认 300。'],
  ['questionTimeoutMs', 'int', '提问/审批等待超时（毫秒）',
    'AI 向人提问、或 DSH 索要权限时，等你多久算超时。默认 300000（5 分钟）。超时后**不会替你拒绝**，而是交还控制权（防止吃掉 DSH 界面上的审批权）。'],
  ['consolePort', 'int', '本地控制台端口',
    '桥接自带网页控制台（默认 3100）的监听端口。⚠️ 改了要重启桥接才生效，而且如果你正开着旧端口的面板会连不上。'],

  // ── 通知 ──────────────────────────────────────────────────────────────
  ['notifyTaskDone', 'bool', '任务完成通知',
    'DSH 里的任务跑完时，往你 QQ 发一条消息。关掉 = 完全不发（下面三个阈值也就都不生效了）。'],
  ['notifyTaskDoneMinTurnMs', 'int', '只通知跑够多久的任务（毫秒）',
    '只有耗时超过这个值的回合才发通知。默认 300000（5 分钟）—— 也就是只报"大活"，小任务不打扰你。调小更吵，调大更安静。'],
  ['notifyTaskDoneDebounceMs', 'int', '回合结束后的静默期（毫秒）',
    '回合结束后先等这么久再发通知；这段时间里如果又开了新回合，就把通知撤掉（避免一个任务连发好几条）。默认 15000。'],
  ['notifyTaskDoneMaxChars', 'int', '通知正文长度上限（字）',
    '通知里附带的正文最多截取多少字，防止长答案刷屏。默认 200。'],
  ['relayApprovalsToOwner', 'bool', '把 DSH 审批转发到手机 QQ',
    'DSH 要权限（执行命令、改文件）时，把请求发到你的 QQ，你回"通过/拒绝"就能批复。**关掉后手机就收不到批复请求了**，只能在 DSH 界面上点。默认开。'],
  ['sessionDiscoveryMs', 'int', '扫描 DSH 会话的间隔（毫秒）',
    '任务完成通知需要看到"你自己在 DSH 里开的会话"，桥接每隔这么久扫一次会话列表。默认 30000。调小更及时但更费，调大通知可能慢一拍。'],

  // ── 白名单 ────────────────────────────────────────────────────────────
  ['allow.private', 'numbers', '私聊白名单',
    '允许私聊机器人的 QQ 号，逗号分隔（例如 123456,789012）。不在名单里的私聊会被直接忽略。'],
  ['allow.groups', 'numbers', '群白名单',
    '允许机器人在里面说话的群号，逗号分隔。**空着 = 不进任何群**，想在群里用它必须先加群号。'],
  ['allowAllWhenEmpty', 'bool', '⚠️ 白名单为空时放行所有人',
    '开了之后，白名单一个都没配时会**接受任何人的消息**，等于把机器人公开出去。除非在做临时测试，别开。'],

  // ── 黑名单 ────────────────────────────────────────────────────────────
  ['deny.private', 'numbers', '私聊黑名单',
    '禁止私聊的 QQ 号，逗号分隔。优先级高于白名单：同一个人同时出现在两边时，以黑名单为准。'],
  ['deny.groups', 'numbers', '群黑名单',
    '禁止在群里说话的群号，逗号分隔。优先级高于白名单。临时想让它在某个群闭嘴，加这里最快。'],

  // ── 安全 ──────────────────────────────────────────────────────────────
  ['security.interceptNotify', 'bool', '安全拦截时通知管理员',
    '当有消息触发安全拦截（越权、敏感操作被挡下）时，是否给你发一条通知。默认开。'],

  // ── 黑话学习 ──────────────────────────────────────────────────────────
  ['slang.enabled', 'bool', '黑话学习总开关',
    '关掉后不再学习新词，但已经学会的词仍然会被使用。'],
  ['slang.extractMinMessages', 'int', '攒够多少条消息才提取',
    '一个会话里攒够这么多条消息，才触发一次黑话提取。默认 10。调小学习快，但更容易把普通话当成黑话。'],
  ['slang.extractCooldownMs', 'int', '两次提取之间的冷却（毫秒）',
    '同一会话两次提取至少间隔这么久，防止刷屏式学习。默认 300000（5 分钟）。'],
  ['slang.inferenceThresholds', 'numbers', '推断阈值（出现次数）',
    '一个陌生词出现几次才值得判定为黑话，逗号分隔表示多个档位。默认 2,4,8：出现 2 次先记着，4 次开始推断，8 次就比较确定了。'],
  ['slang.injectMax', 'int', '最多注入几条黑话',
    '每次跟 AI 对话时最多塞几条已学会的黑话进上下文，防止把提示词撑爆。默认 8。'],
  ['slang.learnerPreset', 'string', '学习用的 preset',
    '让哪个 DSH agent preset 去研究新词（它会开独立会话去查）。默认 qq-chat。'],
  ['slang.workspaceTitle', 'string', '学习工作区名称',
    '黑话研究用的那些会话在 DSH 里归到哪个工作区名下。默认"QQ 黑话学习"。'],
  ['slang.autoResearch', 'bool', '自动送 DSH 深度研究',
    '开启后，遇到判断不准的新词会自动开一个 DSH 会话去查（更聪明，但会消耗 token/时间）。关掉就只能靠控制台手动送研究。'],

  // ── 一代仿真 ──────────────────────────────────────────────────────────
  ['social.maxReplyChars', 'int', '回复最大字数',
    '单条回复最多多少字，超了会被截断。默认 500。'],
  ['social.mustReplyKeywords', 'strings', '必答词',
    '消息里出现这些词就一定要回（不受概率判定影响），逗号分隔。默认有 deepseek、小鲸鱼、在吗 等。把"在吗"这类点名词放进来能显著减少漏回。'],
  ['social.contextWindow', 'int', '上下文条数',
    '每次回复时带多少条历史消息给 AI。默认 20。调大记得更清楚但更贵，调小容易失忆。'],
  ['social.triggerProbability', 'number', '群聊插话概率',
    '群里出现一条跟它无关的消息时，它主动接话的概率，0~1。默认 0.1（十次接一次）。0 = 只回必答词和 @，1 = 每条都想插嘴。'],
  ['social.activeCheckMinMs', 'int', '活跃检查间隔下限（毫秒）',
    '"活跃"状态下多久检查一次要不要继续说话，这里是最短间隔。默认 8000。'],
  ['social.activeCheckMaxMs', 'int', '活跃检查间隔上限（毫秒）',
    '同上，最长间隔。实际间隔在这两个值之间随机取。默认 30000。'],
  ['social.idleWindowMs', 'int', '观望窗口（毫秒）',
    '进入"观望"后等多久再考虑重新接话。默认 360000（6 分钟）。'],
  ['social.idleRetryProbability', 'number', '观望后重试概率',
    '观望窗口到了之后，再次开口的概率，0~1。默认 0.4。调低更安静。'],
  ['social.proactiveEnabled', 'bool', '主动找人',
    '允许它在没人说话时主动开话题。关掉 = 只回复，不主动。'],
  ['social.proactiveIdleThresholdMs', 'int', '闲置多久才主动（毫秒）',
    '会话安静超过这个时长，才考虑主动开口。默认 1800000（30 分钟）。'],
  ['social.proactiveCheckMinMs', 'int', '主动检查间隔下限（毫秒）',
    '多久检查一次"要不要主动说话"，最短间隔。默认 2700000（45 分钟）。'],
  ['social.proactiveCheckMaxMs', 'int', '主动检查间隔上限（毫秒）',
    '同上，最长间隔。默认 5400000（90 分钟）。'],
  ['social.proactiveProbability', 'number', '主动概率',
    '每次检查时真的开口的概率，0~1。默认 0.2。'],
  ['social.activeReplyDelayMinMs', 'int', '活跃时回复延迟下限（毫秒）',
    '"活跃"状态下回复前先等多久，最短值。默认 1000（1 秒）。'],
  ['social.activeReplyDelayMaxMs', 'int', '活跃时回复延迟上限（毫秒）',
    '同上，最长值。实际延迟在两者之间随机。默认 5000（5 秒）。'],
  ['social.activeDurationEnabled', 'bool', '限制单次活跃时长',
    '开启后，一次"活跃"最多持续下面设定的时长，然后自动转观望，防止它一直在群里说个不停。'],
  ['social.activeDurationMinMs', 'int', '活跃时长下限（毫秒）',
    '单次活跃的最短持续时间。默认 1200000（20 分钟）。'],
  ['social.activeDurationMaxMs', 'int', '活跃时长上限（毫秒）',
    '单次活跃的最长持续时间。默认 3000000（50 分钟）。'],
  ['social.skipProbability', 'number', '无视消息的概率',
    '即使判定该回，也有这个概率直接不回（模拟"人没看见"）。0~1，默认 0.05。'],
  ['social.surrenderProbability', 'number', '认输概率',
    '话题僵住/被追问时直接放弃的概率。0~1，默认 0（从不认输）。'],
  ['social.idleRetryWaitMs', 'int', '重试等待（毫秒）',
    '一次重试没成功，隔多久再试。默认 120000（2 分钟）。'],
  ['social.burstEnabled', 'bool', '允许分条发送',
    '把一段话拆成几条连续发出去（更像真人打字）。关掉后一句话就是一条消息。'],
  ['social.burstIntervalMinMs', 'int', '分条间隔下限（毫秒）',
    '分条发送时两条之间的最短间隔。默认 1000（1 秒）。'],
  ['social.burstIntervalMaxMs', 'int', '分条间隔上限（毫秒）',
    '同上，最长间隔。默认 3000（3 秒）。'],
  ['social.longGapProbability', 'number', '长停顿概率',
    '分条发送时，两条之间出现一次"明显停顿"的概率。0~1，默认 0.2。'],
  ['social.longGapMinMs', 'int', '长停顿下限（毫秒）',
    '长停顿的最短时长。默认 5000（5 秒）。'],
  ['social.longGapMaxMs', 'int', '长停顿上限（毫秒）',
    '长停顿的最长时长。默认 10000（10 秒）。'],

  // ── 二代仿真 ──────────────────────────────────────────────────────────
  ['socialV2.enabled', 'bool', '二代仿真总开关',
    '关掉后带 agent token 的二代工具接口全部拒绝，只剩控制台能管。一般保持开。'],
  ['socialV2.autoReplyCheckMs', 'int', '自动回复检查间隔（毫秒）',
    '多久检查一次"有没有该回但没回的消息"。默认 30000。调小更及时，调大更省。'],
  ['socialV2.agentPreset', 'string', '二代 preset',
    'reserved2 模式下 QQ 会话用哪套 agent preset，默认 qq-chat-v2。改完只影响**之后新建**的会话。'],
  ['socialV2.provideRecommendations', 'bool', '把推荐值告诉 AI',
    '是否把它自己配置里的"推荐值/建议文案"一并给 AI 看（例如"潜水建议 5~120 分钟"）。关掉后 AI 少一层提示，行为更自由也更不可控。'],

  // 工具开关
  ['socialV2.tools.getPrompt', 'bool', '工具：qq_get_prompt（读自己的设定）',
    '允许 AI 读自己的提示词、推荐值、可用工具清单。关掉它会"忘了自己有哪些能力"。'],
  ['socialV2.tools.getUnread', 'bool', '工具：qq_get_unread_messages（读未读）',
    '允许它读未读消息。关掉后它只能看见叫醒它的那一条，群里会显得很瞎。'],
  ['socialV2.tools.getRecent', 'bool', '工具：qq_get_recent_messages（读最近消息）',
    '允许它往前翻聊天记录（可以带 offset 一直翻）。关掉后只能看到很短的一截上下文。'],
  ['socialV2.tools.socialState', 'bool', '工具：qq_social_state（读会话状态）',
    '允许它查看自己在这个会话里的状态（活跃/潜水、上次唤醒原因、未读数等）。'],
  ['socialV2.tools.sendGroup', 'bool', '工具：qq_send_group_message（发群消息）',
    '允许它往群里发消息。关掉 = 不能在群里说话（私聊不受影响）。'],
  ['socialV2.tools.sendPrivate', 'bool', '工具：qq_send_private_message（发私聊）',
    '允许它给人发私聊。关掉 = 不能私聊（群里说话不受影响）。'],
  ['socialV2.tools.reply', 'bool', '工具：qq_reply（引用回复）',
    '允许它引用某条消息再回复 —— "回的是哪一句"写得清清楚楚。群聊消息多时很有用。'],
  ['socialV2.tools.sendBurst', 'bool', '工具：qq_send_burst（分条发送）',
    '允许它一次安排多条消息、按真人节奏分开发。关掉就只能一条一条自己发。'],
  ['socialV2.tools.sendMessage', 'bool', '工具：qq_send_message（统一发送）',
    '允许它用统一发送接口（可带分条间隔、可配 @ / 引用）。它是"分条"和"引用回复"的底层入口，关掉会连带影响那两项。'],
  ['socialV2.tools.waitMessages', 'bool', '工具：qq_wait_for_messages（等消息）',
    '允许它"等一会儿看有没有人接着说"（而不是急着回）。这是它判断该不该潜水的主要手段，建议保持开。'],
  ['socialV2.tools.feedback', 'bool', '工具：qq_report_feedback（上报问题）',
    '允许它在遇到困惑/异常时给你报一条反馈（在控制台能看到）。'],
  ['socialV2.tools.getMyRecent', 'bool', '工具：qq_get_my_recent_messages（看自己说过什么）',
    '允许它回看自己刚发过的内容，避免重复刷同一句话。'],
  ['socialV2.tools.getMessageDetail', 'bool', '工具：qq_get_message_detail（看单条消息）',
    '允许它查一条消息的完整内容、发送者和引用关系。'],
  ['socialV2.tools.getActiveMembers', 'bool', '工具：qq_get_active_members（看活跃成员）',
    '允许它知道群里最近谁在说话，方便判断该跟谁互动、话题里都有谁。'],
  ['socialV2.tools.setWakeConfig', 'bool', '工具：qq_set_wake_config（设置何时唤醒自己）',
    '允许它自己决定"潜水多久、什么条件下叫醒我"。**关掉后它就不能自主潜水了**，只能被动回复。'],
  ['socialV2.tools.markRead', 'bool', '工具：qq_mark_read（标记已读）',
    '允许它把看过的消息标成已读，避免下次醒来又看到同一批。'],
  ['socialV2.tools.memory', 'bool', '工具：qq_memory_*（轻量记忆）',
    '允许它记录/查询/删除轻量记忆（对某人的印象、想说还没说的话、当前话题）。这是它跨对话记住事情的主要手段。'],
  ['socialV2.tools.slangQuery', 'bool', '工具：qq_slang_query（查黑话）',
    '允许它查询已收录的群聊黑话/梗的含义。'],
  ['socialV2.tools.slangSubmit', 'bool', '工具：qq_slang_submit（提交黑话）',
    '允许它把看不懂的新词提交给你确认，确认后进入它的词库。'],
  ['socialV2.tools.getImages', 'bool', '工具：qq_get_message_images（看图片）',
    '允许它真正"看"消息里的图片/表情（会交给视觉模型）。关掉后只能看到 [图片] 这样的占位符。'],
  ['socialV2.tools.getForwardMsg', 'bool', '工具：qq_get_forward_msg（看合并转发）',
    '允许它展开聊天记录合并转发里的内容（含其中的图片）。'],
  ['socialV2.tools.sendPoke', 'bool', '工具：qq_send_poke（拍一拍）',
    '允许它用"拍一拍"代替一句话。偶尔用很自然，建议保持开但让它少用。'],
  ['socialV2.tools.listStickers', 'bool', '工具：qq_list_stickers（列表情包）',
    '允许它查看账号收藏的表情包列表及备注。'],
  ['socialV2.tools.getStickerImage', 'bool', '工具：qq_get_sticker_image（看表情图）',
    '允许它真的"看"某个收藏表情长什么样，方便判断该不该用。'],
  ['socialV2.tools.sendSticker', 'bool', '工具：qq_send_sticker（发表情包）',
    '允许它在对话里发收藏的表情包。'],
  ['socialV2.tools.setStickerRemark', 'bool', '工具：qq_sticker_remark（改官方备注）',
    '允许它修改 QQ 账号上表情的**官方备注** —— 会影响你手机 QQ 里看到的备注。默认关，别随便开。'],
  ['socialV2.tools.stickerNote', 'bool', '工具：qq_sticker_note（记表情含义）',
    '允许它给表情写本地笔记/标签（只存在本地，不影响 QQ），方便以后挑表情。'],
  ['socialV2.tools.collectSticker', 'bool', '工具：qq_collect_sticker（收藏表情）',
    '允许它把别人发的有意思的图"偷"进你的收藏表情。偶尔来一张挺有趣，频率由下面的收藏配额控制。'],
  ['socialV2.tools.getSelfImage', 'bool', '工具：qq_get_self_image（看自己的形象）',
    '允许它查看自己的默认形象图（有人问"你长什么样"时用得上）。'],

  // 潜水 / 唤醒
  ['socialV2.wake.defaultMode', 'enum', '默认状态',
    '会话刚开始时它处于什么状态。active = 活跃（有消息就参与）；diving = 潜水（等人叫它才出来）。默认 diving，比较安静。',
    ['active', 'diving']],
  ['socialV2.wake.preSleepWaitEnabled', 'bool', '沉睡前必须先观察一轮',
    '要求它潜水前先等一个观察窗口（确认没人接着说话）才能真正睡下。开了更像真人；关掉睡觉更快，但容易"说一半就跑"。'],
  ['socialV2.wake.preSleepWaitMs', 'int', '沉睡前观察时长（毫秒）',
    '上面那个观察窗口有多长。默认 300000（5 分钟）：这 5 分钟没人说话就可以睡。'],
  ['socialV2.wake.recommendedDefaultInfinite', 'bool', '推荐"无限期潜水"',
    '给 AI 的建议值：潜水时选"无限期"（只在被叫到时醒来）而不是定个时长。默认开。'],
  ['socialV2.wake.sleepMinMs', 'int', '潜水时长下限（毫秒）',
    '允许它自己设置的最短潜水时长。默认 60000（1 分钟）。'],
  ['socialV2.wake.sleepMaxMs', 'int', '潜水时长上限（毫秒）',
    '允许它自己设置的最长潜水时长。0 = 不限制。'],
  ['socialV2.wake.recommendedSleepMinMs', 'int', '推荐潜水时长下限（毫秒）',
    '给 AI 的推荐值：建议它潜水至少这么久。默认 300000（5 分钟）。'],
  ['socialV2.wake.recommendedSleepMaxMs', 'int', '推荐潜水时长上限（毫秒）',
    '给 AI 的推荐值：建议潜水不超过这么久。默认 7200000（2 小时）。'],
  ['socialV2.wake.recommendedProbability', 'number', '推荐普通消息唤醒概率',
    '给 AI 的推荐值：潜水期间遇到普通消息（没 @、没提名字）被唤醒的概率。0~1，默认 0.05。'],
  ['socialV2.wake.recommendedKeywords', 'strings', '推荐唤醒关键词',
    '给 AI 的推荐值：出现这些词就唤醒它。逗号分隔，默认含 小鲸鱼 / DeepSeek / D老师 / 大肥鱼 等。'],
  ['socialV2.wake.recommendedAtMention', 'bool', '推荐开启"@ 唤醒"',
    '给 AI 的推荐值：被 @ 时唤醒。建议保持开。'],
  ['socialV2.wake.recommendedNameMention', 'bool', '推荐开启"叫名字唤醒"',
    '给 AI 的推荐值：有人叫它名字/昵称时唤醒。'],
  ['socialV2.wake.recommendedQuestion', 'bool', '推荐开启"提问唤醒"',
    '给 AI 的推荐值：出现明显在问它的问题时唤醒。'],
  ['socialV2.wake.recommendedPoke', 'bool', '推荐开启"拍一拍唤醒"',
    '给 AI 的推荐值：有人拍一拍时唤醒。'],
  ['socialV2.wake.batchWindowMs', 'int', '多条消息合并唤醒窗口（毫秒）',
    '几条消息挨得很近时合并成一次唤醒，避免每来一条就醒一次。默认 8000。'],
  ['socialV2.wake.maxWakePerMinute', 'int', '每分钟最多被唤醒次数',
    '硬上限：一分钟内最多唤醒几次，防刷屏。默认 1。'],
  ['socialV2.wake.maxWakePerHour', 'int', '每小时最多被唤醒次数',
    '硬上限：一小时内最多唤醒几次。默认 12。调大 = 更活跃，也更费 token。'],
  ['socialV2.wake.noActionLimit', 'int', '连续无动作几次就强制处理',
    '醒来后连续几次什么都没做（既没回、也没睡），就强制它处理。默认 3。'],
  ['socialV2.wake.maxWakeConfigReminders', 'int', '提醒设置唤醒条件的次数',
    '在同一个会话里最多提醒它几次"该设唤醒条件了"。默认 2，防止反复唠叨。'],
  ['socialV2.wake.recommendedHint', 'text', '潜水建议文案（写给 AI 的话）',
    '这段文字会直接塞给 AI，告诉它推荐的潜水流程。它属于提示词的一部分 —— 改这里等于改它的行为准则，不熟别动。'],

  // 发送策略
  ['socialV2.send.burstEnabled', 'bool', '允许分条发送',
    '把一段话拆成几条连续发。关掉后一句话就是一条消息。'],
  ['socialV2.send.burstMaxMessages', 'int', '一次最多分几条',
    '一次发送最多拆成几条，防止刷屏。默认 8。'],
  ['socialV2.send.burstIntervalMinMs', 'int', '分条间隔下限（毫秒）',
    '分条时两条之间的最短间隔。默认 1000（1 秒）。'],
  ['socialV2.send.burstIntervalMaxMs', 'int', '分条间隔上限（毫秒）',
    '分条时两条之间的最长间隔。默认 3000（3 秒）。'],
  ['socialV2.send.longGapProbability', 'number', '长停顿概率',
    '分条时出现一次"想了一会儿"的长停顿的概率。0~1，默认 0.2。'],
  ['socialV2.send.longGapMinMs', 'int', '长停顿下限（毫秒）',
    '长停顿最短时长。默认 5000（5 秒）。'],
  ['socialV2.send.longGapMaxMs', 'int', '长停顿上限（毫秒）',
    '长停顿最长时长。默认 10000（10 秒）。'],
  ['socialV2.send.maxSendPerMinute', 'int', '每分钟最多发几条',
    '防止刷屏的硬上限。默认 8 条/分钟。'],
  ['socialV2.send.maxSendPerHour', 'int', '每小时最多发几条',
    '同上，小时级。默认 60 条/小时。'],
  ['socialV2.send.maxMessageChars', 'int', '单条最大字数',
    '单条消息最多多少字，超了会被截断。默认 500。'],
  ['socialV2.send.maxGapMs', 'int', '最大间隔（毫秒）',
    '两条消息之间最多等多久，超过就当作"重新开始一轮"。默认 10000。'],
  ['socialV2.send.gapBaseMs', 'int', '基础条间间隔（毫秒）',
    '按字数算间隔时的基础值。默认 800。'],
  ['socialV2.send.gapPerCharMs', 'int', '每多一个字追加的间隔（毫秒）',
    '按字数算间隔时，每个字再加多少毫秒（模拟打字速度）。默认 20。'],
  ['socialV2.send.recommendedHint', 'text', '发送风格建议（写给 AI 的话）',
    '这段文字会直接塞给 AI，规定它该怎么分条、间隔多久、别刷屏。属于提示词，改之前想清楚。'],

  // 等待
  ['socialV2.wait.defaultMs', 'int', '等消息默认时长（毫秒）',
    '它调用"等消息"时如果没说时长，默认等多久。默认 30000（30 秒）。'],
  ['socialV2.wait.minMs', 'int', '等消息时长下限（毫秒）',
    '允许它等的最短时间。默认 5000（5 秒）。'],
  ['socialV2.wait.maxMs', 'int', '等消息时长上限（毫秒）',
    '允许它等的最长时间。默认 600000（10 分钟）。这决定了一次"沉睡前观察"最多能有多长。'],
  ['socialV2.wait.defaultQuietMs', 'int', '默认静默窗口（毫秒）',
    '收到新消息后，再等多久没有新消息才算"对方说完了"。默认 8000（8 秒）。'],
  ['socialV2.wait.minQuietAfterNewMs', 'int', '收到新消息后的最小静默（毫秒）',
    '防止它抢话：即使刚收到消息，也必须至少静默这么久才能回应。默认 10000（10 秒）。'],

  // 表情包
  ['socialV2.sticker.enabled', 'bool', '表情包总开关',
    '关掉后它不能收发收藏表情，相关工具也会失效。'],
  ['socialV2.sticker.syncTtlMs', 'int', '表情列表缓存时长（毫秒）',
    '收藏表情列表多久重新同步一次。默认 60000（1 分钟）。'],
  ['socialV2.sticker.maxListCount', 'int', '一次最多列几个表情',
    '它查询表情列表时最多返回多少个。默认 100。'],
  ['socialV2.sticker.includeInPrompt', 'bool', '把表情写进提示词',
    '让它在开口之前就知道自己有哪些表情可用（不用先查一次）。开了更会挑图，代价是提示词更长。'],
  ['socialV2.sticker.promptMaxStickers', 'int', '提示词里最多放几个',
    '上面那条最多放几张表情进提示词。默认 8。'],
  ['socialV2.sticker.collect.enabled', 'bool', '允许偷图收藏',
    '允许它把别人发的图收藏进你的表情包。'],
  ['socialV2.sticker.collect.maxPerMinute', 'int', '每分钟最多收藏几个',
    '偷图频率上限（分钟）。默认 2。'],
  ['socialV2.sticker.collect.maxPerHour', 'int', '每小时最多收藏几个',
    '偷图频率上限（小时）。默认 10。太小攒得慢，太大你表情包会乱。'],
  ['socialV2.sticker.collect.maxRemarkChars', 'int', '表情备注最大字数',
    '它给收藏的表情写备注时最多几个字。默认 20。'],

  // 主动找人
  ['socialV2.proactive.enabled', 'bool', '主动找人总开关',
    '允许它在没人说话时主动找你/找群聊。关掉 = 只被动回复。'],
  ['socialV2.proactive.checkIntervalMinMs', 'int', '主动检查间隔下限（毫秒）',
    '多久检查一次"要不要主动开口"，最短间隔。默认 1800000（30 分钟）。'],
  ['socialV2.proactive.checkIntervalMaxMs', 'int', '主动检查间隔上限（毫秒）',
    '同上，最长间隔。默认 5400000（90 分钟）。'],
  ['socialV2.proactive.idleThresholdMs', 'int', '闲置多久才主动（毫秒）',
    '会话安静超过这么久，才考虑主动开口。默认 900000（15 分钟）。'],
  ['socialV2.proactive.probability', 'number', '主动概率',
    '每次检查时真的开口的概率。0~1，默认 0.3。'],

  // 反馈 / 上下文
  ['socialV2.feedback.maxLength', 'int', 'AI 反馈最大长度（字）',
    '它上报反馈时正文最多多少字。默认 500。'],
  ['socialV2.feedback.notifyOwnerOnError', 'bool', '出错时也通知管理员',
    '它上报错误类反馈时，是否顺带给你发一条 QQ 消息。默认关（只在控制台看得到）。'],
  ['socialV2.context.recentLimit', 'int', '塞给 AI 的近期消息条数',
    '它读"最近消息"时默认最多给多少条。默认 100。'],
  ['socialV2.context.unreadLimit', 'int', '塞给 AI 的未读消息条数',
    '它读"未读消息"时默认最多给多少条。默认 30。'],
  ['socialV2.context.contextWindow', 'int', '上下文窗口条数',
    '每次回复时带多少条历史给 AI。默认 20。'],

  // ── 模型与 DSH 接线 ───────────────────────────────────────────────────
  ['dsh.baseUrl', 'string', 'DSH 地址',
    '桥接去连哪个 DSH。留默认（http://127.0.0.1:3080）= 自动从 harness 日志里发现当前地址和令牌；只有你把它跑在别的端口时才需要改。'],
  ['dsh.provider', 'string', '模型提供方',
    '机器人用哪个 LLM 提供方，例如 deepseek-official。这个值要和 DSH 里已安装的提供方对得上，填错会话会起不来。'],
  ['dsh.model', 'string', '模型 ID',
    '机器人用哪个模型，例如 deepseek-flash（快）或 deepseek-v4-flash-vision-exp（带视觉）。改完下一回合生效。'],
  ['dsh.reasoningEffort', 'enum', '思考强度',
    '模型的思考档位。档位越高越聪明，也越慢越贵；default 表示交给模型自己定。日常聊天建议 high 或 medium。',
    ['default', 'low', 'medium', 'high', 'max']],

  // ── SnowLuma 接线 ─────────────────────────────────────────────────────
  ['snowluma.wsUrl', 'string', 'SnowLuma WebSocket 地址',
    '桥接连 SnowLuma 用的 WS 地址。本机就用「HTTP 服务端」那个端口（默认 ws://127.0.0.1:3000）—— 它同时提供 HTTP 和 WS。⚠️ 改了要重启桥接。'],
  ['snowluma.httpUrl', 'string', 'SnowLuma HTTP API 地址',
    '桥接问 SnowLuma"QQ 登录了吗 / 发消息"用的 HTTP 地址（默认 http://127.0.0.1:3000）。**必须填 HTTP API 端口**，填成纯 WS 端口会报 HTTP 426。⚠️ 改了要重启桥接。'],
  ['snowluma.launcherPath', 'string', 'SnowLuma 启动脚本',
    '需要重启 SnowLuma 时用的启动脚本路径（默认 C:\\SnowLuma\\launcher.bat）。'],
  ['snowluma.homeDir', 'string', 'SnowLuma 安装目录',
    'SnowLuma 的安装位置（默认 C:\\SnowLuma）。换机器/换盘时改这里。'],
  ['snowluma.allowProcessControl', 'bool', '允许控制 QQ 进程',
    '允许桥接去启动/结束 QQ 客户端进程。属于危险权限，除非你很确定在干什么，否则保持关闭。']
];

/**
 * 顶层字段属于哪个分组。
 * 分组默认按路径第一段切（`socialV2.send.*` → socialV2），但这几个字段在 config.json 里
 * 是**顶格**的（`notifyTaskDone` 而不是 `notify.enabled`），按路径会被归到"基本"，
 * 所以在设置页里点名归到"通知"。注意：schema 的嵌套结构必须等于 config.json 的嵌套结构
 * （桥接要深合并），所以这里是**纯展示层面的归类**，不动 schema 结构。
 */
export const TOP_LEVEL_GROUPS = {
  notifyTaskDone: 'notify',
  notifyTaskDoneMinTurnMs: 'notify',
  notifyTaskDoneDebounceMs: 'notify',
  notifyTaskDoneMaxChars: 'notify',
  relayApprovalsToOwner: 'notify',
  sessionDiscoveryMs: 'notify'
};

/** 字段所属分组（设置页用；lib/client.js 里有一份同样的表，测试会校验两边一致）。 */
export function groupOf(pathStr) {
  if (TOP_LEVEL_GROUPS[pathStr] !== undefined) return TOP_LEVEL_GROUPS[pathStr];
  return pathStr.includes('.') ? pathStr.split('.')[0] : 'core';
}

/**
 * 按字段表建 schemastery schema。
 * @param {Function} z schemastery 模块。
 * @returns {object} 根 z.object。
 */
export function buildSchema(z) {
  const root = {};
  const seen = new Set();
  for (const [pathStr, kind, label, detail, extra] of FIELDS) {
    if (seen.has(pathStr)) continue;   // 同路径只保留第一条
    seen.add(pathStr);
    const segments = pathStr.split('.');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      node[segments[i]] ??= {};
      node = node[segments[i]];
    }
    node[segments[segments.length - 1]] = leafSchema(z, kind, label, detail, extra);
  }
  // 分组对象的 description = 这一组的中文名 + 这一组是干什么的。
  // 客户端从 schema 里读它当小标题，就不用再抄一份分组表。
  const groups = {};
  for (const [key, value] of Object.entries(root)) {
    const wrapped = isLeaf(value) ? value : wrap(z, value);
    const meta = GROUPS[key];
    groups[key] = meta === undefined || isLeaf(value)
      ? wrapped
      : wrapped.description(`${meta.title}｜${meta.desc}`);
  }
  return z.object(groups);
}

/** 把「普通对象树」递归包成 z.object（schemastery 不认嵌套简写）。 */
function wrap(z, tree) {
  const dict = {};
  for (const [key, value] of Object.entries(tree)) {
    dict[key] = isLeaf(value) ? value : wrap(z, value);
  }
  return z.object(dict);
}

/**
 * 是不是 schemastery 的 Schema 实例。
 * 注意：Schema 实例本身是**函数**（可调用做校验），别用 typeof === 'object' 判断，
 * 否则会把 Schema 当成分组对象递归进去，撞上循环引用直接爆栈。
 */
function isLeaf(value) {
  return (typeof value === 'function' || (value !== null && typeof value === 'object'))
    && typeof value.type === 'string';
}

/** 设置页里显示的完整文案：标签 + 说明（用 ｜ 分隔，卡片自己拆两行）。 */
function described(label, detail) {
  return detail ? `${label}｜${detail}` : label;
}

function leafSchema(z, kind, label, detail, extra) {
  const text = described(label, detail);
  switch (kind) {
    case 'bool': return z.boolean().description(text);
    case 'int': return z.number().description(text);
    case 'number': return z.number().description(text);
    case 'text': return z.string().role('textarea').description(text);
    case 'numbers': return z.array(z.number()).description(text);
    case 'strings': return z.array(z.string()).description(text);
    case 'enum': {
      const options = Array.isArray(extra) ? extra : [];
      if (options.length === 0) return z.string().description(text);
      return z.union(options.map((option) => z.const(option))).description(text);
    }
    case 'string':
    default: return z.string().description(text);
  }
}
