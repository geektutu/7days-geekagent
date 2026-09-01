---
title: 从零实现 GeekAgent —— Day13 主动记忆
description: >-
  7天从零实现Agent教程，用 TypeScript 动手写一个最简单的 Agent/Harness。Day 13 把长期记忆切成小块，用 BM25 找出相关内容，并在每轮对话前自动放进上下文。
date: '2026-09-01 21:00:00'
tags:
  - Agent
  - Harness
book: geekagent
status: done
draft: false
---

# Day 13：不用提醒，也能想起来——主动记忆

> Day 10 已经能把重要信息存进长期记忆，但模型只有主动调用 `memory_search` 才能看到它。今天让程序在每轮对话前自动检索，模型一开口就能带上相关记忆。

## 0. 自动唤起和模型自己搜索，有什么区别？

看到“自动唤起”，我们可能会问：已经有 `memory_search` 了，为什么还要让程序再搜一次？

`memory_search` 是一个工具。模型必须先意识到“这个问题可能与以前的信息有关”，才会主动调用它。如果模型没有想到这一步，记忆就不会进入上下文。

自动唤起发生得更早：用户刚发来问题，程序就搜索长期记忆，再把相关内容和问题一起交给模型。它不是替代 `memory_search`，而是给每轮对话加一次默认回忆。

| | 手动 `memory_search` | 自动唤起 |
|---|---|---|
| 谁发起 | 模型 | 主程序 |
| 何时发生 | 模型决定调用工具时 | 每轮对话开始前 |
| 查询内容 | 模型整理的关键词 | 用户的原始问题 |
| 适合用途 | 有目标地继续深挖 | 避免模型忘记搜索 |

## 1. 为什么：记住了，还要想得起来

Day 10 有两个记忆工具：`memory_write` 负责保存，`memory_search` 负责搜索。问题是，搜索要由模型主动发起。模型没想到调用工具，磁盘里即使有答案，也不会出现在当前对话中。

还有两个搜索问题：

- 长记忆只要命中一个词，就会整条返回，里面常常夹着很多无关内容；
- 原来的排序只数命中了几个关键词，没有考虑词是否常见、记忆是否过长。

我们分三步解决：先把长记忆切成小块，再用 BM25 给每块打分，最后在用户提问时自动检索。

## 2. 目标

1. 长记忆在搜索时按 320 字窗口、80 字重叠切块，结果标出“条目 #N、第 M 段”，不再返回整条长文；
2. 中文问题切成 bigram，英文和数字保留整词，再用 BM25 综合词频、常见程度和块长度排序；
3. 每轮用户提问到达后先自动搜索，把前五个命中块放进本轮 system prompt；整个过程不依赖模型主动调用 `memory_search`。

**当天代码行数**：相对 Day 12，源码新增 165 行、删除 31 行，净增 134 行。

## 3. 设计：从一条记忆到一次自动回忆

### 3.1 先切块，再搜索

`memory.json` 仍然保存完整字符串。搜索时，我们临时把每条记忆按 320 字切开，相邻两块重叠 80 字。

这样做有两个好处：搜索只返回相关的一小段；一句话即使落在切分位置，也会因为重叠而完整出现在其中一块。

### 3.2 用 BM25 排序

搜索文本通常有两条路线：关键词检索和向量检索。

向量检索先用 embedding 模型把问题和文本变成一组数字，再比较它们在语义上是否接近。它更擅长处理“说法不同、意思相近”的问题，是语义检索的常见方案，但需要额外的 embedding 模型和向量索引。

BM25 是经典的关键词检索算法，不理解语义，但不需要训练模型。当前知识量只有几十条记忆，用它就能以很少的代码展示完整检索过程。

| | BM25 关键词检索 | 向量检索 |
|---|---|---|
| 比较对象 | 查询词与文本词 | 查询向量与文本向量 |
| 擅长 | 名称、代码、原词命中 | 同义表达、语义相近 |
| 额外能力 | 分词和打分 | embedding 模型、向量索引 |
| 当前 demo | 采用，零新增服务 | 暂不采用 |

BM25 的名称来自 Okapi BM25。公式不用背，先理解三条规则：

- 查询词在一块里出现得越多，分数越高；
- 到处都有的常见词，作用越小；
- 内容越长，不能只靠篇幅占便宜。

自动检索接收的是一句中文提问。中文没有空格，我们把连续中文切成相邻的两个字。例如「历史压缩」会变成「历史」「史压」「压缩」。英文和数字保留完整单词。这种方法叫 bigram，不需要额外的分词库。

专业中文搜索通常会使用分词器，把句子拆成真正的词；bigram 可能产生「史压」这类没有实际含义的片段。这里选择 bigram，是因为实现短、无需词典，又能比整句匹配覆盖更多说法。它仍是字面检索，不能解决同义词问题。

