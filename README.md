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
| 11 | 技能系统 | `skills/` 目录 = 一组 system prompt + 工具集合，`/use <name>` 按需加载 |
| 12 | 代码搜索 + Web 抓取 | `search` 工具（ripgrep 风格）仓库内检索；`fetch` 网页转 markdown，让模型看见外面的世界 |

### 阶段 E：体验与工程化（Day 13–15）——执行稳定、配置收编、交互顺手

| Day | 功能 | 最简单实现说明 |
|---|---|---|
| 13 | 重试体系 + 并行工具调用 | 网络层 SDK 内置重试 + 随机退避（`maxRetries` / 超时配置驱动）；业务层工具失败 → 模型读错误自修 → 重试 N 次；一次请求发多个独立工具，`Promise.all` 聚合结果（不支持则降级串行） |
| 14 | 配置体系 + 多模型切换 + 日志调试 | 全局/项目级 `.geekagent/GeekAgent.json`，支持直接填写 API Key，也可用环境变量覆盖；预置多套 baseURL/model/key，`/model` 热切换；超时、重试次数等健壮性参数一并收编；`DEBUG=1` 打印工具调用轨迹，可复现问题 |
| 15 | 交互组件化 | 引入 `clack`：spinner / 确认框 / 多选，替换裸确认提示（Day 7 已接管补全、快捷键与 Ctrl+C 中断，此天专注组件与体验细节） |

### 阶段 F：进阶与收尾（Day 16–17）

| Day | 功能 | 最简单实现说明 |
|---|---|---|
| 16 | 基准评测 | 一组真实任务（改 bug / 写测试）跑分，输出报告 |
| 17 | 路线图复盘 | 逐条对照「最简单」原则复盘，写总结博文收尾 |

## 编排说明

- 本表是**路线图而非承诺**，每天独立评估：功能若被某天提前完成或推翻，顺延/替换，不影响整体节奏
- 每个功能遵循「最简单实现」：能用手写函数解决的不封装、能内置 API 解决的不引依赖、能文本解决的不上 TUI
- 两处允许「结构性修改」的例外，避免洁癖卡住进度：Day 2 工具调用循环必动 `Chat`（tool_calls delta）；Day 4 工具注册表收编 Day 2 / Day 3 的手写工具
- 站标按「一条完整的当天故事」组合：功能聚焦的合并到一天（如安全三段合一、规划 + 执行、交互层合一），每个站标控制在 100–300 行（500 行是硬上限）：低于 100 说明太薄，并入相邻站标；高于 300 说明塞太多，砍掉或顺延，不为凑功能硬塞代码
- 系列名保留「28 天」，日程暂收 17 站，后续新增的规划从 Day 18 起顺延补齐
- TUI 排在第 7 天，与项目事后才做体验的一贯取向相反：右侧常驻面板是后续 todos/用量/记忆等展示型能力的底座，先搭好、后续每天「往面板加一行」即可；Day 7 因此只做面板引擎与用量统计，不掺其他功能，篇幅仍受 500 行硬上限约束

## 变更记录

- 2026-08-29：Day 10 合并项目 `AGENTS.md` 指令注入与长期记忆；项目指令全量注入，运行时 memory 不进版本库、动态更新并通过 `memory_search` 按需读取。Day 11 只保留技能系统。
- 2026-08-29：重试体系与并行工具调用属于工程加固，从 Day 10 移至阶段 E 的 Day 13；长期记忆、指令与技能、代码搜索与 Web 抓取依次前移为 Day 10–12。
- 2026-08-29：轨道合并与调整——原 Day 4/5 并为「文件读写 + 注册表」、原 Day 7/8 并为「多会话与持久化」；撤销与回滚只有 60 行，并入权限与目录隔离组成 Day 8，后续站标整体前移，日程缩到 17 站；Day 7 改为「轻量 TUI + 用量显示」，多模型切换并入 Day 14 配置体系。
- 2026-08-26：轨道重构（保持 30 天）——网络错误自动退避不再独占一天，并入 Day 17 重试体系（SDK 内置退避 + 业务自修，健壮性参数由 Day 26 配置体系接管）；工具抽象层并入 Day 5 收口；中断取消并入 Day 25；项目指令注入独立成 Day 19；任务规划器与子 Agent 对调（Day 15/16）。
