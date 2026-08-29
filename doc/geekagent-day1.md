# Day 1：一个「最简单」Agent 的 REPL 地基

## 0. 标题从哪来：REPL 是什么

标题里的 **REPL** 是个行话，先把它讲清楚，后面才好展开。

REPL 是 Read-Eval-Print-Loop 四个词的缩写，翻译过来就是「读入 → 求值 → 打印 → 再循环」。我们天天用的命令行、Python 交互式解释器、`node` 不带文件名直接敲，全是 REPL：打一行、回一句、光标又亮起等下一行。

为什么 Agent 的地基要选 REPL？因为人和模型对话的本质就是「一来一回循环」：我们输入、模型答、再输入……一个会反复收集输入的循环，恰好就是 REPL 的本意。所以 Day 1 不追求花哨界面，先把这条「能反复聊」的循环跑通，后面加工具、加文件读写，都是在循环里塞新本事。

## 1. 为什么做这个项目

现在市面上的 Agent（OpenCode、Claude Code、Cursor 之类）能力很强，但也越来越像黑盒。我想自己动手，从零写一个 Agent，看看一个能「聊起来」的 Agent 最少需要多少代码。

于是立了三个规矩：

1. **最简单**：不引入任何 Agent/CLI 框架，核心依赖只留「调模型」和「读环境变量」两个。
2. **分天实现**：每天只做一个功能，当天交付可运行的成果。
3. **非侵入式新增**：后续每一天的功能都在前一天的基础上新增，不推翻重写。

## 2. Day 1 目标：REPL + 流式多轮对话

第一天地基，只做一件事：**让模型能「聊」起来**。验收标准是四条：

1. 一条命令启动，进入青色 `You › ` 提示符
2. 提问后**逐字流式**输出回答（不是等半天一次性吐出来）
3. **多轮记忆**：聊过的内容模型都记得（"记住我叫张三" → "我叫什么"答得上）
4. `/reset` 清空记忆，`/exit` 正常退出

这里顺手解释两个可能陌生的词：

- **流式（streaming）**：模型不是憋一口气生成完整回答再放出来，而是一边生成一边往回传。打字时见过输入法「逐字跳出来」的效果吗？模型回答也是一样，收到一个片段就先显示，体验上从「转圈半天」变成「看着它边想边说」。
- **多轮记忆**：模型本身是无状态的——它不记得上一句。所谓「记忆」是我们每次把历史对话一起重新发给它。这个机制 Day 1 就要铺好，后面所有天都靠它。

**当天代码行数**：4 个源文件共约 157 行。

## 3. 设计：选型与几个决策

### 3.1 选型：用脚投票

- **语言**：TypeScript + Node.js 22。对标对象 OpenCode 本身就是 TS 生态；本机 Node 22 现成，读写文件、起 REPL 都极快。
- **运行时**：`tsx` 直接跑 TS 源码，不编译、不打包，开发体验最轻。
- **模型接口**：OpenAI 兼容接口（`baseURL` + `apiKey` + `model` 三件套）。这意味着 DeepSeek、Kimi、Ollama 等几乎市面所有模型都能即插即用，`deepseek-v4-flash` 只是默认值。
- **零框架**：连 `commander`/`inquirer` 都没用。REPL 就用 Node 自带的 `readline`，多 100 行代码，换来的是每一行都能看懂。

最终依赖清单只有 5 个包：

```json
{
  "dependencies": {
    "dotenv": "^17.4.2",
    "openai": "^7.5.0"
  },
  "devDependencies": {
    "@types/node": "^26.3.0",
    "tsx": "^4.23.12",
    "typescript": "^7.0.2"
  }
}
```

### 3.2 三个关键决策

1. **history 就是 OpenAI 的 `messages` 数组，零转换**。这是 Day 1 最重要的一个设计，后面每天吃红利：多轮记忆、工具调用、系统提示，统统只是往同一个数组里追加不同 `role` 的条目。
2. **颜色都集中在一个文件**：所有终端着色只在 `color.ts` 一个文件里，新增颜色只改一个表，不污染业务代码。

## 4. 必要性：为什么不能直接 `curl` 一下

我们可能会想：调模型不就是发个 HTTP 请求吗？`curl` 一行搞定，为啥还要写 157 行？

我们用「裸做」对比一下，把必要性讲透：

1. **`curl` 只能「一问一答」**。我们发一次、它回一次，进程退出。要聊第二句，得自己把上一句的回答手动贴回去——`curl` 不会帮忙记。多轮记忆要求把历史**自动累积**并重发，这正是 `history` 数组要做的事。
2. **`curl` 默认不流式**。不加 `-N` 之类参数，我们要等模型把整段生成完、连接关闭才看到全部文字，几十字的回答还行，几百字的回答就是漫长的「转圈」。流式要靠边收边打印，得写一段循环。
3. **`curl` 没有「循环」**。人和模型是反复一来一回，需要有个 `while`/事件循环不断收输入、发请求、打印。`readline` 的 REPL 正好干这个。
4. **`curl` 的输出是一坨纯文本**。用户敲的、模型回的、报错，全一个颜色，读样例时得靠脑补谁是谁。上色是最朴素也最有效的可读性增强。

