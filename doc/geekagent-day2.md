# Day 2：让模型第一次「动手」——工具调用循环

> Day 1 让模型能「聊」，Day 2 让模型能「动手」：回答不再只是纸上谈兵，它真的会去查时间（未来是执行命令、读写文件）。

## 0. 标题从哪来：工具调用循环是什么

标题里有两个词要先讲清，否则后面没法展开。

**工具调用（tool calling / function calling）**：模型本来只能「说话」——吐一段文本。但 OpenAI 兼容接口允许我们在请求里附上一份「工具清单」：每个工具写清名字、一句话描述和参数格式。模型看到清单后，遇到自己干不了的事（比如查实时时间），不再硬编答案，而是输出一段约定好的 JSON，指明「我要调 `get_current_time`，参数 {}」。这就叫工具调用——模型从「动嘴」变成了「下单」。

**循环**：模型下一次就完事了吗？不是。它下了单，我们得真的去执行、把结果拿回来再喂给它，它才据此组织最终回答。所以完整链路是「请求 → 模型调用工具 → 我们执行 → 结果回传 → 模型继续」，一轮不够就再来一轮，直到它给出不调工具的纯文本回答。把这条链路写成一个 `for` 循环，就是 Day 2 的全部工作。

一句话：**工具调用循环 = 模型会「下单」+ 我们帮它「跑腿」+ 结果回传再问**，循环往复。这是所有 Agent 能力的起点，后面要接的 Shell、文件读写、搜索、抓网页，都只是往这个循环里换工具而已。

## 1. 为什么让模型「动手」

Day 1 的模型只会聊天。问它「现在几点」，它只能凭训练数据瞎猜一个——因为它根本没有「看时钟」的能力。一个只会聊天的模型，再能说也不是 Agent，只是个 chatbot。

Agent 和 chatbot 的分水岭就一句话：**能不能调用外部能力去拿到自己没有的信息、或做出自己做不到的动作**。查时间、跑命令、读文件、调 API……这些都不在模型的「脑内」，必须靠工具伸出去够。所以 Day 2 不急着上复杂工具，先把「模型下单 → 我们跑腿 → 结果回传」这条循环打通——循环通了，后面塞什么工具都只是往清单里加一项。

## 2. Day 2 目标：把「工具调用」的循环打通

Day 2 只做一件事：**模型返回 `tool_call` → 我们执行 → 结果回传 → 模型继续**，直到它给出最终回答。验收标准是四条：

1. 问「现在几点」这类问题，模型会主动调用 `get_current_time` 工具
2. 工具结果在终端可见（`[调用工具 get_current_time → …]`），并回传给模型
3. 模型基于工具结果组织出最终回答，多轮记忆依然有效

**当天代码行数**：5 个源文件共 268 行，新增约 56 行 `tools.ts`，改造约 30 行 `chat.ts`。

## 3. 设计：三个约定，把复杂度按死

1. **工具 = 一个对象**。名字 + 描述 + 参数 JSON Schema + 一个 `run` 函数。模型只会看到清单里声明的工具，`run` 才是我们这边的真实世界。
2. **history 依然是那个数组**。工具调用只是一种新的 message 角色：assistant 发起的 `tool_calls`，以及回传的 `tool` 消息。
3. **结果只有字符串**。工具 `run` 的结果一律转成字符串回传给模型。真实世界（时间、命令输出、文件内容）最后都折叠成一行文本，模型层面不需要任何结构化协议。

## 4. 必要性：为什么不是我们翻译「问题 → 工具」

我们可能会想：模型为啥会主动调工具？是不是我们代码里写了「问题含『几点』→ 调 `get_current_time`」的关键词匹配？

**不是。恰恰相反，整个链路里没有一行「问题关键词 → 工具」的映射**，这正是工具调用设计的精髓。把必要性讲透：

1. 每轮请求，我们把每个工具的「说明书」通过 `tools` 参数交给模型（`toOpenAITools()`）——就是一个名字 + 一句描述 + 参数 Schema，代码里没有任何分支逻辑。
2. 模型生成时自己判断：能凭知识回答的（"1+1 等于几？"），照常输出文本；涉及它不知道的实时信息（"现在几点？"），它看到 `get_current_time` 的描述正好对得上需求，就决定不写答案、改为发起一次工具调用——这是模型在训练中学到的「我知道的不查、不知道的用工」。
3. 调用不是自然语言，而是固定协议：模型输出 JSON（`name` + `arguments`），OpenAI 兼容接口把它放进响应的 `tool_calls` 字段（流式下是拆成碎片的 `delta.tool_calls`）。我们的循环只负责认领、执行、回传，没有理解任何语义。
4. 所以 `description` 写得好不好、`parameters` Schema 定义得准不准，直接决定模型调用得对不对——这也是为什么 `Tool` 抽象里「描述」是必备字段。

代码侧唯一的对应分叉在 chat.ts：本轮流式结束后若**没有** `tool_calls`，就走「最终回答」分支。模型随时可以不理工具，直接开口答。

