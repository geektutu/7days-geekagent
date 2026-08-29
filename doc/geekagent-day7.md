# Day 7：把用量搬上桌——轻量 TUI 与常驻面板

> 前六天是「读一行命令、回一串文本」的流水日志：聊得热闹，但这轮烧了多少 token、上下文离模型窗口还有多远，全是暗账。今天给终端换一张桌：程序暂时接管整个终端，左侧放消息流，右侧**常驻一块用量面板**——本轮 / 累计 tokens 与上下文占用比例一边聊一边看得见。退出程序后，原来的终端内容会恢复；对话、工具、会话、压缩的行为都不变。

## 0. 为什么需要一块「一直留在屏幕上的地方」

前六天的终端没有任何「常驻内容」。一条回复下来，输出往下滚一行，旧的缩到屏外，屏幕上永远只有「最近一段」——聊天没问题，直到有两样东西想一直摆在眼前。

**第一样是本轮 / 累计 tokens。** 花销本来不是秘密：OpenAI 兼容接口在流式请求末尾会回传 `usage`，只要带上 `stream_options: { include_usage: true }`。可从 Day 1 开始我们就没问过接口要这个数字，每轮花了多少、累计多少，全靠直觉。

**第二样是上下文占用。** Day 5 会趁 history 超长时自动压缩，但那更像「失火才救」。如果占用比例一直摆在眼皮底下，快到窗口边缘就能主动 `/compact`，而不是等模型下一次请求悄悄变慢、甚至直接失败。

两样都需要数据**常驻**在视野里，日志流没有这个位置——它只会往下滚。所以要让出整块屏幕、换一张桌。这张桌还有一个更长远的理由：往后 todos、用量、记忆这类「展示型」能力都需要一块固定的屏幕区域，先把这块地方搭好，之后每天的增量就只是「往面板上添一行」。

## 1. 目标：一块桌 + 一块面板

验收标准：

- 进入临时全屏双栏界面：左侧滚动消息流，右侧常驻面板；退出后恢复原来的终端内容
- 配色完全沿用前六天的四色约定（用户青 / 模型绿 / 工具黄 / 系统灰），流式回复与工具调用、历史压缩的进度行全部进主区
- 面板持续显示：模型、会话、上下文占用（估算 / 窗口 + 百分比）、本轮 tokens、累计 tokens
- 输入框由 TUI 接管：打字 / 退格 / ←→ 移动、回车提交、Ctrl+C / Ctrl+D 退出；工具执行的 `[y/N]` 确认也落进输入行
- 会话命令（`/new` `/sessions` `/open` `/save` `/load` `/reset` `/compact`）与退出自动保存全部保留、行为不变
- 输入或输出被管道 / 重定向时给出提示并退出，不向日志混入控制终端的特殊字符
- 当天代码行数：8 个源文件共 1115 行（Day 6 为 7 个源文件 820 行，**净增 295 行**）。新增 `tui.ts`（216 行）；`index.ts` 从 151 涨到 203 行（面板接线），`chat.ts` 增加 27 行（用量回调）

## 2. 设计：这一次，讲台交给库

### 2.1 为什么给项目引了第一个 UI 依赖

这是项目第一次引一个「界面」库。TUI 是 Terminal User Interface 的缩写，也就是直接画在终端里的界面。前六天能靠 Node.js 解决的都没有额外引库，这次破例，是因为自己画一个可用的终端界面绕不开三件事：

- **中英文宽度**。英文字母通常占 1 格，汉字和全角符号占 2 格。宽度算错后，面板边界和输入光标都会错位。
- **输入与刷新互不打架**。模型每吐出一小段文字，界面就要更新一次；与此同时，我们可能还在输入框里打字、移动光标。两边都直接写终端，很容易互相覆盖。
- **进入和退出全屏界面**。启动时暂时接管终端，退出时还要把用户原来的终端内容、光标和输入状态恢复回来。不同终端、窗口大小变化和重定向都会影响这件事。

