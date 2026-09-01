---
title: 从零实现 GeekAgent —— Day8 权限与回滚
description: >-
  7天从零实现Agent教程，用 TypeScript 动手写一个最简单的 Agent/Harness。Day 8 给工具划边界，也给写入留后路：用 .geekagent/GeekAgent.json 划清权限与目录边界，再给每次文件写入保存最近状态——不该做的操作提前拦住，写错还能用 /undo 恢复。
date: '2026-08-27 21:30:00'
tags:
  - Agent
  - Harness
book: geekagent
status: done
draft: false
---

# Day 8：给工具划边界，也给写入留后路——权限与回滚

> Day 7 已经能让 Agent 在终端里持续工作，但「能调用」几乎等于「有权限调用」：读工具永远放行，shell 和写工具永远询问，而且文件路径可以指向机器上的任何位置。今天先用 `.geekagent/GeekAgent.json` 划清权限与目录边界，再给每次文件写入保存最近状态：不该做的操作提前拦住，已经确认却写错的内容还能用 `/undo` 恢复。

## 0. 为什么确认框还不等于权限

Day 3 的确认框解决的是「执行这一次命令前问一句」，并没有回答三个更长期的问题：

1. 一个只读工具是否可以一直放行？
2. 一个不希望 Agent 使用的工具，能否从入口直接拒绝？
3. 文件工具即使免确认，能否保证它只看当前项目？

把答案写死在工具里，每次换项目都要改 TypeScript。更麻烦的是，`read ../../.env` 仍然属于“只读”，却已经越过了项目边界。我们需要的不是更多确认框，而是一张独立于工具实现的权限表，以及一条所有文件路径都必须经过的边界线。

不过，确认只能说明“此刻允许写”，不能保证写出的每一行都正确。既然 `write` 和 `patch` 已经共享同一个写盘入口，我们还可以在那里记住“写之前是什么样”：权限负责事前控制，撤销负责事后恢复。

| 能力 | 回答的问题 | 当前实现 |
|---|---|---|
| 确认 | 这一次要不要执行？ | TUI `[y/N]` |
| 权限策略 | 这个工具通常能不能执行？ | `allow` / `ask` / `deny` |
| 目录隔离 | 工具最多能访问哪里？ | `root` + `safePath` |
| 回滚 | 已经写错了怎么办？ | 保存最近一次旧状态，`/undo` 恢复 |

工业级 Agent 往往还会使用操作系统 sandbox、容器或更细的命令规则。Day 8 先在应用层实现四个最容易观察的边界；它能减少误操作，但不等同于操作系统级隔离。

## 1. 目标

今天的验收标准：

1. `.geekagent/GeekAgent.json` 为每个工具配置 `allow`、`ask` 或 `deny`：分别直接执行、询问后执行或在进入工具前拒绝；
2. `ls` / `read` / `glob` / `write` / `patch` 只能访问配置的 `root`，相对越界、绝对路径和借符号链接越界都会被拒绝；工具返回中的密钥值会被替换；
3. `write` 和 `patch` 真正写入前把旧内容保存到 `.geekagent/undo.json`，`/undo` 能恢复被覆盖的文件或删除刚创建的文件。

**当天代码行数**：Day 8 源码净增 155 行，其中新增 `day8/permissions.ts` 111 行、`day8/undo.ts` 49 行；删除 Day 7 留下的硬编码确认实现后，总增量仍控制在 500 行以内。

## 2. 设计

### 2.1 三种策略只回答一件事

权限表不判断命令“看起来危不危险”，只给每个工具三种明确结果：

- `allow`：直接执行
- `ask`：交给 TUI 显示 `[y/N]`
- `deny`：不进入工具实现，直接返回拒绝

这样，策略和工具代码分开了。`run_shell` 在一个项目里可以是 `ask`，在另一个只做代码阅读的项目里可以是 `deny`。未知工具默认拒绝，避免以后新增工具时忘记配置却自动获得权限。

### 2.2 目录隔离不能只检查 `..`

路径 `../secret` 很容易识别，但还有一条绕路：项目内可以存在一个指向项目外的符号链接。只比较字符串时，`root/link/secret` 看起来仍在根目录内，操作系统真正访问的却是外部目录。

所以 `safePath` 做两次检查：先用 `resolve` / `relative` 拦住字面上的越界，再用 `realpath` 找到磁盘上的真实位置。新文件还不存在时，就逐级向上寻找第一个存在的父目录，确认它没有借符号链接跑出去。

`glob` 不接收普通文件路径，参数里会带 `*` 和 `**`，不能直接交给 `realpath`。它采用更窄的规则：只接受不含 `..` 的相对模式，并把搜索的 `cwd` 固定为配置根目录。

### 2.3 脱敏放在工具统一出口

