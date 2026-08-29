# Day 4：把读写都从 shell 里拆出来——文件工具与注册表

> Day 3 只给了模型一扇门：`run_shell`。读文件要被反复过问，改代码只能用 `echo >` / `sed`，改了什么看不见、确认是对整条命令拍板。Day 4 一次把这两端都拆出来：**读**走免确认的专用工具（`ls` / `read` / `glob`），**写**走展示 diff 再落盘的专用通道（`write` / `patch`），顺手把攒下的 7 个工具统一进一个注册表。这一天，模型第一次走通「读 → 改 → 验证」的闭环。

## 0. 为什么同一个 shell，撑不住读写两端

先把自己代入模型的处境：想改代码，第一件事永远是**先弄清楚项目长什么样**。可就算只是 `cat` 一个文件，也得先调 `run_shell`、再等一个 `y/N`。读一个文件确认一次，读十个文件确认十次，光点确认就够累了。

再想深一层：「读」本身毫无破坏力，看文件永远不会让机器变坏。可为了能干活，读和写被绑在了同一个口子上——`run_shell` 什么命令都放行，所以它也**永远不会被设为免确认**。明明无害的操作，却和危险的命令挤在一起，每读一个文件都要被过问一句「可不可以读」，这就是 Day 3 的粗糙之处。

而对面那头更别扭。模型真想改代码，能用的还是 `echo >` / `sed`，这里面有三个解不掉的结：

1. **改了什么，不可预览**。`sed -i 's/foo/bar/' day4/x.ts` 一敲回车，这次改动偏没偏，得写完再 `read` 一遍才知道。它本质上是一次「看不见的破坏」。
2. **确认的粒度太粗**。`y/N` 是对**整条命令**拍板，一条 `sed` 完全能一口气改十个地方，人却只能给一个「同意」。想看清楚模型具体要动哪几行，无从谈起。
3. **改错的代价是静默的**。模型对着几百行的文件拼正则、数行号，一个字符错位文件就悄悄坏了，还没有后悔药（回滚是后续的事）。

于是问题的形状很清楚：一扇 `run_shell` 门上挂着两套互相矛盾的诉求——无害的读整天被过问，危险的写溜着走。Day 4 就把这扇门拆成两条窄道：读，做成**免确认、工具层杜绝写**的只读工具；写，做成**进门之前先展示 diff** 的专用工具。

## 1. 目标：五把文件工具 + 一个注册表

验收标准：

1. 新增 `ls` / `read` / `glob` 三个只读工具，模型能调用且**全程不弹确认**
2. `read` 大文件自动截断，支持 `offset` 分段续读；`glob` 用通配符查文件，自动跳过 `node_modules` 与隐藏路径
3. 新增 `write`（整体写）/ `patch`（局部改）两个写工具，写入前展示 diff 并 `y/N` 确认
4. 工具统一注册到注册表，模型看到的清单与能执行的分发**读同一张表**，外部只通过 `toOpenAITools` / `execTool` 两个出口访问

**当天代码行数**：5 个源文件共 570 行（Day 3 为 359 行，**净增 211 行**），主要增量在 `day4/tools.ts`（142 → 353 行）。

## 2. 设计：一扇门，拆成两条窄道

### 2.1 读：把无害的操作解放出来

「免确认」到底是放松管控还是收紧管控？答案是后者。我们担心的从来不是「模型读文件」，而是「模型顺手跑了一条别的命令」——以前的顾虑都藏在 shell 的 `run` 里。现在把读拆出去，这三个工具的 `run` 从写进代码起就只调 `readdir` / `readFile` / `glob`，**不存在写路径**，确认机制盯住 `run_shell` 一个口就够了。真正需要拍板的命令（shell），目标反而更集中了。

拆出来的第二个理由是**输出结构化**。同样找文件，让模型去跑 `ls -R` 然后从文本里反猜目录，和调 `glob '**/tools.ts'` 直接拿回一份路径清单，是两个世界。`read` 也一样，返回的是带「共 N 字符 / 读到第 a-b 段」元信息的文本段，模型清楚自己读了全文的哪一块、还差哪一块。

