# Prophey（仓库原名 pi-mcps，本地目录不变）

## Layout

- `apps/desktop` — Electron + React 桌面端。主进程 (`src/main`) 以 RPC 子进程方式启动 pi，渲染层 (`src/renderer`) 只通过 preload 暴露的 `window.pi` 通信。
- `packages/` — 给 pi / 其他 MCP 客户端使用的服务器。`mcp-core`：桌面端核心交互 MCP（零依赖 stdio），当前提供 `ask_user_question`，新工具加到 `packages/mcp-core/tools/` 并在 `tools/index.mjs` 注册即可。`warpgrep-mcp`：独立的自然语言代码搜索 MCP（`codebase_search`），后端默认 DeepSeek `deepseek-flash`，见下方「WarpGrep（DeepSeek 版）」。
- `scripts/electron-vite.mjs` — electron-vite 启动器。

## Commands

```bash
npm install          # 根目录，workspaces 安装
npm run dev          # electron-vite dev（HMR）
npm start            # 构建后预览生产包
npm run build        # 构建 main / preload / renderer 到 apps/desktop/out
npm run typecheck    # node + web 两个 tsconfig 分别检查
```

## Notes

- 从 Electron 宿主（如 Devin Desktop）派生的终端会带有 `ELECTRON_RUN_AS_NODE=1`。`scripts/electron-vite.mjs` 在启动前删除该变量，否则 Electron 会以纯 Node 模式运行并报 `electron.app is undefined`。不要改回直接调用 `electron-vite`。
- pi 的 CLI 从 `node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` 解析（该包没有 `main`/`exports`，不能用 `require.resolve`）。可用 `PI_CLI_PATH` 覆盖。
- 主进程用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 启动 pi RPC。
- RPC 协议：stdin/stdout 各一行一个 JSON 对象，只按 `\n` 切分（不要用 readline）。事件 `message_update` 只含增量，最终以 `message_end` 为准。
- pi 配置：用户级 `~/.pi/agent/mcp.json`，项目级 `.pi/mcp.json`（需项目信任）。桌面端默认工作目录存于 Electron `userData/config.json`。
- 未登录时 `get_state` 返回 `model.id = "unknown"`，主进程将其归一为 `undefined`，界面显示登录提示。

## Provider settings

- `src/main/providers.ts` 用 pi SDK 的 `ModelRuntime` 读取服务商、凭据状态并执行登录。SDK 是 ESM-only 且没有 CJS `main`，必须用 `await import('@earendil-works/pi-coding-agent')`，不要用 `require`。
- 登录：`runtime.login(providerId, 'oauth' | 'api_key', interaction)`。`interaction.prompt` / `notify` 通过 `providers:login-message` 发给渲染层，答案从 `providers:answer-login` 回来；OAuth 的授权 URL / device code 会自动用系统浏览器打开。
- 凭据写入 `~/.pi/agent/auth.json`；`models.json` 保存后必须 `resetRuntime()` 再重建，否则模型目录是旧的。`settings.json` 只合并 `defaultProvider` / `defaultModel` / `defaultThinkingLevel`。
- 凭据、models.json、settings 变更后主进程重启 pi，并用 `--session <当前会话文件>` 保留对话；如果正在流式输出则跳过重启，下次启动生效（`configPending`，见「运行状态」）。
- **服务商统一入口**：设置页只保留“服务商”，所有条目都可通过 `ProviderEditor.tsx` 编辑地址、协议和模型，顶部提供添加服务商与高级 JSON。定义仍由 pi SDK 预置目录叠加 `models.json` 得到；`builtin` 仅用于内部默认值校验和恢复预置配置，不再作为界面分类。旧的 `setProviderBaseUrl` IPC 保留兼容，新界面统一保存 `models.json`，随后重建 runtime 并应用到当前引擎。
- **新增或修改的模型必须填 `contextWindow`**（`ProviderEditor` 保存时校验）。缺了它会影响自动压缩与用量显示；只修改预置服务商地址时不写空模型列表，继续沿用预置模型目录。
- 区域/订阅版本是 pi 的**独立 provider id**，不要合并：`moonshotai-cn`/`moonshotai`（Kimi 国内/海外）、`kimi-coding`（Kimi 订阅）、`minimax-cn`/`minimax`、`zai`/`zai-coding-cn`（Z.AI 海外/国内订阅）、`google`（AI Studio）/`google-vertex`。设置页用 `PROVIDER_NOTES` 给这些 id 加中文说明，而不是改名字或做映射。
- 模型切换：输入条模型 chip 打开列表，数据来自 RPC `get_available_models`（只含已配置凭据的服务商），选择后调用 `set_model` 并广播新状态；不要再用 `cycle_model` 盲切。
- 同一会话内跨服务商切换是 pi 原生能力：`set_model` 只要求新服务商有凭据，会向会话追加 `model_change` 记录，历史保持不变，下一条 assistant 消息记录新的 `provider/model`。恢复会话时 pi 用会话里最后一个 `model_change` / assistant 消息恢复模型（`sdk.js` 的 `getBranchSelection` + `hasConfiguredAuth`）；凭据缺失才回退默认模型并给出 “Could not restore model …”。切换的代价是 prompt cache 归零、换到窗口更小的模型会触发自动压缩；当前 SDK 会在跨模型请求中过滤其他模型的 thinking/私有签名，并由目标协议适配器处理工具 ID（`pi-ai/dist/api/transform-messages.js`）。

## Theme & sidebar

- 新建会话优先打开 `WorkspacePicker` 的最近目录列表；侧栏、工具栏加号、Ctrl+N 和目录入口共用，只在点击“选择其他目录…”时调用系统选择器。最近 24 个目录保存到 config.recentRepos，按最近使用顺序去重（Windows 大小写/斜杠归一），并补充历史会话目录；同名不同路径同时显示。取消系统选择保留最近列表，失效目录明确提示，不清空当前会话。

- 当前会话以 `status.sessionKey` 为准标记选中，比较 Windows 路径时归一斜杠和大小写。选中行使用底色与实心点；`runningSessionKeys` 汇总主回合、压缩、后台命令、子代理所属会话以及**停在后台继续跑的会话**（`parkedEngines`），执行中显示动态状态点；普通列表和置顶一致。
- 首条请求额外启动一次独立标题请求（`session-title.ts`），只传用户首条提示词，禁用工具，不写 transcript，不阻塞主回合。优先用当前已配置模型，CLI 模型不在桌面目录时用已配置的默认/可用模型。无凭据或生成失败保留首句标题。结果按原 session file 写入，不能跟随当前激活会话漂移；`titleSource` 区分 prompt/generated/manual，生成结果不得覆盖手工标题。
- `readSummary` 同时读取 pi 和内建 JSONL 格式；已有 `s_...` 文件名标题按首条真实用户消息修复。后台通知不能作为标题来源。

- 侧栏区分“会话”和“项目”：单目录会话按目录分组，多目录项目按持久化的 `SessionSummary.projectId` 分组，不得仅因 cwd 相同就吸收到项目中。全部多目录项目都列出，不随当前激活项目切换而消失；历史单目录项目保留记录并按普通会话显示。
- `SessionSummary` 携带 `projectId/additional`，从 SessionStore 透传。项目标题右侧 `+` 创建该项目的新会话；目录分组的 `+` 只创建单目录会话，清除之前项目的归属。项目选择器统一放进列表，不再使用顶部横向项目 chips。
- 侧栏“新项目”的目录选择器：去重后只有一个目录时直接创建普通会话，不保存一个空的单目录项目。多目录时创建项目。“管理项目目录”使用中立的目录/默认工作目录文案。
- 会话行固定约 30px，标题占主要宽度，时间与引擎移入 title 提示；选中态用底色，菜单在悬停/键盘聚焦时显示。置顶与列表共用滚动区，置顶会话不重复出现。`node scripts/test-sidebar.cjs` 用隔离 Electron 验证并输出亮暗主题截图至 `artifacts/sidebar/`。
- **左侧列表和右侧概览用同一套卡片语言**：`.sidebar-nav`、`.pinned-block`、每个 `.project-group` 都是 `border: 1px solid var(--border)` + `border-radius: 10px` + `background: var(--bg-elev)` 的卡片（对齐 `.panel-card`），卡头一行「名称 —— 数量」，卡内是 30px 行；`.section-label`/`.sidebar-section-label` 只是卡片之间的分隔标签。样式集中在 `styles.css` 末尾的 sidebar-as-folded-cards 段，改这里之前先看 `scripts/test-sidebar-cards.cjs`（真实 Electron，断言卡面/圆角/行高/选中 chip 并输出 `artifacts/sidebar-cards/{light,dark}.png`）。

- 主题：`document.documentElement.dataset.theme` 为 `dark` / `light`，持久化在 localStorage `pi-desktop-theme`。样式全部走 `styles.css` 顶部的 CSS 变量；新增样式不要写死颜色，否则亮色主题会破。切换主题时同时调用 `app:set-theme` 同步 Electron 标题栏 overlay 颜色。
- **窗口拖拽区里的按钮必须自己 `-webkit-app-region: no-drag`**：`.tabbar`、`.rail`、`.sidebar-head` 都是 `drag` 区，鼠标按下只会拖动窗口，事件不会落到按钮上。`.rail-btn`、`.tab-new`、`.tab-close`、`.sidebar-head .icon-btn` 都写了 `no-drag`，标题栏右侧的 `.tabbar-right .icon-btn`（会话概览 / 侧栏）和 `.subagent-btn` 曾经漏写，表现为“点侧栏按钮没反应”。注意 `element.click()`、`sendInputEvent` 和 CDP `Input.dispatchMouseEvent` 都会绕过拖拽区命中测试，验证必须用真实鼠标（`artifacts/os-click-retry-proof.cjs`）。
- 侧栏顶部按参考产品（Claude 桌面端）排：`.sidebar-toolbar`（☰ 收起侧栏 / ▭ 视图选项 / ← → 会话前进后退）、`.sidebar-nav`（新建 / 自定义 / 更多，更多展开 `.nav-menu`）、`.pinned-block`（置顶会话，编号徽标）。
- 会话前进后退由 `App.tsx` 的 `historyRef`（stack + index，上限 50）驱动：`selectSession(session, { remember: false })` 用于历史跳转，避免再次入栈。
- 置顶存在 localStorage `pi-pinned-sessions`（路径数组），会话悬停时的第一个 `.session-archive` 按钮是置顶、第二个是归档。**置顶的会话只在 `.pinned-block` 里出现，必须从项目分组里过滤掉**（`groups` 用 `visible = sessions.filter(!pinned)`）——否则同一个会话在两处重复，用户会以为有两条。
- 侧栏：按 `session.cwd` 分项目，默认每个项目显示 10 条，超出显示“显示其余 N 个”；折叠/展开状态在 `Sidebar` 内部。项目标题右侧 `+` 通过 `pi:new-project-session` 切换 cwd 并开新会话。
- **目录顺序不随切换会话变化**：分组排序键是 `SessionGroup.born`（该组**全部**会话里最早的 `createdAt`，置顶/归档的也算），不再是 `latest`（最近活动）。切会话会碰 `updatedAt`，但不会改变 `born`，所以目录永远不换位；只有真正多出一个目录（或它的第一条会话出现）才会按 `born` 降序插进来。`sort` 选「名称」时仍按 label。组内顺序：`最近活动` 模式下把当前打开的会话（`activePath`）提到组首，显式选了名称/创建时间则不移动。改这条规则要同步 `tests/renderer-state.test.cjs`（切换不换位 / 组内置顶 / 置顶或归档不改变 born / 新目录插入）与 `scripts/test-sidebar.cjs` 的真实切换检查。
- **一个会话 = 一个 git 仓库**（单仓库会话模式；多仓库 project 是后面一层）。`src/main/repo.ts` 用 `git -C <dir> rev-parse --show-toplevel` 把目录归一化到仓库根，`pi:new-project-session` / `pi:choose-workspace` 都会先归一化，所以 `session.cwd` 就是仓库根、侧栏分组天然按仓库走。仓库信息（分支 / remote / 未提交数）5 秒缓存，`PiStatus.repo` 给输入框的 workspace chip 用，`pi:repos` 给侧栏每组头部的 `⎇ main 8` 徽标用；**不要在渲染层直接跑 git**。
- 目录不是仓库时 `isRepo: false`，此时不显示分支徽标、行为退回“普通文件夹会话”，不要报错——用户可能就想在非仓库目录里跑。
- `PiRpcClient` 的 `exit` / `error` 回调必须确认 `this.child === child` 再处理，否则重启时旧进程的退出事件会把新进程引用置空并误报“pi 进程已退出”。

## Conversation layout

- assistant 消息不再有头像，正文直接铺开（文档式）；用户消息是右对齐气泡，图片在气泡上方（`.message.user` 为 column + align-items flex-end）。
- **工具卡片直接铺开，不再有聚合行**：一轮里的工具调用按顺序渲染成 `.tool-card`（`.tool-list` 里 gap 4px），每条显示名称、参数摘要、状态与耗时；参数与输出默认折叠，运行中也不自动展开。原来上面那行「调用 N 个工具 / 读取 2 个文件 ›」已经删掉——它每条 assistant 消息吃掉一整行加边距，而且文字重复卡片已有的信息；运行中提示由输入框上方的 `RunStatusBar` 负责，所以没有信息损失。**一轮 = 一条 assistant 消息**：不要为了“看起来少一点”去跨消息合并思考块或工具。
- **竖向节奏要紧凑（同屏信息量优先）**：`.conversation` 项间距 10px、上下 padding 14px；`.assistant-body` gap 6px；`.tool-list` gap 4px；`.tool-head` 内边距 5px 9px（行高约 26px）；`.markdown p` 下边距 8px。同一段 transcript 的 `scrollHeight` 623 → 487（去掉聚合行后再降到约 460）。改小之前先量：不要靠肉眼拍脑脑袋。
- 量间距不要靠肉眼拍脑袋：写一个一次性脚本（种一份带工具调用的 transcript → 用真实构建打开 → 打印 `itemGaps` / `contentHeight` / `toolHeadHeight` 并截图到 `artifacts/`），对比改前改后的数字，量完删掉、不要提交。
- 每轮结束的统计行（`.run-status`）来自 `App.tsx` 的 `run` 状态：`agent_start` 记开始时间、`tool_execution_start/end` 加减运行中数量、`agent_settled` 记结束时间并通过 `pi:session-stats`（RPC `get_session_stats`）取 `tokens.total`。1 秒定时器只为刷新计时，不要用它做别的。

## 会话概览面板（仿 Claude Desktop 右侧栏）

