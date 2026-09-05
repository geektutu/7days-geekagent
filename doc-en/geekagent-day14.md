---
lang: en
title: Build GeekAgent from Scratch — Day 14 Lightweight RAG Knowledge Base
description: >-
  A 7-day tutorial on building an Agent from scratch, writing the simplest possible Agent/Harness in TypeScript. Day 14 reuses Day 13's chunking and BM25 search to build a lightweight knowledge base that collects web pages and files and returns the relevant passages for a question.
date: '2026-09-01 23:00:00'
tags:
  - Agent
  - Harness
book: geekagent
status: done
draft: false
---

# Day 14: Look It Up First, Then Answer — A Lightweight RAG Knowledge Base

> Day 13 could find related content in long-term memory. Today we apply the same method to web pages and files: documents live on disk, and when a question comes in, only the relevant few passages are fetched back.

## 0. Isn't a Knowledge Base Just More Long-Term Memory?

Both are "save content, then search it by question" — but they save different things.

| | Long-term memory | RAG knowledge base |
|---|---|---|
| What it saves | User preferences, project facts, important decisions | External material such as tutorials, manuals, and blogs |
| Content scale | A few short texts | Many long documents |
| How it's written | The model distills it and calls `memory_write` | A program collects the original text and chunks it |
| Role in answering | Supplements past context | Provides evidence and sources for material-related questions |

Writing an entire tutorial into memory would blur the line between "facts we need to remember long-term" and "material we need to look up on demand". So we build a separate knowledge base, while reusing Day 13's chunking and search algorithms.

## 1. Why: You Can't Cram a Whole Document into the Context

Long-term memory suits short items like user preferences and project decisions. Tutorials, API references, and blog posts are usually much longer and don't fit as a single memory entry.

If we made the model read a whole document every time, two problems arise:

- The document would eat a large slice of the context window;
- The model only needs a few passages, yet it has to read the full text over and over.

RAG stands for "Retrieval-Augmented Generation". First store documents in a knowledge base, then search for the relevant passages based on the question, and finally hand those passages to the model to answer. In short: **look it up first, then answer**.

Day 13 already implemented chunking, tokenization, and BM25 scoring. Today we reuse those functions and only add document collection, storage, and the tool wiring.

## 2. Goals

1. `rag_add` reads a web page or local file, chunks the body text into 800-character windows, and writes them into `.geekagent/rag/index.json`; collection returns only a summary, and the full text never enters the current context;
2. `rag_search` tokenizes a natural-language question and ranks it with BM25, returning at most four relevant chunks, each tagged with its document title and passage number;
3. `/rag add <URL or path>...` collects several sources in a row, and `/rag` shows the document count, chunk count, and source list.

**Lines of code for the day**: compared with Day 13, the source gains 184 lines and loses 5 — a net gain of 179.

## 3. Design: Collection, Storage, Retrieval

### 3.1 A Simple RAG Pipeline

A common RAG system contains two stages.

The **ingestion stage** prepares the material: collect documents, clean the text, chunk it, then use an embedding model to produce vectors and write them into a vector database.

The **query stage** finds the evidence: convert the question into a vector too, retrieve the nearby text chunks, optionally re-rank them with a reranker, and finally hand a few results to the large language model to generate the answer.

Two common terms appear here: an embedding turns text into comparable numeric vectors; a reranker takes a second, closer look at whether the candidate results really match the question.

This demo keeps the backbone and swaps vector retrieval for Day 13's BM25, and the vector database for a single JSON file:

| Stage | Mainstream RAG | This demo |
|---|---|---|
| Document processing | Parsing, cleaning, semantic chunking | Basic HTML cleanup, fixed-window chunking |
| Retrieval representation | Embedding vectors | bigram tokens |
| Index storage | Vector database | Text chunks in a JSON file |
| Recall and ranking | Vector recall, often with a reranker | BM25 takes the top four chunks directly |
| Document maintenance | Incremental updates, deletion, versioning | A full rewrite after each added document |

The code still comes down to four steps:

1. Read a web page or file;
2. Chunk the body text into roughly 800-character pieces;
3. Write the title, source, and chunks into the JSON;
4. When asked a question, use BM25 to pick the four most relevant chunks.

This already demonstrates the core loop of "ingest material → search by question → answer with sources", hence the name lightweight RAG. It suits a handful of tutorials and local documents; it is not meant to replace a vector database serving large-scale corpora.

### 3.2 Keep Collection and Reading Apart

Day 12's `fetch` returns the body of a web page directly to the model. `rag_add` is different: reading, chunking, and writing to disk all happen inside the program, and only one line about the ingestion comes back. This way, collecting a long article doesn't consume the current context.

