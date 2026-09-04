---
title: 从零实现 GeekAgent —— Day14 轻 RAG 知识库
description: >-
  7天从零实现Agent教程，用 TypeScript 动手写一个最简单的 Agent/Harness。Day 14 复用 Day 13 的切块和 BM25 搜索，实现一个能采集网页与文件、按问题返回相关段落的轻量知识库。
date: '2026-09-01 23:00:00'
tags:
  - Agent
  - Harness
book: geekagent
status: done
draft: false
---

# Day 14：先查资料，再回答——轻 RAG 知识库

> Day 13 能从长期记忆里找到相关内容。今天把同一套方法用到网页和文件：文档保存在磁盘里，提问时只取回相关的几段。

## 0. 知识库不就是更多的长期记忆吗？

两者都在“保存内容，再按问题搜索”，但保存的对象不同。

| | 长期记忆 | RAG 知识库 |
|---|---|---|
| 保存什么 | 用户偏好、项目事实、重要决定 | 教程、手册、博客等外部资料 |
| 内容规模 | 少量、短文本 | 多篇、长文档 |
| 写入方式 | 模型提炼后调用 `memory_write` | 程序采集原文并切块 |
| 回答作用 | 补充过去的上下文 | 为资料问题提供依据和来源 |

把整篇教程写进记忆，会混淆“需要长期记住的事实”和“需要随时查阅的资料”。因此我们单独建立知识库，但复用 Day 13 的切块与搜索算法。

## 1. 为什么：不能把整篇文档都塞进上下文

长期记忆适合保存用户偏好、项目决定等短信息。教程、接口文档和博客通常更长，不适合当成一条记忆保存。

如果每次都让模型读取整篇文档，会遇到两个问题：

- 文档会占用大量上下文；
- 模型只需要其中几段，却要反复阅读全文。

RAG 的全称是“检索增强生成”。先把文档保存在知识库中，再根据问题搜索相关段落，最后把这些段落交给模型回答。简单说，就是**先查资料，再回答**。

Day 13 已经实现了切块、分词和 BM25 打分。今天复用这些函数，只补上文档采集、存储和工具接线。

## 2. 目标

1. `rag_add` 读取网页或本地文件，把正文按 800 字窗口切块并写入 `.geekagent/rag/index.json`；采集过程只返回摘要，全文不进入当前上下文；
2. `rag_search` 对自然语言问题分词并用 BM25 排序，最多返回四个相关块，每块带文档标题和段号；
3. `/rag add <URL 或路径>...` 可以连续采集多个来源，`/rag` 展示文档数、块数和来源清单。

**当天代码行数**：相对 Day 13，源码新增 184 行、删除 5 行，净增 179 行。

## 3. 设计：采集、存储、检索

### 3.1 一条简单的 RAG 流程

一个常见的 RAG 系统包含两段流程。

**入库阶段**负责准备资料：采集文档、清洗正文、切块，再用 embedding 模型生成向量并写入向量数据库。

**问答阶段**负责寻找依据：把问题也转成向量，检索相近文本块，必要时用 reranker 重新排序，最后把少量结果交给大模型生成答案。

这里出现了两个常见概念：embedding 把文字变成可比较的数字向量；reranker 会更仔细地重新判断候选结果与问题是否相关。

当前 demo 保留主干，把向量检索换成 Day 13 的 BM25，把向量数据库换成一个 JSON 文件：

| 环节 | 主流 RAG | 当前 demo |
|---|---|---|
| 文档处理 | 解析、清洗、按语义切块 | 基础 HTML 清理、固定窗口切块 |
| 检索表示 | embedding 向量 | bigram token |
| 索引存储 | 向量数据库 | JSON 文件中的文本块 |
| 召回与排序 | 向量召回，常配合 reranker | BM25 直接取前四块 |
| 文档维护 | 增量更新、删除、版本管理 | 新增文档后全量写回 |

代码最终仍是四步：

1. 读取网页或文件；
2. 把正文切成 800 字左右的小块；
3. 把标题、来源和文本块写进 JSON；
4. 提问时用 BM25 选出最相关的四块。