### 3.3 在对话前自动唤起

每次收到用户输入，`index.ts` 先调用 `recallMemory`。它把问题拆成 token，给所有记忆块打分，再把前几名交给 `Chat`。`Chat` 把这些内容追加到本轮 system prompt。

原来的 `memory_search` 继续保留。自动唤起负责每轮先找一次，模型需要更明确的关键词时，仍可主动调用工具搜索。

## 4. 实现：先效果，后实现

### 4.1 先看效果

启动后，先是启动横幅，然后让模型把一段选型过程写进长期记忆：

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#808080">GeekAgent Day 13 —— 主动记忆（BM25 分块 + 自动唤起）</span>
<span style="color:#808080">每轮提问前自动检索长期记忆：相关段落先进入上下文，长记忆只返回命中的块。</span>
<span style="color:#00cdcd">You › 把上月的技术选型记进长期记忆：历史压缩决定放第五天做，因为上下文长度第一次成为瓶颈；触发阈值 MAX_HISTORY_CHARS 默认 4000 字符，压缩保留最近 6 条，KEEP_RECENT 常量之后一直没改过。多写点背景以便验证分块——这里放一段超过三百二十字的技术背景填充，用来保证这条记忆真的会被切成两块。背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充背景填充。分块按 320 字窗口、80 字重叠走。</span>
<span style="color:#cdcd00">[调用工具 memory_write → 已记住：把上月的技术选型记进长期记忆：历史压缩决定放第五天做，因为上下文长度第一次成为瓶颈；触发阈值 MAX_HISTORY_CHARS 默认 4000 字符，压缩保留最近 6 条，KEEP_RECENT 常量之后一直没改过。多写点背景以便验证分块——这里放一段超过三百二十字的技术背景填充……]</span>
<span style="color:#00cdcd">You › 记完啦。咱们当初把历史压缩搁在第五天做，到底是图什么？</span>
<span style="color:#00cd00">当时把历史压缩放在第五天，是因为上下文长度第一次成为瓶颈。触发阈值是 MAX_HISTORY_CHARS 默认 4000 字符，压缩时保留最近 6 条。</span>
</pre>

第二次提问后没有出现 `[调用工具 memory_search]`。因为用户输入刚到达程序时，相关记忆已经被放进本轮 system prompt，模型不需要再调用工具。

长记录被切成两块后，面板也会显示块数：

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#808080">──── 上下文 ────</span>
<span style="color:#d4d4d4">…</span>
<span style="color:#808080">记忆  1 条 / 2 块</span>
</pre>

下面从检索主体开始实现。

### 4.2 memory.ts：切块、打分与唤起（完整 202 行）

`day13/memory.ts` 包含完整的记忆读写与检索代码：

```ts
// day13/memory.ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { registerTool, type Tool } from './tools.js';

const MEMORY_FILE = resolve('.geekagent/memory.json');
/** 记忆条目按这个字符窗口切块；检索、返回都以块为单位，长条目也能精确定位到段。 */
const CHUNK_SIZE = 320;
/** 相邻块的字符重叠，避免一句结论恰好被切在块边界上。 */
const CHUNK_OVERLAP = 80;
/** 一次检索最多返回的命中块数，够用又不至于撑爆上下文。 */
const MAX_RESULTS = 5;
/** BM25 平滑参数：k1 越小对词频越敏感，b 越大对长度归一越弱。 */
const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** 查询里的虚词 / 常用字：命中再多也没有区分度，直接忽略。 */
export const STOPWORDS = new Set(['的', '了', '在', '是', '和', '一', '个', '也', '就', '都', '把', '被', '从', '到', '给', '与', '及', '这', '那', '并', '而', '等', '有', '没', '不', '我们', '一个', '可以']);

let items: string[] = [];

/** 一条记忆的一块：记录它属于哪条、条内第几段、原文偏移。 */
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

/** 归一化：转小写、空白压成一个空格。查询词直接按子串匹配，省掉分词。 */
function norm(s: string): string {
    return s.toLowerCase().replace(/\s+/g, ' ');
}

/**
 * 零依赖分词：中文连续段切成字符二元组（bigram），英文 / 数字保留整词。
 * 自然语言提问没有词边界，bigram 是换掉「必须空格分隔关键词」的最小代价。
 */
export function tokenize(text: string): string[] {
    const tokens: string[] = [];
    const runs = norm(text).match(/[\u4e00-\u9fa5]+|[a-z0-9]+/g) ?? [];
    for (const run of runs) {
        if (/[a-z0-9]/.test(run[0]) || run.length === 1) {
            tokens.push(run);
        } else {
            for (let i = 0; i + 2 <= run.length; i++) tokens.push(run.slice(i, i + 2));
        }
    }
    return tokens;
}

/** 统计 term 在 text 中连续出现的次数（不重叠计数）。 */
function termCount(text: string, term: string): number {
    let n = 0, i = 0;
    while ((i = text.indexOf(term, i)) >= 0) {
        n++;
        i += term.length;
    }
    return n;
}

/**
 * BM25-lite：每个查询词按「tf × 平滑 idf」贡献分数，再用文档长度做归一。
 * df 越大（出现越广的词）idf 越小，长块因为词频被摊薄也不会白白占优。
 */
export function bm25(chunk: string, query: string[], all: Chunk[]): number {
    const n = all.length;
    const avgdl = all.reduce((s, c) => s + norm(c.text).length, 0) / n;
    const doc = norm(chunk);
    const dl = doc.length;
    let score = 0;
    for (const t of query) {
        const df = all.filter((c) => norm(c.text).includes(t)).length;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const tf = termCount(doc, t);
        const normed = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgdl)));
        score += idf * normed;
    }
    return score;
}

/** 对 query tokens 做 BM25 检索，返回命中的 top-k 块；一个都没有就返回空串。 */
function topHits(query: string[], chunks: Chunk[]): Chunk[] {
    return chunks
        .map((chunk) => ({ chunk, score: bm25(chunk.text, query, chunks) }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_RESULTS)
        .map((hit) => hit.chunk);
}

/** 把命中块排成「条目 #N，第 M 段：内容」的可读列表，模型和用户看同一份。 */
function formatHits(hits: Chunk[]): string {
    return hits.map((c, i) => `${i + 1}. （条目 #${c.entry + 1}，第 ${c.index + 1} 段）${c.text.trim()}`).join('\n');
}