如果硬要在我们代码里写关键词匹配，会有两个致命问题：一是覆盖不全（用户换个问法就匹配不到），二是模型明明能自己判断却被迫走我们的死规则。把「要不要调工具」交给模型，才是少写代码、多覆盖的正确做法。

## 5. 实现：先效果，后实现

运行后终端里会看到下面的效果（颜色用 HTML 还原）：

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#00cdcd">You › 现在几点</span>
<span style="color:#00cd00">稍等，我查一下……</span>
<span style="color:#cdcd00">[调用工具 get_current_time → 2026/8/26 20:42:11]</span>
<span style="color:#00cd00">现在是晚上 8 点 42 分。</span>
<span style="color:#00cdcd">You › </span>
</pre>

### 5.1 tools.ts —— 工具的「最小公约数」

Day 2 新增 `tools.ts`，完整内容如下：

```ts
// day2/tools.ts
import type { ChatCompletionTool } from 'openai/resources/chat/completions';

/**
 * 工具的最小抽象：一个名字 + 描述 + 参数 JSON Schema + 一个 run 函数。
 * Day 2 只有时间工具一个成员；后续每天往 TOOLS 数组里加即可（Day 4 再收编成注册表）。
 */
export interface Tool {
    name: string;
    description: string;
    /** OpenAI function 的 parameters 层（如 { type: 'object', properties, additionalProperties }） */
    parameters: Record<string, unknown>;
    run(args: Record<string, unknown>): Promise<string> | string;
}

/** 全部已接入工具。模型只会拿到这份清单里声明的函数。 */
export const TOOLS: Tool[] = [
    {
        name: 'get_current_time',
        description: '获取当前本地时间（Asia/Shanghai）。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        run: () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
    },
];

/** 把内部 Tool 转成 OpenAI Chat Completions 的 tools 参数格式。 */
export function toOpenAITools(): ChatCompletionTool[] {
    return TOOLS.map((tool) => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
        },
    }));
}

/**
 * 按名字执行工具。参数是模型生成的 JSON 字符串。
 * 任何报错都作为「结果文本」返回给模型——让模型自己读错误（失败自检后续会实现，先在这里埋线）。
 */
export async function execTool(name: string, argsJson: string): Promise<string> {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return `未知工具：${name}`;

    let args: Record<string, unknown> = {};
    try {
        args = argsJson ? JSON.parse(argsJson) : {};
    } catch {
        return `参数不是合法 JSON：${argsJson}`;
    }

    try {
        return await tool.run(args);
    } catch (err) {
        return `工具执行失败：${(err as Error).message}`;
    }
}
```

后面每天加工具就是往 `TOOLS` 数组里 push 一个对象，循环体一行都不用改。两个配套小函数：

- `toOpenAITools()`：把内部 `Tool` 转成 OpenAI 的 `tools` 参数格式（一个 `type: 'function'` 的包装），交给模型的是「说明书」而非 `run`。

### 5.2 chat.ts —— 工具调用循环

Day 1 的 `streamReply` 是「请求一次 → 流式输出 → 结束」。Day 2 把它包成一个循环，最多转 5 圈（`MAX_TOOL_TURNS`）。完整方法如下：

```ts
// day2/chat.ts
async *streamReply(userInput: string): AsyncGenerator<string> {
  this.history.push({ role: 'user', content: userInput });
  try {
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      const stream = await this.client.chat.completions.create({
        model: this.model,
        messages: this.history,
        tools: toOpenAITools(),
        stream: true,
      });

      // 流式边攒内容边聚拢工具调用（delta 按 index 碎片下发）
      let answer = '';
      const calls = new Map<number, { id: string; name: string; args: string }>();
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) {
          answer += delta.content;
          yield delta.content;
        }
        for (const tc of delta?.tool_calls ?? []) {
          let call = calls.get(tc.index);
          if (!call) {
            call = { id: '', name: '', args: '' };
            calls.set(tc.index, call);
          }
          if (tc.id) call.id = tc.id;
          if (tc.function?.name) call.name += tc.function.name;
          if (tc.function?.arguments) call.args += tc.function.arguments;
        }
      }

      const toolCalls = [...calls.values()];
      if (toolCalls.length > 0 && toolCalls.every((c) => c.name)) {
        // 模型要动手：先把这条 assistant 消息（含 tool_calls）记入 history
        toolCalls.forEach((c, i) => {
          if (!c.id) c.id = `call_${i}`; // 个别模型不返回 id，补一个稳定值
        });
        this.history.push({
          role: 'assistant',
          content: answer || null,
          tool_calls: toolCalls.map((c) => ({
            id: c.id,
            type: 'function' as const,
            function: { name: c.name, arguments: c.args },
          })),
        });
        // 逐个执行并把结果以 role=tool 消息回传，然后进入下一轮
        for (const c of toolCalls) {
          const result = await execTool(c.name, c.args);
          yield `\n[调用工具 ${c.name} → ${result}]\n`;
          this.history.push({ role: 'tool', tool_call_id: c.id, content: result });
        }
        continue;
      }

      // 没有工具调用，就是最终回答
      this.history.push({ role: 'assistant', content: answer });
      return;
    }
    // 轮次用尽仍未停下：兜底收尾，保持 history 有来有回
    yield '\n[工具调用轮次过多，已停止]';
    this.history.push({ role: 'assistant', content: '[工具调用轮次过多，已停止]' });
  } catch (err) {
    // 出错就回滚刚入队的用户消息，保持 history 只有「有来有回」的对话。
    this.history.pop();
    throw err;
  }
}
```