`run_shell` 当然还留着——旧能力不删，只是它的描述里多了句「纯查看文件请优先用 ls / read / glob」，引导模型择优。

### 2.2 写：跨过门之前，先看见 diff

读的时候我们想的是「无害的操作不该被反复过问」；写的时候反过来了——**破坏性的操作，光问一句「可不可以」不够，还得让人看清楚「要动什么」**。所以写工具的思路：让模型把「这次改什么」讲成一份看得见的东西——diff，也就是「新旧内容逐行对照」的清单，删了哪些行、加了哪些行一眼可见。先进给用户看一眼，确认后再落盘。

写工具分两把，而不是一把「写文件」：`write` 的参数是 `path` + `content`，语义是「**整体替换**」，适合新建文件或整体重写；`patch` 的参数是 `hunks` 数组，每个 `{ old, new }`，语义是「**局部手术**」，把 `old` 那个片段换成 `new`。之所以分家，是因为确认的对象不同：`write` 展示的是整文件新旧对比，`patch` 是局部替换的钉对钉。拆开后两个工具的描述、参数、确认界面各自朴素，模型也不用为了改一行而传一遍完整文件。

`run_shell` 的 `confirm` 那一行原样保留——两个写工具和 shell 共用同一道确认抽象。

### 2.3 patch 用什么锚点：唯一文本片段，不是行号、不是正则

模型怎么告诉代码「我要改哪里」？三个候选：

- **行号**：`read` 根本没带行号，模型不知道第几行是什么；就算带了，数错行号也是家常便饭。
- **正则**：要转义、要担心贪婪匹配，模型写错的概率高，很难 debug。
- **唯一文本片段**：模型刚 `read` 过文件，直接抄一段原文当锚点（带上足够上下文），最贴合它「读到的样子」。

所以我们选第三个：每个 `old` 必须在文件里恰好出现一次。找不到说明模型记忆里的文件跟磁盘对不上；匹配到多处说明锚点太短，请它补充更多上下文。OpenAI / Claude 那一代编码 Agent 的 patch 工具用的也是同一套思路，我们只实现它的最简版。

### 2.4 diff 预览怎么来：前缀/后缀修剪，不写算法

「写入前展示 diff」听起来要写一个 diff 算法——经典的 LCS 或 Myers 都要几十行，还有不小的内存风险。值得吗？

看看模型真实会做的三种操作：新建、整体重写、局部改一处。对这三种情况，一个**最朴素**的做法就够：把新旧文本都按行切开，砍掉「完全相同的公共前缀」和「完全相同的公共后缀」，剩下的中间部分就是改动——旧行标 `-`，新行标 `+`，前后各留 3 行上下文。代价是：如果模型一次在多个相距很远的点做修改，修剪会把中间那段原样内容也当成「改动」拉进来，出现成对的 `-原样行` `+原样行`，可读性下降，但信息不失真。为一个少见的边缘场景上整套算法，不符合「宁缺毋滥」。另外加了 100 行展示上限，防止整个大文件被覆盖时屏幕被刷爆。

### 2.5 工具攒到 7 个，收进一个注册表

工具从 Day 2 的 1 个长到今天的 7 个，`TOOLS` 还是一个平铺的公共数组。两个问题浮现了：

1. **「加工具」不是一个动作**：往后大家顺手改数组，哪天手滑重名了，静默覆盖旧工具，模型看到的、执行到的不一致。
2. **入口太多**：`TOOLS` 数组被到处引用，绕过 `toOpenAITools` / `execTool` 两个出口，清单和分发容易对不上。

于是把数组收进一个私有注册表：新增工具必须走 `registerTool(tool)`，重名直接抛错；`toOpenAITools` 和 `execTool` 读的是同一张表。外部从此只认这两个口子，谁都不再直接摸数组。

## 3. 实现：先效果，后实现

### 3.0 只读工具的终端效果