/** 按 BM25 打分检索记忆块（手动调用）：query 是空格分隔的关键词。 */
export function searchMemory(query: string): string {
    const keywords = query.toLowerCase().split(/\s+/).filter((w) => w && !STOPWORDS.has(w));
    if (keywords.length === 0) return '没有找到相关记忆';
    const chunks = items.flatMap((item, entry) => chunkEntry(item, entry));
    if (chunks.length === 0) return '没有找到相关记忆';
    const hits = topHits(keywords, chunks);
    return hits.length > 0 ? `找到 ${hits.length} 条相关记忆：\n${formatHits(hits)}` : '没有找到相关记忆';
}

/**
 * 每轮对话前的自动唤起：把用户原话直接切成 bigram token 再检索，命中就以「自动唤起记忆」
 * 的形式拼进 system prompt——模型不用记得自己去查，提问的同时相关记忆已在案头。
 */
export function recallMemory(rawText: string): string {
    const keywords = tokenize(rawText).filter((t) => !STOPWORDS.has(t));
    if (keywords.length === 0) return '';
    const chunks = items.flatMap((item, entry) => chunkEntry(item, entry));
    if (chunks.length === 0) return '';
    const hits = topHits(keywords, chunks);
    return hits.length > 0 ? `自动唤起 ${hits.length} 条相关记忆（供参考）：\n${formatHits(hits)}` : '';
}

/** 磁盘格式保持 string[] 不变，读、写、内存态三处一致。 */
async function saveToDisk(next: string[]): Promise<void> {
    await mkdir(dirname(MEMORY_FILE), { recursive: true });
    await writeFile(MEMORY_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    items = next;
}

/** 启动时从磁盘恢复长期记忆；文件不存在等同于还没有记忆。 */
export async function loadMemory(): Promise<void> {
    try {
        const value = JSON.parse(await readFile(MEMORY_FILE, 'utf8')) as unknown;
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
            throw new Error('memory.json 必须是字符串数组');
        }
        items = value.map((item) => item.trim()).filter(Boolean);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            items = [];
            return;
        }
        throw err;
    }
}

/** 注册写记忆 / 检索记忆工具。写入仍是整条落盘，chunks 在检索时按需切出。 */
export function setupMemory(changed: () => void): void {
    const tools: Tool[] = [
        {
            name: 'memory_write',
            description: '把值得跨会话保留的用户偏好、项目事实或重要决定写入长期记忆。支持存多段长文，检索时会按块命中、返回相关段落。不要记录临时任务进度或可随时从文件读到的内容。',
            parameters: {
                type: 'object',
                properties: { content: { type: 'string', description: '一条脱离当前对话也能独立理解的事实，可以是一段长文' } },
                required: ['content'],
                additionalProperties: false,
            },
            run: async (args) => {
                const content = String(args.content ?? '').trim();
                if (!content) return '缺少参数 content';
                const entry = content.slice(0, 4000);
                if (items.includes(entry)) return '这条记忆已经存在';
                await saveToDisk([...items, entry]);
                changed();
                return entry.length < content.length ? `已记住（过长已截短）：${entry}` : `已记住：${entry}`;
            },
        },
        {
            name: 'memory_search',
            description: '按 BM25 打分检索长期记忆，返回命中的记忆块（精确到段）。需要回忆用户偏好、项目事实或以前的决定时调用；query 使用一个或多个空格分隔的关键词，如“博客 人称”。',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string', description: '搜索关键词，多个词用空格分隔，关键词越聚焦命中越准' } },
                required: ['query'],
                additionalProperties: false,
            },
            run: (args) => searchMemory(String(args.query ?? '')),
        },
    ];
    tools.forEach(registerTool);
}

