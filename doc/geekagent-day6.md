# Day 6：同时聊几件事，窗口关了还在——多会话与会话持久化

> Day 5 已经能压缩一条过长的 `history`，但所有话题仍挤在同一条数组里：上午改代码、下午查资料，模型每次都要同时看到两边的上下文。Day 6 做两件事：让一个进程内可以同时维护多条互相独立的会话（`/new`、`/sessions`、`/open`），再把**整个会话集合连同当前 ID**一次性落成 JSON（`/save`、`/load`，退出自动保存）——「聊得长」升级成「分得开、留得住」。

## 0. 为什么既要分会话，又要落盘

先看内存里缺什么。我们需要的不是更大的 `history`，而是多条互相独立的 `history`：每条会话用一个 ID 标记，切换任务时切换对应的消息数组，模型不必每轮都背上不相干的话题；话题各归各的，摘要也不会互相污染。

再看进程外缺什么。即便有了多条会话，它们也只活在内存里：退出程序后，`default`、`work` 以及各自的消息都会消失。所以持久化的对象不是某一条碰巧正在聊天的 `history`，而是**整个会话集合和当前会话 ID**——把这份状态写成一个 JSON 文件，下次启动时整体恢复，内存模型和磁盘模型一一对应。

## 1. 目标：会话可以切，也可以跨进程

验收标准：

- 启动时自动创建 `default` 会话
- `/new <id>` 新建空会话并立即切换；`/sessions` 列出会话 ID、消息数，用 `*` 标记当前会话；`/open <id>` 切回已有会话，原会话的消息仍在
- ID 只允许字母、数字、短横线和下划线
- `/save` 把全部会话和当前 ID 写入 `.geekagent/sessions.json`
- `/load` 恢复全部会话，并切回保存时的当前会话
- `/exit`、Ctrl+C、Ctrl+D 等正常关闭会在退出前自动保存全部会话；若当前仍是临时的 `default`，退出时生成 8 位 ID 并打印，重启后可以按 ID 打开
- `.geekagent/` 不存在时自动创建；文件损坏或结构不对时给出错误，不替换当前内存状态

**当天代码行数**：7 个源文件共 835 行（Day 5 为 646 行，**净增 189 行**）。新增 `sessions.ts`（91 行）与 `storage.ts`（15 行），`chat.ts` 增加 10 行（导入导出），`index.ts` 增加 73 行（命令接线与退出保存）。

## 2. 设计：一个 Chat，一组 history，一张磁盘快照

### 2.1 为什么不创建多个 Chat

最直观的做法是每条会话创建一个 `Chat` 对象。但 `Chat` 里除了 `history`，还有 OpenAI client、模型配置和完整工具循环。复制多个对象只是为了保存多条数组，职责太重。

我们保留唯一的 `Chat`，新增 `Sessions` 管理 `Map<string, Message[]>`。切换时，先把 `Chat` 当前的消息交还给 Map，再把目标数组放进 `Chat`。模型调用逻辑完全不需要认识"会话"。

### 2.2 为什么切换前必须同步当前消息

`Chat.streamReply()` 会不断向数组追加消息，历史压缩还可能直接换成一条新数组。Map 里的引用不一定永远是最新的。因此 `/new`、`/open`、`/sessions` 都把 `chat.exportHistory()` 传给 `Sessions`，先同步当前会话，再执行操作。

### 2.3 ID 为什么限制字符

今天会读写文件，ID 将成为存档中的键。现在就约束为 `/^[a-zA-Z0-9_-]+$/`，命令格式简单，将来无论换什么存储都直接用，不必再改会话规则。

### 2.4 存档长什么样

存档只有两层：`current` 记录当前 ID，`sessions` 保存 ID 到 message 数组的映射。

```json
{
  "current": "work",
  "sessions": {
    "default": [],
    "work": [
      { "role": "user", "content": "继续实现 Day 6" },
      { "role": "assistant", "content": "好。" }
    ]
  }
}
```