这三件事都不是 Agent 的核心能力，只是把输出摆好的基础设施。这里选择 PI 项目拆出的 `@earendil-works/pi-tui`：`TuiAltScreen` 负责进入和退出临时全屏界面，并且只重画发生变化的内容；`ScrollView` 负责滚动消息；`Input` 负责中文输入、光标和编辑键；`HStack` / `VStack` 负责把区域横着、竖着排开。我们只写「每块显示什么、Agent 的事件送到哪里」。

代价也如实讲：从此多了一个依赖，而且 pi-tui 不只是布局工具，还内置 Markdown 等这一天用不到的组件。我们换来的是完整的 TypeScript 类型、与项目直接兼容的模块格式，以及持续维护的终端处理。它只被 `tui.ts` 使用，不会渗进对话、工具和会话代码。

### 2.2 pi-tui 接走后，我们只做三件事

布局、路由、数据。`tui.ts` 里 `TUI` 类管三块：

- **布局**：`HStack` 把消息流和 28 列面板左右排开，`VStack` 再把输入行放到底部；终端不足 60 列时自动隐藏面板，保证输入和正文仍可用。
- **路由**：`Input` 接住文字、退格、方向键和粘贴；`[y/N]` 确认只切换提示符，回车把答案通过 promise 交还给等待中的工具调用。
- **数据**：主区仍只存 `{ text, color }`。更新时交给 `Text` 换行、`ScrollView` 跟随底部；pi-tui 能分清颜色代码和真正显示的文字，也知道一个汉字通常占两格。

### 2.3 token 从哪来：接口真值 + 字符估算

面板上两类数字，来源不同：

- **本轮 / 累计 tokens**：以接口回传的 `usage` 为准。流式请求带上 `stream_options: { include_usage: true }`，最后一个 chunk 会带 `usage`；历史压缩的非流式请求同样回传。但「正在流」的那几秒钟拿不到真实值，面板要即时跳动，就先用 `estimateTokens` 按字符估算顶着，真实值一到立即覆盖。
- **上下文占用**：`estimateTokens(JSON.stringify(history)) / CONTEXT_WINDOW`。history 被压缩变薄时分子会回落——面板因此能直观看到 Day 5 的「压缩」在干什么，这是字符估算派上的最大用场。

`estimateTokens` 只有一行：中文 1 字≈1 token、英文约 4 字符≈1 token，混合取 2 字符 1 token。够面板参考，真金白银的数字永远看接口。

## 3. 实现：先效果，后实现

### 3.0 终端效果

第一帧是刚启动的样子：主区两行提示语，面板上下文 `1% used`、本轮 / 累计 0（空 history 的 JSON `[]` 按 2 字符估出 1 token，所以是 1 / 64000；占比向上取整）：

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px;display:grid;grid-template-columns:minmax(0,1fr) 15rem">
<span style="color:#808080"> GeekAgent Day 7 —— 轻量 TUI + 用量显示</span><span style="color:#808080">│ 模型  deepseek-v4-flash</span>
<span style="color:#808080"> 输入 /help 查看命令；右侧面板实时显示用量。</span><span style="color:#808080">│ 会话  default</span>
<span style="color:#808080"></span><span style="color:#808080">│ ──── 上下文 ────</span>
<span style="color:#808080"></span><span style="color:#808080">│ 1 / 64000 tokens</span>
<span style="color:#808080"></span><span style="color:#808080">│ 1% used</span>
<span style="color:#808080"></span><span style="color:#808080">│ ──── 本轮 ────</span>
<span style="color:#808080"></span><span style="color:#808080">│ 0 tokens</span>
<span style="color:#808080"></span><span style="color:#808080">│ ──── 累计 ────</span>
<span style="color:#808080"></span><span style="color:#808080">│ 0 tokens</span>
<span style="grid-column:1/-1;border-top:1px solid #808080;height:0"></span>
<span style="color:#00cdcd">You › </span><span style="color:#808080"></span>
</pre>