/** 记忆块总数，供面板展示「N 条 / M 块」，让人一眼看到分块生效了。 */
export function memoryBlocks(): number {
    return items.reduce((n, item) => n + chunkEntry(item, 0).length, 0);
}

export function listMemories(): readonly string[] {
    return items;
}
```

代码按一条直线工作：

1. `chunkEntry` 把长记忆切成有重叠的小块；
2. `tokenize` 把问题拆成可匹配的 token；
3. `bm25` 给每个块打分，`topHits` 取前五名；
4. `recallMemory` 把命中块排成一段文字，准备放入 system prompt。

写入时仍保存完整记忆，只有搜索时才切块。因此 `.geekagent/memory.json` 的格式没有变化。

### 4.3 chat.ts：接收本轮记忆（+9 行）

`Chat` 新增一个字段保存本轮命中的记忆，并通过 `setRecall` 接收内容：

字段与 setter：

```ts
// day13/chat.ts
  private skillInstructions = '';
  /** Day 13：每轮用户输入触发的自动唤起记忆，拼进本轮 system prompt；空串表示无唤起。 */
  private recalled = '';
```

```ts
// day13/chat.ts
  /** Day 13：挂上本轮自动唤起的记忆文本；主程序在每次用户提问前调用，空串表示无唤起。 */
  setRecall(text: string): void {
    this.recalled = text;
  }
```

`systemPrompt()` 是每轮请求必走的，把唤起文本按需拼到最末：

```ts
// day13/chat.ts
  /** 组装 system prompt：任务基石 + 项目指令 + 技能指令 + 自动唤起记忆。 */
  private systemPrompt(): string {
    const skill = this.skillInstructions.trim();
    const recall = this.recalled.trim();
    return (
      `${AGENT_SYSTEM}\n\n项目指令（AGENTS.md）：\n${this.instructions || '暂无'}` +
      (skill ? `\n\n技能指令：\n${skill}` : '') +
      (recall ? `\n\n自动唤起长期记忆（仅供本轮参考，可能有噪声，涉及重要事实请与用户确认）：\n${recall}` : '')
    );
  }
```

`systemPrompt()` 在每次请求前重新组装，因此这些记忆会在本轮对话中一直可见。

### 4.4 index.ts：在回复前检索

先引入 `recallMemory`：

```ts
// day13/index.ts
import { listMemories, loadMemory, memoryBlocks, recallMemory, setupMemory } from './memory.js';
```

面板同时显示记忆条数和切块数：

```ts
// day13/index.ts
        `记忆  ${listMemories().length} 条 / ${memoryBlocks()} 块`,
```

最后在 `reply()` 开头检索，并把结果交给 `Chat`：

```ts
// day13/index.ts
async function reply(line: string): Promise<void> {
    usage.round = 0;
    chat.setRecall(recallMemory(line)); // 自动唤起：用户一开口，相关记忆先进 system prompt
```

至此流程连起来了：用户提问 → 检索记忆 → 写入 system prompt → 模型回答。

## 5. 验证

```bash
npm run typecheck
npm run dev -- day13/index.ts
```

1. 让模型保存一段超过 320 字、包含「压缩阈值 4000」的记忆；
2. 确认面板显示 1 条记忆和至少 2 个块；
3. 重启程序，换一种说法询问压缩阈值；
4. 确认回答包含 4000，且没有调用 `memory_search`；
5. 用 `/memory` 查看，确认磁盘中保存的仍是一条完整记忆。

## 6. 没做什么

- 不做向量检索，只按文字是否相近来搜索；
- 不支持修改、删除和合并记忆；
- 不记录记忆的时间，也不会判断内容是否过期；
- bigram 不理解同义词，换一种完全不同的说法可能搜不到。

## 7. 下一步

现在，Agent 会自动想起保存过的信息。下一步，我们把同样的切块和搜索方法用到教程、接口说明等外部文档中，让 Agent 能从一批资料里找到答案。