shell 执行 `env`、文件工具读取配置、错误信息回显命令，都可能把密钥带回模型。逐个工具补替换很容易漏，所以 `execTool` 在结果离开注册表之前统一调用 `redact`。确认提示也走同一个函数，终端和模型两边都看不到真实值。

### 2.4 最近状态只保留一份

完整的撤销栈还要处理多条记录、容量限制和历史清理。这里先解决最直接的问题：刚写错一个文件，马上退回去。因此 `.geekagent/undo.json` 始终只有一条记录，下一次写入会覆盖上一次记录。

记录包含相对权限根目录的 `path` 和写入前的 `content`。已有文件用字符串保存原内容；新建文件原先不存在，就用 `null` 表示。空文件的内容是 `""`，与 `null` 不同，所以两种状态不会混淆。

恢复时，记录中的路径重新经过 `safePath`。即使有人手工篡改撤销文件，也不能借 `/undo` 写到配置根目录之外。

### 2.5 只为真正发生的写入备份

内容没有变化，或者用户在确认框里选择 `n`，磁盘都不会改变，也不应该覆盖此前的撤销记录。因此写入顺序固定为：

```text
生成新内容 -> 展示 diff -> 用户确认 -> 保存旧状态 -> 写入新内容
```

`write` 和 `patch` 最终都会进入 `commitWrite`，备份只需要接在这个共同出口一次。

## 3. 实现：先看效果

把 `run_shell` 改成 `deny` 后，让模型执行命令，工具入口直接返回：

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#00cdcd">You › 执行 echo hello</span>
<span style="color:#cdcd00">[调用工具 run_shell → 权限拒绝：工具 run_shell 不允许执行]</span>
<span style="color:#00cd00">run_shell 当前被权限配置拒绝，命令没有执行。</span>
</pre>

把它恢复成 `ask`，TUI 才会出现确认；`allow` 则直接运行。文件越界和敏感值也在同一出口被挡住：

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#00cdcd">You › 读取 ../outside.txt</span>
<span style="color:#cdcd00">[调用工具 read → 工具执行失败：路径越界：../outside.txt]</span>
<span style="color:#00cd00">这个路径超出了 GeekAgent.json 配置的根目录，无法读取。</span>
</pre>

文件写入通过确认后会自动留下快照。发现内容不对时，不需要再调用模型，直接输入 `/undo`：

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#00cdcd">You › 把 hello.txt 改成 hello world</span>
<span style="color:#cdcd00">确认写入 /home/me/project/hello.txt？ → y</span>
<span style="color:#cdcd00">[调用工具 patch → 已应用 1 处修改到 hello.txt]</span>
<span style="color:#00cd00">已经把 hello.txt 改成 hello world。</span>
<span style="color:#00cdcd">You › /undo</span>
<span style="color:#808080">（已撤销对 hello.txt 的最近一次写入）</span>
</pre>

### 3.1 第一份 .geekagent/GeekAgent.json

配置只有一个根目录和一张工具表。`root` 相对配置文件所在目录解析：

```json
{
  "root": "..",
  "tools": {
    "get_current_time": "allow",
    "run_shell": "ask",
    "ls": "allow",
    "read": "allow",
    "glob": "allow",
    "write": "ask",
    "patch": "ask"
  }
}
```

首次启动时如果文件不存在，程序会自动创建 `.geekagent` 目录并写入这份配置。`root` 相对配置文件解析，所以 `..` 正好指向项目根。默认值延续 Day 7 的体验：时间与只读文件工具直接执行，shell 和写文件询问。

### 3.2 权限、路径与脱敏集中到一个文件

权限部分集中在一个新增的 TypeScript 文件里：