问一句「现在几点了？」，模型调 `get_current_time` 工具拿时间再回答后，主区多了一整套对话（问题青色、工具进度黄色、回答绿色），面板同步刷新——本轮 / 累计 2329 tokens、上下文 188 / 64000：

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px;display:grid;grid-template-columns:minmax(0,1fr) 15rem">
<span style="color:#808080"> GeekAgent Day 7 —— 轻量 TUI + 用量显示</span><span style="color:#808080">│ 模型  deepseek-v4-flash</span>
<span style="color:#808080"> 输入 /help 查看命令；右侧面板实时显示用量。</span><span style="color:#808080">│ 会话  default</span>
<span style="color:#00cdcd"> You › 现在几点了？</span><span style="color:#808080">│ ──── 上下文 ────</span>
<span style="color:#808080"></span><span style="color:#808080">│ 188 / 64000 tokens</span>
<span style="color:#808080"></span><span style="color:#808080">│ 1% used</span>
<span style="color:#cdcd00"> [调用工具 get_current_time → 2026/8/29 20:01:53]</span><span style="color:#808080">│ ──── 本轮 ────</span>
<span style="color:#00cd00"> 现在是 **2026年8月29日 20:01:53**</span><span style="color:#808080">│ 2329 tokens</span>
<span style="color:#00cd00"> （Asia/Shanghai 本地时间）。</span><span style="color:#808080">│ ──── 累计 ────</span>
<span style="color:#808080"></span><span style="color:#808080">│ 2329 tokens</span>
<span style="grid-column:1/-1;border-top:1px solid #808080;height:0"></span>
<span style="color:#00cdcd">You › </span><span style="color:#808080"></span>
</pre>

两帧只是两个时刻的快照，面板是**常驻**的：每流出一个字符、每执行一次工具调用，右侧就在刷新。上下文 token 数和占比随对话变长而增长、`/compact` 后回落——一眼看清「压缩腾出了多少」（验证一节有步骤）。

数字从哪来：上面这轮真实试跑的接口 `usage` 是两次请求之和（工具轮 1058、回答轮 1271＝2329）；history 序列化约 376 字符按估算折 188 token。换成真实模型数字自然不同，但「接口给的 + 字符估的」这套机制不变。注意模型回答里的 `**…**` 是它原样输出的 markdown，我们没做渲染（见没做一节）。

### 3.1 tui.ts：216 行的布局引擎

pi-tui 这一版要求 Node.js 22.19 或更高。仓库把版本精确锁住，后面即使组件 API 变化，这一天的代码仍能复现：

```bash
npm install --save-exact @earendil-works/pi-tui@0.84.4
```

当天新增的源文件只有这一个，完整代码：