这已经能跑通“资料入库 → 按问题搜索 → 带来源回答”的核心原理，所以称为轻 RAG。它适合少量教程和本地资料，不适合直接替代面向大规模语料的向量数据库。

### 3.2 采集和阅读分开

Day 12 的 `fetch` 会把网页正文直接返回给模型。`rag_add` 不同：它在程序内部完成读取、切块和写盘，只返回一行入库结果。这样，采集一篇长文不会占用当前上下文。

等模型调用 `rag_search` 时，程序才把命中的几段返回给它。`rag_add` 需要读取外部内容并写入知识库，所以执行前询问；`rag_search` 只读本地数据，可以直接执行。

### 3.3 复用 Day 13 的搜索函数

`rag_search` 不再重复编写打分代码，而是直接导入 Day 13 的函数：

```ts
// day14/rag.ts
import { STOPWORDS, bm25, chunkEntry, tokenize, type Chunk } from './memory.js';
```

`rag.ts` 直接导入 Day 13 的四个成员：`chunkEntry` 负责切块，`tokenize` 负责拆分问题，`STOPWORDS` 去掉常见词，`bm25` 负责打分。

记忆默认按 320 字切块，知识库调用 `chunkEntry` 时传入 800。搜索方法相同，只是两类内容使用不同的块大小。

知识库使用更大的块，是为了给模型保留一段较完整的文档上下文。固定窗口实现简单，但可能在标题与正文之间切开；成熟方案常按段落、标题或 token 数切块，有时还会为每块补上文档标题。

### 3.4 用一个 JSON 文件保存

库的持久化就一个 `.geekagent/rag/index.json`：

```json
{
  "docs": [
    {
      "title": "Day 5 学习笔记",
      "source": "http://127.0.0.1:8934/notes/day5.html",
      "addedAt": "2026-09-01T...",
      "chunks": [{ "start": 0, "text": "…" }, { "start": 720, "text": "…" }]
    }
  ]
}
```

每个文档保存标题、来源、加入时间和文本块。启动时读入文件，搜索时遍历所有块并打分。对于几十篇教程，这种做法已经够用。

## 4. 实现：先效果，后实现

### 4.1 先看效果

启动后，先把两页笔记采集进库（本地起服务，`python3 -m http.server 8934`，页面我放在 `notes/day5.html` 和 `notes/day9.html`）：

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#808080">GeekAgent Day 14 —— 轻 RAG 知识库</span>
<span style="color:#808080">长期记忆保存项目事实，知识库保存外部资料：/rag add 采集网页或文件，rag_search 返回带来源的相关段落。</span>
<span style="color:#00cdcd">You › /rag add http://127.0.0.1:8934/notes/day5.html</span>
<span style="color:#cdcd00">即将把以下内容加入知识库：</span>
<span style="color:#cdcd00">http://127.0.0.1:8934/notes/day5.html</span>
<span style="color:#cdcd00">确认采集？[y/N] → y</span>
<span style="color:#cdcd00">[已加入知识库：《Day 5 学习笔记》共 1042 字符 / 2 块]</span>
<span style="color:#00cdcd">You › /rag add http://127.0.0.1:8934/notes/day9.html</span>
<span style="color:#cdcd00">即将把以下内容加入知识库：</span>
<span style="color:#cdcd00">http://127.0.0.1:8934/notes/day9.html</span>
<span style="color:#cdcd00">确认采集？[y/N] → y</span>
<span style="color:#cdcd00">[已加入知识库：《Day 9 学习笔记》共 886 字符 / 2 块]</span>
<span style="color:#00cdcd">You › /rag</span>
<span style="color:#808080">知识库共 2 个文档 / 4 块 / 2088 字符：</span>
<span style="color:#808080">1. 《Day 5 学习笔记》（2 块，http://127.0.0.1:8934/notes/day5.html）</span>
<span style="color:#808080">2. 《Day 9 学习笔记》（2 块，http://127.0.0.1:8934/notes/day9.html）</span>
<span style="color:#00cdcd">You › 这套笔记里，历史压缩相关的触发阈值是多少？</span>
<span style="color:#cdcd00">[调用工具 rag_search → 命中 2 块：</span>
<span style="color:#cdcd00">1. 《Day 5 学习笔记》第 2 段：…触发阈值 MAX_HISTORY_CHARS 默认 4000 字符，压缩保留最近 6 条…</span>
<span style="color:#cdcd00">2. 《Day 9 学习笔记》第 1 段：第二章 规划器。…]</span>
<span style="color:#00cd00">《Day 5 学习笔记》第 2 段明确写了历史压缩的触发阈值是 MAX_HISTORY_CHARS 默认 4000 字符，压缩保留最近 6 条。这个答案来自知识库检索，不是我猜的。</span>
</pre>

