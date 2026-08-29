# Day 5：聊得长，不淡忘——历史压缩

## 0. 为什么要压缩 history

前四天的成果连起来是一条完整的链路：Day 1 能聊、Day 2 会下单、Day 3 能动 shell、Day 4 看清楚也改得动手。可这一切都建立在一个前提上——`Chat` 对象里那条 `history` 数组，从出生起就只增不减：

```ts
// day4/chat.ts（省略其他细节）
this.history.push({ role: 'user', content: userInput });        // 每轮先放用户消息
this.history.push({ role: 'assistant', content: answer });      // 再把回答放回去
this.history.push({ role: 'tool', tool_call_id: c.id, content: result }); // 工具结果也放回去
```

每次发请求，都是把整条 `history` 全量送给模型（`chat.ts` 里那行 `messages: this.history`）。聊五句没问题，聊五十句呢？五个文件读下来，每条工具结果三千字呢？

解决办法有三个：

1. **全部保留**。记忆最完整，但上下文窗口总有上限，而且输入越长，每个 token 的成本和响应延迟都在涨。迟早爆。
2. **只留最近 N 条，旧的直接扔**。窗口永不满，但信息被"一刀切"：昨晚讨论的方案、报错里的那行关键线索，全跟着旧消息一起蒸发。第二天接着聊，它对着熟人一脸茫然。
3. **摘要变薄**（今天选它）。旧对话不删，而是让模型先"读一遍、写要点"，用一条精炼的摘要消息替换掉大段原文。像记笔记：逐字录音装不下，只留标题又是断章取义，读一遍再写下关键点，字少了，信息还在。

Day 5 选择第三种：复用现有模型生成摘要，不增加新的依赖和调用通道。接下来只需回答三个问题：什么时候压、压哪些消息、摘要怎样放回 `history`。

## 1. 目标：自动压缩 + 手动入口

验收标准：

1. `history` 累计超过阈值（默认 4000 字符，可用环境变量 `GEEKAGENT_MAX_HISTORY` 覆盖）时，在下一轮对话开始前自动压缩，全程不打断用户
2. 只压旧消息：把除最近 6 条以外的旧消息，交给模型摘成 1 条 system「此前对话摘要」；最近的对话原样保留，保住刚发生的事
3. 压缩发生时，终端能看见黄色进度行 `[历史压缩：N 条旧消息合并为 1 条摘要]`
4. 提供手动入口 `/compact`：不等超阈值，随时主动压缩旧对话（复用同一套压缩逻辑）
5. 压缩后模型的"记忆"没丢：回头问起旧对话里的事实，仍能答对（Demo 第 6 轮）

**当天代码行数**：5 个源文件共 646 行（Day 4 为 570 行，**净增 76 行**）。改动在 `day5/chat.ts`（98 → 166）与 `day5/index.ts`（74 → 82）。

## 2. 设计：何时压、压什么、怎么压

### 2.1 何时压：字符数超过阈值

压缩要有个触发条件，得先给"history 有多长"定义一把尺子。最直接的当然是 token——模型接口按 token 计费、按 token 数窗口，可**精确数 token 需要分词器**，那是一个要按模型维护的字典。用它，就得先为"换模型该换哪套分词"操心，这不是今天该背的包袱。

退一步：`history` 是内存里的一堆对象，把它们 `JSON.stringify` 之后数一下字符数，就能粗略判断上下文大小。Day 5 使用 4000 字符作为默认阈值，精确 token 统计留给后续实现。

为了不用先聊很久才能看到效果，阈值也可以通过 `GEEKAGENT_MAX_HISTORY` 临时调小。第 3 节的 Demo 使用 600。

### 2.2 压什么：摘要旧消息，保留最近 6 条

压缩不能把整个 `history` 一锅端——最近几轮对话是当下问题的上下文，模型正指着它组织回答，压没了是给自己挖坑。所以划一刀：**除最近 `KEEP_RECENT`（取 6）条以外**的统统算"旧消息"，交给模型摘成一条摘要；最近 6 条原样保留，跟摘要拼在一起继续聊。6 大约是"最近两三轮问答再加几条工具结果"，够当下用，也让压缩有得可压。

这一刀怎么砍有个细节值得看：砍点 `split = history.length - KEEP_RECENT`，从数组头往后数——因为消息按时间排列，旧的一定在前。当切点小得没有"更旧的"可压（当前消息还不到 6 条），直接返回 0 不折腾。