- 入口：标题栏右侧的面板按钮（`TabBar`，`ListIcon`），开关状态存 localStorage `pi-session-panel`。面板是 `.main-body` 里的 flex 兄弟节点（`.session-panel`，306px，窄窗口 264px），不覆盖聊天区，也不影响右侧会话大纲（大纲在 `.chat-area` 内绝对定位）。
- 五张卡片（`components/SessionPanel.tsx`）：**环境**（`status.cwd` / `status.repo` 分支与未提交数 / 会话 additional 根 / 引擎 · 模型）、**上下文**、**连接器**、**产出**、**后台任务**。`PanelCard` 是唯一容器，不要为单张卡片另写折叠逻辑。
- **折叠态是默认视图，也是信息本身**（仿 Claude Code）：每张卡片折起来只剩一行「标题 + 该卡片最该看的数字」，环境给目录名、上下文给百分比 + 迷你条、连接器给 `N 已连接` / `N 需重连`、产出给文件数、后台任务给 `N 运行中` / `N 已完成`。展开状态存 localStorage `pi-session-panel-cards`（`{context:true}` 这种形状，只在点击时写），所以“我习惯看上下文”这种偏好不会每次丢。新增卡片时必须同时给它写 `summary`，否则折起来就是空行。
- **上下文分类只在 Prophey 引擎下存在**：引擎自己拼请求，所以它知道每部分多大（`ContextUsage.breakdown`）。`measurePrompt()` 用“发给模型的声明”估算系统提示词、自建工具（文件/命令/子代理/提问，`CoreTool.source` 为空）、每个 MCP 服务（`source` = 端点名，`mcp-client` 填的）各占多少；消息部分取“总量 − 其余部分”的余额，所以各段加起来永远等于环上的数字；估算比实测还大时（字符/4 对 JSON 声明偏高）按比例压到实测总量，不会出现“各段之和 > 已用”。pi / Claude Code / Codex 拿不到分类，`breakdown` 留空，卡片自动退回原来那三块（会话与工具 / 自动压缩缓冲 / 剩余空间）——**不要为它们编造分类**。
- 分类条是 `.panel-meter` 里的 `.panel-meter-seg`，颜色来自 `--chart-messages` / `--chart-system-tools` / `--chart-mcp-tools` / `--chart-system-prompt`（深浅色各一套）；图例行即使为 0 也保留（`always`），只看不留空白。MCP 工具那行可展开，列出每个服务端占的 token 与工具数。
- **产出**来自 transcript 的写文件工具调用（`lib/session-outputs.ts`，纯函数、有单测）：`write_file`/`write`/`Write`/`edit_file`/`Edit`/`multiedit` 等取 `path`/`file_path` 参数，Codex 的 `apply_patch` 解析 `*** Update|Add|Delete File:` 行；相对路径按 `status.cwd` 解析，失败的调用丢弃，同一文件只留一条（最新在前，保留首次的写/改类型）。点条目走 `workspace:reveal`，主进程只允许会话工作区（含 additional）内的路径，越界或文件不存在返回错误，不在渲染层拼路径直接开。
- **后台任务**读 `status.backgroundTasks`（运行中）和 `status.backgroundFinished`（本会话已结束数量，`BashTasks.finishedCount()`，受 128 条保留上限约束，是「最近」不是生命周期总数）。停止按钮走 `engine:stop-background-task` → `AgentEngine.stopBackgroundTask?`；只有 Prophey 引擎实现，其他引擎回错误并提示用 `stop_bash_task`，**不要给所有引擎假装支持**。
- **连接器**读 `get_mcp_state`（App 已订阅 `mcp:state`，面板和设置页共享同一份状态）：内建引擎 codegraph/warpgrep/web 显示连接/索引状态，「重新检测」调 `refreshMcpEngines`；外部 MCP 服务显示启用状态并提供停用/启用（写 `mcp.json` 后 `reloadPiConfig`）。「管理」直接打开设置 → MCP 标签。
- 验证：`node scripts/test-session-panel.cjs`（真实 Electron、隔离 profile、种子事件，断言五张卡片不横向溢出、聊天区保留宽度，截图写 `artifacts/session-panel/`，含折叠态 `folded.png`）；行为回归在 `npm run test:smoke` 的 `tests/session-panel-smoke.cjs`（折叠摘要、展开后的卡片内容、注入 `contextUsage.breakdown` 后的分段条与 MCP 服务端占比、连接器「管理」跳 MCP 标签、产出与后台任务行、折叠持久化）。

## Session view, thinking, model allowlist

- 会话导航：`SessionNavigator.tsx` 在聊天区右侧渲染标题大纲（`buildOutline` 提取 assistant Markdown 标题，无标题时用首行兜底）和用户提问时间线。消息元素带 `data-message-id`，App 用 `jumpToMessage` 滚动定位；滚动时按消息相对位置更新 `activeUserIndex`，到底部时强制标记最后一条提问。

- 侧栏视图偏好存在 localStorage `pi-sidebar-prefs`（environment/group/sort/showEmptyGroups），归档会话存在 `pi-archived-sessions`。启发注意：**展开/收起本身**（`sidebarOpen`）由 `lib/layout-prefs.ts` 的 `SIDEBAR_OPEN_KEY`（`pi-sidebar-open`，`'1'`/`'0'`）记录，和右侧概览的 `PANEL_OPEN_KEY`（`pi-session-panel`）走同一套 `readLayoutFlag`/`writeLayoutFlag`——缺省值是"侧栏开、概览关"，读不出来（隐私模式 / 脏值）就回缺省，绝不把未知值当成"关"。两个开关按钮同时在标题栏（`TabBar`，`.sidebar-toggle` / `.panel-toggle`）和左侧图标栏（`IconRail`，`.rail-btn.sidebar-toggle`）出现，**必须都带 `on` 类 + `aria-pressed` + `title`（"隐藏侧栏"/"显示侧栏"）**，否则用户看不到当前状态；测试选择器用这两个稳定类名，不要依赖会变的 title 文案。搜索和状态筛选是**项目级**的（项目头部的 `+ / 搜索 / 筛选`，状态存在组件内 `projectStatus`，搜索存在 `projectQueries`）；顶部的漏斗是全局“视图选项”（环境/分组/排序/显示空分组）。分组支持文件夹 / 日期 / 不分组，排序支持最近活动 / 创建时间 / 名称；归档通过会话悬停按钮切换。`showEmptyGroups` 会在文件夹分组下保留当前工作目录以及所有出现过会话的项目（即使筛选后为 0 条）。SSH 环境和 PR 状态 pi 没有数据来源，菜单里显示为禁用项。
- 思考等级必须用 RPC `get_available_thinking_levels` 获取（随模型变化），选择后调用 `set_thinking_level`；不要用 `cycle_thinking_level` 盲切。
- 模型隐藏走 pi 的 `settings.json.enabledModels` 允许列表：`setProviderModels` 会把“除隐藏项外的全部模型 ID”写进去，全部启用时删除该字段（空 = 全部）。`pi:list-models` 和 `listModelChoices` 都按该列表过滤。未勾选的模型不会出现在模型选择器/默认模型下拉中。
- 允许列表必须**压缩**写入：某个服务商的所有模型都启用时写 `provider/*`（pi 用 minimatch 匹配 `provider/id`），只有部分启用才写具体 ID。历史上写成 1560 条精确 ID 会让 `isModelEnabled` 变成 O(模型×模式) 的 2 秒级卡顿（打开设置卡住的原因）。
- `isModelEnabled` 用 `getMatchers`：精确模式进 Set、通配模式预编译成 RegExp，按模式串缓存，禁止再在循环里 `new RegExp`。`listModelChoices` 结果也按「模式 + 已配置服务商」缓存，凭据/`models.json`/`settings.json` 变化时调用 `invalidateCache()`（登录、登出、保存设置、保存模型列表都会调用）。
- `listModelChoices` 默认只返回**已配置凭据**的服务商模型（1560 → 5），否则 contextBridge 跨隔离世界复制上千个对象会让设置页卡 2 秒。需要全部模型时传 `{ includeUnconfigured: true }`。
- 主进程启动时在后台 `listProviders()` / `listModelChoices()` 预热（`whenReady` 里），让第一次打开设置不用等 `ModelRuntime` 冷启动（约 500ms）。
- 服务商列表合并 runtime 与 `models.json` 中的定义，尚无凭据或运行时未提供登录方式的条目也可编辑。`ProviderEditor.tsx` 保留未知字段（headers/compat/cost 等），保存失败时保留草稿；重复 ID 要从列表编辑。删除预置条目的配置称为“恢复预置配置”，不删除 SDK 目录和 OAuth 凭据。预置 ID 仍从 `modelsPath: null` 的独立 ModelRuntime 获取，不能用叠加后的目录判断。
- OpenAI ChatGPT 订阅登录必须在 `runtime.login` 的 options 里传 `getDeviceId`（稳定的 UUID，保存在 Electron userData 的 `device-id` 文件），否则报 “Sign in with ChatGPT requires a device ID (UUID) for this installation”。
- 两个 OpenAI 服务商是 pi 内置的：`openai`（ChatGPT 订阅 / API Key，标准模型）和 `openai-codex`（旧版 Codex 渠道，仅 ChatGPT Plus/Pro，模型较少）。设置页对两者有说明文案。
- **ChatGPT 订阅的「剩余用量」只能借用 Codex 凭据**：OpenAI 把 “Sign in with ChatGPT”（token sharing）令牌限制在 `api.openai.com/v1/models` 与 `/v1/responses`——`chatgpt.com/backend-api/wham/usage` 返回 401 `no_matching_rule`，`/v1/responses/usage` 要 `api.responses.read` 权限（两者都实测过）。Codex 凭据带 ChatGPT 账号 id，能读**同一份**套餐窗口，所以 `src/main/chatgpt-usage.ts` 先试 pi `auth.json` 的 `openai-codex` 凭据、再试 Codex CLI 的 `~/.codex/auth.json`（`CODEX_HOME` 优先），请求带 `chatgpt-account-id` / `originator: codex_cli_rs`，主进程缓存 60 秒、登录/登出时 `invalidateChatGptUsage()`。解析与文案在 `src/shared/chatgpt-usage.ts`（`18000s → 5 小时`、`604800s → 7 天`，剩余 = `100 - used_percent`，百分比保留小数、展示时向下取整）。设置页只在 `openai` / `openai-codex` 且 `storedType === 'oauth'` 时显示这一行；查不到就写「需在 ChatGPT 设置中查看」并给 `chatgpt.com/settings/usage` 链接，**不要编造百分比**，也不要把这一行挂到 API Key 凭据上。验证：`node scripts/test-usage-row.cjs`（真实 Electron + 隔离 profile：本机有 `~/.codex/auth.json` 时校验数字，没有时校验回退文案，截图写到 `artifacts/usage/`）。

## Composer & images

- 图片走 pi 原生能力：RPC `prompt` / `steer` 的 `images` 字段，元素是 `{type:'image', data: base64, mimeType}`；pi 会把它们写进会话 JSONL 的 image content block，`get_messages` 也返回同样的块。
- 渲染层 `lib/images.ts` 负责 File → base64（`blobToDraftImage`，上限 8MB）和 `clipboardImages`（读 `clipboardData.items`）。**图片是纯附件**：不写文件名、不插入 `[图片N]` 标记，统一在输入框上方以 42×42 圆角方块展示（`object-fit: cover`，不同长宽比也对齐），悬停才出现删除按钮；发送时按数组顺序传给 pi。
- **粘贴入口在 `Composer.tsx` 的 window 级 `paste` 监听**（不是 textarea 的 `onPaste`）：焦点在 chip / 滚动区时 Cmd+V 也要能附图，而落到其他控件（设置、@ 搜索框、队列编辑）的粘贴要放过去不拦。命中图片时 `preventDefault()`，纯文本粘贴仍走浏览器默认。`addImages` 和 `removeImage` 都用 `imagesRef` 而不是 props 里的 `images`：连贴两张时两次解码并发、连删两个时两次点击同批，用 props 会让后一次覆盖前一次。输入框 `disabled`（pi 未就绪或 `/btw` 开着）时给提示而不是静默丢弃——剪贴板里那张图已经没了。
- 验证方式（不用手点）：PowerShell `[Windows.Forms.Clipboard]::SetImage()` 放一张图到系统剪贴板，再用 CDP `Input.dispatchKeyEvent`（`modifiers: 2` + `KeyV`）发真正的 Ctrl+V，然后数 `.draft-image` 的数量；合成 `ClipboardEvent` + `DataTransfer` 只能测到监听器，测不到系统剪贴板这一层。
- 点任意缩略图打开 `ImageLightbox`（Esc / 点背景关闭）；会话里用户消息用 `MessageImages` 渲染，图片在气泡**上方**右对齐（`.message.user` 是 column + align-items flex-end）。放大预览支持右键 `.image-context-menu`（复制图片 / 关闭预览），点外面或再按 Esc 只关菜单；菜单打开时 Esc 不会直接关掉预览。
- 放大预览共用「复制图片」按钮、Ctrl/Cmd+C 和原生 copy 事件；`lib/images.ts` 将已加载图片按原始尺寸绘制为 PNG，经 `window.pi.copyImage` / `app:copy-image` 写入系统图片剪贴板，不复制 URL/文本。Electron 45 使用异步 `clipboard.write([new ClipboardItem(...)])`（不再有 `writeImage`）；必须 await 写入完成再显示成功。主进程 `image-clipboard.ts` 只接受有大小限制的 PNG 数据，解码前检查 IHDR 像素数，不读取任意文件/网络 URL。测试 `image-copy-smoke.cjs` 使用真实系统剪贴板并在 finally 恢复原内容。
- 允许只发图片不发文字：`prompt` 的 `message` 传空串，pi 接受（实测模型能收到图）。
- **上下文用量**：输入框右下角的小圆环 + `2% 20K / 1M`，数据来自 `get_session_stats().contextUsage`（`{tokens, contextWindow, percent}`）。`App.tsx` 在 `loadMessages`、`agent_settled`、`status.autoCompactPercent` 以及 **`status.model.id` / `contextWindow` 变化时**刷新（换模型是新的窗口、新的阈值，用量和配色必须跟着变）。**Prophey 引擎还会把用量写进 `status.contextUsage` 并在流式过程中推送**（每 400ms 或变化超过窗口 1% 才推一次，避免每个 token 都重渲染），`App.tsx` 有一个 effect 专门用它覆盖 `contextUsage`/`run.tokens`，所以那一轮还没结束圆环就在动；其他引擎不写这个字段，继续走 `get_session_stats`。`percent` 在刚压缩完时是 `null`，此时按 `tokens/ceiling` 兜底、拿不到就显示 0。**不要**显示 prompt cache 到期时间——pi 不提供，也不该猜。
- **分母是“可用上限”，不是窗口**：自动压缩开着时 `ceiling = round(window × autoCompactPercent / 100)`（1M 窗口 50% → 500K），界面显示 `211K / 500K`，提示里才写 `（窗口 1M，到 50% 自动压缩）`。显示 1M 等于给用户一个这轮永远到不了的上限（压缩先发生）。压缩关掉时分母回到窗口本身，提示写「自动压缩已关闭」。颜色：`>= 100%` 红、`>= 85%` 琥珀。
- **自动压缩**：默认目标是窗口的 90%（`AUTO_COMPACT_RATIO`）。pi 在 `contextTokens > contextWindow - reserveTokens` 时压缩，所以 `reserveTokens = window × (1 - ratio)`（1M 窗口 → 100K 余量）。写入 `~/.pi/agent/settings.json` 的 `compaction.{enabled,reserveTokens}`；**pi 只在启动时读这个值**，所以改完必须重启（`reloadPiConfig`，忙时会延后）。`syncAutoCompact()` 在启用、换模型、启动时各跑一次，值没变就不重启。
- 阈值只有一个真源：`config.json` 的 `autoCompact.ratio`（按比例存，换模型时按新窗口重算）。三个入口都写它并立刻 `broadcastStatus()`：设置 → 通用 → 「自动压缩」开关（`pi:set-auto-compact`）、设置 → 通用 → 「自动压缩阈值」下拉（`pi:set-auto-compact-ratio`，10–99%）、`/autocompact <tokens>`（换算成比例）。**设阈值必须把 `autoCompactEnabled` 置 true**：`statusSnapshot()` 只在它为真时给出 `autoCompactPercent`，漏了这一步界面会一直显示「已关闭 / 90%」，用户看到的阈值就不跟随设置变。
- 渲染层不要用 `status.autoCompactPercent ?? 90` 兜底成一个假阈值（历史上设置页这么写过，等于把真实值藏掉）；拿不到就说明没窗口信息或压缩已关，按这个含义显示。模型没有 `contextWindow` 时保留 pi 默认的 16K 余量并提示用户补 `contextWindow`。