一句话：**`curl` 是「调一次」，Agent 要的是「能反复调、记得住、边出边显、看着清楚」**。这四点差的就是 Day 1 这 157 行。

## 5. 实现：先效果，后实现

运行后终端里会看到下面的效果（颜色用 HTML 还原）：

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#808080">GeekAgent Day 1 —— 最简单的 Agent</span>
<span style="color:#00cdcd">You › 你好，记住我叫张三</span>
<span style="color:#00cd00">你好张三，我记住了。</span>
<span style="color:#00cdcd">You › 我叫什么？</span>
<span style="color:#00cd00">你叫张三。</span>
<span style="color:#00cdcd">You › /reset</span>
<span style="color:#808080">（已清空对话记忆）</span>
<span style="color:#00cdcd">You › /exit</span>
<span style="color:#808080">bye</span>
</pre>

Day 1 包含 4 个源文件：

```
day1/                  # 第一天的工程目录，后续每天一个目录
├── index.ts        # 入口：readline REPL 循环
├── chat.ts         # Chat 类：流式调用 + 上下文记忆
├── config.ts       # 读 .env，缺 key 就报错退出
└── color.ts        # 终端着色
```

### 5.1 chat.ts —— 一个类管住对话与记忆

对应「必要性」第 1、2 点：它持有 `history`（解决记忆），对外暴露流式方法 `streamReply`（解决流式）。完整内容如下：

```ts
// day1/chat.ts
async *streamReply(userInput: string): AsyncGenerator<string> {
  this.history.push({ role: 'user', content: userInput });
  try {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: this.history,   // 每轮全量携带历史
      stream: true,
    });

    let answer = '';
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? '';
      if (delta) { answer += delta; yield delta; }  // 边收边吐
    }
    this.history.push({ role: 'assistant', content: answer });
  } catch (err) {
    this.history.pop();   // 出错回滚，保持「有来有回」
    throw err;
  }
}
```

这里的关键是 `AsyncGenerator`：

- **AsyncGenerator**：`async function*` 配合 `yield`，调用方 `for await` 拿到一个增量就写一个，这就是流式。模型每吐一个片段，就立刻 `yield` 出去打印。

### 5.2 history 的格式：一条新问题是怎么进来的

`history` 就是一个普通的数组，元素格式和 OpenAI Chat Completions 接口的 `messages` **完全一致**——这也是为什么 `messages: this.history` 可以直接原样传参：

```ts
[
  { role: 'user',      content: '记住我叫张三' },
  { role: 'assistant', content: '好的，张三。' },
  { role: 'user',      content: '我叫什么？' },
]
```

新增一条问题，走的是标准的「进一出」流程：

1. 用户输入作为一条 `{ role: 'user', content }` 追加进 `history`；
2. 把整个 `history` 全量发给模型（代码里的 `messages: this.history`），模型据此理解上下文；
3. 流式回答结束后，把完整回答作为一条 `{ role: 'assistant', content }` 追加回去。

所以「多轮记忆」没有任何魔法：对话越长，`history` 携带的上下文越多。而且因为格式与接口零转换，未来想加 system 提示词、工具调用消息，都只是往同一个数组里追加不同 `role` 的条目而已。

### 5.3 config.ts —— 三行配置

`OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` 从环境变量读取，缺 key 直接退并提示复制 `.env.example`：

```ts
// day1/config.ts
import 'dotenv/config';

export interface Config {
    baseURL: string;
    apiKey: string;
    model: string;
}

/** 从环境变量读取模型配置，缺少 API Key 时直接退出并提示。 */
export function loadConfig(): Config {
    const baseURL = process.env.OPENAI_BASE_URL?.trim() || 'https://api.deepseek.com';
    const apiKey = process.env.OPENAI_API_KEY?.trim() || '';
    const model = process.env.OPENAI_MODEL?.trim() || 'deepseek-v4-flash';

    if (!apiKey) {
        console.error('缺少 OPENAI_API_KEY：请复制 .env.example 为 .env 并填写。');
        process.exit(1);
    }

    return { baseURL, apiKey, model };
}
```

### 5.4 color.ts —— 终端着色，输入/输出一眼可分

对应「必要性」第 4 点。光有对话还不够直观：用户敲的和模型回的都一个颜色，读样例时得靠脑补谁是谁。给终端上色是最朴素也最有效的可读性增强，而且零依赖——终端颜色就是「转义序列 + 文字 + 复位序列」三件套，不用引任何库。

完整内容如下：