```ts
// day7/tui.ts
import {
    HStack,
    Input,
    Key,
    matchesKey,
    ProcessTerminal,
    ScrollView,
    sliceByColumn,
    Text,
    TuiAltScreen,
    truncateToWidth,
    visibleWidth,
    VStack,
    type Component,
    type Focusable,
} from '@earendil-works/pi-tui';
import { paint } from './color.js';

export type Color = 'user' | 'model' | 'tool' | 'sys';

/** 简易 token 估算：中文 1 字约 1 token、英文约 4 字符 1 token，混合取 2 字符 1 token。 */
export function estimateTokens(text: string): number {
    return Math.ceil([...text].length / 2);
}

interface Line {
    text: string;
    color: Color;
}

const PANEL_WIDTH = 28;
const MAX_LINES = 1000;

/** 固定宽度的右侧信息栏；窄终端下由 HStack 自动隐藏。 */
class Panel implements Component {
    constructor(private getLines: () => string[]) {}

    render(width: number): string[] {
        return this.getLines().map((line) => paint('sys', `│ ${truncateToWidth(line, Math.max(1, width - 2))}`));
    }

    invalidate(): void {}
}

/** 输入区把提示符和 pi-tui 的单行 Input 拼在一起，并把焦点传给 Input 以支持中文输入法。 */
class InputRow implements Component, Focusable {
    private input = new Input();
    private prompt: Color = 'user';
    private promptText = 'You › ';

    constructor(onSubmit: (value: string) => void) {
        this.input.onSubmit = onSubmit;
    }

    get focused(): boolean {
        return this.input.focused;
    }

    set focused(value: boolean) {
        this.input.focused = value;
    }

    setPrompt(color: Color, text: string): void {
        this.prompt = color;
        this.promptText = text;
    }

    takeValue(): string {
        const value = this.input.getValue().trim();
        this.input.setValue('');
        return value;
    }

    clear(): void {
        this.input.setValue('');
    }

    handleInput(data: string): void {
        this.input.handleInput(data);
    }

    render(width: number): string[] {
        const prompt = paint(this.prompt, this.promptText);
        const inputWidth = Math.max(1, width - visibleWidth(prompt));
        // Input 自带 "> "，这里切掉后换成项目沿用的提示符。
        const value = sliceByColumn(this.input.render(inputWidth + 2)[0] ?? '', 2, inputWidth, true);
        return [paint('sys', '─'.repeat(width)), `${prompt}${value}`];
    }

    invalidate(): void {
        this.input.invalidate();
    }
}

/**
 * 轻量 TUI：左侧滚动消息流，右侧常驻面板，底部单行输入。
 * 全屏切换、局部刷新、中文宽度、输入编辑与窗口大小变化交给 pi-tui。
 */
export class TUI {
    private terminal = new ProcessTerminal();
    private screen = new TuiAltScreen(this.terminal, true, undefined, { mouse: true });
    private log = new Text('', 1, 0);
    private input: InputRow;
    private lines: Line[] = [];
    private panelLines: string[] = [];
    private busy = false;
    private exiting = false;
    private confirmQuestion: string | null = null;
    private confirmResolve: ((ok: boolean) => void) | null = null;

    constructor(
        private onLine: (line: string) => void,
        private onExit: () => void,
    ) {
        this.input = new InputRow(() => this.submit());
        const body = new HStack([
            {
                component: new ScrollView(this.log, { follow: 'end', primary: true, scrollbar: 'auto' }),
                basis: 0,
                grow: 1,
                minSize: 20,
            },
            {
                component: new Panel(() => this.panelLines),
                basis: PANEL_WIDTH,
                shrink: 0,
                visible: ({ width }) => width >= 60,
            },
        ], { gap: 1 });
        this.screen.setLayoutRoot(new VStack([
            { component: body, basis: 0, grow: 1, minSize: 1 },
            { component: this.input, basis: 2, shrink: 0 },
        ]));
        this.screen.addInputListener((data) => {
            if (matchesKey(data, Key.ctrl('c')) || matchesKey(data, Key.ctrl('d'))) {
                void this.onExit();
                return { consume: true };
            }
        });
    }

    start(): void {
        this.screen.start();
        this.screen.setFocus(this.input);
    }

    stop(): void {
        if (this.exiting) return;
        this.exiting = true;
        this.screen.stop({ preserveScreen: true });
    }

    append(text: string, color: Color): void {
        for (const line of text.replace(/\r\n/g, '\n').split('\n')) this.lines.push({ text: line, color });
        if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
        this.render();
    }

    appendInline(text: string, color: Color): void {
        const last = this.lines[this.lines.length - 1];
        if (last && last.color === color) last.text += text;
        else this.lines.push({ text, color });
        this.render();
    }

    setPanel(lines: string[]): void {
        this.panelLines = lines;
        this.screen.requestRender();
    }

    setBusy(busy: boolean): void {
        this.busy = busy;
    }

    ready(): void {
        if (!this.busy && this.confirmQuestion === null) this.screen.setFocus(this.input);
    }

    confirm(prompt: string): Promise<boolean> {
        const parts = prompt.replace(/\r\n/g, '\n').split('\n').map((s) => s.trimEnd()).filter(Boolean);
        const question = parts.pop() ?? '确认';
        for (const part of parts) this.append(part, 'tool');
        this.append(question, 'tool');
        this.confirmQuestion = question;
        this.input.setPrompt('tool', '[y/N] ');
        this.input.clear();
        this.screen.setFocus(this.input);
        this.screen.requestRender();
        return new Promise((resolve) => {
            this.confirmResolve = resolve;
        });
    }

    private submit(): void {
        const line = this.input.takeValue();
        if (this.confirmQuestion !== null) {
            const ok = line.toLowerCase() === 'y';
            const question = this.confirmQuestion;
            const resolve = this.confirmResolve;
            this.confirmQuestion = null;
            this.confirmResolve = null;
            this.input.setPrompt('user', 'You › ');
            const last = this.lines[this.lines.length - 1];
            if (last?.color === 'tool' && last.text === question) {
                last.text += ` → ${ok ? 'y' : 'n'}`;
                this.render();
            } else {
                this.append(`${question} → ${ok ? 'y' : 'n'}`, 'tool');
            }
            resolve?.(ok);
            return;
        }
        if (!line || this.busy) return;
        this.append(`You › ${line}`, 'user');
        this.onLine(line);
    }

    private render(): void {
        this.log.setText(this.lines.map((line) => paint(line.color, line.text)).join('\n'));
        this.screen.requestRender();
    }
}
```