`/rag add` 先询问再采集，并且只返回一行结果。真正提问时，模型调用 `rag_search`，拿到带标题和段号的相关内容。

### 4.2 rag.ts：知识库本体（完整 149 行）

新文件 `day14/rag.ts`，全量贴出：

```ts
// day14/rag.ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { registerTool, type Tool } from './tools.js';
import { authorize, safePath } from './permissions.js';
import { STOPWORDS, bm25, chunkEntry, tokenize, type Chunk } from './memory.js';
import { htmlToText } from './tools.js';

const RAG_FILE = resolve('.geekagent/rag/index.json');
/** 文档切块窗口：比记忆条目大（整篇文档），知识库检索的块粒度更粗。 */
const RAG_CHUNK_SIZE = 800;
/** 网络抓取最长等待。 */
const FETCH_TIMEOUT_MS = 15_000;
/** 单篇文档入库上限，超出直接整篇弃掉，防失控。 */
const MAX_DOC_CHARS = 2 * 1024 * 1024;
/** 一次检索最多返回的命中块数。 */
const MAX_RESULTS = 4;

/** 知识库里的一个文档：标题、来源、切块后的段落。 */
interface RagDoc {
    title: string;
    source: string;
    addedAt: string;
    chunks: { start: number; text: string }[];
}

let docs: RagDoc[] = [];

/** 启动时从磁盘恢复知识库；文件不存在等同于空库。 */
export async function loadRag(): Promise<void> {
    try {
        const value = JSON.parse(await readFile(RAG_FILE, 'utf8')) as { docs?: unknown };
        docs = Array.isArray(value.docs)
            ? value.docs.filter((d): d is RagDoc => !!d && typeof (d as RagDoc).title === 'string' && Array.isArray((d as RagDoc).chunks))
            : [];
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            docs = [];
            return;
        }
        throw err;
    }
}

/** 把 docs 整体写盘。 */
async function saveRag(): Promise<void> {
    await mkdir(dirname(RAG_FILE), { recursive: true });
    await writeFile(RAG_FILE, `${JSON.stringify({ docs }, null, 2)}\n`, 'utf8');
}

/**
 * 采集一个网页（http/https）或本地文件进知识库。全文走内部通道，不经模型上下文；
 * 切块后连同一份索引落盘，之后按 rag_search 检索。重复来源直接跳过。
 */
export async function addToRag(source: string): Promise<string> {
    const target = source.trim();
    if (!target) return '缺少要采集的来源';
    if (!(await authorize('rag_add', `\n即将把以下内容加入知识库：\n${target}\n确认采集？`))) return '已取消采集';
    if (docs.some((d) => d.source === target)) return '已在知识库中，跳过（重复采集）';

    let title: string;
    let text: string;
    try {
        if (/^https?:\/\//i.test(target)) {
            const res = await fetch(target, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
            if (!res.ok) return `抓取失败：HTTP ${res.status} ${res.statusText}`;
            const body = await res.text();
            const isHtml = /\bhtml\b/.test(res.headers.get('content-type') ?? '');
            text = isHtml ? htmlToText(body) : body;
            const m = isHtml ? body.match(/<title[^>]*>([^<]+)<\/title>/i) : null;
            title = m ? m[1].trim() : target;
        } else {
            const file = await safePath(target);
            text = await readFile(file, 'utf8');
            if (/\.html?$/i.test(target)) text = htmlToText(text);
            title = basename(file);
        }
    } catch (err) {
        return `采集失败：${(err as Error).message}`;
    }

    if (!text.trim()) return '内容为空，未入库';
    if (text.length > MAX_DOC_CHARS) return `内容过大（${text.length} 字符，上限 2MB），未入库`;
    const chunks = chunkEntry(text, 0, RAG_CHUNK_SIZE);
    docs.push({ title: title.slice(0, 120), source: target, addedAt: new Date().toISOString(), chunks });
    await saveRag();
    return `已加入知识库：《${title.slice(0, 120)}》共 ${text.length} 字符 / ${chunks.length} 块`;
}

/** 在知识库里按 BM25 检索相关段落：query 支持自然语言（内部切 bigram token）或空格分隔关键词。 */
export function ragSearch(query: string): string {
    const keywords = tokenize(query).filter((t) => !STOPWORDS.has(t));
    if (keywords.length === 0) return '没有命中任何知识块';
    const all: Chunk[] = docs.flatMap((doc, di) => doc.chunks.map((c, ci) => ({ entry: di, index: ci, start: c.start, text: c.text })));
    if (all.length === 0) return '知识库还是空的，先用 rag_add 或 /rag add 采集';
    const hits = all
        .map((chunk) => ({ chunk, score: bm25(chunk.text, keywords, all) }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_RESULTS);
    if (hits.length === 0) return '没有命中任何知识块，换个更聚焦的说法再试';
    return `命中 ${hits.length} 块：\n${hits
        .map((h, i) => {
            const doc = docs[h.chunk.entry];
            return `${i + 1}. 《${doc.title}》第 ${h.chunk.index + 1} 段：${h.chunk.text.trim()}`;
        })
        .join('\n')}`;
}

/** 知识库总览：文档数、块数、字符数与文档清单，供 /rag 命令直接展示。 */
export function ragStats(): string {
    if (docs.length === 0) return '知识库还是空的（用 /rag add 采集，或让模型调用 rag_add）';
    const blocks = docs.reduce((n, d) => n + d.chunks.length, 0);
    const chars = docs.reduce((n, d) => n + d.chunks.reduce((m, c) => m + c.text.length, 0), 0);
    return `知识库共 ${docs.length} 个文档 / ${blocks} 块 / ${chars} 字符：\n${docs
        .map((d, i) => `${i + 1}. 《${d.title}》（${d.chunks.length} 块，${d.source}）`)
        .join('\n')}`;
}

/** 注册 rag 工具：采集（ask）与检索（allow）。 */
export function setupRag(changed: () => void): void {
    const tools: Tool[] = [
        {
            name: 'rag_add',
            description: '把一个网页（http/https）或本地文件采集进知识库：全文切块、建索引，之后用 rag_search 按问检索。采集经过内部通道，正文不进入当前上下文，适合批量灌文档。回答涉及教程、资料前，若发现相关文档没入库，可先采集。默认 ask 策略。',
            parameters: {
                type: 'object',
                properties: { source: { type: 'string', description: '网页完整 URL（http/https）或仓库内文件路径' } },
                required: ['source'],
                additionalProperties: false,
            },
            run: (args) => addToRag(String(args.source ?? '').trim()),
            authorizes: true,
        },
        {
            name: 'rag_search',
            description: '在知识库里按 BM25 检索相关段落，返回命中块与来源标题。回答涉及项目文档、教程、系列博客、本地资料等知识库内容之前，先调用它找到依据。query 直接用自然语言提问即可，也支持空格分隔关键词。',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string', description: '要检索的说法，直接写自然语言，如「这套教程 Day 5 做了什么」' } },
                required: ['query'],
                additionalProperties: false,
            },
            run: (args) => ragSearch(String(args.query ?? '')),
        },
    ];
    tools.forEach(registerTool);
    changed();
}
```

