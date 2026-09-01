---
title: 从零实现 GeekAgent —— Day12 代码搜索与网页抓取
description: >-
  7天从零实现Agent教程，用 TypeScript 动手写一个最简单的 Agent/Harness。Day 12 新增 `search` 和 `fetch`：一个按内容搜索仓库，一个读取网页并转成纯文本。
date: '2026-08-31 21:30:00'
tags:
  - Agent
  - Harness
book: geekagent
status: done
draft: false
---

# Day 12：向内搜索代码，向外读取网页——代码搜索与 Web 抓取

> Day 11 能按任务切换工具，但模型仍然只能按文件名找文件，也不能直接读取网页。今天新增 `search` 和 `fetch`，分别解决这两个问题。

## 1. 为什么：知道内容，却不知道在哪个文件

`glob` 只能按文件名匹配。如果我们想找 `safePath` 在哪里定义、在哪里调用，就要先猜文件，再逐个 `read`。代码一多，这种方法很慢。

所以需要 `search`：输入一段文字，返回所有命中的 `文件:行号: 内容`。模型先定位，再用 `read` 查看上下文。

另一个缺口在仓库外。依赖文档、技术博客和报错页面都在网页中，模型目前没有直接读取它们的工具。因此还需要 `fetch`：访问网页，把 HTML 转成模型容易阅读的纯文本。

一个工具向内搜索仓库，一个工具向外读取网页。

## 2. 目标

1. `search` 在权限根目录内逐行匹配内容，返回 `相对路径:行号: 原文`；模型可以把命中路径继续交给 `read` 查看上下文；
2. `fetch` 读取 http/https 页面，删除脚本、样式和 HTML 标签，再把正文作为纯文本交给模型；
3. 本地搜索默认直接执行；访问外部网页前显示完整 URL 并询问，确认后才发起请求。

**当天代码行数**：相对 Day 11，源码新增 135 行、删除 5 行，净增 130 行。

## 3. 设计：搜索本地，读取网页

### 3.1 search：为什么不直接调用 ripgrep

按内容搜索代码，常见做法是调用 ripgrep。它速度快、支持正则，也会读取 `.gitignore`。如果要做一个成熟的代码搜索工具，ripgrep 是更合适的选择。

两种方案的差异可以放在一起看：

| | ripgrep | Node `glob` + `readFile` |
|---|---|---|
| 搜索速度 | 快，适合大型仓库 | 较慢，适合小型仓库 |
| 搜索能力 | 正则、文件过滤、`.gitignore` | 忽略大小写的包含匹配 |
| 运行条件 | 系统需要安装 `rg` | 只依赖当前 Node 运行时 |
| 权限接入 | 需要另外约束进程路径 | 直接复用 `safePath` |

因此，这一版选择 Node 自带的 `glob` 枚举文件，再用 `readFile` 逐行匹配。代码更直接，也不增加运行条件。代价是速度和搜索能力都不如 ripgrep。

搜索会跳过 `node_modules`、隐藏目录、大文件和二进制文件，最多返回 50 行。这个实现适合当前的小型仓库。

结果使用 `路径:行号: 内容` 格式。模型拿到路径后，可以继续调用 `read` 查看附近代码。

### 3.2 fetch：为什么不用 HTML 解析库

网页转文本通常会使用 `cheerio` 解析 DOM，或用 `turndown` 转成 Markdown。它们能更准确地保留标题、列表、链接和代码块。

| | `cheerio` | `turndown` | 当前 `htmlToText` |
|---|---|---|---|
| 主要用途 | 查询和清洗 DOM | HTML 转 Markdown | HTML 转纯文本 |
| 保留结构 | 由我们控制 | 标题、列表、链接较完整 | 只保留段落换行 |
| 依赖 | 需要安装 | 需要安装 | 无新增依赖 |
| 适用场景 | 精细抽取网页内容 | 保留文章结构 | 快速让模型读到正文 |

当前目标只是让模型读到文档和博客的正文。Node 已经提供全局 `fetch`，再用一个短小的 `htmlToText` 删除脚本、样式和标签，就能跑通完整流程，也不用增加依赖。

这个取舍会丢失页面结构，复杂网页的清理效果也不如解析库。对于当前 demo，我们先保留正文；更完整的网页解析留到真正需要时再加入。