拆开讲四块：

- **布局**。`VStack` 把屏幕纵向分成「正文 + 两行输入」，正文里的 `HStack` 再横向分成「可增长的消息区 + 固定 28 列的面板」。`visible` 每帧都能读到终端宽度，小于 60 列时不画面板，正文不会被挤成几列。
- **存与画**。`append` 把文本按 `\n` 拆开推入 `lines`，`setPanel` 只替换面板数据；`render()` 用项目原有的 `paint` 包颜色，再交给 `Text` 换行。`ScrollView` 的 `follow: 'end'` 让流式输出始终跟到底部，`requestRender()` 只安排下一次界面更新，不需要我们自己拼控制终端的特殊字符。
- **流式续写 `appendInline`**。模型流是「一次吐一两个词」的增量，若每个增量都 `append` 成新行，回答会碎成一行两三个字。它把增量接到上一行同色文本末尾，回答因此连成自然段；遇到用户 / 工具 / 系统换色时另起新行，天然分段。
- **输入与确认**。`InputRow` 把焦点继续传给内层 `Input`，中文输入法的候选窗因此能跟着真实光标。工具要 `[y/N]` 时，`confirm()` 用 `[y/N] ` 顶替 `You › `；回车把答案通过 promise 交还，并把「问题 → 回答」记成一行黄色日志。

### 3.2 chat.ts：把用量报出去

`Chat` 原本闷头干活，从不过问花销。今天加一根回调线：`usage` 一到账，就归一成 `{ prompt, completion, total }` 报给外头累计。增量共 27 行，分四处：

1. 新增 `UsageInfo` 接口与 `onUsage` 回调：

```ts
// day7/chat.ts
/** 单次请求的用量信息（同 OpenAI 的 usage 字段）。 */
export interface UsageInfo {
    prompt: number;
    completion: number;
    total: number;
}

…

  /** Day 7：每次请求拿到用量就回调出去，供 TUI 面板累计显示。 */
  private onUsage?: (u: UsageInfo) => void;
  …
  setUsageListener(fn: (u: UsageInfo) => void): void {
    this.onUsage = fn;
  }
```

2. 流式请求带上 `stream_options: { include_usage: true }`，并在 chunk 循环里认出结尾那一个（只有它带 usage）：

```ts
// day7/chat.ts
          stream: true,
          stream_options: { include_usage: true }, // Day 7：请求末尾的 chunk 里带上本次用量
        });

…

          if (chunk.usage) this.reportUsage(chunk.usage); // 只有最后一个 chunk 才带 usage
```

3. 历史压缩的非流式请求同样回传 usage，顺手报一次：