Map 不能直接变成 JSON 对象，所以 `Sessions.dump()` 使用 `Object.fromEntries` 生成普通对象；恢复时再用 `Object.entries` 建回 Map。

### 2.5 为什么 Sessions 校验，storage 只读写

`storage.ts` 不理解会话结构，只负责 mkdir、JSON 和文件路径。`Sessions.restore()` 才知道什么是合法 ID、message 数组以及当前 ID 是否存在。职责与 2.1 保持一致：`Sessions` 管会话规则，磁盘模块管文件。未来换成多个文件或数据库时，会话规则不必搬家。

### 2.6 为什么退出时再自动保存一次

只有手动 `/save` 很容易忘。Node 的 readline 在 `/exit`、Ctrl+D 或输入流关闭时都会触发 `close` 事件，因此把同一套保存逻辑挂到这里：正常离开程序前，总有一次最新快照落盘。

手动和自动保存不能各写一套，所以提取 `saveAll()`：它先同步当前 history，再保存整个集合。`/save` 与 `close` 只是决定何时调用它。

### 2.7 为什么 default 退出时必须换一个 ID

`default` 只是每次启动时临时创建的名字。如果直接用它保存，第一次退出写下的 `default` 会话，会被下一次启动后新建的同名会话覆盖。终端虽然打印了“已保存”，但用户没有一个稳定的 ID 可以再次找到它。

因此，正常退出时先检查当前会话：如果仍叫 `default`，就取 UUID 的前 8 位作为 ID，把 Map 中的键从 `default` 换成这个 ID，再保存。8 位比完整 UUID 更适合手动输入；生成后还会检查 Map 中是否已有同名会话，碰撞就重新生成。通过 `/new work` 命名过的会话不需要改名，仍按用户给出的 ID 保存。

## 3. 实现：先效果，后实现

### 3.0 终端效果

`default` 里先聊过一轮（因此有 2 条消息），新建 `work` 后它会话从空数组开始，切来切去不串话；把整个集合 `/save` 后退出，重启进程再 `/load`，`work` 和星号都回来了：

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#808080">GeekAgent Day 6 —— 多会话与持久化（模型：deepseek-v4-flash，当前会话：default）</span>
<span style="color:#00cdcd">You › 帮我记住：项目名是 GeekAgent，作者是 geektutu。只回复「好的」。</span>
<span style="color:#00cd00">好的</span>
<span style="color:#00cdcd">You › /new work</span>
<span style="color:#808080">（已新建并切换到会话 work）</span>
<span style="color:#00cdcd">You › /sessions</span>
<span style="color:#808080">会话：</span>
<span style="color:#808080">  default（2 条消息）</span>
<span style="color:#808080">* work（0 条消息）</span>
<span style="color:#00cdcd">You › 我下午的 TODO：给 write 工具加备份，再写一篇演示文档。只回复「好的」。</span>
<span style="color:#00cd00">好的</span>
<span style="color:#00cdcd">You › /sessions</span>
<span style="color:#808080">会话：</span>
<span style="color:#808080">  default（2 条消息）</span>
<span style="color:#808080">* work（2 条消息）</span>
<span style="color:#00cdcd">You › /save</span>
<span style="color:#808080">（已保存 2 个会话到 /home/daijie/git/geekagent/.geekagent/sessions.json）</span>
<span style="color:#00cdcd">You › /exit</span>
<span style="color:#808080">（退出前已保存 2 个会话到 /home/daijie/git/geekagent/.geekagent/sessions.json）</span>
<span style="color:#808080">bye</span>
<span style="color:#808080">── 重新启动进程 ──</span>
<span style="color:#808080">GeekAgent Day 6 —— 多会话与持久化（模型：deepseek-v4-flash，当前会话：default）</span>
<span style="color:#00cdcd">You › /load</span>
<span style="color:#808080">（已从 /home/daijie/git/geekagent/.geekagent/sessions.json 恢复 2 个会话，当前：work）</span>
<span style="color:#00cdcd">You › /sessions</span>
<span style="color:#808080">会话：</span>
<span style="color:#808080">  default（2 条消息）</span>
<span style="color:#808080">* work（2 条消息）</span>
</pre>