三个函数组成主要流程：

1. `addToRag` 读取来源，把 HTML 转成纯文本，按 800 字切块并保存；
2. `ragSearch` 拆分问题，给所有块打分，返回前四块；
3. `ragStats` 汇总文档数、块数和来源，供 `/rag` 展示。

### 4.3 memory.ts：复用搜索能力

`chunkEntry` 已经支持传入块大小。知识库传入 800，记忆不传参数，继续使用默认的 320：

```ts
// day14/memory.ts
export interface Chunk {
    entry: number;
    index: number;
    start: number;
    text: string;
}

/**
 * 按固定窗口 + 重叠把条目切成块；短条目（不超过窗口）就是一块。
 * size 参数供 Day 14 的知识库按更大窗口切文档，省略时沿用记忆的默认窗口。
 */
export function chunkEntry(text: string, entry: number, size = CHUNK_SIZE): Chunk[] {
    if (text.length <= size) return [{ entry, index: 0, start: 0, text }];
    const chunks: Chunk[] = [];
    const step = size - CHUNK_OVERLAP;
    for (let start = 0; ; start += step) {
        chunks.push({ entry, index: chunks.length, start, text: text.slice(start, start + size) });
        if (start + size >= text.length) break;
    }
    return chunks;
}
```

`tokenize`、`bm25` 和 `STOPWORDS` 也直接从 `memory.ts` 导入。`rag.ts` 不再重复实现分词和打分。