这是运行后终端里真实会看到的样子——三个只读工具全程不弹一次确认：

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#00cdcd">You › 用 ls 看当前目录，再用 glob 找 "day4/*.ts"，再读 day4/index.ts 的前面部分</span>
<span style="color:#00cd00">我先依次完成这三步：列目录 → glob 抓文件 → 读文件内容。</span>
<span style="color:#cdcd00">[调用工具 ls → 共 20 项：</span>
<span style="color:#cdcd00">.geekagent/</span>
<span style="color:#cdcd00">.git/</span>
<span style="color:#cdcd00">day1/</span>
<span style="color:#cdcd00">day2/</span>
<span style="color:#cdcd00">day3/</span>
<span style="color:#cdcd00">day4/</span>
<span style="color:#cdcd00">day5/</span>
<span style="color:#cdcd00">day6/</span>
<span style="color:#cdcd00">dist/</span>
<span style="color:#cdcd00">doc/</span>
<span style="color:#cdcd00">node_modules/</span>
<span style="color:#cdcd00">scripts/</span>
<span style="color:#cdcd00">.env</span>
<span style="color:#cdcd00">.env.example</span>
<span style="color:#cdcd00">.gitignore</span>
<span style="color:#cdcd00">AGENTS.md</span>
<span style="color:#cdcd00">package-lock.json</span>
<span style="color:#cdcd00">package.json</span>
<span style="color:#cdcd00">README.md</span>
<span style="color:#cdcd00">tsconfig.json]</span>
<span style="color:#cdcd00">[调用工具 glob → 匹配到 5 个：</span>
<span style="color:#cdcd00">day4/chat.ts</span>
<span style="color:#cdcd00">day4/color.ts</span>
<span style="color:#cdcd00">day4/config.ts</span>
<span style="color:#cdcd00">day4/index.ts</span>
<span style="color:#cdcd00">day4/tools.ts]</span>
<span style="color:#cdcd00">[调用工具 read → （文件共 2182 字符，已读第 0-2000 段）</span>
<span style="color:#cdcd00">import { createInterface } from 'node:readline';</span>
<span style="color:#cdcd00">import 'dotenv/config';</span>
<span style="color:#cdcd00">import { loadConfig } from './config.js';</span>
<span style="color:#cdcd00">import { Chat } from './chat.js';</span>
<span style="color:#cdcd00">……</span>
<span style="color:#cdcd00">rl.on('close', () => {</span>
<span style="color:#cdcd00">    out('sys', 'bye'</span>
<span style="color:#cdcd00">……(已截断，续读可用 offset=2000)]</span>
<span style="color:#00cd00">三步都完成了，全程没有弹过一次确认。总结如下：</span>
<span style="color:#00cd00"></span>
<span style="color:#00cd00">1. 当前目录共 20 项，day1~day6 是分日迭代的代码目录，还有 .geekagent/、dist/、doc/、scripts/、node_modules/ 等</span>
<span style="color:#00cd00">2. day4 下有 5 个 .ts 源文件</span>
<span style="color:#00cd00">3. index.ts 共 2182 字符，前 2000 字符已读完，末尾可用 offset=2000 续读</span>
<span style="color:#00cdcd">You › </span>
</pre>

关键效果是全程免确认：三个 `run` 从头到尾只碰 `readdir` / `readFile` / `glob`，没有 `confirm()`、没有写文件的 API——「拒绝写」写在骨子里。

### 3.1 三个只读工具：ls / read / glob

改动全部落在 `day4/tools.ts`。给 `registerTool` 的注册表挂上三个只读工具，完整定义如下：

```ts
// day4/tools.ts
    {
        name: 'ls',
        description: '列出目录下的条目（只读）。默认当前目录，目录元素带 / 后缀，目录在前。',
        parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: '要列出的目录路径，默认当前目录。' } },
            additionalProperties: false,
        },
        run: async (args) => {
            const dir = String(args.path ?? '.').trim() || '.';
            try {
                const entries = await readdir(dir, { withFileTypes: true });
                if (entries.length === 0) return '(空目录)';
                const lines = entries
                    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
                    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
                return `共 ${lines.length} 项：\n${lines.join('\n')}`;
            } catch (err) {
                return `打开目录失败：${(err as NodeJS.ErrnoException).message}`;
            }
        },
    },
```

```ts
// day4/tools.ts
    {
        name: 'read',
        description: '读取文本文件内容（只读）。文件过大时自动截断，可用 offset 从指定字符偏移处分段续读。',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '要读取的文件路径。' },
                offset: { type: 'number', description: '从第 offset 个字符开始读，默认 0；用于分段读大文件。' },
            },
            required: ['path'],
            additionalProperties: false,
        },
        run: async (args) => {
            const file = String(args.path ?? '').trim();
            if (!file) return '缺少参数 path';
            const offset = Math.max(0, Number(args.offset) || 0);
            try {
                const text = await readFile(file, 'utf8');
                if (offset >= text.length) return 'offset 已越过文件末尾';
                const slice = text.slice(offset, offset + MAX_OUTPUT_CHARS);
                const truncated = offset + slice.length < text.length;
                const meta = `（文件共 ${text.length} 字符，已读第 ${offset}-${offset + slice.length} 段）\n`;
                const hint = truncated ? `\n...(已截断，续读可用 offset=${offset + slice.length})` : '';
                return meta + slice + hint;
            } catch (err) {
                return `读取文件失败：${(err as NodeJS.ErrnoException).message}`;
            }
        },
    },
```

```ts
// day4/tools.ts
    {
        name: 'glob',
        description: '按通配符查找文件路径（只读，不含内容）。* 匹配单层内任意串、? 匹配单个字符、** 匹配任意多层目录；默认从当前目录查找，跳过 node_modules 与隐藏路径。',
        parameters: {
            type: 'object',
            properties: { pattern: { type: 'string', description: 'glob 模式，如 "day4/*.ts" 或 "**/tools.ts"。' } },
            required: ['pattern'],
            additionalProperties: false,
        },
        run: async (args) => {
            const pattern = String(args.pattern ?? '').trim();
            if (!pattern) return '缺少参数 pattern';
            try {
                const files: string[] = [];
                for await (const p of glob(pattern, {
                    cwd: process.cwd(),
                    exclude: (dir) => dir.includes('node_modules'),
                })) {
                    files.push(p.replaceAll('\\', '/'));
                    if (files.length >= MAX_GLOB_RESULTS) break;
                }
                if (files.length === 0) return '(没有匹配到任何文件)';
                const list = files.join('\n');
                const hint = files.length >= MAX_GLOB_RESULTS ? `\n...(已达上限 ${MAX_GLOB_RESULTS} 条，可换更精确的 pattern)` : '';
                return `匹配到 ${files.length} 个：\n${list}${hint}`;
            } catch (err) {
                return `glob 失败：${(err as Error).message}`;
            }
        },
    },
```

配套的常量与 import 也很小，在文件头部追加：

```ts
// day4/tools.ts
import { readdir, readFile, glob, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
```

```ts
// day4/tools.ts
/** glob 最多返回的条数，防止一次性撑爆上下文。 */
const MAX_GLOB_RESULTS = 200;
```

要点：

- **免确认怎么来的**：三个 `run` 只碰 `readdir` / `readFile` / `glob`，没有任何写路径，也就没有可以确认的东西。
- **`read` 的截断语义**：返回头部永远带元信息 `（文件共 N 字符，已读第 a-b 段）`，让模型一眼知道「我看的是全文的哪一块」；读完被截断时，尾部的 hint 直接告诉它下一次的 `offset` 该填多少——这就是模型组织多轮分段读的接力棒。
- **`glob` 的 `**`**：`**/tools.ts` 一次拿到 `day2`～`day6` 几份同名文件，比 `ls` 递归再脑补可靠得多。`exclude` 把 `node_modules` 挡在门外；隐藏路径（如 `.git`）由 Node glob 默认的 `dot: false` 排除。用的是 Node 内置 `fs/promises` 的 glob，零依赖。

### 3.2 引导模型优先使用只读工具

只读工具上线后，还要在工具描述和帮助信息里告诉模型与用户怎样使用：

1. `run_shell` 的描述末尾追加一句引导，让模型「纯查看文件」时优先走只读工具：

```ts
// day4/tools.ts
        description: '在本地执行一条 shell 命令（bash -c），返回合并后的标准输出/错误。执行前会向用户确认。纯查看文件请优先用 ls / read / glob（只读、免确认）。',
```

2. `index.ts` 的 `/help` 文案补上只读工具清单：

```ts
// day4/index.ts
已接入工具：get_current_time（当前时间）、run_shell（执行 shell 命令，执行前需确认）、ls（列目录）、read（读文件）、glob（通配符查文件）——三者只读、免确认，模型需要时会自动调用。
```

### 3.3 写工具的终端效果

下面是带着两把写工具跑出来的真实终端输出（diff 预览在确认之前亮出来，输入 `y` 后模型才真正落盘）：

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#00cdcd">You › 新建 demo.txt，内容三行：line1 hello、line2 world、line3 end，再把第二行改成 line2 CHANGED。</span>
<span style="color:#cdcd00">+line1 hello</span>
<span style="color:#cdcd00">+line2 world</span>
<span style="color:#cdcd00">+line3 end</span>
<span style="color:#cdcd00">确认写入 demo.txt？[y/N] y</span>
<span style="color:#cdcd00">[调用工具 write → 已写入 demo.txt]</span>
<span style="color:#cdcd00"> line1 hello</span>
<span style="color:#cdcd00">-line2 world</span>
<span style="color:#cdcd00">+line2 CHANGED</span>
<span style="color:#cdcd00"> line3 end</span>
<span style="color:#cdcd00">确认写入 demo.txt？[y/N] y</span>
<span style="color:#cdcd00">[调用工具 patch → 已应用 1 处修改到 demo.txt]</span>
<span style="color:#00cd00">已完成：</span>
<span style="color:#00cd00">1. write 创建了 demo.txt，内容为三行：</span>
<span style="color:#00cd00">line1 hello / line2 world / line3 end</span>
<span style="color:#00cd00">2. patch 将 line2 world 替换为 line2 CHANGED，1 处修改成功。</span>
<span style="color:#00cd00">最终 demo.txt 内容为：</span>
<span style="color:#00cd00">line1 hello</span>
<span style="color:#00cd00">line2 CHANGED</span>
<span style="color:#00cd00">line3 end</span>
</pre>

几个真实细节值得注意：

- 新建文件时 `write` 的 diff 是全 `+`；第二次 `patch` 的 diff 变成标准 diff 的骨架：上下文行 → `-` 旧行 → `+` 新行 → 尾部上下文（最后那行 ` line3 end`）。
- 模型这次**没先开口**，直接甩出 write 的调用（「先动手后解释」在它这里是常态），连跑两个写操作、我确认两次，最后才停下来总结。工具循环全程没打断它。
- 真实输出里模型总结还带着 `**` 和 `` ``` `` 这些 Markdown 标记——Day 4 还没做渲染，原样打在终端上。为了示例干净，上面把 Markdown 注解展开了。渲染美化是后续的事，今天不碰。

改动全部落在 `day4/tools.ts`（净增 211 行），外加 `index.ts` 几处文案。

### 3.4 工具注册表：7 行，把「加工具」变成显式动作

在 `Tool` 接口下方新增注册表与注册函数，把原来 `export const TOOLS` 的数组贴回成模块内部数组 `BUILTIN_TOOLS`，末尾统一注册：

```ts
// day4/tools.ts
/** 工具注册表。新增工具调用 registerTool 收口，重复名字直接报错。 */
const registry: Tool[] = [];

export function registerTool(tool: Tool): void {
    if (registry.some((t) => t.name === tool.name)) throw new Error(`工具 ${tool.name} 已注册`);
    registry.push(tool);
}
```

```ts
// day4/tools.ts
/** 内置工具数组：逐一注册进注册表，之后模型就能自动调用了。 */
const BUILTIN_TOOLS: Tool[] = [
    // ……Day 2、Day 3 的三个工具原样躺在里面，一个字符都没动
    {
        name: 'ls',
        // ……只读三工具见 3.1
    },
    {
        name: 'write',
        // ……完整 write 工具见 3.5
    },
    {
        name: 'patch',
        // ……完整 patch 工具见 3.6
    },
];

BUILTIN_TOOLS.forEach(registerTool);
```

- **重名保护**是新行为：以前数组里塞进两个同名工具，后一个静默覆盖前一个；现在 `registerTool` 直接抛错，把「清单和分发不一致」挡在注册环节。
- 旧工具**逐字未动**，只是从「公共导出」降级成「模块内部清单」。对外唯一的变化是 `toOpenAITools` / `execTool` 两个出口改读注册表，见 3.8。

### 3.5 `write`：整体写文件，完整代码

```ts
// day4/tools.ts
    {
        name: 'write',
        description: '写入或整体覆盖一个文本文件。展示新旧内容的 diff 并请求确认；自动创建缺失的父目录；适合新建文件或整体重写，小幅修改请优先用 patch。',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '要写入的文件路径。' },
                content: { type: 'string', description: '文件的新完整内容（原内容将被整体替换）。' },
            },
            required: ['path', 'content'],
            additionalProperties: false,
        },
        run: async (args) => {
            const file = String(args.path ?? '').trim();
            if (!file) return '缺少参数 path';
            const wrote = await commitWrite(file, String(args.content ?? ''));
            return wrote ? `已写入 ${file}` : '已取消写入';
        },
    },
