# GeekAgent 路线图（Day 1 – Day 28）

> 项目定位：纯实验性质，用**最简单**的方式实现一个 Agent，对标 PI / OpenCode。
> 四条原则：① 每天实现一个功能，都是最简单的实现；② 每天的功能在前一天基础上**新增**，不侵入式修改（两处例外见 Day 2 / Day 4 说明）；③ 每天交付可运行的成果；④ 每天代码量控制在 100–300 行（500 行封顶），宁缺毋滥。

## 目录与运行约定

- 每天一个目录：`day1/`、`day2/`、……，每个 `dayN/` 直接平铺源码文件（`index.ts`/`chat.ts`/`tools.ts`……）；新增 Day N 时，先拷贝 Day N-1 的源文件作为 `dayN/` 起点，随后**只在拷贝基础上做增量**——能新增就不改动上一天已交付的代码，非改不可时在当天文档里说明原因
- 依赖与配置收敛在仓库根：根 `package.json` 的 `dev` 就是裸 `tsx`，用 `npm run dev -- dayN/index.ts` 运行对应天（路径随意给，新增一天**无需加任何 script**）；根 `tsconfig.json` 统一类型检查（`npm run typecheck` 扫全部 `day*/`）；根 `.env` / `.env.example` 全仓共用
- 技术基线：TypeScript + Node + `tsx`，OpenAI 兼容接口，零框架（何时引入 TUI 由下面日程决定，不提前引入）

## 每日计划

### 阶段 A：地基（Day 1–4）——能聊，且开始动手