## 斜杠命令

- 输入框打 `/` 弹出命令菜单（`Composer.tsx` 的 `SLASH_COMMANDS`），↑/↓ 选择、Enter/Tab 填入、Esc 清空。**填入后 `slashPicked` 记住当前值**，否则菜单会一直打开、Enter 永远只是重复填入，命令发不出去。
- 命令在渲染层拦截（`App.tsx` 的 `runCommand`），**不管是否在流式输出都会先走命令，认不出的 `/xxx` 才当普通消息**（`send()` 里先 `runCommand`，返回 true 才算消费、清空输入框）。命令本身永远不进入对话。
  - `/mcp`、`/btw` 是**本地命令，立刻执行**：`/mcp` 读一次 `getMcpState()` 弹浮层；`/btw` 立刻打开面板，主进程等本轮结束再 `clone`（面板里显示「正在回答…」）。两者都不排队，`send()` 里命令处理必须排在 `/btw` 面板守卫之前，否则面板打开时连 `/mcp` 都被拒。
  - 需要空闲会话的命令（`/clear`、`/compact`、`/autocompact <数字>`）**排队而不是拒绝**：忙碌时 `queueCommand()` 往消息队列里塞一条 `command: true` 的条目（输入框上方显示「命令」标签，没有「立即发送」按钮），回合结束后由同一个 flush effect 调 `runCommand(text, { queued: true })` 执行。`queued: true` 时若 pi 又忙起来就返回 false，flush 会把条目放回队列而不是丢掉。
  - `/clear`：开新会话（= 侧栏「新建」），不是清空当前 JSONL。
  - `/compact [提示词]`：RPC `compact` + `customInstructions`；会话太小时 pi 会返回 `Nothing to compact`，原样提示给用户。
  - `/autocompact <token 数 | on | off>`：写 `~/.pi/agent/settings.json` 的 `compaction.enabled` / `compaction.reserveTokens`（`reserveTokens = contextWindow - 阈值`，按当前模型的 `contextWindow` 换算），再按比例存进 `config.json` 的 `autoCompact.ratio` 并重启 pi；`on/off` 额外调 RPC `set_auto_compaction` 立即生效。同一个阈值也能在 设置 → 通用 → 「自动压缩阈值」里按百分比选。
  - `/mcp`：用 `getMcpState()` 弹浮层列出所有服务器（名称/传输/内置/启用状态）与全部工具名。
  - `/btw <问题>`：在当前分支节点开一个**新的侧边对话**（`BtwChat` 面板，全屏浮层）。主进程 `pi:btw-start` 用 RPC `clone`（不是 `fork`——`fork` 需要具体 entry id，传 leaf 会报 `Invalid entry ID for forking`）拿到分支文件，然后在这个分支上 `prompt` + `waitForSettle` + `get_last_assistant_text`；**分支保留到面板关闭**，面板里的追问走 `pi:btw-ask`（同一个分支，可多轮），关闭走 `pi:btw-close`：切回原会话、删掉分支文件。整个过程 `btwActive` 为真：`pi:event` 不发给窗口（否则渲染层会把分支会话加载进主记录），`sessionArgs()` 也强制返回原会话，重启不会落到分支上；任何切换/重开会话的 IPC 与 `reloadPiConfig()` 都先 `closeSideChat()`。左侧栏、输入框在面板打开时不可用（输入框 `disabled`），避免消息发进分支。
  - `/btw` 不排队：正在跑时先 `waitForIdle()` 等本轮结束再 `clone`（面板立刻打开显示「正在回答…」）；再次 `/btw` 会先 `closeSideChat()` 丢掉旧分支，从**当前**节点重新分支。`btwGeneration` 在每次 start/close 自增，用于取消还在等待的 start——否则面板关掉后它仍会把进程停在分支上。
  - 面板打开期间 `setStatus` 不广播，但 `status.isStreaming` 仍会随分支运行更新（`pi:btw-ask` 用它判断上一轮是否结束）。

## 设置界面

- 设置弹窗可拖右下角缩放（CSS `resize: both`，最小 720×460），尺寸存 `localStorage["pi-settings-size"]`，由 `ResizeObserver` 在 400ms 防抖后写入；`SettingsModal` 常驻挂载，所以关闭再打开尺寸不会丢。
- 服务商列表左侧的 `.provider-mark` 用**品牌图标**（`ProviderMark.tsx`）：路径来自 `@lobehub/icons-static-svg`（MIT）并**内联进源码**，不要再装那个包。图标是单色、用 `currentColor` 上色，颜色取 `--provider-color`；品牌色在黑/白主题之一会消失时（OpenAI、Kimi、Anthropic 这类近黑，Hugging Face 这类近黄）退回 `currentColor`。图标集里没有的品牌（Radius、小米）显示首字母，不要自己重画 logo。
- MCP 页使用紧凑服务列表：默认每行只放名称、简短说明、状态、工具数量、配置入口和开关。路径、密钥、索引操作及工具明细默认折叠，配置/工具面板互斥。内置服务不要在下方外部服务列表重复显示；配置路径只在“配置文件位置”展开区显示真实路径。文案面向当前引擎，不再向用户展示 pi 启动参数或扩展注入细节。

## 消息队列

- 运行中（`status.isStreaming` 或 `status.compacting`）发消息**默认是引导（steer）**：`Enter` 直接把这条消息插进当前回合，`Ctrl+Enter` 才是**加入队列**（等本轮结束后自动发送）。空闲时两者都是发送。2026-10 之前是反的（Enter 排队、Ctrl+Enter 强制引导），被用户否掉了——「发送就该发送，不想被打断时才按 Ctrl」。
- **输入框、待发图片和队列都是会话独享的**：三者一起存在 `lib/session-composer.ts` 的那张表里（`SessionComposerMap`，键 = 侧边栏会话 key，落在 `localStorage: pi-session-composer`）。`App.tsx` 只把当前会话那一条取出来当 `draft` / `draftImages` / `queued` 用，setter 也只改当前会话；切换会话不清理输入框（清的是"别人的"，以前正是这样丢草的），失败回填和 flush 用**入队时捕获的 key**（`composerKeyRef` / `owner`），异步返回时用户已经切走也不会写错会话。启动阶段还没有 session key 时落到 `local`，会话到位后由 `adoptComposer` 迁过去。
- **右侧对话必须属于当前会话**（“会话串目录”回归）：切换会话时引擎可能还没换好 transcript，`pi:get-messages` 以前只返回一个数组，窗口无法分辨拿到的是哪个会话。现在主进程回 `{ sessionKey, messages }`（`sessionKey` 取自 `currentEngine.state()`，不是 `status`，引擎没换完时能看出来），渲染层用 `lib/session-messages.ts` 的 `messagesBelong()` 比对 `sessionKey`/`sessionFile`（`pathKey` 归一大小写与斜杠），不属于当前会话的答案直接丢掉并最多重试 20×150ms；`status.sessionKey ?? sessionFile` 一变就先 `setItems([])`，宁可短暂空白也不要把上一个目录的对话留在屏幕上。改这里别退回"只返回数组"——那就又没法判断归属了。
- 模型和思考等级同样跟会话走：写进 `SessionRecord`（`sessions.json` 的 `provider` / `model` / `thinkingLevel`），重开会话时 `applySessionPreferences()` 覆盖引擎自己的全局默认值——CLI 引擎只有一个全局默认模型，不这么做会出现"在 A 改了模型，回 B 又变成 A 的"。
- 队列渲染在**输入框外面**（`.composer-wrap > .queue-panel`，不是 `.composer` 里）：输入框本身的边界不被队列改动。每条可编辑（放回输入框）、删除，非命令条目还有「引导」按钮（`.queue-steer`）——排队后想立刻插进当前回合就点它（走 `prompt(text, 'steer')`）。布局上的 `max-width: 860px; margin: 0 auto` 要和 `.composer` 对齐。
- 回合结束后自动按顺序发送队列里的下一条。**flush 的 effect 只能依赖 `status.isStreaming` / `status.compacting` / `status.phase`，不能依赖 `queued`**——否则加入第二条时会和第一条抢跑（`isStreaming` 还没变 true 就再发一次），实测第二条会被 pi 拒绝并丢失。
- 发送失败时把该条放回队首并提示，避免静默丢消息。放回后必须**自己再排一次**（`restore()` 重新读 `pi:get-status` 并 2 秒后 `setQueueTick`）：条目出队又回队不产生任何状态变化，flush 不会重跑，否则排队项会永远躺在那里。

## bash 工具（Windows）

- pi 的 bash 工具用 `where bash.exe` 找 shell：先 `%ProgramFiles%\Git\bin\bash.exe`，再 PATH 里的第一个。**Git 装在别处（按用户安装、`D:\app\Git`）时，PATH 里的第一个是 `%LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe`——那是 WSL 的 App Execution Alias，没装发行版时它永远不返回**。表现是每条 bash 都 `Command timed out after N seconds`，连 `echo hi` 也一样，从记录里完全看不出 shell 根本没启动。
- 所以 `shell.ts` 的 `withRealBash()` 会在**每个 pi 子进程**（主进程 `runStart`、子代理 `SubagentManager.start`）的环境里把真实 Git Bash 的目录放到 PATH 最前面（`%LOCALAPPDATA%\Programs\Git\bin`、`%ProgramFiles%\Git\bin`、以及从 PATH 里的 `git.exe` 反推的 `…\Git\bin`），WindowsApps 里的 stub 一律跳过。
- 注意 `withRealBash(env)` 的 `env` 只是**要追加的变量**（`launch.env` 通常没有 PATH），PATH 必须从 `process.env` 取；写成从 `env` 取会把整条 PATH 换成单个目录，`where.exe` 自己就找不到了（表现成 `No bash shell found`）。合并后只保留一种大小写（`PATH` / `Path` 同时出现时 Windows 取哪个是不确定的）。
- 用户在 `settings.json` 里写 `shellPath` 时仍然优先（pi 先看它），不要覆盖。

## 引擎边界（`src/main/agent/`）

