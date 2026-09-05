---
lang: en
title: Build GeekAgent from Scratch — Day 13 Proactive Memory
description: >-
  A 7-day tutorial on building an Agent from scratch, writing the simplest possible Agent/Harness in TypeScript. Day 13 cuts long-term memory into small chunks, finds the relevant ones with BM25, and automatically places them into the context before every turn.
date: '2026-09-01 21:00:00'
tags:
  - Agent
  - Harness
book: geekagent
status: done
draft: false
---

# Day 13: Remembering Without Being Reminded — Proactive Memory

> Day 10 could already save important information into long-term memory, but the model only sees it by actively calling `memory_search`. Today the program searches automatically before every turn, so related memories are on hand the moment the model starts to answer.

## 0. Auto-Recall vs. the Model Searching Itself — What's the Difference?

Seeing "auto-recall", we might ask: `memory_search` already exists — why search again from the program?

`memory_search` is a tool. The model has to first realize "this question might relate to something from before" before it calls the tool. If the model doesn't think of that step, the memory never enters the context.

Auto-recall happens earlier: the moment the user's question arrives, the program searches long-term memory, then hands the related content to the model together with the question. It doesn't replace `memory_search`; it adds a default act of remembering to every turn.

| | Manual `memory_search` | Auto-recall |
|---|---|---|
| Initiated by | The model | The main program |
| When | When the model decides to call the tool | Before every turn starts |
| Query | Keywords the model composes | The user's raw question |
| Best for | Deliberate, targeted digging | Keeping the model from forgetting to search |

## 1. Why: Remembering Is Not Enough — You Have to Recall It

Day 10 has two memory tools: `memory_write` saves, `memory_search` searches. The catch is that searching depends on the model taking the initiative. If the model doesn't think to call the tool, the answer sitting on disk never enters the current conversation.

Two more search problems:

- As long as a long memory matches one word, the whole entry is returned, often carrying lots of irrelevant content;
- The old ranking only counted how many keywords matched, ignoring how common a word is or whether a memory is overly long.

We fix this in three steps: first cut long memories into small chunks, then score every chunk with BM25, and finally search automatically whenever the user asks.

## 2. Goals

1. Long memories are cut into chunks with a 320-char window and an 80-char overlap at search time; results are labeled "entry #N, chunk M" instead of returning the whole long text;
2. Chinese questions are split into bigrams while English words and numbers stay whole; BM25 then ranks by term frequency, commonness, and chunk length combined;
3. After each user question arrives, the search runs automatically and the top five matching chunks go into this turn's system prompt; none of this depends on the model choosing to call `memory_search`.

**Lines of code today**: relative to Day 12, 165 lines added, 31 removed, 134 net.

## 3. Design: From One Memory to One Automatic Recall

### 3.1 Chunk First, Then Search

`memory.json` still stores complete strings. At search time, we temporarily cut each memory into 320-char pieces, with adjacent pieces overlapping by 80 chars.

Two benefits: a search returns only the relevant little piece, and even if a sentence lands right at a cut point, the overlap guarantees it appears complete in one of the chunks.

### 3.2 Ranking with BM25

Text search usually has two routes: keyword search and vector search.

Vector search first turns the question and the text into strings of numbers with an embedding model, then compares how semantically close they are. It handles "different wording, similar meaning" well and is the common choice for semantic search, but it needs an extra embedding model and a vector index.

BM25 is the classic keyword search algorithm. It doesn't understand semantics, but it needs no trained model. With only a few dozen memories, it demonstrates the complete retrieval flow in very little code.

| | BM25 keyword search | Vector search |
|---|---|---|
| What's compared | Query words vs. text words | Query vector vs. text vector |
| Good at | Names, code, exact-word hits | Paraphrases, semantic nearness |
| Extra needs | Tokenizing and scoring | Embedding model, vector index |
| This demo | Adopted, zero new services | Skipped for now |

BM25's name comes from Okapi BM25. Don't memorize the formula; understand three rules:

- The more often a query word appears in a chunk, the higher the score;
- Common words that appear everywhere contribute less;
- Longer content doesn't win just by being long.

Auto-recall receives a Chinese question. Chinese has no spaces, so we cut each run of Chinese characters into adjacent pairs. For example, 历史压缩 (history compaction) becomes 历史, 史压, and 压缩. English words and numbers stay whole. This method is called bigram, and it needs no extra tokenization library.