恢复出来的不只是两组消息——重启后的星号回到了 `work`，说明当前 ID 一起越过了进程边界。

如果没有先用 `/new` 命名，退出时会生成并打印一个短 ID：

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#00cdcd">You › /exit</span>
<span style="color:#808080">（退出前已保存 1 个会话到 /home/daijie/git/geekagent/.geekagent/sessions.json）</span>
<span style="color:#808080">（会话 ID：97f61f19，重启后可用 /load 再用 /open 97f61f19 打开）</span>
<span style="color:#808080">bye</span>
</pre>

这个 ID 已经写进存档。重启后先 `/load` 恢复磁盘快照，再执行 `/open 97f61f19`，就能按退出时打印的 ID 找回会话。

### 3.1 Sessions：完整的多会话集合 + 快照与恢复

当天新增的完整文件如下（含序列化的两端）：

```ts
// day6/sessions.ts
import type OpenAI from 'openai';
import { randomUUID } from 'node:crypto';

export type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const ROLES = new Set(['system', 'user', 'assistant', 'tool', 'developer', 'function']);

export interface SessionData {
    current: string;
    sessions: Record<string, Message[]>;
}
/** 多会话集合；Day 6 增加整个集合的序列化与恢复。 */
export class Sessions {
    private items = new Map<string, Message[]>([['default', []]]);
    private current = 'default';

    currentId(): string {
        return this.current;
    }

    nameDefault(currentMessages: Message[]): string | undefined {
        if (this.current !== 'default') return undefined;
        let id: string;
        do id = randomUUID().slice(0, 8); while (this.items.has(id));
        this.items.delete('default');
        this.items.set(id, currentMessages);
        this.current = id;
        return id;
    }

    create(id: string, currentMessages: Message[]): Message[] {
        checkId(id);
        if (this.items.has(id)) throw new Error(`会话 ${id} 已存在`);
        this.items.set(this.current, currentMessages);
        this.items.set(id, []);
        this.current = id;
        return [];
    }

    open(id: string, currentMessages: Message[]): Message[] {
        checkId(id);
        if (id === this.current) {
            this.items.set(id, currentMessages);
            return currentMessages;
        }
        const messages = this.items.get(id);
        if (!messages) throw new Error(`会话 ${id} 不存在`);
        this.items.set(this.current, currentMessages);
        this.current = id;
        return messages;
    }

    list(currentMessages: Message[]): { id: string; count: number; current: boolean }[] {
        this.items.set(this.current, currentMessages);
        return [...this.items]
            .map(([id, messages]) => ({ id, count: messages.length, current: id === this.current }))
            .sort((a, b) => a.id.localeCompare(b.id));
    }

    dump(currentMessages: Message[]): SessionData {
        this.items.set(this.current, currentMessages);
        return { current: this.current, sessions: Object.fromEntries(this.items) };
    }

    restore(data: unknown): Message[] {
        if (!isSessionData(data)) throw new Error('存档不是有效的多会话数据');
        this.items = new Map(Object.entries(data.sessions));
        this.current = data.current;
        return this.items.get(this.current)!;
    }
}

function checkId(id: string): void {
    if (!ID_PATTERN.test(id)) throw new Error('会话 ID 只能包含字母、数字、短横线和下划线');
}

function isSessionData(value: unknown): value is SessionData {
    if (!value || typeof value !== 'object') return false;
    const data = value as Partial<SessionData>;
    if (typeof data.current !== 'string' || !data.sessions || typeof data.sessions !== 'object') return false;
    return Object.entries(data.sessions).every(([id, messages]) =>
        ID_PATTERN.test(id) && Array.isArray(messages) && messages.every(isMessage)
    ) && Object.hasOwn(data.sessions, data.current);
}

function isMessage(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const role = (value as { role?: unknown }).role;
    return typeof role === 'string' && ROLES.has(role);
}
```