### 4.4 permissions.ts 与 tools.ts：补上接线

权限表加入两个工具。采集默认询问，搜索默认允许：

```ts
// day14/permissions.ts
    memory_write: 'allow',
    memory_search: 'allow',
    rag_add: 'ask',
    rag_search: 'allow',
};

```

`tools.ts` 中已有 `htmlToText`，给它加上 `export`，`rag.ts` 就能复用网页转文本的代码。

### 4.5 index.ts：加载知识库与处理命令

先引入知识库函数，并在启动时加载数据：

```ts
// day14/index.ts
import { addToRag, loadRag, ragStats, setupRag } from './rag.js';
```

```ts
// day14/index.ts
try {
    await loadRag();
} catch (e) {
    console.error(`知识库读取失败：${(e as Error).message}`);
    process.exit(1);
}
```

然后注册两个 RAG 工具：

```ts
// day14/index.ts
setupMemory(updatePanel);
setupRag(updatePanel);
```

最后处理 `/rag` 命令。无参数时显示总览，`add` 后可以跟一个或多个来源：

```ts
// day14/index.ts
        case '/rag': {
            const args = line.slice('/rag'.length).trim();
            if (!args) {
                tui.append(ragStats(), 'sys');
            } else if (args.startsWith('add ')) {
                const sources = args.slice(4).trim().split(/\s+/).filter(Boolean);
                for (const src of sources) {
                    try {
                        const result = await addToRag(src);
                        tui.append(`[${result}]`, 'tool');
                    } catch (e) {
                        tui.append(`采集失败：${(e as Error).message}`, 'sys');
                    }
                }
            } else {
                tui.append('用法：/rag add <网页 URL 或文件路径>... 采集建库；/rag 查看知识库', 'sys');
            }
            break;
        }
```

到这里流程连起来了：`/rag add` 采集文档 → `rag_search` 找到相关块 → 模型根据带来源的内容回答。

## 5. 验证

```bash
npm run typecheck
npm run dev -- day14/index.ts
```

1. 新建一篇 HTML 笔记，并在它所在的目录启动本地服务：

```html
<!-- notes/day5.html -->
<!DOCTYPE html>
<html>
<head><title>Day 5 学习笔记</title></head>
<body>
<h1>历史压缩</h1>
<p>第一章 历史压缩。触发阈值 MAX_HISTORY_CHARS 默认 4000 字符，压缩保留最近 6 条。</p>
<!-- 再补一些正文，使文章超过 800 字，便于观察切块 -->
</body>
</html>
```

2. 运行 `/rag add http://127.0.0.1:8934/day5.html`，输入 `y` 确认；
3. 运行 `/rag`，确认能看到文档标题、块数和来源；
4. 询问“历史压缩的触发阈值是多少”；
5. 确认模型调用 `rag_search`，回答包含 4000，并标出《Day 5 学习笔记》和段号。

## 6. 没做什么

- 检索只用关键词匹配，没有向量检索和结果重排；切块与 HTML 清理也只采用基础规则；
- 文档入库后不能删除、更新或自动同步；
- 长期记忆与知识库仍然分别搜索，没有统一召回和排序。

## 7. 下一步

RAG 让 Agent 能从外部资料中查找内容，但采集和检索仍是写在项目里的本地工具。下一步，我们把视线移到进程之外：如果数据库、浏览器或其他团队维护的服务也想提供工具，Agent 怎样用一种统一方式发现并调用它们？