- 目标形态是「我们自己的 agent，pi 只是可替换的引擎」。`agent/engine.ts` 是契约（`state/busy/compacting/running/start/stop/request/refresh/waitForSettle/waitForIdle`），`agent/pi-engine.ts` 是 pi 的实现。
- **引擎只负责跑一轮和运行状态机**：子进程、`agent_start → agent_settled` 的 busy、压缩、settle waiter、`get_state` 权威校正、崩溃退出通知。**应用策略全部留在 `index.ts`**：MCP 服务器、`/btw` 分支、压缩阈值、速度档位、config、profile、子代理。
- 引擎要的启动参数（MCP 参数、扩展、profile、速度档位、项目根）由 `prepare(workspace)` 回调提供，所以引擎不认识 MCP/profile 这些概念；`sessionArgs()` / `sessionDirArgs()` 同理。
- **`AgentWorkspace = { primary, additional[] }`** 是「一个会话跨多个目录」在 agent 层的表达：`primary` 是工作目录（相对路径、bash、搜索默认都对它解析），`additional` 是项目里的其他目录（只能用绝对路径访问，绝不当子目录）。`engine.start()` 收 `string | AgentWorkspace`，`engine.workspace()` 报告当前生效的根；不存在的 additional 根在启动时被丢弃。**会话在项目内启动时覆盖整个项目，在项目外就是一个根**（`currentWorkspace()`），这条是行为分界，别在别处再拼一遍根列表。
- **根感知工具**（`packages/mcp-core/tools/workspace.mjs`）：`workspace_roots` / `read_file` / `grep_files` / `write_file` / `edit_file` / `run_bash`，入参是 `root`（目录名）+ 相对路径，越界（`..`、绝对路径、符号出根）直接拒绝。**只在多根会话里列出**（`AGENT_DESKTOP_ROOTS` 多于一个），单目录会话继续用 pi 自带的工具，不重复造轮子。主进程在 `prepare()` 里把根清单写进 `AGENT_DESKTOP_ROOTS`、把解析到的 Git Bash 写进 `AGENT_DESKTOP_SHELL`（core server 没有修好的 PATH），扩展转给 core server；`<project>` 段会告诉模型优先用它们。
- `run_bash` 的 `root` 只决定**工作目录**，shell 本身仍有完整文件系统权限（`cd ../别的仓库` 照样能跑）——要真正限制得靠沙箱，现在没有。
- 实测（两目录项目）：模型全程只用 `mcp__desktop__*`，`root: "Git"` 读到/写入第二个目录，`run_bash` 在 `Git` 里跑 `ls | head -3` 拿到真实输出；`../beta/x`、`C:/Windows/win.ini`、未知 root 全部被拒绝并列出可用目录。
- `index.ts` 里的 `status` 只是**镜像**：引擎通过 `onStatus` 推过来，`statusSnapshot()` 再加应用自己的字段（压缩百分比、档位、仓库）。写状态必须走 `engine.setStatus()`，不要直接赋值。
- 新增 pi 调用时用引擎的**语义方法**（`setModel` / `thinkingLevels` / `stats` / `messages` / `compact` / `newSession` / `switchSession` / `clone` / `abort` / `send`），**不要**再写 `engine.request('set_model')` 这种命令名：那等于把 pi 的命令表写进窗口，第二个引擎就接不进来。`PiEngine` 里这些方法只是薄封装，`index.ts` 已无一处 `engine.request(`。
- `engine.prompt()` 承担「窗口和 pi 对忙碌判断不一致」的全部兜底（压缩中等空闲后重试、`already processing` 改发 `followUp` 并回 `queued: true`），所以它是唯一发送入口；不要在别处再包一层重试。
- **Prophey 引擎（v1）**：`agent/prophey-engine.ts`，`config.engine = 'prophey'` 或设置 → 引擎切换（默认 `pi`）。它自己调 `ModelRuntime.streamSimple` 跑循环：一轮 = 一次模型回复，回复里有 `toolCall` 就执行、把 `toolResult` 塞回 transcript、再来一轮（持续执行到最终回复或用户停止，不按固定工具轮数静默退出），事件流和 pi 一致（`agent_start → message_start → message_update… → message_end → tool_execution_start/end → agent_end → agent_settled`）。transcript 只在内存里。
- Prophey 引擎的工具**复用 pi 那边同一份实现**：`agent/core-tools.ts` 按绝对路径 import `packages/mcp-core/tools/workspace.mjs`（打包后在 `resources/mcp/tools/`），不复制第二份；工具调用的 `root` 语义、越界拒绝、Git Bash 路径全部一致。
- **WarpGrep（DeepSeek 版，`packages/warpgrep-mcp`）**：独立的零依赖 stdio MCP，只暴露一个 `codebase_search`（与桌面内置 WarpGrep 同名同参），把「grep → 列目录 → 读指定行 → finish」这套循环交给 `deepseek-flash`（默认）跑，返回**验证过存在**的 `path:start-end`。分工：`server.mjs` 只做 JSON-RPC 分帧 + 工具注册（照 `mcp-core` 的写法，日志只走 stderr），`search.mjs` 是循环（system prompt 在 `prompt.mjs`，工具 schema、预算、超时、finish 兜底都在这里），`workspace.mjs` 是沙箱化的 grep/glob/list/read（**不执行 shell**），`config.mjs` 解析 CLI/env 与 Key。五个坑写在包 README 里，最要紧两条：**工具预算只能在回合之间截断**（一次回复多个 `tool_calls` 时中途 break 会留下未应答的 `tool_call`，DeepSeek 直接 400），**`finish` 的路径必须 `verifyFiles` 校验**（模型会编路径；`App.tsx:1184` 后面单起一行 `1233` 要续到同一文件）。Key 发现顺序：`WARPGREP_API_KEY` → 服务商 env → `WARPGREP_KEY_FILE` → pi 的 `auth.json`（所以桌面里登录过 DeepSeek 就不用再粘 Key）。回归：`node --test tests/warpgrep-mcp.test.cjs`（12 条，脚本化假端点驱动真程序），真机：`node artifacts/warpgrep-mcp-live.cjs`。
- **桌面 WarpGrep 的两个后端**：`apps/desktop/src/main/warpgrep.ts` 用 `resolveWarpGrepBackend()` 分流。没配 `mcp.warpgrep.baseUrl` → 走原来的 hosted Morph（`morph-warp-grep-v2.1`，**没有 system prompt、不追问、只认 finish**，一点没改，避免质量回归）；配了自定义端点 → 走 `packages/warpgrep-mcp/search.mjs` 那份循环（`searchCustom()`，`systemPrompt` 默认、finish 兜底、`verifyFiles` 都在里面），所以一套实现两个入口。配置：`config.json` 的 `mcp.warpgrep = { baseUrl, model, apiKey }`，IPC 是 `mcp:set-warpgrep`（只收 http(s)，空 baseUrl 即回 Morph），`McpState.warpgrep` 暴露 `baseUrl/model/keyHint/keySource`，UI 在 `McpPanel` 的 WarpGrep 卡片里（端点 + 模型 + Key 一行）。**Key 不要求再粘一遍**：`warpgrepBackend()`（`index.ts`）在自己没 Key 时按 host 找 `deepseek`/`openai`，用 `providers.providerApiKey()` 读 pi 的 `auth.json`，最后才回落 `morphApiKey`。`engineStates()` 里 `available` 也随之放宽（有端点即算可用），`entry` 显示 `baseUrl · model`。回归：`node --test tests/warpgrep-endpoint.test.cjs`（8 条：Morph 无 system prompt / 自定义端点有、默认模型、路径校验、prose 追问、Key 缺失与 401 错误码）；真机：`node artifacts/warpgrep-desktop-live.cjs`（走 config → buildEngineTargets → gateway → DeepSeek 全链）。
- **会话持久化**：`transcript-store.ts` 把 transcript 写 `userData/transcripts/<sessionId>.jsonl`（头行 + 每条消息一行，全量重写、原子 rename）；`start()` 时 resume 一次并把历史按 `message_end` 重放给窗口，所以刷新/重启后对话还在。sessionId 存在 `config.propheySessionId`，新建会话时轮换。
- **重试**：`streamRoundWithRetry` 对瞬时错误（429/5xx/timeout/ECONNRESET/流提前关闭）退避重试 3 次，发 `auto_retry_start/end`；鉴权/参数错误不重试。
- **压缩**：`compact()` 让模型把对话压成一段结构化中文摘要（目标/决定/改过的文件/未完成/继续所需事实），摘要作为唯一一条 user 消息替换 transcript；`shouldCompact()` 在**每轮开始前**按 `contextWindow × 比例` 判断是否自动压缩（配置来自窗口同一个阈值设置，不重启），并发 `compaction_start/end`。`stats()` 报告的是**实测用量 + 增量估算**（见下条），所以用量环和自动压缩阈值在 Prophey 引擎下也工作。
- **子代理按引擎归属执行**：Prophey 子代理创建独立 `PropheyEngine` 实例与 transcript，不启动 pi；pi 子代理仍用 `PiRpcClient`。CC/Codex 使用其原生子代理，不注入桌面子代理 MCP。记录/UI 可共用，执行后端不得跨引擎静默回退。
- **`/btw` 也通了**：`clone()` 把 transcript 复制成新 id 并返回它的路径，`switchSession()` 按路径载入，所以 `pi:btw-start` 那套「记住原会话 → fork → 关闭时切回」的记账不用改就成立（实测：起侧边对话 → 追问 → 关闭后 sessionFile 回到原值）。
- **MCP 也通了**：`agent/mcp-client.ts` 直接连桥接的 `/mcp/<key>`（streamable HTTP，`initialize` + `tools/list` + `tools/call`），工具名保持 `mcp__<server>__<tool>`，和 pi 完全一致。端点由 `mcpEndpointsFor(workspace)` 生成（同一套 `buildEngineTargets` / `buildEngineRegistrations`，所以多根仓库的 `codegraph__<repo>` 也在）。实测：Prophey 引擎下调 `mcp__codegraph__codegraph_search` 拿到了真实路径。
- **速度档位（两家都支持）**：用 SDK 的 `onPayload`（改请求体）+ `transformHeaders`（加 beta 头）两个钩子，不要去 patch 全局 fetch。OpenAI 写 `service_tier: fast|ultrafast`；Anthropic 写 `speed: "fast"` 并把 `fast-mode-2026-02-01` 合并进已有的 `anthropic-beta`（不重复、不覆盖别的 beta）。档位由 `speed.resolveSpeedMode` 按 provider 判断，非目标服务商不会发。**注意：两家都没有在真实付费账号上验证过**（当前账号不支持该档位），只验证了生成的 payload/header 形状。
- **`ask_user_question` 也通了**：工具直接调桥接 `/ask`（走 `node:http`，**不要用 fetch**——主进程装了全局 undici proxy dispatcher，loopback 请求会 `fetch failed`，而且 undici 有 300s headers 超时，等待用户回答必然超时）。实测：引擎调工具 → 窗口弹窗 → 回答后模型拿到选择。
- **契约里没有 `instanceof`**：`poll()` 取代了 `PiEngine.watch()`（pi 需要轮询 `get_state`，Prophey 无事可做），新会话的 id 由 `newSessionId()` 回调交给引擎（应用负责持久化），所以 `index.ts` 里不再有引擎类型判断。
- **已知小瑕疵**：Prophey 的 transcript 里会出现一条内容为空的 `system` 消息（provider 侧归一化时混进来的），不影响对话与持久化，但会让 `getMessages()` 多一条。原因还没定位。
- **默认引擎是 Prophey**（`config.engine` 不设或不是 `'pi'` 时都走它）；`pi` 仍是可切换的另一套实现。
- **MCP 工具名不带 `mcp__` 前缀**：那个前缀是 pi 为了给 MCP 工具分命名空间才有的，我们自己的循环不需要——工具名就是 `<server>__<tool>`（如 `codegraph__codegraph_search`、`codegraph__git__codegraph_search`）。pi 引擎那边仍然是 `mcp__…`，所以两边的工具名不同，提示词不要写死名字。
- **系统提示词由引擎自己拼**（`systemPrompt()`）：角色 → 工作目录清单 → `root` 语义（越界拒绝、先读后改、run_bash 指目录、后台任务读日志）。没有扩展钩子参与。
- **工作目录直接写进提示词，不让模型调 `workspace_roots`**：多根会话列出「目录名（主目录）+ 绝对路径」，单根会话写「工作目录：<path>（工具不需要 root）」。目录名必须和工具解析的名字一致（都取 `basename`），这样模型第一次调用就带对 `root`，省掉一次往返和那份工具输出。`workspace_roots` 工具仍保留（子代理、根清单可能变化时应答），只是提示词不再引导它。
- **上下文用量必须实测，而且要边跑边更新**（`contextTokens()` / `publishUsage()`）：提供商在每个流事件的 `partial.usage` 里给真实计数（Anthropic 一开始就给 prompt，OpenAI 末尾才给），`usage.input` 不含缓存部分，所以 `prompt = input + cacheRead + cacheWrite`。口径是「下一次请求会发多少」：最近一次响应的 `prompt + output`（它已经包含系统提示词、工具声明和全部消息）**减去**已被它覆盖的那段 transcript，**加上**此后追加的消息；正在生成的回复用 `partial.usage.output`（没有就给 partial 的文本估算）叠加上去——这就是圆环在一轮开始等待时就已经跳到真实值、并且随流式增长的原因。`transcript` 被替换（`newSession` / `switchSession` / `resume` / `compact`）必须 `resetUsage()`，否则旧基数会挂在新对话上。永远没有响应过的会话才退回估算：`estimateTokens(transcript) + promptTokens`（系统提示词 + 工具声明的字符数），`estimateTokens` 只数消息真正发送的内容（text / thinking / tool arguments），**不要**用 `JSON.stringify` 整条消息——字段名和转义会让估算系统性偏高，自动压缩就会提前触发。
- Prophey 引擎与 pi 的功能差距：**没有了**（Anthropic 快速模式已补齐）。只有尚未开始的空会话可以选择 agent；开始后的会话不得更换 agent。
- 改名说明：产品名是 Prophey，但 `app.setName('agent-desktop')` **故意保留**——它决定 `%APPDATA%/agent-desktop`，改了等于丢失用户的配置、会话、项目和凭据。
- 还没搬完的部分：`/btw` 的 clone/switch、压缩阈值同步、登录消息、MCP 启动参数装配（`prepare` 仍由 `index.ts` 提供，这是刻意的）。

## CLI 引擎与统一能力

- Claude Code 的 Bash / Read / Write / Edit / Task / 搜索等工具由 CC 原生管理；桌面不传 `tools` / `disallowedTools`，不再读取旧 `engineTools` 配置，也不提供禁用原生工具的设置入口。避免重复应通过不注入 Prophey 的桌面 MCP 工具实现；保留 CC 自己的用户、项目及本地设置和第三方 MCP。