- `nameDefault` 只处理临时的 `default`：生成不重复的 8 位 ID，保留当前消息并更新 `current`。已有名字的会话返回 `undefined`，退出提示也就不额外打印 ID。
- `create` 和 `open` 都返回目标消息数组，CLI 拿到后直接交给 `Chat`。`list` 返回的是展示需要的最少信息，不暴露内部 Map。
- **`dump` / `restore` 是序列化这一天的核心**：`dump` 先把当前 history 同步进 Map，再用 `Object.fromEntries` 生成普通对象；`restore` 先完成全部校验，成功后才替换 `items` 和 `current`——坏存档不会留下"恢复了一半"的状态。`isMessage` 只校验 `role` 是合法角色，完整的 OpenAI Schema 校验留给以后（见第 5 节）。

### 3.2 Chat：开放 history 的导入导出

`day6/chat.ts` 新增两个方法，只负责交接消息数组：

```ts
// day6/chat.ts
  exportHistory(): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    return this.history;
  }

  importHistory(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): void {
    this.history = messages;
  }
```

### 3.3 storage.ts：完整的磁盘层

丢给磁盘的只有 15 行——不碰会话结构，只碰文件：

```ts
// day6/storage.ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { SessionData } from './sessions.js';

const SESSION_FILE = resolve('.geekagent/sessions.json');

export async function saveSessions(data: SessionData): Promise<string> {
    await mkdir(dirname(SESSION_FILE), { recursive: true });
    await writeFile(SESSION_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return SESSION_FILE;
}

export async function loadSessions(): Promise<{ data: unknown; file: string }> {
    return { data: JSON.parse(await readFile(SESSION_FILE, 'utf8')), file: SESSION_FILE };
}
```

读取结果刻意保留为 `unknown`，只有经过 `Sessions.restore()` 才能成为可信的会话数据——`JSON.parse` 解析失败（比如文件被手改坏了），错误在 `/load` 的分支里被捕获，当前内存状态不会被替换。

### 3.4 CLI：创建、列表与切换

先创建唯一的会话集合：

```ts
// day6/index.ts
const config = loadConfig();
const chat = new Chat(config.baseURL, config.apiKey, config.model);
const sessions = new Sessions();
```

```ts
// day6/index.ts
async function saveAll(): Promise<{ count: number; file: string }> {
    const data = sessions.dump(chat.exportHistory());
    const file = await saveSessions(data);
    return { count: Object.keys(data.sessions).length, file };
}
```

切换三命令，都先把当前 history 同步给 `Sessions`：

```ts
// day6/index.ts
                case '/new':
                    if (!id) {
                        err('sys', '用法：/new <id>');
                        break;
                    }
                    try {
                        chat.importHistory(sessions.create(id, chat.exportHistory()));
                        out('sys', `（已新建并切换到会话 ${id}）`, true);
                    } catch (e) {
                        err('sys', `新建失败：${(e as Error).message}`);
                    }
                    break;
                case '/sessions': {
                    const list = sessions.list(chat.exportHistory());
                    const lines = list.map((item) => `${item.current ? '*' : ' '} ${item.id}（${item.count} 条消息）`);
                    out('sys', `会话：\n${lines.join('\n')}`, true);
                    break;
                }
                case '/open':
                    if (!id) {
                        err('sys', '用法：/open <id>');
                        break;
                    }
                    try {
                        const messages = sessions.open(id, chat.exportHistory());
                        chat.importHistory(messages);
                        out('sys', `（已切换到会话 ${id}，${messages.length} 条消息）`, true);
                    } catch (e) {
                        err('sys', `打开失败：${(e as Error).message}`);
                    }
                    break;
```