```ts
// day7/chat.ts
      ],
    });
    this.reportUsage(res.usage);
    const text = res.choices[0]?.message?.content?.trim();
```

4. `reportUsage` 把接口的 `prompt_tokens / completion_tokens / total_tokens` 归一成 `UsageInfo`，统一走回调：

```ts
// day7/chat.ts
  /** 把接口返回的 usage 归一化成 UsageInfo，回调给外部累计。 */
  private reportUsage(usage: OpenAI.CompletionUsage | null | undefined): void {
    if (!usage) return;
    this.onUsage?.({
      prompt: usage.prompt_tokens,
      completion: usage.completion_tokens,
      total: usage.total_tokens,
    });
  }
```

对 Agent 主干零侵入：`streamReply` 的工具调用循环、历史压缩、出错回滚一行没碰，只是每个请求多带回一个数字。

### 3.3 index.ts：把六天的一切接上这张桌

CLI 层从「逐个 `out(...)` 打印」换成「往 TUI 里塞行」，会话逻辑一行没动。先接线：

```ts
// day7/index.ts
/** 用量状态：live 是流式进行中按字符估算的增量；正式总数以接口 usage 为准。 */
const usage = { cum: 0, round: 0, live: 0 };
/** 忙碌期间 TUI 不接受新输入，这里再兜一层防止异步入队重入。 */
let busy = false;

const tui = new TUI(onLine, onExit);
// 把工具层的执行确认接到 TUI：默认实现是「一律拒绝」，这里换成输入行上的 [y/N]
setConfirmFn((prompt) => tui.confirm(prompt));
chat.setUsageListener((u) => {
    usage.live = 0; // 真实用量到了，清掉流式估算，避免短暂重复计数
    usage.cum += u.total;
    usage.round += u.total;
    updatePanel();
});
```

`usage` 是面板的数据源：`cum` 累计所有请求的 `total`，`round` 记当前回合，`live` 是流式进行中的估算。`setConfirmFn` 把工具层默认的「一律拒绝」换成 TUI 的 `[y/N]`——确认的行画法由 `tui.confirm` 接管，Day 3/4 的工具代码毫无知觉。

再定义面板长什么样，并暴露唯一的刷新口 `updatePanel`：

```ts
// day7/index.ts
/** 右侧面板：模型、会话、上下文占用与本轮 / 累计 tokens。 */
function buildPanel(): string[] {
    const window = CONTEXT_WINDOW;
    const ctx = estimateTokens(JSON.stringify(chat.exportHistory()));
    return [
        `模型  ${config.model}`,
        `会话  ${sessions.currentId()}`,
        '──── 上下文 ────',
        `${ctx} / ${window} tokens`,
        `${Math.ceil((ctx / window) * 100)}% used`,
        '──── 本轮 ────',
        `${usage.round + usage.live} tokens`,
        '──── 累计 ────',
        `${usage.cum} tokens`,
    ];
}

function updatePanel(): void {
    tui.setPanel(buildPanel());
}
```

面板五段式：模型、会话、上下文 token 数 + 占比、本轮（`round + live`）、累计。`ctx` 就是上文说的「上下文占用的分子」。占比向上取整，刚产生少量上下文时也会显示 `1% used`。

流式转发进主区：进度行（`[调用工具…]` / `[历史压缩…]`）上黄色，回复正文绿色用 `appendInline` 连成一段，边转发边按字符估算 `live`：

```ts
// day7/index.ts
async function reply(line: string): Promise<void> {
    usage.round = 0;
    try {
        tui.append('', 'sys'); // 回复前空一行，把上一段对话隔开
        for await (const delta of chat.streamReply(line)) {
            // 进度行（工具调用 / 历史压缩）用黄色；流式期间按字符估算本轮增量
            if (delta.startsWith('\n[调用工具') || delta.startsWith('\n[历史压缩')) {
                usage.live = 0;
                tui.append(delta, 'tool');
            } else {
                tui.appendInline(delta, 'model');
                usage.live = estimateTokens(delta);
            }
            updatePanel();
        }
        usage.live = 0;
        tui.append('', 'sys');
    } catch (e) {
        tui.append(`请求失败：${(e as Error).message}`, 'sys');
    }
    updatePanel();
}
```