- 共享能力和命令描述在 `src/shared/engine.ts`；引擎契约在 `src/main/agent/engine.ts`。界面与 IPC 使用同一份描述，不按引擎名各写一套判断。
- `EngineStartOptions` 使用中立的 `session/model` 字段；只有 PiEngine 将其转换为 pi 命令行参数。会话记录保存 engine，原生 `claude:/codex:` 标识不是文件，不能用 existsSync 清理。
- ClaudeCodeEngine 使用官方 Claude Agent SDK 驱动本机 CLI；CodexEngine 使用本机 `codex app-server` 的 JSON-RPC。两者保留自己的登录、工具、网络搜索和原生自动压缩。禁止注入桌面 web 工具，禁止再传退休的 WebFetch/WebSearch/web_search 禁用项。
- 手动压缩走原生接口：Claude 的 /compact，Codex 的 thread/compact/start。Codex 请求返回只代表接受，必须等完成事件；Claude 只有 compact_boundary 才能证明成功。不要将普通摘要回答当成原生压缩。
- 自动压缩分 configurable/native/none。原生管理时隐藏桌面阈值，后端也拒绝覆写 pi 配置。未知上下文用量不能显示成 0%，原生自动压缩不能显示成已关闭。
- 命令来源：桌面公共命令 + pi get_commands / Claude supportedCommands / Codex skills/list 与 review/start。未知命令明确拒绝，不作为普通提示词。重名时由公共适配入口处理。
- 运行中引导只对支持 steer 的引擎开放（`engineCapabilities().steer`：pi / Prophey / Codex 为 true，Claude 为 false——SDK 没有中途注入，只能排队）。原生审批和提问复用 ask 回调与桌面问答队列，缺少 UI 时拒绝，不静默授权。
- **原生提问（CC / Codex）走同一套 UI**：引擎侧只调 `ask(questions, tool)`（`native-engine.ts`），它走桥接的 `askEngine` → `ask:request` → `AskQuestionPanel`，和 pi/Prophey 的 `ask_user_question` 共用队列与面板，不另做一套弹窗。
  - Claude Code：在 `canUseTool` 拦 `AskUserQuestion`，问题**原样**交给面板；回答回 `{ behavior: 'allow', updatedInput: { ...input, answers } }`（键=问题文本，值=选项 + 手输用 `, ` 拼接），取消回 `deny`。其他工具的审批也走这个回调（拒绝 / 允许本次）。
  - Codex：处理服务端请求 `item/tool/requestUserInput`，问题映射成 `AskQuestion`（`header`、`options[].description`、`isSecret → secret`），回答回 `{ answers: { <question id>: { answers: [...] } } }`（形状照 `codex app-server generate-json-schema` 的 `ToolRequestUserInputResponse`）。另外 `item/permissions/requestApproval` 同意时把请求的权限原样回传（`scope: 'turn'`）、拒绝回 `{ permissions: {} }`；`item/tool/call` 明确回 `success: false`（桌面没注册动态工具）；其余方法抛「尚不支持的 Codex 请求」。
  - **Codex 的 `request_user_input` 是实验工具，0.163 必须同时给两条启动覆盖**：`-c tools.experimental_request_user_input.enabled=true` 与 `-c features.default_mode_request_user_input=true`。少后者时工具在 Default 模式下被调用会报 `request_user_input is unavailable in Default mode`（只打到 stderr，模型自己改写回答，看起来像“没提问”）。用 `-c` 而不是写 `~/.codex/config.toml`；开关是 `config.json` 的 `codexRequestUserInput`（默认开，设置 → 通用 → 「原生提问」），因为它是启动参数，改了要重启 Codex。
  - `initialize` 仍声明 `capabilities.experimentalApi = false`：实测 0.163 不打开也能收到 `item/tool/requestUserInput`，打开只会多收到其他实验方法（`elicitation/create` 等我们并不实现）。
  - `isOther` 为 false 时 Codex 表示“请从选项里选”，但 `answers` 本身就是自由字符串，桌面面板继续保留手输（否则 `options: null` 的问题没法回答）；`isSecret` 会让面板用密码框并把手输内容显示成「已填写」。
  - 回归方式（均需登录 + 系统代理，会跑一轮真实模型）：`node scripts/claude-question-probe.mjs` 与 `node scripts/codex-question-probe.mjs`。实测 CC 2.1.304：`AskUserQuestion` 进 ask 回调（header/options/multiSelect）→ 选「英文/详细」→ 模型回 “From here on I’ll answer in English and go into detail.”；Codex 0.163：`item/tool/requestUserInput` 进回调（header/options/isSecret）→ 选「英文/详细」→ 模型回 “I’ll respond in English with detailed explanations.”。
  - 单测：`tests/engine-contract.test.cjs` 覆盖两条映射（含取消/拒绝/权限/动态工具分支）与 Codex 启动参数；面板由 `tests/ask-panel-smoke.cjs`（经 `npm run test:smoke`）向桥 `POST /ask` 验证：工具名、选项、多问题步骤、`secret` 密码框、回答回传与关闭取消。
- Claude 初始化可发现模型/命令目录；实际默认模型在首轮 init 才报告。此前显示 CLI 默认模型，不误报未登录。
- 本机 Codex 0.163.0 生成了 thread/items/list 类型但运行时返回 not supported；保留 thread/read/恢复响应历史的兼容路径，不能仅凭 schema 推断运行时能力。
- 验证使用 npm test + npm run typecheck + npm run build + npm run test:smoke。真实 CLI 验证使用系统代理，与主应用一致；不修改用户现有配置（手工探针：`scripts/claude-question-probe.mjs`、`scripts/codex-question-probe.mjs`）。

## 会话存储（我们自己的）

- `src/main/session-store.ts`：`SessionStore` 拥有会话列表（`%APPDATA%/agent-desktop/sessions.json`：`id / path / cwd / additional / projectId / title / createdAt / updatedAt`）。**窗口只读这个 store**，pi 的 JSONL 只是 `path` 这个引擎私有字段，换引擎时列表、排序、分组都不用动。
- 首次启动 `importPiSessions()` 把已有 pi 会话导入一次（走 `sessions.ts` 的 `listSessions`/`readSummary`）；之后 `rememberSession()` 在 `sessionFile` 变化、`session_info_changed`、`agent_settled` 时 upsert。新会话还没有名字时用 `readSummary` 读文件头取第一条用户消息当标题——否则侧栏会显示文件名。
- `pi:list-sessions` 先 `prune()` 掉文件已不存在的记录，再返回 `toSummary()`（形状和以前一样，渲染层不用改）。
- 别在渲染层或别处再扫 pi 的 session 目录：那等于把引擎的存储格式当数据模型，正是这层要解掉的耦合。

## 项目（多仓库）

- `src/main/projects.ts`：`ProjectStore`（`projects.json`，原子写、坏文件静默当空）+ `renderProjectSection()`。一个 project = 多个仓库根，**恰好一个 primary**，它是 pi 的 cwd。
- **项目是可选的上层，不是会话的前提**：默认侧栏还是「按文件夹分组」的老样子，没有项目时不出现任何 chip、不建任何文件。只有在需要「把多个目录合成一个工作单元」时才建项目，项目激活后会话才覆盖它的全部根。**不要**在启动时给每个会话目录自动建项目，也不要在新建会话/选目录时强制建项目（试过，等于把界面形状改了，被否掉）。
- 激活项目：`projects:activate` 把 `config.activeProject` 存下并重启 pi 到主仓库；扩展通过环境变量 `AGENT_DESKTOP_PROJECT`（`{id,name,roots}`）收到根清单，在 `before_agent_start` 里注入 `<project>` 段——**只在多根时注入**，单仓库就是普通会话。这个段和速度档位一样，注册在 `if (!url) return` 之前，MCP 全关也要生效。
- pi 没有 `--add-dir`：跨仓库靠提示词约定（绝对路径、每条 bash 是新 shell 要 `cd`、跨仓库搜索用 grep 的 `path` 参数）。实测模型能准确复述两个仓库的绝对路径。
- 侧栏在项目激活时把该项目所有仓库的会话归到同一个组头（`project:<id>`），组头的 `+` 和分支徽标用主仓库。
- 最近仓库 `config.recentRepos`（最多 12 个，启动时更新），侧栏「更多 → 最近仓库」；每仓库默认模型/思考等级存 `config.repoDefaults[cwd]`，**只在新建会话时应用**（带 `--session` 的重启不覆盖用户当前选择）。
- 项目激活时**会话目录也归到项目**：`--session-dir <profile>/sessions/projects/<projectId>`，`listSessions()` 仍然从 profile 根递归读，所以旧会话不会消失。
- 索引按项目铺开：`afterStart` 对主仓库和项目的每个根都调 `startCodegraphIndex`（`indexedRoots` 去重），否则跨仓库时代码图只覆盖主仓库。
- **引擎按仓库分端点**：`buildEngineTargets({ roots })` 给每个根生成一个 target，key 是 `codegraph`（主仓库）或 `codegraph__<repo>`（其余，小写 slug），上限 `ENGINE_ROOT_LIMIT = 3`（每个根一个上游进程 + 一套工具）。网关的 `Map` 键、桥接 `/mcp/<key>` 路由、扩展里的 server 名都用这个 key；单仓库会话的 key 就是原来的 id，行为不变。
- 两个坑：桥接的 `MCP_ENDPOINT` 正则必须允许大小写（曾经只认 `[a-z0-9_-]`，`codegraph__Git` 直接 404）；扩展的 `reportTools` 不能用 `^mcp__(.+?)__(.+)$` 拆服务器名（惰性匹配会把 `codegraph__git` 的工具记到 `codegraph` 名下），要按已注册的服务器名做最长前缀匹配。
- 实测：两仓库项目里 `mcp-tools.json` 出现 `codegraph__git`(8) / `warpgrep__git`(1)；模型用 `tool_search` 激活后真的调用了 `mcp__codegraph__git__codegraph_search`。注意 CodeGraph 是符号索引、只覆盖源码文件，全文检索仍要用 grep。
- 项目编辑在 `ProjectEditor.tsx`（改名 / 加仓库 / 移除仓库 / 换主仓库），保存走 `projects:update`；取目录用 `repos:pick-folders`（**无副作用**，不要复用 `pi:choose-workspace`，它会切会话）。移除仓库和删除项目都要**两步确认**，并且最后一个仓库不能被移除（`项目至少要有一个仓库`）。
- `@` 上下文选择器（`workspace:files`）覆盖项目的**所有根**：主仓库给相对路径（模型从 cwd 解析），其他仓库给绝对路径（`read`/`edit` 接受），预算主仓库 60%、其余平分——一个装了几千文件的工具目录否则会把列表淹掉。
- 侧栏视图选项里有「只看「项目名」」（`prefs.onlyActiveProject`），用来隐藏不属于当前项目的会话。

## 速度档位（fast / ultrafast）

- 两家都把它放在**请求体**里，但字段不同，Anthropic 还要 beta 头：OpenAI `service_tier`（`fast` 即原来的 `priority`，`ultrafast` 只有 `gpt-6-astra` / `gpt-6.1-sol`）；Anthropic `speed: "fast"` + `anthropic-beta: fast-mode-2026-02-01`，且只支持 Claude Opus 5.5 / 5 / 4.8（Opus 4.7 直接报错，4.6 静默按标准速度跑）。
- pi 自己没有这个开关（`service_tier` 只出现在内置 ai-sdk 的 chunk 里），所以走扩展的两个钩子：`before_provider_request`（改 payload）和 `before_provider_headers`（原地改 headers，返回值被忽略）。它们在 `apps/desktop/resources/extension/desktop-mcp.js` 的 `registerSpeed()` 里，**注册在 `if (!url) return` 之前**：MCP 全关时也要能改请求。
- 判定必须按 **provider**，不能只看 `model.api`：DeepSeek / Moonshot / Z.AI / Groq 都是 `openai-completions`，但都不实现 `service_tier`（发过去是 400 或未知字段）。`src/main/speed.ts` 与扩展里的 `tierFor()` 各判一次，扩展那次是防止模型中途切换后仍把档位塞给不支持的模型。
- 界面：输入框右侧 `.pill-seg.speed`（只有 `status.speed.available.length > 1` 时出现，非 `standard` 时高亮），点开是「标准 / 快速 / 极速」。`PiStatus.speed = { mode, available, note }`，`note` 说明缺哪档、为什么。
- 档位通过环境变量 `AGENT_DESKTOP_SPEED` 传给 pi 子进程（扩展在加载时读），所以切换会重启 pi；`sessionArgs()` 因此必须带上 `--provider/--model`：没有消息的新会话在磁盘上还没有文件，不带这两个参数重启会退回 settings.json 的默认模型，用户看到的是「切了档位模型自己变了」。
- 档位不是所有账号都能用：ChatGPT 订阅登录实测返回 `OpenAI API error (400): {"detail":"Unsupported service_tier: fast"}`（需要 API 计费或支持该档位的套餐，Claude 那边同理）。**没有接口能提前问出来**，所以第一次 400 就是信号：`forwardEvent` 在 `message_end` 里看到 assistant `stopReason === 'error'` 且错误匹配 `TIER_REJECTED` 时，把 `config.speed.mode` 写回 `standard`、`broadcastStatus()`、发一条 `speed_unsupported` 事件给窗口（提示「已回退标准，请重新发送」），再 `reloadPiConfig()` 让扩展不再注入。用户重新发送就正常了。
- 用户 `settings.json` 里显式写了别的 shell/模型默认值时不要覆盖；`ultrafast` 与 `flex` 的计价不同，UI 里要写清是按服务商计价的档位。

## 运行状态（busy）

- **`agent_end` 不是空闲**：自动重试、溢出恢复、压缩重试和队列消息都可能再开一轮，pi 在这段时间里会拒绝 `prompt`（`Agent is already processing…` / `Cannot submit a prompt while compaction is in progress`）。主进程只在 `agent_settled` 把 `busy` 置 false，`agent_start` / `compaction_start` 置 true；`get_state` 的 `isStreaming` / `isCompacting` 是权威值（`applyState` 会同步覆盖）。
- 之前把 `agent_end` 当空闲，导致队列 flush 抢在 pi 收尾时发送、被拒绝后弹「Agent is already processing…」并把消息退回输入框——这就是「发新消息卡住」的来源。
- `submitPrompt()`（`pi:prompt`）是唯一入口：先原样发；命中 `compaction is in progress` 就 `waitForIdle()` 后重试；命中 `already processing` 且没指定 `streamingBehavior` 就改发 `followUp` 排队并返回 `queued: true`（渲染层提示「已排队」）。**不要再在渲染层直接调 `rpc.prompt` 判断忙碌**。
- 压缩状态进 `PiStatus.compacting`，输入框占位符显示「正在压缩上下文」。
- `busy` 是事件驱动的，事件可能丢（压缩结束时 pi 正在重启、子进程被杀、`agent_settled` 没送到），而它**唯一的作用就是解锁队列**：卡住时界面一直显示运行中、排队消息永远不发。所以 `watchRunState()` 在 `busy` 期间每 3 秒 `get_state` 一次，以 pi 的答案为准。
- `startPi()` 必须返回**正在进行的那个 promise**，不能 `if (starting) return status`：第二个调用者会拿到 `phase: 'starting'`，而没有任何东西会替它把状态推到 `ready`，队列（只在 `ready` 时 flush）就永久停住。
- 渲染层的 `statusRef` 在 **effect 里**赋值，不要写成 `statusRef.current = status`（渲染期赋值）：被 React 丢弃的渲染会把 `busy` 留在 ref 里，`piBusy()` 就会和 flush 看到的状态打架。
- 运行中改 MCP/子代理设置走 `reloadPiConfig()`：忙碌时只记 `configPending`，`agent_settled` 时用 `sessionArgs()` 重启 pi 把新配置装上（否则开关改了永远不生效）。
- pi 非预期退出（扩展抛错、OOM）时 `rpc.on('exit')` 会在 1 秒后用同一会话重启，2 分钟内最多 3 次；`shuttingDown` 为真（`window-all-closed` / `before-quit`）时不再重启。
- 扩展里的定时器**必须能容忍失效的 ctx**：`new_session` / `clone` / `switch_session` / `reload` 之后捕获的 `pi` 会变 stale，`pi.getAllTools()` 抛出的异常会直接杀掉整个 pi 进程（实测 `Timeout.reportTools` 崩溃导致「pi 未运行」）。`reportTools` 已包 try/catch。
- **切换会话不打断在跑的回合**：`activateConversation()` 不再 dispose 忙碌的引擎，而是用 `retireEngine()` 把它「停到后台」——`parkEngine()` 把引擎和它的会话 key 放进 `parkedEngines`，引擎继续跑、继续写自己的 transcript，只是 `onEvent` 因为 `isActive()` 为假而不再往窗口发事件。重新打开那个会话时（`parkedEngines` 命中且引擎还活着）走 `activateParked()`：直接把 `currentEngine` / `status` 切回去，不重启、不丢上下文，`loadMessages()` 从 transcript 补齐已落盘的消息。空闲的引擎在切换时照旧 dispose；后台引擎一旦 settle 就 `reapParked()` 回收（300ms 后，等 transcript 写完），但**有后台命令在跑时不回收**，下次打开从 transcript 重启并拿到新配置。
- 每个引擎有独立的 `EngineSlot`（`engineSlots` WeakMap）保存它的 status 镜像：全局 `status` 只属于当前屏幕上的引擎。后台引擎的 `onStatus` 只更新镜像 + 侧栏运行点（`statusSnapshot().runningSessionKeys` 遍历 `parkedEngines`）并调用 `rememberParkedSession()` 落 SessionStore；**不要**让它写 `activeSession` / `engineSessions`（那是当前会话的指针）。
- `flushSubagentNotices()` 用 `engineForSession(parentSession)` 找会话对应的引擎，后台父会话也能收到子代理完成通知并自行继续；后台引擎的 `wake` 不受「用户刚点过停止」的限制。pi 没有 `notify()`，走桥事件时必须带 `session`，`desktop-mcp.js` 在 `session_start` 记住自己的 session file 后按 `sameSession()` 过滤——否则同时活着的两个 pi 进程会各自投递一遍。
- 唯一的例外：忙碌但**还没有 session file** 的引擎（回合最开始的一瞬间）没法重新打开，仍走 `agent/switch-guard.ts` 的 `idleBeforeSwitch()` 停掉。`{ stop: true }` 参数保留兼容，但正常情况下不再使用。
- **网关与工具调用按引擎隔离**：每个 EngineSlot 注册独立桥接凭据；`gateway.configure(targets, credential)` 只管理该引擎的端点，切换仓库不会重定向后台引擎的 codegraph / warpgrep。工具名保持不变。提问、创建/查询子代理、完成通知和 web 模型选择都从调用方取会话、工作区和模型；不得从全局当前会话推断后台调用来源。dispose 时释放凭据与网关。
- 验证：`tests/session-switch-smoke.cjs`（`npm run test:smoke`）在 `isStreaming: true` 状态下点仓库 `+`，断言不再出现 `ConfirmDialog` 且直接进入新会话；`tests/engine-contract.test.cjs` 仍覆盖 `idleBeforeSwitch` 的无 session file 兜底。