```

要点：

- **run 只有四行**：校验参数 → 交给共用的 `commitWrite`（3.7 会讲，它负责「读旧 → 算 diff → 确认 → 写盘」）→ 按是否真写返回结果。确认逻辑不在自己身上。
- 结果文本两种：真写了回 `已写入 ${file}`，用户拒绝回 `已取消写入`。模型能据此决定下一步。

### 3.6 `patch`：局部精确修改，完整代码

`hunks` 是 `old` + `new` 的对象数组，逐条应用。配套的类型与常量先看：

```ts
// day4/tools.ts
/** 写入前 diff 预览最多展示的行数，避免整文件覆盖时刷屏。 */
const MAX_DIFF_LINES = 100;

/** patch 的单个修改片段：把文件中唯一出现的 old 替换为 new。 */
interface PatchHunk {
    old: string;
    new: string;
}
```

完整工具定义：

```ts
// day4/tools.ts
    {
        name: 'patch',
        description: '对已有文本文件做局部修改：hunks 里每个 { old, new } 把文件中唯一出现的 old 片段替换为 new。应用前展示 diff 并请求确认；old 须在文件中唯一匹配，否则该片段失败。',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: '要修改的文件路径。' },
                hunks: {
                    type: 'array',
                    description: '修改片段列表：每个片段把文件中唯一匹配的 old 替换为 new。',
                    items: {
                        type: 'object',
                        properties: {
                            old: { type: 'string', description: '要从文件中替换的原文片段，须唯一匹配（建议带上足够上下文）。' },
                            new: { type: 'string', description: '替换后的新文本。' },
                        },
                        required: ['old', 'new'],
                        additionalProperties: false,
                    },
                },
            },
            required: ['path', 'hunks'],
            additionalProperties: false,
        },
        run: async (args) => {
            const file = String(args.path ?? '').trim();
            if (!file) return '缺少参数 path';
            const hunks = (Array.isArray(args.hunks) ? args.hunks : []) as PatchHunk[];
            if (hunks.length === 0) return 'hunks 为空，未做任何修改';
            let original: string;
            try {
                original = await readFile(file, 'utf8');
            } catch (err) {
                return `读取文件失败：${(err as Error).message}`;
            }
            let patched = original;
            for (const h of hunks) {
                if (!h.old) return 'hunks 中存在空的 old 片段';
                const i = patched.indexOf(h.old);
                if (i < 0) return `未找到匹配片段：${truncate(h.old)}`;
                if (patched.indexOf(h.old, i + 1) >= 0) return `片段匹配到多处，请加长 old 使其唯一：${truncate(h.old)}`;
                patched = patched.slice(0, i) + h.new + patched.slice(i + h.old.length);
            }
            if (patched === original) return '替换后内容与原文件一致，未做任何修改';
            const wrote = await commitWrite(file, patched);
            return wrote ? `已应用 ${hunks.length} 处修改到 ${file}` : '已取消修改';
        },
    },