`onLine` 把 Day 6 的输入循环搬进新界面：`busy` 防止上一轮没结束又提交下一轮，随后区分命令和普通对话。`/exit`、Ctrl+C、Ctrl+D 都先自动保存，再退出临时全屏界面，最后回到原来的终端打印结果：

```ts
// day7/index.ts
async function onLine(line: string): Promise<void> {
    if (busy) return; // TUI 已挡一道，这里再兜一次防止重入
    busy = true;
    tui.setBusy(true);
    if (line.startsWith('/')) {
        await handleCommand(line);
    } else {
        await reply(line);
    }
    busy = false;
    tui.setBusy(false);
    tui.ready(); // 恢复到输入状态，读下一行
}

async function onExit(): Promise<void> {
    tui.stop(); // 恢复原来的终端内容后再用 console 打印
    try {
        const { count, file } = await saveAll();
        console.log(`（退出前已保存 ${count} 个会话到 ${file}）`);
    } catch (e) {
        console.error(`退出前保存失败：${(e as Error).message}`);
    }
    console.log('bye');
    process.exit(0);
}
```

会话命令的 `switch` 只是把原先的 `out('sys', …)` 换成 `tui.append(…, 'sys')`，其余不动，不再贴。启动时先让界面接管终端，再补两行提示语、刷一次面板：

```ts
// day7/index.ts
tui.start();
updatePanel();
tui.append('GeekAgent Day 7 —— 轻量 TUI + 用量显示', 'sys');
tui.append('输入 /help 查看命令；右侧面板实时显示用量。', 'sys');
```

## 4. 验证

```bash
npm run typecheck
```

```bash
npm run dev -- day7/index.ts
```

在真实终端（建议至少 80 列）里逐条走：

1. 启动即进入双栏界面：左侧两行提示语、右侧面板显示模型与 `会话 default`、上下文 `1% used`、本轮 / 累计 0。
2. 输入 `现在几点了？`：主区黄色打印 `[调用工具 get_current_time → …]`，随后绿色回答；面板本轮 / 累计开始跳动（流式期间按估算、结束后以接口 `usage` 为准），工具能拿到的当前时间与面板数字一一对应。
3. 输入 `/help`、`/new work`、`/sessions`：面板 `会话` 一栏跟着切到 `work`，列表照常进主区。
4. 让模型执行一条 `run_shell`：确认帧落到输入行（`[y/N] ` 顶替 `You › `），此时输入 `n` 回车，主区记一行「… → n」，命令不执行；模型读回「已取消」并自行处理。
5. 再聊几轮让 history 变长，输入 `/compact`：上下文 token 数和 `used` 百分比回落——面板能直观看到「压缩腾出了多少」。
6. 输入 `/exit`（或 Ctrl+C / Ctrl+D）：先看到退出提醒与 `bye`，回到主屏——改造前的终端内容原样还在。
7. 重定向兜底：`npm run dev -- day7/index.ts < /dev/null` 应给出「需要真实终端」提示并退出，不输出控制终端的特殊字符。

## 5. Day 7 明确没做

- **管道 / 重定向降级**：这两种情况下程序直接退出，没有退回 Day 6 的纯文本模式。
- **历史浏览**：输入框还不能用 ↑ 找回上一条输入，主区也只保留最近 1000 行。
- **markdown 渲染**：模型输出仍原样带 `**` / 反引号，渲染留给体验阶段。

## 6. 下一步

桌面搭好了，接下来该给「敢动手」兜底。聊得越深、工具越多，「确认」这条线越需要精细管理：哪些工具免确认、哪些必须问、哪些直接不许，应该由**配置声明**而不是写死在代码里；同时文件工具还指哪儿写哪儿，需要圈一个允许访问的根目录。下一站，把权限模型与目录隔离落进第一份配置文件。