### 2.3 怎么压：一次摘要请求，两个调用入口

摘要走哪条路？两个选择：

- **流式**：像聊天那样一段段吐给用户看。可摘要只是过程性的，用户其实看个进度就行，不必逐字观赏。
- **非流式**：一个普通请求等返回，拿到完整摘要文本后直接拼接。代码少，行为也直白。

我们选非流式，一条 `/chat/completions` 请求，带上两句 prompt：一句 system 命令（`COMPRESS_SYSTEM`：把对话压成要点，保留目标、决定、文件路径、未完成事项），一句 user（把要压缩的旧消息，`JSON.stringify` 成文本贴进去）。模型读一遍、吐一份要点，我们把要点包成一条 system 消息接回 `history`。

摘要使用同一个模型和同一份配置，不需要新增调用通道。生成后，用一条 system 消息替换旧消息，再拼回原样保留的最近 6 条。

这段逻辑集中在 `compactOldMessages()`，外面有两个入口：每轮对话开始前检查阈值，超过就自动调用；用户输入 `/compact` 时手动调用。两条路径共用同一套切分和摘要逻辑。

## 3. 实现：先效果，后实现

下面是用 `GEEKAGENT_MAX_HISTORY=600` 跑出来的真实回放：我让模型"记住"五条事实（每轮只准回两个字，控制每次回复都很短，这样历史会匀速变长），等到第六轮提问时，`history` 已经攒超了 600 字符，压缩自动触发：

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#808080">GeekAgent Day 5 —— 历史压缩（模型：deepseek-v4-flash，输入 /help 查看命令）</span>
<span style="color:#00cdcd">You › 记住：项目名是 GeekAgent，用的语言是 TypeScript。请只回复「好的」，不要输出任何其他内容。</span>
<span style="color:#00cd00">好的</span>
<span style="color:#00cdcd">You › 记住：作者是 geektutu。请只回复「好的」，不要输出任何其他内容。</span>
<span style="color:#00cd00">好的</span>
<span style="color:#00cdcd">You › 记住：启动命令是 npm run dev。请只回复「好的」，不要输出任何其他内容。</span>
<span style="color:#00cd00">好的</span>
<span style="color:#00cdcd">You › 记住：目标是做一个最简单可运行的 Agent。请只回复「好的」，不要输出任何其他内容。</span>
<span style="color:#00cd00">好的</span>
<span style="color:#00cdcd">You › 记住：代码目录在 /home/daijie/git/geekagent。请只回复「好的」，不要输出任何其他内容。</span>
<span style="color:#00cd00">好的</span>
<span style="color:#00cdcd">You › 我们刚才逐条记了很多信息。请把你记得的都列出来，包括项目名、语言、作者、启动命令、目标、代码目录。只列事实，用分号分隔，一句话。</span>
<span style="color:#cdcd00">[历史压缩：5 条旧消息合并为 1 条摘要]</span>
<span style="color:#00cd00">项目名 GeekAgent；语言 TypeScript；作者 geektutu；启动命令 npm run dev；目标是做一个最简单可运行的 Agent；代码目录 /home/daijie/git/geekagent。</span>
</pre>

这段回放验证了两件事：

- **自动压缩触发了**：第六轮提问入队后，`history` 超过 600 字符，5 条旧消息被合并成 1 条 system 摘要，终端显示黄色进度行。
- **压缩没让模型失忆**：六条事实里，项目名 / 语言 / 作者 / 启动命令在前五轮的**旧**消息里（已被压缩），目标 / 代码目录在未被压掉的**最近**消息里。模型照样全答出来了——两边都对得上，说明摘要把那几条事实嚼进去了，不是截断丢弃。

改动有两处：`day5/chat.ts` 增加压缩逻辑，`day5/index.ts` 增加命令、提示文案和进度配色。

### 3.1 三个常量：阈值、保留条数、压缩指令

`day5/chat.ts` 顶部新增三个常量：