Only when the model calls `rag_search` does the program hand back the few matching passages. `rag_add` reads external content and writes to the knowledge base, so it asks first; `rag_search` only reads local data and can run directly.

### 3.3 Reuse Day 13's Search Functions

`rag_search` doesn't rewrite the scoring code; it imports Day 13's functions directly:

```ts
// day14/rag.ts
import { STOPWORDS, bm25, chunkEntry, tokenize, type Chunk } from './memory.js';
```

`rag.ts` imports four members from Day 13: `chunkEntry` does the chunking, `tokenize` splits the question, `STOPWORDS` removes common words, and `bm25` does the scoring.

Memory chunks entries at 320 characters by default; the knowledge base passes 800 when calling `chunkEntry`. The search method is identical — the two kinds of content just use different chunk sizes.

The knowledge base uses larger chunks to preserve a relatively complete stretch of document context for the model. A fixed window is simple to implement, but it can cut right between a heading and its body; mature solutions often chunk by paragraph, heading, or token count, and sometimes prepend the document title to each chunk.

### 3.4 Store It in One JSON File

Persistence is a single `.geekagent/rag/index.json`:

```json
{
  "docs": [
    {
      "title": "Day 5 Study Notes",
      "source": "http://127.0.0.1:8934/notes/day5.html",
      "addedAt": "2026-09-01T...",
      "chunks": [{ "start": 0, "text": "…" }, { "start": 720, "text": "…" }]
    }
  ]
}
```

Each document stores its title, source, add time, and text chunks. The file is read in at startup, and a search walks all chunks and scores them. For a few dozen tutorials, this is plenty.

## 4. Implementation: Effect First, Then Code

### 4.1 The Effect First