`fetch` 会访问外部地址，因此默认先显示目标 URL 并询问：

```
即将访问网页：
http://127.0.0.1:8934/note.html
确认抓取？
```

只有 http/https 地址可以访问。HTML 会转成纯文本，其他文本内容直接返回。

### 3.3 沿用工具注册与权限

两个工具都注册到 `BUILTIN_TOOLS`。`search` 通过 `safePath` 使用 Day 8 的目录边界，`fetch` 通过 `authorize` 请求确认。Day 11 的技能也能像筛选其他工具一样筛选它们。

## 4. 实现：先效果，后实现

### 4.1 先看效果

启动后，先让模型自己搜代码——提问是"搜 day12 里 `ensureToolPolicy` 的定义和用法"：

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#808080">GeekAgent Day 12 —— 代码搜索 + Web 抓取</span>
<span style="color:#808080">想看某段代码出现在哪，直接让模型去 search；想读仓库外的文档、博文，让模型 fetch 回来转成文本。检索结果会显示 路径:行号，方便顺着找。</span>
<span style="color:#00cdcd">You › 我忘了昨天技能的 ensureToolPolicy 是干什么的，帮我在 day12 里搜一下定义和用法</span>
<span style="color:#cdcd00">[调用工具 search → 匹配 "ensureToolPolicy" 3 行：</span>
<span style="color:#cdcd00">day12/permissions.ts:72: export function ensureToolPolicy(tool: string, policy: Policy): void {</span>
<span style="color:#cdcd00">day12/skills.ts:6: import { ensureToolPolicy } from './permissions.js';</span>
<span style="color:#cdcd00">day12/skills.ts:103:         ensureToolPolicy(tool.name, 'ask'); // 技能工具默认 ask，用户可自行在配置里改 allow</span>
<span style="color:#cdcd00">]</span>
<span style="color:#00cd00">定义在 day12/permissions.ts:72，作用：给配置表里没写过的工具补一条默认策略。skills.ts 在装载技能时（103 行）给自带工具补 ask，所以昨天 git_diff 第一次调用也会先弹确认，而不是被默认 deny 拦死。需要细节的话我可以用 read 补看这两个文件。</span>
</pre>

`search` 一次返回三处命中。模型可以根据路径和行号继续阅读代码，不必先猜文件名。

再启动一个本地网页，让模型读取：

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#00cdcd">You › 本地起了个页面 http://127.0.0.1:8934/note.html ，抓下来看看写了什么</span>
<span style="color:#cdcd00">即将访问网页：</span>
<span style="color:#cdcd00">http://127.0.0.1:8934/note.html</span>
<span style="color:#cdcd00">确认抓取？[y/N] → y</span>
<span style="color:#cdcd00">[调用工具 fetch → GeekAgent 学习笔记第 12 天</span>
<span style="color:#cdcd00">从零实现 GeekAgent</span>
<span style="color:#cdcd00">今天新增两个工具：search 按内容检索仓库，fetch 把网页转成纯文本。</span>
<span style="color:#cdcd00">search 返回 文件:行号: 内容，跳过 node_modules 和二进制文件</span>
<span style="color:#cdcd00">fetch 用内置 fetch + 正则剥标签，先确认再访问</span>
<span style="color:#cdcd00">下一步方向：工具调用失败后让模型读错误自愈、多个独立工具并行</span>
<span style="color:#cdcd00">]</span>
<span style="color:#00cd00">这是一页 GeekAgent 学习笔记。页面介绍了两个工具：search 按内容搜索仓库，fetch 读取网页并转成纯文本。</span>
</pre>

`fetch` 先询问，确认后返回纯文本。页面中的标题、列表和粗体标签不会出现在结果中。

### 4.2 search 工具：接收关键词

先定义搜索结果、文件大小和网页等待时间的上限：

```ts
// day12/tools.ts
/** search 最多返回的命中行数，命中太多说明关键词不够聚焦。 */
const MAX_SEARCH_RESULTS = 50;
/** search 只扫不超过这个字节数的文本文件，跳过体积可疑的大文件。 */
const MAX_SEARCH_FILE_SIZE = 1024 * 1024;
/** fetch 最长的等待时间，超时按失败处理。 */
const FETCH_TIMEOUT_MS = 15_000;
```

`search` 接收两个参数：`pattern` 是关键词，`path` 是可选的搜索目录。

```ts
// day12/tools.ts
    {
        name: 'search',
        description: '在仓库内按内容检索代码（忽略大小写）。返回 相对路径:行号: 内容，适合找「哪个文件里出现了某段文字/某个调用」。默认跳过 node_modules、隐藏路径、二进制与大于 1MB 的文件。',
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: '要检索的关键词，如 "safePath"、一个函数名或一行报错文案。' },
                path: { type: 'string', description: '要检索的相对目录，默认整个仓库根目录；传子目录可加快速度。' },
            },
            required: ['pattern'],
            additionalProperties: false,
        },
        run: async (args) => {
            const pattern = String(args.pattern ?? '').trim();
            if (!pattern) return '缺少参数 pattern';
            const sub = String(args.path ?? '').trim();
            try {
                const dir = sub ? await safePath(sub) : permissionRoot();
                const hits = await searchTree(dir, pattern.toLowerCase());
                if (hits.length === 0) return `没有匹配 "${pattern}"${sub ? `（在 ${sub} 下）` : ''}`;
                const hint = hits.length >= MAX_SEARCH_RESULTS ? `\n...(已达上限 ${MAX_SEARCH_RESULTS} 行，换更聚焦的关键词再搜)` : '';
                return `匹配 "${pattern}" ${hits.length} 行：\n${hits.join('\n')}${hint}`;
            } catch (err) {
                return `search 失败：${(err as Error).message}`;
            }
        },
    },
```

`run` 先确定搜索目录，再调用 `searchTree`。搜索忽略大小写；达到 50 行时停止，并提示模型换一个更具体的关键词。

### 4.3 searchTree：逐行寻找内容

`searchTree` 用 `glob('**/*')` 枚举文件，跳过 `node_modules` 和隐藏路径，然后读取文本并逐行匹配：

```ts
// day12/tools.ts
/**
 * 在 dir 目录内按内容检索：用 Node 内置 glob 枚举文件（默认跳过隐藏路径与 node_modules），
 * 跳过二进制（含空字节）与过大的文件，逐行做忽略大小写的包含匹配，凑满上限即停。
 * 返回「相对 root 的路径:行号: 内容」列表，格式照搬 ripgrep。
 */
async function searchTree(dir: string, pattern: string): Promise<string[]> {
    const root = permissionRoot();
    const prefix = relative(root, dir);
    const hits: string[] = [];
    for await (const p of glob('**/*', {
        cwd: dir,
        exclude: (d) => d.split('/').some((seg) => seg === 'node_modules' || seg.startsWith('.')),
    })) {
        if (hits.length >= MAX_SEARCH_RESULTS) break;
        const rel = (prefix ? `${prefix.replaceAll('\\', '/')}/` : '') + p.replaceAll('\\', '/');
        const file = join(dir, p);
        let st;
        try {
            st = await stat(file);
        } catch {
            continue; // 文件可能在被遍历时被删除
        }
        if (!st.isFile() || st.size > MAX_SEARCH_FILE_SIZE) continue;
        let text: string;
        try {
            text = await readFile(file, 'utf8');
        } catch {
            continue;
        }
        if (text.includes('\0')) continue; // 含空字节基本是二进制，跳过
        text.split('\n').forEach((line, i) => {
            if (hits.length >= MAX_SEARCH_RESULTS) return;
            if (line.toLowerCase().includes(pattern)) hits.push(`${rel}:${i + 1}: ${line.trimEnd()}`);
        });
    }
    return hits;
}
```

每条结果都从权限根开始计算相对路径。模型可以把这个路径直接传给 `read`。文件中的每一行匹配成功后，连同行号一起加入结果。

### 4.4 fetch 工具：读取并转换网页

`fetch` 接收一个完整 URL，确认后访问页面：

```ts
// day12/tools.ts
    {
        name: 'fetch',
        description: '抓取一个网页并转成纯文本，让模型看到仓库之外的信息（文档、博文、报错页等）。默认 ask 策略，执行前需要确认；只支持 http/https。',
        parameters: {
            type: 'object',
            properties: { url: { type: 'string', description: '要访问的完整网址，以 http:// 或 https:// 开头。' } },
            required: ['url'],
            additionalProperties: false,
        },
        run: async (args) => {
            const input = String(args.url ?? '').trim();
            if (!input) return '缺少参数 url';
            let target: URL;
            try {
                target = new URL(input);
            } catch {
                return `URL 不合法：${input}`;
            }
            if (target.protocol !== 'http:' && target.protocol !== 'https:') return '只支持 http/https 链接';
            if (!(await authorize('fetch', `\n即将访问网页：\n${input}\n确认抓取？`))) return '已取消抓取';
            try {
                const res = await fetch(target, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
                if (!res.ok) return `请求失败：HTTP ${res.status} ${res.statusText}`;
                const text = await res.text();
                const contentType = res.headers.get('content-type') ?? '';
                const body = /\bhtml\b/.test(contentType) ? htmlToText(text) : text;
                return truncate(body);
            } catch (err) {
                const e = err as Error;
                return e.name === 'TimeoutError' ? `抓取超时（${FETCH_TIMEOUT_MS / 1000}s），可稍后重试` : `抓取失败：${e.message}`;
            }
        },
        authorizes: true,
    },
```

`authorizes: true` 表示确认过程由工具处理，因此提示中可以显示即将访问的 URL。响应是 HTML 时调用 `htmlToText`，否则直接返回文本。

`htmlToText` 按顺序删除脚本、样式、注释和标签：

```ts
// day12/tools.ts
/**
 * 极简 HTML → 纯文本：剥掉脚本/样式/注释，块级标签换行，解码常见实体。
 * 不追求完整解析，够把文档、博文读成模型能用的文本。
 */
function htmlToText(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<\/(?:p|div|h[1-6]|li|ul|ol|tr|td|th|table|pre|blockquote|section|article|header|footer)>/gi, '\n')
        .replace(/<(?:br|hr)[\s\S]*?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&nbsp;/gi, ' ')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join('\n');
}
```

块级标签先变成换行，其余标签再删除，最后解码常见 HTML 实体并清理空行。这样能保留正文的基本段落。

### 4.5 permissions.ts 与 index.ts：完成接线

权限表加入两个工具：

```ts
// day12/permissions.ts
    ls: 'allow',
    read: 'allow',
    glob: 'allow',
    search: 'allow',
    fetch: 'ask',
    write: 'ask',
```

入口文件更新启动提示：

```ts
// day12/index.ts
tui.append('GeekAgent Day 12 —— 代码搜索 + Web 抓取', 'sys');
tui.append('想看某段代码出现在哪，直接让模型去 search；想读仓库外的文档、博文，让模型 fetch 回来转成文本。检索结果会显示 路径:行号，方便顺着找。', 'sys');
```

完整流程是：`search` 定位代码，再用 `read` 查看上下文；或者用 `fetch` 读取网页，直接根据纯文本回答。

## 5. 验证

```bash
npm run typecheck
npm run dev -- day12/index.ts
```

1. 询问“在 day12 里搜索 `ensureToolPolicy` 的定义和用法”，确认结果包含路径和行号；
2. 新建 `note.html`，并在文件所在目录运行 `python3 -m http.server 8934`：

```html
<!-- note.html -->
<!DOCTYPE html>
<html>
<head><title>GeekAgent 学习笔记第 12 天</title></head>
<body>
<h1>从零实现 GeekAgent</h1>
<p>今天新增两个工具：<b>search</b> 按内容检索仓库，<b>fetch</b> 把网页转成纯文本。</p>
<ul>
  <li>search 返回 文件:行号: 内容，跳过 node_modules 和二进制文件</li>
  <li>fetch 用内置 fetch + 正则剥标签，先确认再访问</li>
  <li>下一步方向：工具调用失败后让模型读错误自愈、多个独立工具并行</li>
</ul>
</body>
</html>
```

3. 让模型读取 `http://127.0.0.1:8934/note.html`；
4. 确认程序先显示 URL 并询问，输入 `y` 后返回不含 HTML 标签的正文。

## 6. 没做什么

- `search` 不支持正则、文件类型过滤和结果排序；
- `search` 不读取 `.gitignore`；
- `fetch` 只返回纯文本，不保留标题层级、链接和代码块结构；
- `fetch` 不支持需要登录或 JavaScript 渲染的页面；
- 两个工具都没有缓存。

## 7. 下一步

现在，Agent 能搜索仓库，也能读取网页。下一步可以继续扩展它对长期信息的使用方式，让保存过的内容在需要时主动出现。