```ts
// day5/chat.ts
/** 触发历史压缩的字符阈值：history 序列化总长超过即把旧消息压成摘要。可用环境变量调小以便观察触发过程。 */
const MAX_HISTORY_CHARS = Number(process.env.GEEKAGENT_MAX_HISTORY) || 4000;
/** 压缩时保留最近几条完整消息，只摘要更早的——刚发生的对话需要原样细节，久远的才值得变薄。 */
const KEEP_RECENT = 6;

/** 历史压缩的指令：把旧对话压成要点，浓缩关键事实、决定与未完成事项。 */
const COMPRESS_SYSTEM = `你是对话压缩器。把用户贴出的历史对话压缩成简洁的中文要点，尽量保留以下信息：
- 用户的目标、需求、做过的决定与偏好；
- 出现过的文件路径、shell 命令、工具调用与关键结论；
- 尚未完成、仍在推进中的事项。
只输出压缩后的要点，不要解释、不要寒暄、不要保留逐字对话。`;
```

要点：

- `MAX_HISTORY_CHARS` 就是 2.1 说的那把"尺子"，默认 4000，也可以临时调小观察触发过程。
- `COMPRESS_SYSTEM` 是告诉模型"怎么压缩"的说明书。三条保序的指令（事实 / 路径命令 / 未竟事项）写全，因为摘要丢掉什么、保留什么，全靠这十几行字把方向定住。它会以 system 角色贴给压缩请求。

### 3.2 公共核心：测量 history，再压缩旧消息

紧接着的两个新方法：

```ts
// day5/chat.ts
  /** history 的粗略体积：按消息序列化后的字符数估算，超出 MAX_HISTORY_CHARS 即需压缩。 */
  private historySize(): number {
    return this.history.reduce((n, m) => n + JSON.stringify(m).length, 0);
  }

  /**
   * 历史压缩：把除最近 KEEP_RECENT 条以外的旧消息交给模型摘要，
   * 用一条 system 摘要消息替换它们，让上下文变薄。
   * 返回被合并掉的旧消息条数；模型没产出摘要时返回 0，本次不做替换。
   */
  private async compactOldMessages(): Promise<number> {
    const split = this.history.length - KEEP_RECENT;
    if (split <= 0) return 0; // 历史还不够长，无旧消息可压
    const old = this.history.slice(0, split);
    const recent = this.history.slice(split);
    const res = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: COMPRESS_SYSTEM },
        { role: 'user', content: JSON.stringify(old, null, 2) },
      ],
    });
    const text = res.choices[0]?.message?.content?.trim();
    if (!text) return 0;
    this.history = [{ role: 'system', content: `【此前对话摘要】\n${text}` }, ...recent];
    return old.length;
  }
```

这两个方法分别负责测量和压缩：

- **`historySize`**：`JSON.stringify(m).length` 把每条消息序列化后计算字符数并求和。字符数是代价的近似，这与 2.1 的判断一致。
- **`compactOldMessages` 走完三步**：划一刀（`split`）把它切成 `old` 和 `recent` → 调一次非流式请求让模型读 `old` 出摘要 → 用摘要消息和新列表重建 `history`。返回的 `old.length` 是"合并掉了多少条"，供外层那句进度行播报。

### 3.3 自动入口：每轮请求前检查

自动压缩挂在 `streamReply` 入口：用户消息进入 `history` 后，先测量最新大小；超过阈值就调用 `compactOldMessages()`，再继续原有的工具调用循环。

```ts
// day5/chat.ts
  async *streamReply(userInput: string): AsyncGenerator<string> {
    this.history.push({ role: 'user', content: userInput });
    try {
      // Day 5：历史超长时先把旧消息压成摘要，腾出上下文给本轮；压缩失败也不打断对话。
      if (this.historySize() > MAX_HISTORY_CHARS) {
        try {
          const dropped = await this.compactOldMessages();
          yield dropped > 0
              ? `\n[历史压缩：${dropped} 条旧消息合并为 1 条摘要]\n`
              : '\n[历史压缩：模型未产出摘要，保留原历史]\n';
        } catch {
          yield '\n[历史压缩失败：保留原历史]\n';
        }
      }
```

这里有两个顺序不能颠倒：先把本轮用户消息入队，阈值才包含最新输入；压缩要发生在正式请求之前，模型收到的才是变薄后的 `history`。黄色进度行只通过 `yield` 显示，不写入对话历史。

### 3.4 手动入口：compact()

`compact()` 直接复用 `compactOldMessages()`，把压缩结果转成 `/compact` 命令需要的提示文本：