## Updates & packaging

- 更新实现：`apps/desktop/src/main/updates.ts` 使用 `electron-updater`。打包版走 electron-updater（GitHub Release 的 `latest.yml` + NSIS 安装包）；开发模式用 GitHub Release API 只做版本检测，`canInstall=false`。启动 5 秒后及每 6 小时自动检查，开关存在 userData 的 `updates.json`。
- **更新必须是不用重新安装的那种（参数来源：`codegraph-desktop` 的 Tauri updater 用 `installMode: "passive"`，只显示进度、没有向导）**：检查到新版本就**自动后台下载**（`autoDownload` 开关，默认开），下载完显示「已下载，退出应用时自动安装」，`autoInstallOnAppQuit` 在退出时执行；点「立即重启安装」走 `quitAndInstall(true, true)` —— **第一个参数必须为 true（静默）**。助手式 NSIS 安装器在 `--updated` 时只跳过 license / 目录页（`assistedInstaller.nsh` 的 `skipPageIfUpdated`），**安装模式页仍会弹出**，所以不带 `/S` 就变成“像在重新安装”。另外把 `autoUpdater.installDirectory` 钉到 `dirname(app.getPath('exe'))`（`/D=` 参数），静默升级才会装回原目录，而不是 NSIS 的默认位置。
- 状态语义：`preparing` = 安装包已落盘但还没装，**不算 busy**（用户可以继续工作或退出让它装），只有 `checking/downloading/installing` 算忙；`cancel()` 把下载中的状态退回 `available`。
- 与 `codegraph-desktop` 的另一个差别：那边用 minisign 公钥 + `requireSignedVersion: true` 验签名；我们只有 `latest.yml` 里的 sha512 + HTTPS（没有代码签名证书）。要缩短这个差距得先买证书，别只改配置。
- 更新源默认 `touwaeriol/prophey`，可用环境变量覆盖：`PI_DESKTOP_UPDATE_REPO=owner/repo`、`PI_DESKTOP_UPDATE_URL=<generic feed>`、`PI_DESKTOP_RELEASES_URL=<发布页>`。`electron-builder.yml` 的 `publish` 也要同步 owner/repo。
- 打包：根目录 `npm run dist`（`electron-builder.yml`，NSIS，输出 `release/`）。`asarUnpack` 包含 `@earendil-works/**`、`quickjs-wasi`、`@silvia-odwyer/**`；`findBundledCli` 在打包版优先从 `process.resourcesPath/app.asar.unpacked` 找 pi CLI。
- 系统代理：`proxy.ts` 用 `session.resolveProxy` 解析系统代理，设置 `HTTP(S)_PROXY`/`NO_PROXY`/`NODE_USE_ENV_PROXY`，并通过 `setGlobalDispatcher(new EnvHttpProxyAgent())` 让主进程 fetch 走代理；pi 子进程继承同一环境。设置页「网络代理」显示检测结果。
- 应用名：`app.setName('agent-desktop')`，userData 为 `%APPDATA%\agent-desktop`；启动时会从旧 `%APPDATA%\@pi-mcps\desktop` 迁移 `config.json`/`device-id`/`updates.json`。
- GitHub Actions 用 `--publish never` 打包，再用 `gh release create` 上传资产，避免 electron-builder 并发上传时创建重复 draft release。
- 在带有 `ELECTRON_RUN_AS_NODE=1` 的终端里测试打包版必须 `env -u ELECTRON_RUN_AS_NODE`，否则 exe 会按 Node 运行并立即退出。

## Sessions & workspace

- **配置固定共用**：默认直接读写 pi 的 `~/.pi/agent`，不再展示配置来源、独立配置或导入入口，历史 `config.profile` 字段不再生效。`profile.ts` 是路径唯一来源；显式 `PI_CODING_AGENT_DIR` 覆盖同时用于 SDK 和 pi 子进程，自动测试必须指向临时目录。
- 默认 session 目录由同一个配置目录的 `sessions/` 派生，**没有“会话存储”开关**：桌面端永远写 pi 自己的 `sessions/`（`PI_CODING_AGENT_DIR` 覆盖对它同样生效），项目和 pi CLI/TUI 共用同一批 JSONL。老的 `config.json.sessionMode` 只是被忽略，已有会话文件不迁移不删除（SessionStore 里记录着 `path`，照旧列出来）。
- 项目会话写到 `sessions/projects/<projectId>`（`currentSessionDir()`）；`--session-dir` 仍然**显式传入**（项目子目录 + 测试隔间都需要），只是不再有第二种基目录。`listSessions` 也从同一棵树递归读。
- 老的独立目录（`userData/sessions`）里历史文件不会被删除，但新会话不再写进去；用户要搬就直接移动文件/改 SessionStore 记录。
- 工作目录是**会话级**的：点击其他项目的会话必须走 `pi:open-session`（以该会话 cwd + `--session <path>` 重启 pi），不能只用 `switch_session`，否则工具会在错误目录运行。设置页只读显示当前会话目录，不提供全局工作目录编辑。
- `config.json` 保存 `{ cwd, mcp }`（`sessionMode` 已是历史字段）；`cwd` 只是下次启动/新建会话的默认目录。目录不存在时 `startPi` 会回退到 home，避免 spawn ENOENT。

## MCP & desktop tools

- 桌面提问工具 `ask_user_question` 是一条自建链路，四段：
  1. `packages/mcp-core/server.mjs` — 零依赖 stdio MCP 服务器（手写 JSON-RPC：`initialize` / `tools/list` / `tools/call`，按 `\n` 分帧，日志只走 stderr），工具在 `tools/index.mjs` 注册、实现在 `tools/ask-user.mjs`（每个工具导出 `name` / `title` / `description` / `inputSchema` / `call(args, context)`，`context` 提供 `post(path, payload, signal)`、`signal`、`log`）。注册名仍是 `desktop`（核心交互 MCP），新桌面工具加在这个包里，不要另起服务器。
  2. `apps/desktop/resources/extension/desktop-mcp.js` — pi 扩展，读 `AGENT_DESKTOP_MCP_URL/TOKEN/CORE_SCRIPT/ENGINES/TOGGLES` 后 `pi.registerMcpServer(...)`。核心服务器**必须 `exposure: 'direct'`**（默认 `codemode` 不会把工具声明给模型）。**`timeout` 必须传 `Number.POSITIVE_INFINITY`**：pi 把 `config.timeout`（秒）乘 1000 传给 MCP client，`armTimeout` 在 `!Number.isFinite(timeoutMs)` 时不 arm 定时器，所以只有非有限值才真正不超时；填大数字会踩 `setTimeout` 的 2^31-1 ms 上限而立刻超时（默认值是 60 秒）。
  3. `apps/desktop/src/main/bridge.ts` — 只监听 `127.0.0.1` 的 HTTP 桥，`POST /ask`（`x-agent-desktop-token` 校验）→ 渲染层弹窗 → 回答后返回 JSON。**不要加等待超时**（`server.requestTimeout`/`server.timeout` 都设 0）；取消只来自 `cancelAllAsks`：pi 重启、关窗、退出、以及 `pi:abort`（同时给渲染层发 `ask:cleared` 关掉面板）。同一个桥还有 `POST /tools`：扩展把各内置服务器实际注册的工具回报给主进程，写进 `%APPDATA%\agent-desktop\mcp-tools.json`，设置页的工具开关就靠这份清单。
  4. 渲染层 `AskQuestionPanel.tsx` — **内联面板，固定在输入框上方**（不要做全屏弹窗），高度控制在 ~130-160px：标题行、问题行（tag 内联）、**选项一行一个（不要并排）**、底栏同一行放输入框和按钮。单选 / 多选 / 手动输入；手动输入框常驻，直接打字即可，不用先选“其他”；单选时选项与手动输入互斥，多选时两者可叠加。顶部步骤条（仅多问题时显示）可点击跳回任意问题重新回答，`上一步` / `下一步` / `跳过` / `提交` 支持前后修改。`App.tsx` 用队列保存请求（`askQueue`），一次只显示一个，回答后从队列移除。
- 工具命名是 pi 生成的 `mcp__desktop__ask_user_question`。验证链路最快的方式：向桥 `POST /ask`（端口和令牌在 `%APPDATA%\agent-desktop\config.json` 的 `mcp.bridgePort/bridgeToken`），不需要真实模型调用。
- 注册方式选扩展 + `--extension`，**不要**写 `~/.pi/agent/mcp.json`：这样桌面端的工具不会污染终端里的 pi，桥接端口/令牌也不用每次启动改写用户配置。`mcpArgs()` 在总开关关闭时传 `--no-mcp`，桌面工具关闭时不传 `--extension`。
- **MCP 不能提供系统提示词**：协议只有 `initialize.instructions`（+ `prompts` 原语），pi 的 MCP 客户端只读 `instructions`，且只用于 codemode 命名空间的 `describeNamespace()` 和 `mcp_servers` 段——而 `mcp_servers` 段由 `renderServersSection()` 里的 `hasIndirectTools` 过滤，**`direct` 暴露的服务器不会出现在里面**（每服务器也只取第一行、≤250 字符、整段 ≤4096）。`prompts/list`、`prompts/get`、`sampling`、`elicitation` pi 都没实现（client 只声明 `roots`）。所以 `server.mjs` 里的 `instructions` 在 direct 下对模型不可见，只对 codemode 有意义。
- 因此模型的使用引导由扩展注入：`desktop-mcp.js` 挂 `before_agent_start`，往 `event.systemPromptOptions.sections.desktop_tools` 写一段文案。**必须用 `pi.getActiveTools().includes('mcp__desktop__ask_user_question')` 门控**：只有 MCP 打开、桌面工具打开、服务器真正连上、工具被声明给模型时才注入；否则 `delete sections.desktop_tools`。段名要匹配 `^[a-z][a-z0-9_-]*$` 且不能叫 `preamble`；段内容由 pi 包成 `<desktop_tools>…</desktop_tools>`，不要再手写标签。每轮都会重算，`diffSystemPromptSections` 会把不存在的段 patch 成 null，所以关掉 MCP 后旧段会自动消失，不需要清理会话文件。
- 扩展还无条件往 `event.systemPromptOptions.promptGuidelines` 里推几条规则（`EXTRA_GUIDELINES`）：
  - 批量：需要多个互不依赖的调用时**在同一条 assistant 消息里一起发**，不要在调用之间重复推理。
  - 搜索：用 `grep` / `find` 工具而不是 `bash grep -rn` / `bash find`，并且不要手动搜 `node_modules`、`.git`、`dist`、`out` 或已安装应用的 resources。**这是最常见的失败来源**：pi 的 bash 工具没有默认超时，模型自己传 `timeout: 60`，而 `grep -rn` 会走 `node_modules`（实测同一查询：`rg` 78ms，`grep -rn` 14.3s，冷缓存/Defender 下直接超 60s）。
  - **用 guidelines 而不是自定义 section**：guidelines 会进系统提示的 `<rules>` 列表，和 pi 自己的规则并排，模型遵守率明显更高（自定义段要模型自己决定去读）。pi 每轮一次模型请求，一次只发一个调用就是多一次往返——实测旧会话 131 轮里平均只有 1.2 个调用/轮，这就是「一工具一思考」的来源。
- 路径解析：打包版从 `process.resourcesPath/extension|mcp` 取（`electron-builder.yml` 的 `extraResources` 负责拷贝 `resources/extension` 与 `packages/mcp-core` 的 `server.mjs` + `tools/**`），开发版用 `searchUp` 从 `app.getAppPath()` 向上找 `resources/extension/desktop-mcp.js` 和 `packages/mcp-core/server.mjs`。改了资源位置要同时改这两处。
- 设置 → MCP（`McpPanel.tsx`）管理 `~/.pi/agent/mcp.json`：总开关（`config.json.mcp.enabled`）、桌面工具开关（`mcp.desktopTool`）、服务器启用/删除/新增（新增接受一段 JSON，需含 `command` 或 `url`）。任何变更都会 `reloadPiConfig()` 重启 pi。
- 项目级 `.pi/mcp.json` 只读展示并合并到列表（同名覆盖用户级），仅在信任项目时由 pi 生效。