### 3.5 CLI：手动保存与加载

`/save` 和 `/load` 完整分支：

```ts
// day6/index.ts
                case '/save':
                    try {
                        const { count, file } = await saveAll();
                        out('sys', `（已保存 ${count} 个会话到 ${file}）`, true);
                    } catch (e) {
                        err('sys', `保存失败：${(e as Error).message}`);
                    }
                    break;
                case '/load':
                    try {
                        const { data, file } = await loadSessions();
                        const messages = sessions.restore(data);
                        chat.importHistory(messages);
                        out('sys', `（已从 ${file} 恢复 ${sessions.list(messages).length} 个会话，当前：${sessions.currentId()}）`, true);
                    } catch (e) {
                        err('sys', `读取失败：${(e as Error).message}`);
                    }
                    break;
```

`/save` 先让 Sessions 同步当前 history 并生成快照；`/load` 则先恢复 Sessions，再把当前会话的消息交给 Chat。

### 3.6 close：退出前自动保存

正常关闭都会走同一个 `close` 监听器。保存完成后不再调用 `process.exit()` 强制结束，让异步写文件自然完成：

```ts
// day6/index.ts
rl.on('close', async () => {
    try {
        const generatedId = sessions.nameDefault(chat.exportHistory());
        const { count, file } = await saveAll();
        out('sys', `（退出前已保存 ${count} 个会话到 ${file}）`, true);
        if (generatedId) {
            out('sys', `（会话 ID：${generatedId}，重启后可用 /load 再用 /open ${generatedId} 打开）`, true);
        }
    } catch (e) {
        err('sys', `退出前保存失败：${(e as Error).message}`);
    }
    out('sys', 'bye', true);
});
```

`nameDefault()` 必须在 `saveAll()` 之前调用，这样生成的 ID 才会进入磁盘快照。只有确实为 `default` 生成了 ID，才会多打印一行恢复命令。保存失败时仍会打印 `bye` 并退出——退出行为不能因为磁盘暂时不可写而卡死。

`/help` 与启动 banner 也一并登记了新命令，banner 里的 `当前会话：…` 来自 `sessions.currentId()`。

## 4. 验证

```bash
npm run dev -- day6/index.ts
```

1. 在 `default` 聊一轮，输入 `/new work`，再聊一轮；用 `/sessions` 和 `/open` 来回切换，两边的消息应互不干扰。
2. 当前是 `work` 时直接 `/exit`，应自动保存且不生成新 ID；重启后 `/load`，会话数量、消息数和当前会话应与退出前一致。
3. 备份并移走测试存档后重新启动，只在 `default` 聊一轮并 `/exit`；退出信息应打印 8 位会话 ID。再次启动，执行 `/load` 和 `/open <id>`，应能找回此前对话。
4. 输入 `/new ../bad` 应被 ID 校验拒绝；把存档改成 `{}` 后执行 `/load`，应提示存档无效且不改变当前会话。

```bash
npm run typecheck
```

> 提示：自动化测试（比如 `printf ... | npm run dev`）往下灌命令时要留足间隔——`/load` 这类命令里有 `await`，输入流走得太快，`busy` 锁会跳过后续输入。正常人手敲键盘不会有这个问题。

## 5. Day 6 明确没做

- **异常终止保存**：`SIGKILL`、断电或进程崩溃不会触发 `close`，最后一段修改仍可能丢失。
- **会话管理**：还不能删除或重命名会话。
- **并发写保护**：多个进程保存时，最后写入者会覆盖前者。

## 6. 下一步

多条上下文既能切换，也能一起落盘，但运行状态仍藏在程序内部。下一步会让这些状态变得可见，帮助我们判断一次对话消耗了多少资源、距离模型的上下文上限还有多远。