```ts
// day1/color.ts
/** 终端着色：非 TTY（管道 / 重定向）时自动关闭，避免污染日志。 */
export const useColor = process.stdout.isTTY;

export const C = {
    reset: '\x1b[0m',
    user: '\x1b[36m', // 青色：用户输入
    model: '\x1b[32m', // 绿色：模型回复
    tool: '\x1b[33m', // 黄色：工具调用进度
    sys: '\x1b[90m', // 灰色：系统提示
};

/** 给字符串包上指定颜色并在末尾复位。 */
export function paint(color: keyof typeof C, s: string): string {
    return useColor ? `${C[color]}${s}${C.reset}` : s;
}

/** 按颜色写一段到 stdout；nl 为 true 时末尾补换行（用于整条消息）。 */
export function out(color: keyof typeof C, s = '', nl = false): void {
    process.stdout.write(paint(color, s) + (nl ? '\n' : ''));
}

/** 按颜色向 stderr 写一行（补换行），用于报错。 */
export function err(color: keyof typeof C, s: string): void {
    process.stderr.write(paint(color, s) + '\n');
}
```

几个要点：

- **颜色就是转义码**：`\x1b[36m` 是「开青色」，`\x1b[0m` 是「复位」，夹在中间的文字就带上了颜色。`paint` 自带复位，写出去就是「开色 → 内容 → 复位」自包含，不用担心漏关颜色把后面整片染了。
- **一个 `out` 包揽所有 stdout 输出**：`nl` 参数决定补不补换行——流式增量 `out('model', delta)`（不补，逐字拼），整行消息 `out('sys', '...', true)`（补换行）。`err` 走 stderr，专用于报错。

`index.ts` 里所有输出都过 `out` / `err`，模型回复绿色、系统提示灰色、报错也走 `err`：

```ts
out('sys', '\n');                              // 模型回复前另起一行
for await (const delta of chat.streamReply(line)) {
    out('model', delta);                       // 模型回复：绿色，逐字拼
}
out('sys', '（已清空对话记忆）', true);          // 系统提示：灰色，整行
```

颜色集中在这一张表 `C` 与 `paint` / `out` / `err` 三个函数里，要加新颜色只改 `C` 即可。

### 5.5 index.ts —— REPL 循环

对应「必要性」第 3 点：用 Node 自带 `readline` 搭 REPL（解决循环）。彩色 `You › ` 提示符标注输入侧、命令分发（`/help` `/reset` `/exit`）、一个 `busy` 标志防止流式输出时连发输入串台。所有输出都走 `out` / `err`（着色细节见 §5.4），模型回复逐字 `out('model', delta)` 流式拼出。完整内容如下：

```ts
// day1/index.ts
import { createInterface } from 'node:readline';
import { loadConfig } from './config.js';
import { Chat } from './chat.js';
import { err, out, paint } from './color.js';

const config = loadConfig();
const chat = new Chat(config.baseURL, config.apiKey, config.model);

const rl = createInterface({ input: process.stdin, output: process.stdout });

// 用彩色提示符标注「用户输入」这一侧。
rl.setPrompt(paint('user', 'You › '));

let busy = false;

function printHelp(): void {
    out('sys', `可用命令：
  /help   显示帮助
  /reset  清空本轮对话记忆
  /exit   退出（等价于 Ctrl+C / Ctrl+D）
输入任意内容即可与模型对话。`, true);
}

rl.on('line', async (raw) => {
    if (busy) return; // 上一轮还在流式输出，忽略连发输入
    busy = true;

    const line = raw.trim();
    if (line) {
        if (line.startsWith('/')) {
            switch (line) {
                case '/help':
                    printHelp();
                    break;
                case '/reset':
                    chat.reset();
                    out('sys', '（已清空对话记忆）', true);
                    break;
                case '/exit':
                    rl.close();
                    return;
                default:
                    out('sys', `未知命令：${line}（输入 /help 查看）`, true);
            }
        } else {
            try {
                out('sys', '\n'); // 模型回复另起一行
                for await (const delta of chat.streamReply(line)) {
                    out('model', delta);
                }
                out('sys', '\n');
            } catch (e) {
                err('sys', `\n请求失败：${(e as Error).message}`);
            }
        }
    }

    busy = false;
    rl.prompt();
});

rl.on('close', () => {
    out('sys', 'bye', true);
    process.exit(0);
});

out('sys', `GeekAgent Day 1 —— 最简单的 Agent（模型：${config.model}，输入 /help 查看命令）`, true);
rl.prompt();
```

## 6. 验证

- `npm run typecheck` ✅
- REPL 冒烟测试（喂 `/help` + `/exit`）✅：banner → 帮助 → bye，全链路通畅
- 流式与多轮记忆需要真实 API Key，留给用户 `cp .env.example .env` 后亲自验收

用法就两条命令（依赖与配置在仓库根，全仓共用一份）：

```bash
cp .env.example .env        # 根目录填一次 key
npm run dev -- day1/index.ts
```

## 7. Day 1 明确没做

工具调用、文件读写和会话持久化都还没有。Day 1 只有一件事：**能聊**。

## 8. 下一步

既然能聊了，Day 2 最顺理成章的能力就是让模型**动手**：给它配一个工具（比如查时间，`get_current_time`），让回答不再只是「纸上谈兵」。聊天是我们认识的起点，干活才是 Agent 的意义。