```ts
// day8/permissions.ts
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export type Policy = 'ask' | 'allow' | 'deny';

export interface PermissionConfig {
    root: string;
    tools: Record<string, Policy>;
}

const DEFAULT_TOOLS: Record<string, Policy> = {
    get_current_time: 'allow',
    run_shell: 'ask',
    ls: 'allow',
    read: 'allow',
    glob: 'allow',
    write: 'ask',
    patch: 'ask',
};

let config: PermissionConfig = { root: process.cwd(), tools: DEFAULT_TOOLS };
let confirmFn: (prompt: string) => Promise<boolean> = async () => false;

/** 配置不存在时写入 Day 7 的默认权限；存在但写错时直接报错，不静默放宽。 */
export async function loadPermissions(file = '.geekagent/GeekAgent.json'): Promise<PermissionConfig> {
    let raw: string;
    try {
        raw = await readFile(file, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        const defaults = { root: '..', tools: { ...DEFAULT_TOOLS } };
        await mkdir(dirname(resolve(file)), { recursive: true });
        await writeFile(file, `${JSON.stringify(defaults, null, 2)}\n`);
        raw = JSON.stringify(defaults);
    }
    const value = JSON.parse(raw) as { root?: unknown; tools?: unknown };
    if (typeof value.root !== 'string' || !value.root.trim()) throw new Error('GeekAgent.json 的 root 必须是非空字符串');
    if (!value.tools || typeof value.tools !== 'object' || Array.isArray(value.tools)) {
        throw new Error('GeekAgent.json 的 tools 必须是对象');
    }
    const tools = { ...DEFAULT_TOOLS };
    for (const [name, policy] of Object.entries(value.tools)) {
        if (policy !== 'ask' && policy !== 'allow' && policy !== 'deny') {
            throw new Error(`工具 ${name} 的策略必须是 ask / allow / deny`);
        }
        tools[name] = policy;
    }
    return { root: resolve(dirname(resolve(file)), value.root), tools };
}

export function setupPermissions(next: PermissionConfig, fn: (prompt: string) => Promise<boolean>): void {
    config = next;
    confirmFn = fn;
}

export function permissionRoot(): string {
    return config.root;
}

export function policyFor(tool: string): Policy {
    return config.tools[tool] ?? 'deny';
}

export async function authorize(tool: string, prompt = `工具 ${tool} 请求执行`): Promise<boolean> {
    const policy = policyFor(tool);
    if (policy === 'allow') return true;
    if (policy === 'deny') return false;
    return confirmFn(redact(prompt));
}

/** 返回根目录内的绝对路径，并用 realpath 挡住借符号链接越界。 */
export async function safePath(input: string): Promise<string> {
    const root = resolve(config.root);
    const target = resolve(root, input);
    const rel = relative(root, target);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`路径越界：${input}`);

    let existing = target;
    while (true) {
        try {
            existing = await realpath(existing);
            break;
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
            const parent = dirname(existing);
            if (parent === existing) throw err;
            existing = parent;
        }
    }
    const realRoot = await realpath(root);
    const realRel = relative(realRoot, existing);
    if (realRel === '..' || realRel.startsWith(`..${sep}`) || isAbsolute(realRel)) throw new Error(`路径越界：${input}`);
    return target;
}

/** glob 固定以 root 为 cwd；模式本身只允许根目录内的相对写法。 */
export function safeGlob(pattern: string): string {
    if (isAbsolute(pattern) || pattern.split(/[\\/]+/).includes('..')) throw new Error(`路径越界：${pattern}`);
    return pattern;
}

/** 只屏蔽敏感环境变量的真实值，普通输出保持原样。 */
export function redact(text: string): string {
    let result = text;
    for (const [name, value] of Object.entries(process.env)) {
        if (!/(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(name) || !value) continue;
        result = result.replaceAll(value, `[REDACTED:${name}]`);
    }
    return result;
}
```

三个函数分别守住不同位置：

- `policyFor` 对未知工具返回 `deny`
- `safePath` 同时检查路径字符串和真实磁盘位置
- `redact` 用变量名识别敏感值，再替换输出中出现的真实值

### 3.3 工具注册表统一执行策略

普通工具在 `execTool` 里授权；shell、write、patch 需要展示命令或 diff，因此先构造详细提示，再调用同一个 `authorize`。统一出口还负责结果和错误脱敏：

```ts
// day8/tools.ts
export async function execTool(name: string, argsJson: string): Promise<string> {
    const tool = registry.find((t) => t.name === name);
    if (!tool) return `未知工具：${name}`;

    let args: Record<string, unknown> = {};
    try {
        args = argsJson ? JSON.parse(argsJson) : {};
    } catch {
        return redact(`参数不是合法 JSON：${argsJson}`);
    }

    try {
        if (policyFor(name) === 'deny') return `权限拒绝：工具 ${name} 不允许执行`;
        if (!tool.authorizes && !(await authorize(name))) return `权限拒绝：工具 ${name} 不允许执行`;
        return redact(await tool.run(args));
    } catch (err) {
        return redact(`工具执行失败：${(err as Error).message}`);
    }
}
```

文件工具拿到模型传来的路径后先调用 `safePath`；`glob` 则固定从 `permissionRoot()` 开始搜索。原来的 Node 文件 API 不需要知道权限配置，职责仍然只有读写。

### 3.4 把 TUI 确认接到权限层

启动时先加载权限配置，再把 Day 7 已有的确认组件注入权限层：

```ts
// day8/index.ts
const config = loadConfig();
let permissions;
try {
    permissions = await loadPermissions();
} catch (e) {
    console.error(`.geekagent/GeekAgent.json 读取失败：${(e as Error).message}`);
    process.exit(1);
}
const chat = new Chat(config.baseURL, config.apiKey, config.model);
const sessions = new Sessions();
```