整体骨架就一个 `for` 循环：每轮发请求（携带 `history` + `tools`）→ 流式收 → 有完整 `tool_calls` 就执行并 `continue` 进下一轮，没有就当作最终回答 `return`。

两处需要留意的实现细节，代码里都覆盖到了：

**细节一：流式下 `tool_calls` 是碎片（正常的 streaming 处理）。** 同一个工具调用的 `id`、`function.name`、`function.arguments` 会拆在多个 chunk 里下发，靠 `index` 对号入座，`name`/`arguments` 是**字符串累加**拼出来的（见上面循环里聚拢 `calls` 的那一段）。

**细节二：个别模型不返回 `tool_call_id`。** 抽历史时 `tool` 消息必须对上 assistant 的 `tool_call_id`，缺了请求会 400。所以推入 history 前补齐：`if (!c.id) c.id = \`call_${i}\`;`（见上面 `toolCalls.forEach` 那一段）。

### 5.3 一次工具调用后，history 完整长什么样

问「现在几点」，整个循环跑完，history 尾部追加的是这么 4 条（谁写的清清楚楚）：

```ts
// day2/chat.ts（history 片段示意）
// ① 我们输入：用户原话（Chat 收到输入时 push）
{ role: 'user', content: '现在几点？' },

// ② 模型返回：决定不直接作答，改为调用工具（注意 content 是 null）
{ role: 'assistant', content: null,
  tool_calls: [{ id: 'call_0', type: 'function',
                 function: { name: 'get_current_time', arguments: '{}' } }] },

// ③ 我们回传：工具的真实输出（execTool 的结果，非模型生成）
{ role: 'tool', tool_call_id: 'call_0', content: '2026/8/26 15:42:11' },

// ④ 模型返回：基于工具结果组织出的最终回答
{ role: 'assistant', content: '现在是 2026 年 8 月 26 日下午 3 点 42 分。' },
```

### 5.4 role：history 里每一句话的身份

`messages` 里每一条消息都有一个 `role` 字段，OpenAI Chat Completions 一共有四种，Day 2 已用到三种：

| role | 谁写的 | 含义 | 本项目何时出现 |
|---|---|---|---|
| `system` | 我们 | 设定模型行为与规则的指令，优先级最高 | 还没用，项目指令注入时会用到 |
| `user` | 我们 | 调用方输入的原话 | 每次用户提问入队（即上面的 ①） |
| `assistant` | 模型 | 模型的输出：普通文本，或携带 `tool_calls` 的「我要用工具」声明 | ②（带工具调用）、④（最终回答） |
| `tool` | 工具（经我们回传） | 某次工具调用的执行结果，必须用 `tool_call_id` 对上 assistant 发起的调用 | ③（工具真实输出） |

两个容易误解的点：

- `system` 我们**刻意没引**，上面的 4 条示例里也没有它——Day 1/2 的目标是「先跑起来」，越少概念越好；到后续做指令注入（AGENTS.md）时再登场。
- `tool` 消息不给用户看，它是模型与工具之间的「一问一答」：assistant 发起（带 `id`），`tool` 应答（带回同一个 `tool_call_id`）。若对不上 id，接口直接 400——这就是坑二里要补 id 的原因。

### 5.5 color.ts —— 复用 Day 1 的终端着色

Day 2 直接复用 Day 1 的 `color.ts`（`paint` / `out` / `err` + 颜色表 `C`），不另写一份。唯一新增的着色需求是**工具调用进度行要醒目**：模型调用工具时 chat.ts 会 yield 一段 `[调用工具 ...]`，这一行用黄色（`tool`）而非模型正文的绿色（`model`）。

index.ts 里按行首判断即可，仍是同一个 `out`：

```ts
for await (const delta of chat.streamReply(line)) {
    out(delta.startsWith('\n[调用工具') ? 'tool' : 'model', delta);
}
```

效果即本节开头展示的那段：工具调用进度行染黄，模型正文染绿。

## 6. 验证

- `npm run typecheck` ✅
- 冒烟测试（`/help` + `/exit`）✅：banner 变成 Day 2，help 列出已接入工具
- 真实工具调用需要 API Key：根目录 `cp .env.example .env` 后 `npm run dev -- day2/index.ts` 运行，问「现在几点」即可验收
- 代码量：5 个源文件共 268 行

## 7. Day 2 明确没做

`get_current_time` 不会触碰本地数据，因此这一天还没有处理执行权限。它只负责验证工具调用循环，模型暂时不能操作本地机器。

## 8. 下一步

循环通了，Day 3 顺理成章：给模型接上**第一个能碰真实机器的工具——Shell 执行**，并加上超时、输出截断和执行前确认。用一句话说，Day 2 学会了「伸手」，Day 3 开始「动手干活」。