### 内置引擎（CodeGraph / WarpGrep）

- 两个引擎定位不同：CodeGraph 是**本地 CLI**（npm 全局包 `@colbymchenry/codegraph`，入口解析到 `npm-shim.js`，用 node 跑，避免 Windows `.cmd` 需要 shell），WarpGrep 是 **Morph 托管 API**（只需要 API Key，没有二进制）。检测在 `apps/desktop/src/main/engines.ts`：CodeGraph 走「显式入口 → 已知安装路径 / PATH → `--version` 校验」，WarpGrep 的可用性就是有没有 key；检测结果缓存 60s，`invalidateDetection()` 在改入口时清掉。**显式入口不可用时不要回退到自动检测**。
- 默认关闭（`config.json.mcp.engines.<id>.enabled`），设置页逐个开启；CodeGraph 未安装时卡片显示安装命令和「选择入口」，WarpGrep 卡片是 API Key 输入框（`config.json.mcp.morphApiKey`，UI 只显示掩码）。
- **架构是网关，不是直连**：`apps/desktop/src/main/gateway.ts` 在主进程里持有引擎（CodeGraph 是 stdio 子进程，WarpGrep / web 直接在主进程里跑），对外由桥（`bridge.ts`）暴露 **一个服务、多个端点**：`POST /mcp/codegraph`、`POST /mcp/warpgrep`、`POST /mcp/web`。pi 用 `registerMcpServer(name, { url, headers: { authorization: 'Bearer <token>' } })` 连这些端点，模型看到的是网关的工具集，不是引擎的全量工具。
- 端点只实现 streamable HTTP 的最小合法形态：POST 返回 `application/json`，GET 返回 405（pi 的客户端把 405 当作"没有 server→client 流"），DELETE 返回 204。**不要**加 SSE，pi 的 `McpStreamableHttpTransport` 接受 JSON 响应。
- 工具数量由 `ALLOWED_TOOLS` 控制（`engines.ts`）：CodeGraph 8 个、WarpGrep 1 个（`codebase_search`）、web 2 个（`web_search` / `web_fetch`，都是 direct，所以不激活 `tool_search`）。新增/裁剪工具改这里。
- **CodeGraph 默认不返回源码**（对齐 codegraph-desktop）：网关把 `codegraph_explore` 的 schema 加上 `includeSource`（默认 false），调用时若没显式要求源码，就改写成 `codegraph_search` + `limit:10` 转发；`codegraph_node` 强制 `includeCode:false`。模型只拿到符号名、签名和 `file:line`，需要源码时自己 read。不要在网关里放开源码默认值——那会让一次 explore 返回上万字符。
- 暴露策略：服务器级 `exposure: 'deferred'`，`toolExposure` 把核心工具标 `direct`（CodeGraph: `explore/search/callers/impact`；WarpGrep: `codebase_search`），其余走 `tool_search`。pi 会因此激活 `tool_search` 工具，并在系统提示词里生成 `mcp_servers` 段。
- 网关只把**真实失败**（spawn 失败、进程退出、initialize 失败、Morph API 错误）当作错误上报；引擎自己往 stderr 打的 INFO 日志不算错误。
- WarpGrep 的搜索循环在 `apps/desktop/src/main/warpgrep.ts`：模型（`morph-warp-grep-v2.1`）规划 `list_directory` / `grep_search` / `glob` / `read` / `finish`，本模块在会话目录内执行（路径越界直接拒绝），最多 6 轮。**读取的文件片段会发给 Morph API**，UI 里要保留这句提示。没有 key 时调用返回 `MORPH_NO_KEY`。
- 用户关掉的工具写成 `toolExposure[tool] = 'hidden'`（`config.json.mcp.toolToggles`），工具仍在 `getAllTools()` 里但 `exposure: 'hidden'`，所以设置页能继续显示并重新打开。
- CodeGraph 索引：只在**没有** `.codegraph` 时自动 `codegraph init`；**不要自动 `sync`**——运行中的 MCP 服务器持有 CodeGraph 写锁，自动 sync 会报 "database is locked"。重新索引是设置页的手动动作（`codegraph unlock` 提示也在这里给出）。
- **不要设置 `CODEGRAPH_NO_DAEMON=1`**：那会让服务器独占写锁，用户同时用 IDE/终端的 CodeGraph 时，后启动的一方要么拒绝启动，要么只暴露 3 个工具（`search/node/explore`）。让它代理到共享 daemon 才能共存。`CODEGRAPH_MCP_TOOLS` 必须设，否则默认只暴露 `codegraph_explore`。
- 引擎会往项目里写 `.codegraph/`（已加进 `.gitignore`）。

### 网络搜索（web engine）

- `web` 是网关里的**第三个引擎**（`/mcp/web`，`kind: 'web'`），提供 `web_search` + `web_fetch`，两个都是 `direct`。实现在 `apps/desktop/src/main/web.ts`，网关侧只是 `WebGateway` 转发（`gateway.ts`）。不需要二进制、不需要额外进程。
- **pi 自己没有 provider 原生 web 工具**：`RequestOptions` 只支持客户端 function tool，`convertTools` 永远生成 `{name, description, input_schema}`，没有任何 server tool 通道。想用原生搜索只能在主进程自己发 HTTP，所以 `web.ts` 直接调各家 API，凭据走 `ModelRuntime.getAuth(providerId)`（OAuth 由 pi 自己刷新，桌面端不读 auth.json）。
- `web_search` 的后端解析顺序（`describeRoute`）：`mode: 'native'` → 只允许服务商原生；`'brave'` → 只用 Brave；`'auto'`（默认）→ 当前模型的服务商在 `mcp.web.native[provider] === true` 且实现存在时用原生，否则 Brave。原生失败**回退 Brave** 并在结果顶部加一行说明；只有「既没 Brave Key 又原生失败」才报错。
- 原生实现：`anthropic`（`/v1/messages` + `web_search_20250305`，OAuth 用 `authorization: Bearer` + `anthropic-beta: oauth-2025-04-20`）、`openai`（`/responses` + `web_search_preview`，取 `annotations[].url`）、`google`（`generateContent` + `google_search` grounding，取 `groundingChunks[].web`）、`deepseek`（**专用 Search API**：`POST {base}/v1/tools/search` + `Authorization: Bearer`，body `{query, count, need_content}`，返回结构化 `results[].{title,url,summary,content}`，实测 355ms）。想加新服务商改 `NATIVE_PROVIDERS` + `nativeSearch()`。
- **DeepSeek 不要走 Anthropic 兼容接口做搜索**：`/anthropic/v1/messages` 确实接受 `web_search_20250305` 并返回 `web_search_tool_result`（实测 10 条/次），但一次搜索等于一整个模型回合，而且「模型觉得不用搜」时根本不出结果块（问日期就直接凭记忆答）。专用 Search API 更便宜、更快、结果结构化。`models.json` 可能把 deepseek 指到 `…/anthropic` 代理，所以拼路径前先 `replace(/\/anthropic$/, '')`。
- `web_fetch` **永远本地抓取**（DeepSeek 也有 Fetch API，但本地抓不花 Key、不把 URL 交给第三方）：`fetch` → charset 嗅探（含 `<meta charset>`/GBK）→ HTML 转 Markdown（去 script/style/nav，保留标题/列表/链接/代码块），`maxChars` 截断。拒绝 localhost / 内网 / 169.254 / ULA 地址（SSRF），需要本地内容时让模型用 `read`/`bash`。
- 配置在 `config.json` 的 `mcp.web`：`mode` / `braveApiKey` / `native`（provider → true）/ `count` / `maxChars`。`mcp.web.native` 就是**服务商列表里那个「联网」开关**（`SettingsModal` 的 provider 行，只对 `McpWebState.nativeSupported` 里的服务商显示）。路由（Brave / 原生）是**按调用实时解析**的，所以改开关本身不重启 pi；只有「有没有任何后端」发生变化时才 `reloadPiConfig()`——那决定了 `/mcp/web` 端点是否注册。改 Brave Key 或 web 引擎开关一律重启。
- 可用性：没有任何后端（无 Brave Key、无原生服务商）时 `buildEngineTargets` 不产出 web target，端点不注册，开关按钮为灰。
- 扩展里的 `web_tools` 段：`before_agent_start` 里用 `pi.getActiveTools()` 门控（同 `desktop_tools`），文案强调「搜索结果不是来源，要 `web_fetch` 打开页面并给 URL」，关掉 MCP 后该段自动消失。
- **不要**把 WarpGrep 当网页搜索：Morph 只有项目内代码检索（`warp_grep`），没有通用 web search API。

### 子代理（subagents）

- **子代理后端**：`SubagentManager` 按记录的 `engine` 选择执行器。pi 用独立 RPC 进程；Prophey 用独立执行循环、工具上下文和 `subagents-prophey/` transcript。Prophey 子代理不提供嵌套子代理或用户提问工具；目前不支持桌面 MCP 和运行中的 steer/follow-up，调用时明确报错；thinking 根据选定模型的 SDK 能力校验并传入。
- 主会话通过 8 个桌面工具驱动：`search_agents` / `list_models` / `start_subagent` / `get_subagent` / `wait_subagent` / `send_subagent_prompt` / `stop_subagent` / `get_subagent_changes`，实现在 `packages/mcp-core/tools/subagent.mjs`，只做参数校验 + 转发。
- **工具返回默认是 Markdown**，JSON 只在显式传 `format: "json"` / `include` / `detail` 时返回；`ask_user_question` 也不再附带 JSON 副本。模型不需要解析结构，重复的键名纯属浪费 token。
- `get_subagent` / `wait_subagent` **默认只返回最终结论 + 改动摘要**，运行中只给状态行；要看过程必须显式传 `include: ["messages"]`（带 `since` 游标）或 `["last"]`。
- 预设：内置 `explorer` / `reviewer` / `tester` / `worker`（`apps/desktop/src/main/agents.ts`），用户可在 `%APPDATA%/agent-desktop/agents.json` 覆盖或新增；优先级 = 内置 ← 用户文件 ← `start_subagent` 显式参数。预设字段全部落到 pi 启动参数（`--tools`、`--provider/--model`、`--append-system-prompt`）。
- 子代理的界面在 **设置 → 代理**（`AgentsPanel.tsx`），不在 MCP 页：预设列表 + 编辑器（id/名称/说明/启动方式/工具白名单/模型/追加系统提示词），保存走 `agents.savePreset` 写 `agents.json` 后重启 pi；删除走 `agents.deletePreset`（内置预设会恢复默认）。`Toggle` 已抽到 `components/Toggle.tsx`，MCP 与代理两页共用。
- **预设没有"加载"概念**：`search_agents` 返回 id 后可直接 `start_subagent({ agent })`，不需要像 `tool_search` 那样把 schema 声明进工具列表。`agents.exposure` 只控制要不要提前把列表写进系统提示词（`prompt` / `lazy` / `hidden`，超过 `promptLimit` 自动只列 `visible` 的）。
- `<agents>` 段由主进程渲染后经 `AGENT_DESKTOP_AGENTS_SECTION` 传给扩展，扩展在 `before_agent_start` 里注入 `sections.subagents`，**门控**：`pi.getActiveTools()` 里有 `mcp__desktop__start_subagent` 才注入，否则删除。
- 这段除了预设清单，还有 `SUBAGENT_USAGE`（`agents.ts`）——**何时该用子代理**：自包含且会污染上下文的工作（大范围探索、长验证循环、diff 审查）、可并行的独立切片；不该用的（几次工具调用、依赖本会话上下文、需要用户决策、不可逆操作）。外加"子代理是瞎的，任务里必须写清目标/路径/约束/完成标准，不要写‘如前所述’"。`prompt` 与 `lazy` 两种暴露都带这段，只有 `hidden` 不带。实测：让模型把系统提示里这段原样贴出来，能完整复现。
- 桥内部 API（JSON，给 mcp-core 用）：`GET /agents`、`GET /models`、`POST /subagents`、`GET /subagents/:id`、`POST /subagents/:id/{prompt,stop,wait}`、`GET /subagents/:id/changes`。令牌沿用桥的 Bearer。
- **子代理完成通知**：按 parentSession 归属暂存，只在对应会话激活时投递。Prophey 直接接收带 `subagent_notice` 元数据的通知，支持唤醒新回合；pi 继续经桥事件与扩展接收。手动停止子代理不唤醒父代理。
- 子代理的模型：`start_subagent` 的 `provider`/`model` 先经 `providers.resolveModelChoice()` 校验（`getModels()` 全量目录，**不受 `enabledModels` 白名单影响**，包含 models.json 自定义项）。pi 对未知模型 id 不会报错，只会跑出空结论，所以必须在启动前拦：`UNKNOWN_PROVIDER` / `UNKNOWN_MODEL`（附可用 id）/ `PROVIDER_NOT_CONFIGURED` / `AMBIGUOUS_MODEL`（只给 model 且多服务商都有）。只给 `model` 且唯一时可自动定位 provider。`thinking` 走 `--model <id>:<level>`，实测 `deepseek-v4-pro:high` 生效。
- 记录里的 `model` 以子进程 `get_state` 返回的**实际模型**为准（`waitReady` 时抓取），所以"继承主会话"也能显示真实值，不是猜的。
- `start_subagent` 的 `notify`：`wake`（background 默认，`triggerTurn: true`：空闲时立刻开一个回合，正在流式则作为 steer 插到当前回合之后）、`queue`（只追加一条 custom 消息，**不会**让父代理动起来，等下个回合才被读到）、`none`（sync 默认，只有 `get_subagent` / `wait_subagent` 能看到）。实测过：`queue` 只产生 `custom:subagent_notice`、`assistants` 不变；`wake` 会多一个 assistant 回合。
- 用户刚点过「停止」（`pi:abort` 30 秒内）时，`onSettle` 会把 `wake` 降级成 `queue`，否则用户刚停下的会话会被子代理通知重新拉起来。
- 通知正文用 `<system-reminder source="agent-desktop">` 包起来：pi 把 custom 消息和用户消息**都**转成 `role: "user"` 发给模型（`core/messages.js` 的 `convertToLlm`），不标记的话模型会以为这是用户说的话。pi 自己不解析任何标签，这层纯粹是给模型的约定。
- 渲染层只认 `customType === 'subagent_notice'`：`toChatItems` 和 `App.tsx` 的 `message_end` 都把它变成 `role: 'system'` 的条目，`Conversation.tsx` 画成虚线条（`.system-notice`），**不要**让它变成用户气泡。`noticeText()` 负责剥掉 `<system-reminder>` 外壳。
- 父会话重启（换模型）时扩展重新加载、长轮询重连，队列里没投递的事件会补发；所以事件队列在**主进程**里，不要在扩展里缓存。
- 控制语义映射到 pi：`interrupt` = `abort` + `prompt`，`steer` = `prompt(..., streamingBehavior: 'steer')`，`follow-up` = `'followUp'`。
- 限制：并发 4（超出报 `SUBAGENT_LIMIT`，不排队）、单次总运行 15 分钟、空闲 30 分钟回收、sync 最长等 300s 后转后台、应用退出 `stopAll(true)`。**主会话重启（换模型等）不杀子代理**，它们本来就是独立进程。
- **子代理界面**：顶栏 `.subagent-btn`（运行中显示数字并高亮，否则显示已完成数）打开右侧抽屉 `SubagentsDrawer.tsx`：列表 ↔ 详情两态（详情有返回按钮），详情含结论 Markdown、改动文件、进度时间线、引导/追加/打断 + 停止。数据来自 IPC `subagents:list|get|stop|prompt|reveal` 与事件 `subagents:update`（`serializeSubagent`）。每行带 `.subagent-avatar` 图标徽标（按状态着色），抽屉支持 `initialId` 直接选中某次运行。
- 抽屉是布局的一部分，不是覆盖层：`App.tsx` 的 `.main-body` 是横向 flex（`.chat-column` + `.subagent-drawer`），打开时会话区与输入框一起变窄（实测 chat 1108→708、composer 860→644），不会盖住正文。新增右侧面板时照这个结构放，别用 absolute 遮罩。
- **运行状态条在输入框上方**（`RunStatusBar.tsx`，通过 `Composer` 的 `statusBar` 插槽放进 `.composer-wrap`）：父会话在跑时显示耗时 / tokens / 工具数，空闲时显示「子代理运行中 N」；每个运行中的子代理是一枚 `.run-task` chip（图标 + 名称 + 耗时），点击打开面板并选中该运行。
- **对话里的子代理卡片**：`start_subagent` 的工具调用不再混进「调用 N 个工具」，而是渲染成 `.subagent-card`（图标、label、预设、状态、id、耗时），展开可看实时输出 / 最终结论，并有「查看详细进程」跳到面板。匹配记录靠工具结果里的 `sa_xxxxxxxx`，结果还没回来时按 `label` 匹配。
- 子代理的**实时进度**：`SubagentManager.onEvent` 把 `message_update` 的 `text_delta`/`thinking_delta` 累加进 `record.draft`，`tool_execution_start/end` 维护 `record.activeCalls` 并写入带 `durationMs` 的 `record.calls`，`message_end` 把 assistant 文本追加进 `record.messages` 并清空 draft——所以运行中（还没 settle）就能在卡片和面板看到「正在执行哪个工具 / 正在思考 / 正在生成什么」。delta 走 `emitProgress()` 合并到约 8 次/秒（`PROGRESS_EMIT_MS`），其它事件会 `clearProgress()` 后再 `emit`，避免每个 token 都发一次 IPC 和 `broadcastStatus`。settle 时 `collect()` 用 `get_messages` 整体重写 messages 并清掉 draft/activeCalls，不会重复。抽屉里运行中不再显示「还在运行，暂无结论」，而是 `.subagent-timeline`：调用与消息按时间排序、未结束的调用显示「运行中」、末尾是带脉冲点的 live 块（思考 + 流式文本），只有用户上滚时才停止自动跟随。
- **记录落盘**：`SubagentManager` 把记录写到 `%APPDATA%/agent-desktop/subagents.json`（上限 120 条、800ms 防抖）。启动时 `restore()` 读回，`starting/streaming` 的标记成 `stopped` 并带 `restored: true`。历史记录**没有进程**（`Internal.rpc` 可选），`prompt` 报 `SUBAGENT_GONE`、`stop/wait` 直接返回；`runningCount()` 排除历史记录，否则并发上限会被旧数据占满。记录里保存 `sessionFile`（子代理自己的会话，可用 `pi --session` 复现）和 `parentSession`（发起它的主会话），面板上「定位」用 `shell.showItemInFolder`。
- 模型侧查询：`list_subagents`（`GET /subagents?q=&status=&agent=&limit=`，匹配 id / label / 预设 / cwd / 结论）→ 返回紧凑 Markdown 列表；`get_subagent` 对历史记录同样有效，并在输出里标「历史」。**历史记录只能读，不能继续对话**。
- **退出必须杀进程树**：`apps/desktop/src/main/proc.ts` 的 `killTree(child, sync)` 在 Windows 上走 `taskkill /pid <pid> /T /F`（`child.kill()` 只杀直接子进程，会留下 pi 拉起的 `mcp-core/server.mjs` 和 CodeGraph worker）。`window-all-closed` / `before-quit` 用 `rpc.killNow()` + `gateway.stopAll(true)` + `subagents.stopAll(true)`，因为退出时 `stop()` 里那个 1.5s 的兜底定时器根本来不及跑。MCP 设置变更仍走 `reloadPiConfig()` → `startPi()` → `mcpLaunch()`（重建引擎目标、`gateway.configure()` 差分启停），所以"改设置后 MCP 跟着重启"本来就是这条路，别另起一套。
- 工具调用记录取自 `tool_execution_start` 的参数（`path` / `command` / `pattern`），不要用工具输出首行猜路径——`read` 的输出首行是内容，会把路径解析成 `{`。
- 服务器连接是异步的，扩展在加载后 2.5s / 8s 各补报一次工具清单（`POST /tools`），否则设置页只会看到连接完成前的那部分工具。