| Day | 功能 | 最简单实现说明 |
|---|---|---|
| 1 | [REPL + 流式多轮对话](https://geektutu.com/post/geekagent-day1.html) | `readline` 逐行读，`Chat` 类持有 history，OpenAI 兼容接口流式输出 |
| 2 | [工具调用循环](https://geektutu.com/post/geekagent-day2.html) | 模型返回 `tool_call` → 执行 → 结果回传 → 继续；第一个工具：当前时间。（例外：允许对 `Chat` 类做结构性调整以支撑 tool_calls delta） |
| 3 | [Shell 执行工具](https://geektutu.com/post/geekagent-day3.html) | `child_process` 执行命令，超时 + 输出截断 + 执行前确认（确认逻辑独立成函数，供后续权限模型替换） |
| 4 | [文件读写工具 + 工具收口](https://geektutu.com/post/geekagent-day4.html) | `ls`/`read`/`glob` 只读免确认；`write`/`patch` 写入前展示 diff + 确认；顺手为攒下的 7 个工具立统一 `Tool` 接口 + 注册表 —— Agent 首次闭环「读 → 改 → 验证」 |

### 阶段 B：上下文与展示（Day 5–7）——聊得长、分得开、用量看得见

| Day | 功能 | 最简单实现说明 |
|---|---|---|
| 5 | [历史压缩](https://geektutu.com/post/geekagent-day5.html) | history 超长时用模型摘要旧文，腾出上下文 |
| 6 | [多会话 + 会话持久化](https://geektutu.com/post/geekagent-day6.html) | `/new` `/sessions` `/open` 内存多会话；`/save` `/load` 全部会话与当前 ID 落 `.geekagent/sessions.json`，退出自动保存 |
| 7 | [轻量 TUI + 用量显示](https://geektutu.com/post/geekagent-day7.html) | 右侧常驻面板实时显示本轮/累计 tokens 与上下文占用比例；流式回复与工具进度行全部进主区并着色。Alt 屏 + 双栏整帧重绘 |

### 阶段 C：安全与权限（Day 8）——敢动手也兜得住

| Day | 功能 | 最简单实现说明 |
|---|---|---|
| 8 | [权限模型 + 目录隔离 + 敏感信息保护 + 撤销](https://geektutu.com/post/geekagent-day8.html) | 工具级策略（ask/allow/deny）与允许访问的根目录由 `.geekagent/GeekAgent.json` 配置；文件工具只允许在根目录内读写，工具结果自动屏蔽 KEY 类环境变量；写文件前备份最近状态，`/undo` 恢复 |

### 阶段 D：能力进阶（Day 9–12）——更像一个真正的 Agent

| Day | 功能 | 最简单实现说明 |
|---|---|---|
| 9 | [任务规划器 + 子 Agent 拆分](https://geektutu.com/post/geekagent-day9.html) | 维护 TODO 列表逐步执行，`/todos` 查看；大任务拆成子任务串行执行（简单 pipeline，非并行） |
| 10 | [项目指令 + 可检索长期记忆](https://geektutu.com/post/geekagent-day10.html) | 项目根 `AGENTS.md` 全量注入 system prompt；运行时重要结论写入 memory 文件，跨会话按关键词搜索复用 |
| 11 | [技能系统](https://geektutu.com/post/geekagent-day11.html) | `skills/` 目录 = 一组 system prompt + 工具集合，`/use <name>` 按需加载 |
| 12 | [代码搜索 + Web 抓取](https://geektutu.com/post/geekagent-day12.html) | `search` 工具（ripgrep 风格）仓库内检索；`fetch` 网页转 markdown，让模型看见外面的世界 |

### 阶段 E：记忆与知识库（Day 13–14）——记得住、读得懂

| Day | 功能 | 最简单实现说明 |
|---|---|---|
| 13 | [记忆升级（BM25 分块检索 + 自动唤起）](https://geektutu.com/post/geekagent-day13.html) | `memory_search` 从「整条关键词包含」升级为「按窗口切块 + BM25 打分」，长条目也能精确命中段落；每轮把用户原话切 bigram 自动检索，相关记忆直接拼进 system prompt，模型不用自觉去查 |
| 14 | [轻 RAG 知识库](https://geektutu.com/post/geekagent-day14.html) | `rag_add` 批量采集（内部 fetch 全文落盘、不经模型上下文）→ 切块 → 复用 Day 13 的 BM25 打分 → `rag_search` 按问检索带来源；`/rag` 命令离线建库 |

### 阶段 F：生态互联（Day 15–16）——工具不必自己写

| Day | 功能 | 最简单实现说明 |
|---|---|---|
| 15 | [MCP 工具接入](https://geektutu.com/post/geekagent-day15.html) | `.geekagent/mcp.json` 声明 server；启动时 spawn 子进程，在 stdio 上按行收发 JSON-RPC：initialize 握手 → tools/list 拉工具 → 以 `mcp_<服务>_<工具>` 注册进 Day 4 注册表；调用转发 tools/call，默认 ask 确认 |
| 16 | [插件框架 + Web 对话界面](https://geektutu.com/post/geekagent-day16.html) | 启动时扫描 `plugins/*/plugin.ts`，通过 `PluginContext` 注册命令、工具和生命周期钩子；echo 插件演示扩展能力，web 插件启动 HTTP 服务并用 SSE 复用现有对话与工具循环 |

## 编排说明

- 本表是**路线图而非承诺**，每天独立评估：功能若被某天提前完成或推翻，顺延/替换，不影响整体节奏
- 每个功能遵循「最简单实现」：能用手写函数解决的不封装、能内置 API 解决的不引依赖、能文本解决的不上 TUI
- 两处允许「结构性修改」的例外，避免洁癖卡住进度：Day 2 工具调用循环必动 `Chat`（tool_calls delta）；Day 4 工具注册表收编 Day 2 / Day 3 的手写工具
- 站标按「一条完整的当天故事」组合：功能聚焦的合并到一天（如安全三段合一、规划 + 执行、交互层合一），每个站标控制在 100–300 行（500 行是硬上限）：低于 100 说明太薄，并入相邻站标；高于 300 说明塞太多，砍掉或顺延，不为凑功能硬塞代码
- 系列名保留「28 天」，日程暂收 16 站，后续新增的规划从 Day 17 起顺延补齐
- TUI 排在第 7 天，与项目事后才做体验的一贯取向相反：右侧常驻面板是后续 todos/用量/记忆等展示型能力的底座，先搭好、后续每天「往面板加一行」即可；Day 7 因此只做面板引擎与用量统计，不掺其他功能，篇幅仍受 500 行硬上限约束

## 变更记录

- 2026-09-03：新增 Day 16 插件框架——扫描 `plugins/` 目录动态加载插件，以 `PluginContext` 注入命令、工具和生命周期能力；新增 Web 对话插件，通过 HTTP + SSE 复用现有对话链路。日程推进到 16 站。
- 2026-09-02：新增阶段 F，Day 15 接入 MCP——本地 stdio + JSON-RPC 客户端，外部进程提供的工具复用 Day 4 注册表与 Day 8 权限模型，配置即插即用；日程推进到 15 站。
- 2026-09-01：删掉对 demo 价值不大的站标——交互组件化、用于路线图复盘的可靠性增强（重试体系 + 并行工具调用）与配置体系（多模型切换 + 日志调试），连同基准评测（需 headless 批处理、素材也不好造）一并删除；系列从 17 站缩为 14 站，Day 13 改为记忆升级——`memory_search` 从关键词包含换成 BM25 分块打分 + 每轮自动唤起，磁盘格式与工具接口不变；新增 Day 14 轻 RAG 知识库，复用 Day 13 的分块与 BM25。
- 2026-08-29：轨道合并与调整——原 Day 4/5 并为「文件读写 + 注册表」、原 Day 7/8 并为「多会话与持久化」；撤销与回滚只有 60 行，并入权限与目录隔离组成 Day 8；重试体系与并行工具调用属工程加固，移至阶段 E 的 Day 13；长期记忆、指令与技能、代码搜索与 Web 抓取依次前移为 Day 10–12，项目 `AGENTS.md` 指令注入与长期记忆合并（memory 不进版本库、动态更新并通过 `memory_search` 按需读取），Day 11 只保留技能系统；Day 7 改为「轻量 TUI + 用量显示」，多模型切换并入 Day 14 配置体系，日程缩到 17 站。
- 2026-08-26：轨道重构（保持 30 天）——网络错误自动退避不再独占一天，并入 Day 17 重试体系（SDK 内置退避 + 业务自修，健壮性参数由 Day 26 配置体系接管）；工具抽象层并入 Day 5 收口；中断取消并入 Day 25；项目指令注入独立成 Day 19；任务规划器与子 Agent 对调（Day 15/16）。