```

几个实现细节：

- **唯一性检查是两问**：第一问 `indexOf < 0` 判「没找到」，第二问 `indexOf(h.old, i + 1)` 判「还有第二处」。两问都返回明确的错误文本，且用 `truncate` 截断超长片段，避免把一大段原文塞回上下文。这些错误走的是「结果文本」通道，模型自己读、自己改——这正是 2.3 选的锚点策略落地的样子。
- **修改是累积的**：`patched` 先等于原文件，每个 hunk 在上一次替换的基础上继续找、继续换——多个 hunk 覆盖文件中不同位置时，各自都能命中。
- 最后同样交给 `commitWrite`：同样展示 diff、确认、落盘——「局部手术」和「整体重写」共用同一道确认闸门。

### 3.7 两道写工具的公共底座：commitWrite + simpleDiff

`write` 和 `patch` 殊途同归，最后都调用同一个函数。它就干四件事：读旧内容 → 算 diff → 展示 + 确认 → 写盘。完整代码：

```ts
// day4/tools.ts
/** 展示 diff 并确认后写盘；新文件也照常走此流程。内容没变则不打扰用户，直接返回成功。 */
async function commitWrite(file: string, next: string): Promise<boolean> {
    let oldtxt = '';
    try {
        oldtxt = await readFile(file, 'utf8');
    } catch {
        /* 新文件：旧内容视为空 */
    }
    if (oldtxt === next) return true;
    if (!(await confirm(`\n${simpleDiff(oldtxt, next)}\n确认写入 ${file}？`))) return false;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, next);
    return true;
}
```

要点：

- **新文件也走同一流程**：读旧内容失败（文件不存在），就把旧内容当空字符串，diff 自然变成全 `+`——新建和覆盖没有两条逻辑。
- **确认复用 Day 3 的 `confirm`**：`\n{diff}\n确认写入 …` 作为一条 prompt 传进去，`buildCliConfirm` 原样打印并等待 `[y/N]`。这个函数签名没变，后续权限模型要替换它的位置也没变。
- **父目录自动创建**：`mkdir(dirname(file), { recursive: true })`，模型写 `day4/foo/bar.ts` 时不用先建 `day4/foo`。

再看 diff 预览本身——不带算法的算法：

```ts
// day4/tools.ts
/** 按行拆文本：忽略结尾换行带来的空串；空文本返回空数组。 */
const splitLines = (s: string): string[] => (s === '' ? [] : s.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'));

/**
 * 最小 diff：砍掉公共前缀与公共后缀，剩下的就是变更部分，前后各留 3 行上下文。
 * 只覆盖「单处整体修改」这一最常见场景（新建/覆盖/局部小改），够用且零依赖。
 */
function simpleDiff(oldText: string, newText: string): string {
    const a = splitLines(oldText), b = splitLines(newText);
    let p = 0;
    while (p < a.length && p < b.length && a[p] === b[p]) p++;
    let q = 0;
    while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
    const ctx = 3, out: string[] = [];
    for (let i = Math.max(0, p - ctx); i < p; i++) out.push(' ' + a[i]);
    for (let i = p; i < a.length - q; i++) out.push('-' + a[i]);
    for (let i = p; i < b.length - q; i++) out.push('+' + b[i]);
    for (let i = Math.max(0, b.length - q); i < Math.min(b.length, b.length - q + ctx); i++) out.push(' ' + b[i]);
    if (out.length > MAX_DIFF_LINES) {
        out.length = MAX_DIFF_LINES;
        out.push(`...(diff 太长，仅展示前 ${MAX_DIFF_LINES} 行)`);
    }
    return out.join('\n');
}
```

理解它只要三步：

- **`p` 是公共前缀长度，`q` 是公共后缀长度**：两个 `while` 分别从两头推进，把两边完全一样的行跳过。它们之间（`p` 到 `a.length - q`、`p` 到 `b.length - q`）就是真正的改动区。
- **四段输出**：改动前 3 行上下文 → 旧行的 `-` → 新行的 `+` → 改动后 3 行上下文。回看 Demo：`line1 hello` 是前缀、`-line2 world` 是删除、`+line2 CHANGED` 是新增、` line3 end` 是后缀里的上下文，正好四段齐活。
- **`splitLines` 只在做一件事**：把 `a\nb\n` 结尾那个换行产生的空串扔掉，避免多出一行幽灵空行干扰 diff。

### 3.8 两个出口换绑注册表 + index.ts 两行文案

`toOpenAITools` 和 `execTool` 各改一处引用，数组换成注册表，行为不变：

```ts
// day4/tools.ts
// toOpenAITools() 内：
return registry.map((tool) => ({
    // ……类型、名字、描述、参数，原样
}));

// execTool() 内：
const tool = registry.find((t) => t.name === name);
```

启动 banner 和 `/help` 也补上两个写工具，并说明写入前会展示 diff、等待确认。

## 4. 验证

- `npm run typecheck` ✅：`day4/` 全部源文件类型检查通过（`tsc --noEmit`）
- **离线自测**（不需要 API Key，直接驱动工具层；`setConfirmFn` 把确认替换成「打印 diff 预览并自动同意」）：

```bash
# 从仓库根执行：glob 找全部 tools.ts，node_modules 被排除
npx tsx -e "import('./day4/tools.js').then(async m => console.log(await m.execTool('glob', JSON.stringify({ pattern: '**/tools.ts' }))))"
# read 带 offset 分段读：返回第 100-2100 段，头部元信息正确
npx tsx -e "import('./day4/tools.js').then(async m => console.log((await m.execTool('read', JSON.stringify({ path: 'day4/index.ts', offset: 100 }))).split('\n')[0]))"
```

read 那条只打印第一行，应为 `（文件共 2182 字符，已读第 100-2100 段）`。

写工具链路（在临时目录跑，不用碰仓库文件；`setConfirmFn` 把确认替换成「打印 diff 预览并自动同意」）：

```bash
mkdir -p /tmp/d5 && cd /tmp/d5
npx tsx -e "import('/home/daijie/git/geekagent/day4/tools.js').then(async m => {
  m.setConfirmFn(async (p) => { console.log(p); return true; });
  console.log(await m.execTool('write',  JSON.stringify({ path: 'd5.txt', content: 'line1 hello\nline2 world\nline3 end' })));
  console.log(await m.execTool('patch',  JSON.stringify({ path: 'd5.txt', hunks: [{ old: 'line2 world', new: 'line2 CHANGED' }] })));
  console.log(await m.execTool('patch',  JSON.stringify({ path: 'd5.txt', hunks: [{ old: '不存在', new: 'x' }] })));
  console.log(await m.execTool('patch',  JSON.stringify({ path: 'd5.txt', hunks: [{ old: 'line', new: 'x' }] })));
})"
```

预期输出依次是：

- write：先打出全 `+` 的 diff 预览，再返回 `已写入 d5.txt`
- patch：先打出「上下文 / `-` / `+`」四段 diff，再返回 `已应用 1 处修改到 d5.txt`
- 第二个 patch：返回 `未找到匹配片段：不存在`
- 第三个 patch：返回 `片段匹配到多处，请加长 old 使其唯一：line`

- **真实对话**（需要 API Key）：`npm run dev -- day4/index.ts`，先输入第 3.0 节那句「列目录 + glob + 读文件」——三个工具串行自洽、全程免确认；再输入第 3.3 节那句「write + patch」。模型应依次调用，两次都在终端亮出 diff，输入 `y` 后落盘。
- 代码量：5 个源文件共 570 行，净增 211 行（`tools.ts` 142 → 353）。

## 5. Day 4 明确没做

- **权限与目录隔离**：工具只有「只读 / 需确认」两类，而且仍能访问工作区之外的路径。
- **撤销 / 回滚**：写入前没有自动备份，改坏后需要手动恢复。
- **diff 能力**：预览只做前缀 / 后缀修剪，不提供标准 diff 的行号与细粒度差异。
- **文件类型**：读写只处理 UTF-8 文本，不支持二进制文件。

## 6. 下一步

至此阶段 A 收官：Day 1 能聊、Day 2 会下单、Day 3 能动 shell、Day 4 看清楚也改得动手——「读 → 改 → 验证」闭环第一次完整走通，Agent 真正在代码上干起了活。接下来进入阶段 B「上下文与记忆」：聊得越久，`history` 越长，模型淡忘地越早。Day 5 先解决最眼前的问题——**历史压缩**，用摘要把旧对话变薄，腾出上下文给更重要的事。