After startup, collect the two note pages into the base first (serve them locally with `python3 -m http.server 8934`; I put the pages at `notes/day5.html` and `notes/day9.html`):

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#808080">GeekAgent Day 14 — lightweight RAG knowledge base</span>
<span style="color:#808080">Long-term memory stores project facts; the knowledge base stores external material: /rag add collects a web page or file, and rag_search returns relevant passages with sources.</span>
<span style="color:#00cdcd">You › /rag add http://127.0.0.1:8934/notes/day5.html</span>
<span style="color:#cdcd00">About to add the following to the knowledge base:</span>
<span style="color:#cdcd00">http://127.0.0.1:8934/notes/day5.html</span>
<span style="color:#cdcd00">Confirm collection? [y/N] → y</span>
<span style="color:#cdcd00">[Added to knowledge base: "Day 5 Study Notes" — 1042 characters / 2 chunks]</span>
<span style="color:#00cdcd">You › /rag add http://127.0.0.1:8934/notes/day9.html</span>
<span style="color:#cdcd00">About to add the following to the knowledge base:</span>
<span style="color:#cdcd00">http://127.0.0.1:8934/notes/day9.html</span>
<span style="color:#cdcd00">Confirm collection? [y/N] → y</span>
<span style="color:#cdcd00">[Added to knowledge base: "Day 9 Study Notes" — 886 characters / 2 chunks]</span>
<span style="color:#00cdcd">You › /rag</span>
<span style="color:#808080">Knowledge base: 2 documents / 4 chunks / 2088 characters:</span>
<span style="color:#808080">1. "Day 5 Study Notes" (2 chunks, http://127.0.0.1:8934/notes/day5.html)</span>
<span style="color:#808080">2. "Day 9 Study Notes" (2 chunks, http://127.0.0.1:8934/notes/day9.html)</span>
<span style="color:#00cdcd">You › In these notes, what is the trigger threshold for history compaction?</span>
<span style="color:#cdcd00">[Calling tool rag_search → 2 chunks matched:</span>
<span style="color:#cdcd00">1. "Day 5 Study Notes", passage 2: …trigger threshold MAX_HISTORY_CHARS defaults to 4000 characters, compaction keeps the most recent 6…</span>
<span style="color:#cdcd00">2. "Day 9 Study Notes", passage 1: Chapter 2, the planner. …]</span>
<span style="color:#00cd00">Passage 2 of "Day 5 Study Notes" says it plainly: history compaction triggers at MAX_HISTORY_CHARS, 4000 characters by default, and compaction keeps the most recent 6 messages. This answer came from the knowledge base retrieval, not from my guessing.</span>
</pre>

`/rag add` asks first and then collects, returning only one line of result. When a real question comes in, the model calls `rag_search` and receives relevant content tagged with its title and passage number.

### 4.2 rag.ts: The Knowledge Base Itself (149 Lines in Full)

New file `day14/rag.ts`, posted in full:

```ts
// day14/rag.ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { registerTool, type Tool } from './tools.js';
import { authorize, safePath } from './permissions.js';
import { STOPWORDS, bm25, chunkEntry, tokenize, type Chunk } from './memory.js';
import { htmlToText } from './tools.js';

const RAG_FILE = resolve('.geekagent/rag/index.json');
/** Chunking window for documents: larger than memory entries (whole documents), so knowledge-base chunks are coarser. */
const RAG_CHUNK_SIZE = 800;
/** Longest wait for a network fetch. */
const FETCH_TIMEOUT_MS = 15_000;
/** Per-document ingestion cap; anything larger is dropped whole to stay in control. */
const MAX_DOC_CHARS = 2 * 1024 * 1024;
/** Maximum number of chunks a single search returns. */
const MAX_RESULTS = 4;

/** A document in the knowledge base: title, source, and its chunked passages. */
interface RagDoc {
    title: string;
    source: string;
    addedAt: string;
    chunks: { start: number; text: string }[];
}

let docs: RagDoc[] = [];

/** Restore the knowledge base from disk at startup; a missing file counts as an empty base. */
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

/** Write docs to disk in full. */
async function saveRag(): Promise<void> {
    await mkdir(dirname(RAG_FILE), { recursive: true });
    await writeFile(RAG_FILE, `${JSON.stringify({ docs }, null, 2)}\n`, 'utf8');
}

/**
 * Collect a web page (http/https) or local file into the knowledge base. The full text travels an internal channel,
 * never the model's context; chunks are saved to disk with the index, then searched via rag_search. Duplicate sources are skipped.
 */
export async function addToRag(source: string): Promise<string> {
    const target = source.trim();
    if (!target) return 'Missing a source to collect';
    if (!(await authorize('rag_add', `\nAbout to add the following to the knowledge base:\n${target}\nConfirm collection?`))) return 'Collection cancelled';
    if (docs.some((d) => d.source === target)) return 'Already in the knowledge base, skipped (duplicate source)';

    let title: string;
    let text: string;
    try {
        if (/^https?:\/\//i.test(target)) {
            const res = await fetch(target, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
            if (!res.ok) return `Fetch failed: HTTP ${res.status} ${res.statusText}`;
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
        return `Collection failed: ${(err as Error).message}`;
    }

    if (!text.trim()) return 'Content is empty, not ingested';
    if (text.length > MAX_DOC_CHARS) return `Content too large (${text.length} characters, 2MB cap), not ingested`;
    const chunks = chunkEntry(text, 0, RAG_CHUNK_SIZE);
    docs.push({ title: title.slice(0, 120), source: target, addedAt: new Date().toISOString(), chunks });
    await saveRag();
    return `Added to knowledge base: "${title.slice(0, 120)}" — ${text.length} characters / ${chunks.length} chunks`;
}

/** Search the knowledge base for relevant passages with BM25: query takes natural language (split into bigram tokens internally) or space-separated keywords. */
export function ragSearch(query: string): string {
    const keywords = tokenize(query).filter((t) => !STOPWORDS.has(t));
    if (keywords.length === 0) return 'No knowledge chunks matched';
    const all: Chunk[] = docs.flatMap((doc, di) => doc.chunks.map((c, ci) => ({ entry: di, index: ci, start: c.start, text: c.text })));
    if (all.length === 0) return 'The knowledge base is still empty; collect something first with rag_add or /rag add';
    const hits = all
        .map((chunk) => ({ chunk, score: bm25(chunk.text, keywords, all) }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_RESULTS);
    if (hits.length === 0) return 'No knowledge chunks matched; try a more focused phrasing';
    return `${hits.length} chunks matched:\n${hits
        .map((h, i) => {
            const doc = docs[h.chunk.entry];
            return `${i + 1}. "${doc.title}", passage ${h.chunk.index + 1}: ${h.chunk.text.trim()}`;
        })
        .join('\n')}`;
}

/** Knowledge base overview: document count, chunk count, character count, and the document list, shown directly by the /rag command. */
export function ragStats(): string {
    if (docs.length === 0) return 'The knowledge base is still empty (collect with /rag add, or have the model call rag_add)';
    const blocks = docs.reduce((n, d) => n + d.chunks.length, 0);
    const chars = docs.reduce((n, d) => n + d.chunks.reduce((m, c) => m + c.text.length, 0), 0);
    return `Knowledge base: ${docs.length} documents / ${blocks} chunks / ${chars} characters:\n${docs
        .map((d, i) => `${i + 1}. "${d.title}" (${d.chunks.length} chunks, ${d.source})`)
        .join('\n')}`;
}

/** Register the rag tools: collection (ask) and search (allow). */
export function setupRag(changed: () => void): void {
    const tools: Tool[] = [
        {
            name: 'rag_add',
            description: 'Collect a web page (http/https) or local file into the knowledge base: chunk the full text, build the index, then search it by question with rag_search. Collection goes through an internal channel — the body never enters the current context, which suits bulk document ingestion. Before answering questions about tutorials or reference material, collect the relevant document first if it is missing. Default policy: ask.',
            parameters: {
                type: 'object',
                properties: { source: { type: 'string', description: 'Full URL of a web page (http/https) or a file path inside the repository' } },
                required: ['source'],
                additionalProperties: false,
            },
            run: (args) => addToRag(String(args.source ?? '').trim()),
            authorizes: true,
        },
        {
            name: 'rag_search',
            description: 'Search the knowledge base for relevant passages with BM25, returning the matching chunks and their source titles. Before answering anything involving knowledge-base content — project docs, tutorials, blog series, local material — call it first to find the evidence. The query can be a plain natural-language question; space-separated keywords work too.',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string', description: 'What to search for, written as natural language, e.g. "What does Day 5 of this tutorial do"' } },
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

Three functions carry the main flow:

1. `addToRag` reads a source, converts HTML to plain text, chunks it at 800 characters, and saves it;
2. `ragSearch` splits the question, scores every chunk, and returns the top four;
3. `ragStats` totals the documents, chunks, and sources for the `/rag` display.

### 4.3 memory.ts: Reusing the Search Capability

`chunkEntry` already accepts a chunk size. The knowledge base passes 800; memory passes nothing and keeps the default 320:

```ts
// day14/memory.ts
export interface Chunk {
    entry: number;
    index: number;
    start: number;
    text: string;
}

/**
 * Split an entry into chunks with a fixed window plus overlap; a short entry (within the window) is one chunk.
 * The size parameter lets the Day 14 knowledge base chunk documents with a larger window; omit it to keep memory's default.
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

`tokenize`, `bm25`, and `STOPWORDS` are imported straight from `memory.ts` too. `rag.ts` no longer reimplements tokenization or scoring.

### 4.4 permissions.ts and tools.ts: The Remaining Wiring

Two tools join the permission table. Collection asks by default; search is allowed by default:

```ts
// day14/permissions.ts
    memory_write: 'allow',
    memory_search: 'allow',
    rag_add: 'ask',
    rag_search: 'allow',
};

```

`tools.ts` already had `htmlToText`; add `export` to it, and `rag.ts` can reuse the web-page-to-text code.

### 4.5 index.ts: Loading the Base and Handling the Command

First import the knowledge base functions and load the data at startup:

```ts
// day14/index.ts
import { addToRag, loadRag, ragStats, setupRag } from './rag.js';
```

```ts
// day14/index.ts
try {
    await loadRag();
} catch (e) {
    console.error(`Failed to read the knowledge base: ${(e as Error).message}`);
    process.exit(1);
}
```

Then register the two RAG tools:

```ts
// day14/index.ts
setupMemory(updatePanel);
setupRag(updatePanel);
```

Finally, handle the `/rag` command. With no arguments it shows the overview; `add` takes one or more sources:

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
                        tui.append(`Collection failed: ${(e as Error).message}`, 'sys');
                    }
                }
            } else {
                tui.append('Usage: /rag add <web URL or file path>... to collect and index; /rag to view the knowledge base', 'sys');
            }
            break;
        }
```

At this point the flow connects: `/rag add` collects a document → `rag_search` finds the relevant chunks → the model answers from content that carries its sources.

## 5. Verification

```bash
npm run typecheck
npm run dev -- day14/index.ts
```

1. Create an HTML note and start a local server in its directory:

```html
<!-- notes/day5.html -->
<!DOCTYPE html>
<html>
<head><title>Day 5 Study Notes</title></head>
<body>
<h1>History Compaction</h1>
<p>Chapter 1, history compaction. The trigger threshold MAX_HISTORY_CHARS defaults to 4000 characters, and compaction keeps the most recent 6 messages.</p>
<!-- Add more body text so the page exceeds 800 characters, making the chunking easy to observe -->
</body>
</html>
```

2. Run `/rag add http://127.0.0.1:8934/day5.html` and enter `y` to confirm;
3. Run `/rag` and check that the document title, chunk count, and source appear;
4. Ask "what is the trigger threshold for history compaction";
5. Confirm the model calls `rag_search`, the answer contains 4000, and it cites "Day 5 Study Notes" with the passage number.

## 6. What We Didn't Do

- Retrieval is keyword matching only — no vector search or result re-ranking; chunking and HTML cleanup use basic rules only;
- Documents cannot be deleted, updated, or auto-synced once ingested;
- Long-term memory and the knowledge base are still searched separately, with no unified recall and ranking.

## 7. Next Step

RAG lets the Agent find content in external material, but collection and retrieval are still local tools written into the project. Next, we look beyond the process: if a database, a browser, or a service maintained by another team also wants to offer tools, how does the Agent discover and call them in a uniform way?