## 0.5.4 复用边界与回归

- 同文件写入使用 `storage.ts`；读改写必须使用 `updateJsonFile`，不能先读再只锁写。Transcript 的读/删与写共用队列。队列仅覆盖本进程。
- JSONL 分帧复用 `json-lines.ts`，协议处理留在适配器；每条记录和 stderr/exit/error 均检查子进程身份。
- 主进程命令在 `engine-commands.ts`，压缩数值策略在 `compaction-policy.ts`。百分比在逻辑层保留小数，避免 1000/1M 被取整为 0%。
- 渲染层纯数据转换放在 `lib/conversation-events.ts` / `lib/session-groups.ts`，IPC、副作用和运行计时仍由 App 管理。
- `npm run test:smoke` 在 build 后运行，使用临时数据和真实 Electron，不能接入用户现有 profile；测试成功必须出现明确完成标记。

## 引擎固定，模型可切换

- 会话开始后不能更换引擎。desktop:set-engine 仅为空会话选择引擎；已经删除 AgentEngine.importHistory、四种引擎的导入实现与新历史编码器，不再通过新会话搬运旧历史来换引擎。
- 旧版本已导入的 CC/Codex 会话保留兼容读取及分支；agent/history.ts 仅用于这些旧数据，不得用于当前会话的模型切换。pendingEngineSwitch 仍是会话导航/空会话初始化失败时的恢复记录，并兼容旧配置。
- config.defaultEngine 只影响新会话。已有会话导航按其保存的 engine 打开，不改变所属引擎。
- 内建引擎允许回合之间切换已配置、已启用的服务商模型，原会话 id、transcript 和工具历史保持不变；运行中拒绝切换。思考等级重算为新模型支持的等级，窗口阈值按新模型检查。
- OpenAI Responses / Chat Completions / Anthropic Messages 使用同一份 pi ModelRuntime.streamSimple 及其协议适配器。每条 assistant 保留原 api/provider/model，向适配器传递 transcript 深拷贝，禁止改写原始思考签名或工具 ID。
- 当前 pi-ai SDK 在跨模型请求中丢弃其他模型的 thinking/加密签名，清除文本/工具思考签名，并按目标协议配对规范化 toolCallId；切回原模型可继续使用原始保存的合法签名。不要自行降级所有思考为正文。
- tests/model-switch.test.cjs 通过真实 pi SDK 和本地 HTTP 模拟端点验证三种协议来回切换、图片、工具结果配对、私有思考过滤和恢复；未用真实付费账号做远程服务验收。
- build 后 npm run test:handoff 验证会话锁定、新会话选择和旧状态恢复。

- Prophey 的 workspace 工具目录和 shell 通过每次调用的 context 传递，禁止再写全局 AGENT_DESKTOP_ROOTS；多个子代理必须能同时操作各自的根。CLI MCP 仍支持环境变量入口。

## Prophey 后台命令

- 0.6.2：概览的后台任务同时列出本会话的命令与子代理。命令点击读取最近 12KB 日志并每 2 秒刷新；子代理点击打开已有详情抽屉。「已完成」可展开当前引擎保留的命令及本会话子代理记录。命令日志详情/停止 IPC 必须校验调用方 sessionKey；不接受任意日志路径。命令元数据随引擎回收，日志文件保留。
- 会话切换时，即使主回合已结束，只要后台命令或子代理仍在运行也必须 park 引擎，不能 dispose。

## 0.6.2 会话隔离回归

- 侧栏选中、输入框与消息队列统一从 `status.sessionKey ?? sessionFile` 派生；Windows key 归一大小写与斜杠。草稿 setter 捕获所属 key，Composer 按 key 重建，防止旧图片异步解码写入新会话。
- `pi:event`、历史消息与统计响应都带会话身份；只有匹配当前会话的数据才绘制。发送传所属 key，主进程按 key 找原引擎；原引擎被回收时按 SessionRecord 的目录、模型、引擎在后台恢复。切换界面不拒绝有效发送，不把消息转给屏幕上的会话。队列每会话最多一个在途发送，失败只恢复原队列，不能再复制到草稿。
- 提问按会话过滤，切走保留、返回继续回答；回答/取消/断开时按请求 id 移除。停止或重启只取消该会话的提问。子代理列表、运行 chip、详情入口按 parentSession 过滤；界面操作按不可混淆的任务 id 定位，命令日志按 sessionKey + task id 路由回原引擎。
- 验证：`tests/session-isolation-smoke.cjs` 通过真实 Electron 验证跨会话草稿、延迟图片、队列、提问、事件和子代理；`tests/services.test.cjs` 验证两客户端提问/通知分流、网关共存及异步子代理启动归属。

- 只有 Prophey 的 `run_bash` 接入 `agent/bash-tasks.ts`；pi、Claude Code、Codex 保持各自原生命令执行。Prophey 子代理复用这套自身能力，不启动 pi。
- `run_in_background` 立即返回；普通命令默认等 1 秒（`yield_time_ms` 最多 10 秒），未结束则转后台。stdout/stderr 直接写 `userData/command-logs` 文件，不累积在内存或完整塞进 transcript。首次仅返回末尾 4000 bytes。
- `read_bash_task` 用字节游标增量读取，默认 4000、最多 12000 bytes，可 `tail` / `status_only` / `wait_ms`（最多 60 秒）；`stop_bash_task` 停止进程树。完成只投递任务 id/状态/日志路径；最近 30 秒点过停止则不自动唤醒。
- 后台命令属于创建它的引擎实例，停止/替换引擎或退出应用时终止，日志保留。普通回合结束不终止后台命令；切到 `/btw` 分支时不向错误会话投递通知。Windows 退出使用同步 killTree，不能只杀 Bash 外层。
- 子代理结果默认限量；`get_subagent` 的 `include:["messages"]` 按 `since`（消息索引）和 `offset`（字符游标）分页读取，JSON 也不返回完整历史。

## 会话锁定、模型与运行状态

- 第一条真实消息开始后锁定目录和 agent，`PiStatus.sessionLocked` 由主进程判断；恢复历史仍锁定，空会话文件不锁定。界面 agent 选择器放在模型旁；需要其他目录或 agent 时从侧栏新建会话。`desktop:set-engine` 在主进程拒绝已开始会话，不再搬运历史切换 agent。
- 已保存会话使用 SessionRecord 的 cwd/additional 快照，编辑项目目录只影响新会话。`pi:restart` 也不得借机修改已开始会话的目录。
- Prophey/pi 模型选择器与 `/model` 只允许已配置且 enabledModels 启用的服务商模型。CC/Codex 只接受原生目录返回的模型，不接受任意字符串。
- Prophey 思考等级复用 pi-ai 的 getSupportedThinkingLevels，尊重 reasoning/thinkingLevelMap，发送到 streamSimple 的 reasoning；off 不发送 reasoning。会话头保存模型/思考等级并在恢复后校验。
- Prophey 不再在 16 轮工具后静默结束。每轮检查自动压缩；流提前关闭、空回复和 180 秒无新数据均明确报错/重试，可随时中止。
- **Prophey 支持运行中引导（steer）**：`prompt(message, { behavior: 'steer' })` 在 `busy()` 时不再报「上一轮还没结束」，而是 `steer()`：把这条 user 消息**直接推进 transcript** 并发 `message_start`/`message_end`（渲染层靠 `patchPendingUser` 把乐观气泡转正），并置 `steerPending`。主循环每轮开头清 `steerPending`，这一轮跑完若发现它又被置上，就 `continue` 再跑一轮（模型因此看得到这条插话）；万一它在循环退出后才到，`finally` 里用 `scheduleNoticeTurn()` 补一轮。`streamRound` 每轮都 `structuredClone(transcript)`，所以流式中途 append 不会弄脏在飞的请求。非 `steer` 的 `prompt` 在忙时仍然拒绝（不静默丢）。
- 状态栏依据 status.isStreaming/compacting 而非仅依赖事件计数；activity 给出准备/等待模型/执行工具/重试状态，backgroundTasks 单独报告仍在运行的 Bash，前台结束时不得隐藏后台任务。
- 输入框只保留简短占位提示，底部不再显示重复的快捷键说明栏；Enter 引导 / Ctrl+Enter 排队行为不变。`tests/queue-smoke.cjs` 验证无重复栏并测量节省空间。
- **OpenAI 长窗口元数据修正**：`resources/extension/model-context.ts` 是主进程 SDK 与桌面 pi（含子代理）共用的修正入口，独立于 MCP 开关。仅把 `openai` 下 GPT-6 Astra/Luna/Sol、GPT-6.1 Sol 的旧 `272000` 内置窗口修正为官方 API 的 `1050000`；272K 计费分界和 128K 输出上限不变。修正在用户配置下层，显式 `models` / `modelOverrides` 仍优先；pi 在 `session_start` 确认没有用户扩展接管 OpenAI 后才注册，避免覆盖用户扩展的代理地址、认证或模型。不写用户配置、不修改 node_modules、不覆盖未来 SDK 的不同窗口值。不要据此推断 `openai-codex` 或原生 Codex 的账号窗口权限。`tests/model-context.test.cjs` 覆盖真实 SDK、Prophey 压缩与 pi RPC 的一致性（不发付费模型请求）。