Professional Chinese search usually uses a tokenizer that splits sentences into real words; bigrams can produce fragments like 史压 that mean nothing on their own. We pick bigrams here because the implementation is short, needs no dictionary, and covers more phrasings than whole-sentence matching. It's still literal search, though — it can't solve synonyms.

### 3.3 Recalling Automatically Before Each Turn

Every time user input arrives, `index.ts` calls `recallMemory` first. It splits the question into tokens, scores all memory chunks, and hands the top few to `Chat`, which appends them to this turn's system prompt.

The original `memory_search` stays. Auto-recall does the first sweep every turn; when the model wants sharper keywords, it can still call the tool itself.

## 4. Implementation: Effect First, Then Code

### 4.1 The Effect First

After startup comes the banner, then we have the model write a tech-selection story into long-term memory:

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#808080">GeekAgent Day 13 — Proactive Memory (BM25 chunking + auto-recall)</span>
<span style="color:#808080">Long-term memory is searched automatically before every question: relevant passages enter the context first, and long memories return only the matching chunks.</span>
<span style="color:#00cdcd">You › Write last month's tech selection into long-term memory: history compaction goes on day five, because context length first became a bottleneck; the trigger threshold MAX_HISTORY_CHARS defaults to 4000 chars, compaction keeps the most recent 6 entries, and KEEP_RECENT has never been touched since. Adding extra background so chunking can be verified — filler filler filler filler filler filler filler filler filler filler filler filler filler filler filler filler filler filler filler, and chunking uses a 320-char window with an 80-char overlap.</span>
<span style="color:#cdcd00">[tool call memory_write → remembered: Write last month's tech selection into long-term memory: history compaction goes on day five, because context length first became a bottleneck; the trigger threshold MAX_HISTORY_CHARS defaults to 4000 chars, compaction keeps the most recent 6 entries, and KEEP_RECENT has never been touched since. Adding extra background so chunking can be verified — filler filler filler filler filler……]</span>
<span style="color:#00cdcd">You › Done. Back then, why exactly did we put history compaction on day five?</span>
<span style="color:#00cd00">History compaction went on day five because context length had become a bottleneck for the first time. The trigger threshold is MAX_HISTORY_CHARS, which defaults to 4000 chars, and compaction keeps the most recent 6 entries.</span>
</pre>

After the second question, no `[tool call memory_search]` appeared. By the time the user's input reached the program, the related memory had already been placed into this turn's system prompt, so the model didn't need to call the tool.

Once a long entry is split into two chunks, the panel shows the chunk count too:

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#808080">──── Context ────</span>
<span style="color:#d4d4d4">…</span>
<span style="color:#808080">Memory  1 entry / 2 chunks</span>
</pre>

Let's start implementing from the retrieval core.

### 4.2 memory.ts: Chunking, Scoring, and Recall (202 Lines in Full)

`day13/memory.ts` holds the complete memory read/write and retrieval code:

```ts
// day13/memory.ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { registerTool, type Tool } from './tools.js';

const MEMORY_FILE = resolve('.geekagent/memory.json');
/** Memory entries are chunked by this character window; search and results both work on chunks, so even a long entry can be located down to a passage. */
const CHUNK_SIZE = 320;
/** Character overlap between adjacent chunks, so a conclusion isn't cut right at a chunk boundary. */
const CHUNK_OVERLAP = 80;
/** The max number of matching chunks returned per search — enough to be useful without blowing up the context. */
const MAX_RESULTS = 5;
/** BM25 smoothing parameters: smaller k1 is more sensitive to term frequency; larger b weakens length normalization. */
const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** Function words / common characters in queries: even many matches carry no discrimination, so they're ignored. */
export const STOPWORDS = new Set(['的', '了', '在', '是', '和', '一', '个', '也', '就', '都', '把', '被', '从', '到', '给', '与', '及', '这', '那', '并', '而', '等', '有', '没', '不', '我们', '一个', '可以']);

let items: string[] = [];

/** One chunk of a memory entry: which entry it belongs to, which passage within it, and its offset in the original text. */
export interface Chunk {
    entry: number;
    index: number;
    start: number;
    text: string;
}

/**
 * Split an entry into chunks of a fixed window + overlap; a short entry (within the window) is a single chunk.
 * The size parameter lets Day 14's knowledge base split documents with a larger window; omitted, the memory default applies.
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

/** Normalize: lowercase and collapse whitespace into single spaces. Query terms match as plain substrings, skipping tokenization. */
function norm(s: string): string {
    return s.toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Zero-dependency tokenization: runs of Chinese characters are split into character bigrams, English / digits keep whole words.
 * Natural-language questions have no word boundaries; bigrams are the smallest price for dropping the "space-separated keywords only" rule.
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

/** Count non-overlapping occurrences of term in text. */
function termCount(text: string, term: string): number {
    let n = 0, i = 0;
    while ((i = text.indexOf(term, i)) >= 0) {
        n++;
        i += term.length;
    }
    return n;
}

/**
 * BM25-lite: each query term contributes "tf × smoothed idf" to the score, normalized by document length.
 * The larger df (the more widespread a term), the smaller idf; long chunks gain no unfair edge because their term frequencies get diluted.
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

/** Run BM25 over the query tokens and return the top-k matching chunks; none at all when nothing matches. */
function topHits(query: string[], chunks: Chunk[]): Chunk[] {
    return chunks
        .map((chunk) => ({ chunk, score: bm25(chunk.text, query, chunks) }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_RESULTS)
        .map((hit) => hit.chunk);
}

/** Format matching chunks into a readable "entry #N, chunk M: content" list — the same text the model and the user see. */
function formatHits(hits: Chunk[]): string {
    return hits.map((c, i) => `${i + 1}. (entry #${c.entry + 1}, chunk ${c.index + 1}) ${c.text.trim()}`).join('\n');
}

/** Search memory chunks scored by BM25 (manual call): query is space-separated keywords. */
export function searchMemory(query: string): string {
    const keywords = query.toLowerCase().split(/\s+/).filter((w) => w && !STOPWORDS.has(w));
    if (keywords.length === 0) return 'no related memories found';
    const chunks = items.flatMap((item, entry) => chunkEntry(item, entry));
    if (chunks.length === 0) return 'no related memories found';
    const hits = topHits(keywords, chunks);
    return hits.length > 0 ? `found ${hits.length} related memories:\n${formatHits(hits)}` : 'no related memories found';
}

/**
 * Auto-recall before every turn: cut the user's raw text into bigram tokens and search directly; hits are spliced into
 * the system prompt as "auto-recalled memories" — the model needn't remember to search; memories are already on the desk.
 */
export function recallMemory(rawText: string): string {
    const keywords = tokenize(rawText).filter((t) => !STOPWORDS.has(t));
    if (keywords.length === 0) return '';
    const chunks = items.flatMap((item, entry) => chunkEntry(item, entry));
    if (chunks.length === 0) return '';
    const hits = topHits(keywords, chunks);
    return hits.length > 0 ? `auto-recalled ${hits.length} related memories (for reference):\n${formatHits(hits)}` : '';
}

/** The on-disk format stays string[], identical across reads, writes, and the in-memory copy. */
async function saveToDisk(next: string[]): Promise<void> {
    await mkdir(dirname(MEMORY_FILE), { recursive: true });
    await writeFile(MEMORY_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    items = next;
}

/** Restore long-term memory from disk at startup; a missing file simply means no memories yet. */
export async function loadMemory(): Promise<void> {
    try {
        const value = JSON.parse(await readFile(MEMORY_FILE, 'utf8')) as unknown;
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
            throw new Error('memory.json must be an array of strings');
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

/** Register the memory write / search tools. Writes still persist whole entries; chunks are cut on demand at search time. */
export function setupMemory(changed: () => void): void {
    const tools: Tool[] = [
        {
            name: 'memory_write',
            description: 'Write user preferences, project facts, or important decisions worth keeping across sessions into long-term memory. Long multi-paragraph text is supported; searches hit by chunk and return the relevant passages. Do not record temporary task progress or anything readable from files at any time.',
            parameters: {
                type: 'object',
                properties: { content: { type: 'string', description: 'a fact understandable even outside the current conversation; may be a long passage' } },
                required: ['content'],
                additionalProperties: false,
            },
            run: async (args) => {
                const content = String(args.content ?? '').trim();
                if (!content) return 'missing argument content';
                const entry = content.slice(0, 4000);
                if (items.includes(entry)) return 'this memory already exists';
                await saveToDisk([...items, entry]);
                changed();
                return entry.length < content.length ? `remembered (truncated for length): ${entry}` : `remembered: ${entry}`;
            },
        },
        {
            name: 'memory_search',
            description: 'Search long-term memory scored by BM25, returning the matching memory chunks (down to the passage). Call it when you need to recall user preferences, project facts, or past decisions; the query uses one or more space-separated keywords, e.g. "blog voice".',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string', description: 'search keywords, multiple words separated by spaces — the more focused, the more accurate the hits' } },
                required: ['query'],
                additionalProperties: false,
            },
            run: (args) => searchMemory(String(args.query ?? '')),
        },
    ];
    tools.forEach(registerTool);
}

/** Total number of memory chunks, shown in the panel as "N entries / M chunks" so chunking is visible at a glance. */
export function memoryBlocks(): number {
    return items.reduce((n, item) => n + chunkEntry(item, 0).length, 0);
}

export function listMemories(): readonly string[] {
    return items;
}
```

The code works along one straight line:

1. `chunkEntry` cuts long memories into overlapping small chunks;
2. `tokenize` splits the question into matchable tokens;
3. `bm25` scores every chunk, and `topHits` takes the top five;
4. `recallMemory` arranges the matching chunks into a passage, ready for the system prompt.

Writes still save the complete memory; chunks are cut only at search time. So the format of `.geekagent/memory.json` hasn't changed.

### 4.3 chat.ts: Receiving This Turn's Memory (+9 Lines)

`Chat` gains a field to hold the memory recalled this turn, received through `setRecall`:

Field and setter:

```ts
// day13/chat.ts
  private skillInstructions = '';
  /** Day 13: the auto-recalled memory triggered by each user input, spliced into this turn's system prompt; an empty string means no recall. */
  private recalled = '';
```

```ts
// day13/chat.ts
  /** Day 13: attach this turn's auto-recalled memory text; the main program calls it before every user question, and an empty string means no recall. */
  setRecall(text: string): void {
    this.recalled = text;
  }
```

`systemPrompt()` runs on every request, appending the recalled text at the end as needed:

```ts
// day13/chat.ts
  /** Assemble the system prompt: task cornerstone + project instructions + skill instructions + auto-recalled memory. */
  private systemPrompt(): string {
    const skill = this.skillInstructions.trim();
    const recall = this.recalled.trim();
    return (
      `${AGENT_SYSTEM}\n\nProject instructions (AGENTS.md):\n${this.instructions || 'none'}` +
      (skill ? `\n\nSkill instructions:\n${skill}` : '') +
      (recall ? `\n\nAuto-recalled long-term memories (for this turn's reference only; may contain noise — confirm important facts with the user):\n${recall}` : '')
    );
  }
```

Because `systemPrompt()` is reassembled before every request, these memories stay visible for the whole turn.

### 4.4 index.ts: Search Before Replying

First import `recallMemory`:

```ts
// day13/index.ts
import { listMemories, loadMemory, memoryBlocks, recallMemory, setupMemory } from './memory.js';
```

The panel shows both the number of memories and the number of chunks:

```ts
// day13/index.ts
        `Memory  ${listMemories().length} entries / ${memoryBlocks()} chunks`,
```

Finally, search at the top of `reply()` and hand the result to `Chat`:

```ts
// day13/index.ts
async function reply(line: string): Promise<void> {
    usage.round = 0;
    chat.setRecall(recallMemory(line)); // auto-recall: the moment the user speaks, related memories enter the system prompt first
```

With that, the flow is connected: the user asks → memory is searched → it goes into the system prompt → the model answers.

## 5. Verification

```bash
npm run typecheck
npm run dev -- day13/index.ts
```

1. Have the model save a memory longer than 320 chars that mentions "compaction threshold 4000";
2. Confirm the panel shows 1 memory entry and at least 2 chunks;
3. Restart the program and ask about the compaction threshold in different words;
4. Confirm the answer contains 4000 and no `memory_search` was called;
5. Check with `/memory` that what's stored on disk is still one complete memory.

## 6. What We Didn't Do

- No vector search; matching is purely by how close the text is;
- Memories can't be edited, deleted, or merged;
- Memories carry no timestamps, and stale content is never judged;
- Bigrams don't understand synonyms; a completely different phrasing may find nothing.

## 7. Next Step

Now the Agent automatically recalls the information it has saved. Next, we apply the same chunking and search method to external documents — tutorials, API references, and the like — so the Agent can find answers across a body of material.