```ts
// day5/chat.ts
  /**
   * 主动压缩：随时把旧消息摘成一条摘要，不等历史超阈值（/compact 命令调用）。
   * 返回给用户看的提示文案，不带方括号；压缩失败不抛错，返回失败说明。
   */
  async compact(): Promise<string> {
    if (this.history.length <= KEEP_RECENT) return '历史压缩：没有可压缩的旧消息';
    try {
      const dropped = await this.compactOldMessages();
      return dropped > 0
          ? `历史压缩：${dropped} 条旧消息合并为 1 条摘要`
          : '历史压缩：模型未产出摘要，保留原历史';
    } catch {
      return '历史压缩失败：保留原历史';
    }
  }
```

自动和手动入口的区别只在触发时机：前者由字符阈值触发，后者由用户命令触发。

### 3.5 CLI 接线：命令、提示与配色

`/compact` 命令加在 `/reset` 后面，直接调用 `chat.compact()` 并输出：

```ts
// day5/index.ts
                case '/compact':
                    out('sys', '\n'); // 压缩进度另起一行
                    out('tool', `[${await chat.compact()}]`, true);
                    break;
```

`/help` 里也登记它：

```
  /compact 立即压缩旧对话摘要（不等自动触发）
```

其余三处文案和配色与之前一样：

```ts
// day5/index.ts
// /help 里新增一行（progress 提示）：
 历史保护：history 累积过久时自动压缩——让模型把旧对话摘要成一条「此前对话摘要」，保留最近几条消息原样，腾出上下文（压缩进度以黄色行提示）。

// 渲染循环里的两行（把压缩进度行认成"进度"，别染成正文绿）：
                    // 进度行（工具调用 / 历史压缩）用黄色，真正的回复用绿色
                    const isProgress = delta.startsWith('\n[调用工具') || delta.startsWith('\n[历史压缩');
                    out(isProgress ? 'tool' : 'model', delta);

// banner 文案：
out('sys', `GeekAgent Day 5 —— 历史压缩（模型：${config.model}，输入 /help 查看命令）`, true);
```

- 配色那两行，从"只认 `\n[调用工具`"扩展成"也认 `\n[历史压缩`"——两处进度行共用黄色的 `tool` 色，正文仍走绿色 `model`，对照前面终端里的黄色行，颜色和源码对得上。

阈值没有写进 `.env`——它是给调试 / 演示用的临时旋钮，直接在前缀里带过去最省事，不用污染配置文件。想看压缩触发，起一条命令时临时调小即可：

```bash
GEEKAGENT_MAX_HISTORY=600 npm run dev -- day5/index.ts
```

## 4. 验证

- `npm run typecheck` ✅：`day5/` 全部源文件类型检查通过
- **聊爆它**（需要 API Key，真跑压缩）：

```bash
GEEKAGENT_MAX_HISTORY=600 npm run dev -- day5/index.ts
```

逐条喂几条短事实（让它每轮只回两个字），再问"刚才记了什么"。当 `history` 超过 600 字符的那一轮，会先看到黄色 `[历史压缩：N 条旧消息合并为 1 条摘要]`，随后回答依旧完整——压缩触发、记忆存续两个行为一次看全。默认阈值 4000 同理，只是要多聊不少。

- **手动压缩**（需要 API Key）：照常起 `day5/index.ts`，聊几轮后敲 `/compact`。历史超过 6 条时看到 `[历史压缩：N 条旧消息合并为 1 条摘要]`；历史太短（≤ 6 条）则提示 `[历史压缩：没有可压缩的旧消息]`。
- 代码量：5 个源文件共 646 行，净增 76 行（`chat.ts` 98 → 166、`index.ts` 74 → 82）。

## 5. Day 5 明确没做

- **摘要可能被再次摘要**：旧摘要串本来就是普通消息，下轮再压缩时它同样可能被当旧消息二次压缩，信息层层折损——没有"摘要只允许压一次"的保护。
- **一轮内的中期压缩**：只在每轮开始前检查一次，连续工具调用要等下一轮用户输入才会触发压缩。
- **会话管理**：仍然只有一条内存会话，退出后 history 会丢失。

## 6. 下一步

历史能「变薄」了，可它仍然只存在于进程内：今天聊完，窗口一关，整段对话连同刚压好的摘要烟消云散。阶段 B 的第二枚钉子——**多会话与持久化**——就在眼前：明天我们让模型同时维护几条互相独立的 `history`，再把整个集合连同当前 ID 一次性落成 JSON，把「聊得长」升级成「分得开、留得住」。