```ts
// day8/index.ts
const tui = new TUI(onLine, onExit);
setupPermissions(permissions, (prompt) => tui.confirm(prompt));
```

TUI 不需要理解 `allow` 或 `deny`。只有权限层算出 `ask` 时，它才负责收一次 `y/N`。

确认问题会先写进主区，输入栏再切成 `[y/N]`。作答后不重复打印问题，而是在原行补上 `→ y` 或 `→ n`，因此 shell 命令和写入目标始终可见。

根目录可能是一条很长的绝对路径，直接交给面板会从右侧截断，反而看不到最有辨识度的项目目录名。面板可用空间不足时，我们把它缩成类似 zsh 提示符的 `…/geekagent`：

```ts
// day8/index.ts
const root = permissionRoot();
const shownRoot = visibleWidth(root) <= ROOT_DISPLAY_WIDTH ? root : `…/${basename(root)}`;
```

### 3.5 保存与恢复最近状态

第二个新增模块负责写入快照和消费快照：

```ts
// day8/undo.ts
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { permissionRoot, safePath } from './permissions.js';

const UNDO_FILE = resolve('.geekagent/undo.json');

interface UndoRecord {
    path: string;
    content: string | null;
}

/** 写盘前保存最近一次文件状态；null 表示文件原先不存在。 */
export async function backup(file: string, content: string | null): Promise<void> {
    const record: UndoRecord = {
        path: relative(permissionRoot(), file).replaceAll('\\', '/'),
        content,
    };
    await mkdir(dirname(UNDO_FILE), { recursive: true });
    await writeFile(UNDO_FILE, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/** 恢复最近一次写入前的状态，成功后删除快照，避免重复撤销。 */
export async function undo(): Promise<string> {
    let record: UndoRecord;
    try {
        record = JSON.parse(await readFile(UNDO_FILE, 'utf8')) as UndoRecord;
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '没有可撤销的写入';
        throw new Error(`撤销记录读取失败：${(err as Error).message}`);
    }
    if (typeof record.path !== 'string' || (record.content !== null && typeof record.content !== 'string')) {
        throw new Error('撤销记录格式无效');
    }

    const file = await safePath(record.path);
    if (record.content === null) {
        try {
            await unlink(file);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
    } else {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, record.content, 'utf8');
    }
    await unlink(UNDO_FILE);
    return `已撤销对 ${record.path} 的最近一次写入`;
}
```

恢复成功后才删除 `undo.json`。如果路径检查或文件写入失败，快照仍然保留，排查后还可以重试。

### 3.6 在共同写入出口备份

`commitWrite` 原本已经是 `write` 和 `patch` 的共同出口。旧内容现在既用于生成 diff，也用于保存撤销快照：

```ts
// day8/tools.ts
async function commitWrite(tool: 'write' | 'patch', file: string, next: string): Promise<boolean> {
    let oldtxt: string | null = null;
    try {
        oldtxt = await readFile(file, 'utf8');
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (oldtxt === next) return true;
    if (!(await authorize(tool, `\n${simpleDiff(oldtxt ?? '', next)}\n确认写入 ${file}？`))) return false;
    await backup(file, oldtxt);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, next);
    return true;
}
```

`/undo` 是用户明确发出的本地命令，不经过模型，也不增加对话历史：

```ts
// day8/index.ts
case '/undo':
    try {
        tui.append(`（${await undo()}）`, 'sys');
    } catch (e) {
        tui.append(`撤销失败：${(e as Error).message}`, 'sys');
    }
    break;
```

## 4. 验证

先做完整类型检查：

```bash
npm run typecheck
```

再启动 Day 8：

```bash
npm run dev -- day8/index.ts
```

按下面顺序验证：

1. 删除 `.geekagent/GeekAgent.json` 后启动，确认程序会生成默认配置：只读工具直接执行，shell 和写工具先询问
2. 把 `run_shell` 改成 `deny`，确认命令被拒绝；再读取 `../package.json`，确认文件工具返回“路径越界”
3. 执行 `env`，确认 `OPENAI_API_KEY` 的值显示为 `[REDACTED:OPENAI_API_KEY]`
4. 分别撤销一次新建和一次覆盖，确认文件被删除或恢复；修改后重启再执行 `/undo`，确认快照仍然有效

## 5. 没做什么

- 目录隔离不覆盖 `run_shell`，shell 造成的文件变化也无法撤销
- 配置只有项目级，没有全局配置和热加载
- 只保留最近一次文件写入，不支持多步撤销和重做

## 6. 下一步

权限和回滚让 Agent 可以更稳妥地动手，但面对一项较大的任务，它仍然容易边想边做、忘记进度。下一步让它先列出可检查的步骤，再按顺序推进，并把当前进度持续展示出来。
