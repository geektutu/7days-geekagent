---
lang: en
title: Build GeekAgent from Scratch — Day 12 Code Search and Web Fetching
description: >-
  A 7-day tutorial on building an Agent from scratch, writing the simplest possible Agent/Harness in TypeScript. Day 12 adds `search` and `fetch`: one searches the repository by content, the other reads a web page and converts it to plain text.
date: '2026-08-31 21:30:00'
tags:
  - Agent
  - Harness
book: geekagent
status: done
draft: false
---

# Day 12: Search the Code Inside, Read the Web Outside — Code Search and Web Fetching

> Day 11 can switch tools per task, but the model still finds files only by filename and can't read a web page directly. Today we add `search` and `fetch`, solving these two problems one apiece.

## 1. Why: We Know the Content, but Not Which File It's In

`glob` can only match by filename. If we want to know where `safePath` is defined or called, we have to guess the file first, then `read` them one by one. With more code, this gets slow.

So we need `search`: give it a piece of text, and it returns every hit as `path:line: content`. The model locates first, then uses `read` to view the context.

The other gap is outside the repository. Dependency docs, technical blogs, and error pages all live on the web, and the model so far has no tool to read them. So we also need `fetch`: visit a page and turn its HTML into plain text the model can easily read.

One tool searches the repository inward; the other reads the web outward.

## 2. Goals

1. `search` matches content line by line inside the permission root and returns `relative path:line: text`; the model can hand hit paths to `read` for context;
2. `fetch` reads http/https pages, strips scripts, styles, and HTML tags, then hands the body to the model as plain text;
3. Local search runs directly by default; before visiting an external page, the full URL is shown and confirmed — the request goes out only after a yes.

**Lines of code today**: relative to Day 11, 135 lines added, 5 removed, 130 net.

## 3. Design: Search Locally, Read the Web

### 3.1 search: Why Not Just Call ripgrep

The common way to search code by content is to call ripgrep. It's fast, supports regex, and respects `.gitignore`. For a production-grade code search tool, ripgrep is the better choice.

The two options side by side:

| | ripgrep | Node `glob` + `readFile` |
|---|---|---|
| Speed | Fast, fits large repos | Slower, fits small repos |
| Search power | Regex, file filtering, `.gitignore` | Case-insensitive substring matching |
| Requirements | The system must have `rg` installed | Only the current Node runtime |
| Permission integration | Process paths need separate constraints | Reuses `safePath` directly |

So this version uses Node's built-in `glob` to enumerate files and `readFile` to match line by line. The code is more direct and adds no runtime requirement. The cost: both speed and search power fall short of ripgrep.

The search skips `node_modules`, hidden directories, large files, and binaries, and returns at most 50 lines. That fits the current small repository.

Results use the `path:line: content` format. With a path in hand, the model can call `read` to view nearby code.

### 3.2 fetch: Why Not an HTML Parsing Library

Turning web pages into text usually means `cheerio` to parse the DOM, or `turndown` to convert to Markdown. They preserve headings, lists, links, and code blocks more accurately.

| | `cheerio` | `turndown` | This `htmlToText` |
|---|---|---|---|
| Main purpose | Query and clean the DOM | HTML to Markdown | HTML to plain text |
| Structure kept | Up to us | Headings, lists, links fairly complete | Only paragraph line breaks |
| Dependency | Must install | Must install | No new dependency |
| Best for | Fine-grained web extraction | Keeping article structure | Getting the body to the model quickly |

The current goal is just letting the model read the body of docs and blog posts. Node already ships a global `fetch`, and a short `htmlToText` that strips scripts, styles, and tags completes the flow without a new dependency.

The trade-off loses page structure, and cleanup of complex pages falls short of a parsing library. For this demo we keep the body first; fuller web parsing can wait until it's genuinely needed.

`fetch` reaches external addresses, so by default it shows the target URL and asks first:

```
About to fetch:
http://127.0.0.1:8934/note.html
Confirm fetch?
```

Only http/https addresses are allowed. HTML is converted to plain text; other text content is returned as is.

### 3.3 Reusing Tool Registration and Permissions

Both tools are registered into `BUILTIN_TOOLS`. `search` goes through `safePath` to reuse Day 8's directory boundary, and `fetch` asks for confirmation through `authorize`. Day 11's skills can filter them just like any other tool.

## 4. Implementation: Effect First, Then Code

### 4.1 The Effect First

After startup, let the model search the code itself — the question is "find the definition and usages of `ensureToolPolicy` in day12":

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#808080">GeekAgent Day 12 — Code Search + Web Fetching</span>
<span style="color:#808080">Wondering where a piece of code lives? Just ask the model to search. Want to read docs or blog posts outside the repo? Have the model fetch them and convert to text. Results show path:line so you can follow along.</span>
<span style="color:#00cdcd">You › I forget what yesterday's skill helper ensureToolPolicy does — search day12 for its definition and usages</span>
<span style="color:#cdcd00">[tool call search → matched "ensureToolPolicy" on 3 lines:</span>
<span style="color:#cdcd00">day12/permissions.ts:72: export function ensureToolPolicy(tool: string, policy: Policy): void {</span>
<span style="color:#cdcd00">day12/skills.ts:6: import { ensureToolPolicy } from './permissions.js';</span>
<span style="color:#cdcd00">day12/skills.ts:103:         ensureToolPolicy(tool.name, 'ask'); // skill tools default to ask; users can change to allow in the config</span>
<span style="color:#cdcd00">]</span>
<span style="color:#00cd00">Defined at day12/permissions.ts:72. It fills in a default policy for tools missing from the config table. skills.ts adds ask for bundled tools when a skill loads (line 103), so yesterday's git_diff prompted for confirmation on first use instead of being blocked by a default deny. I can read both files for details if you want.</span>
</pre>

`search` returned three hits in one shot. The model can keep reading the code by path and line number instead of guessing filenames first.

Then start a local web page and have the model read it:

<pre style="background:#1e1e1e;color:#d4d4d4;padding:8px;border-radius:4px">
<span style="color:#00cdcd">You › There's a local page at http://127.0.0.1:8934/note.html — fetch it and see what it says</span>
<span style="color:#cdcd00">About to fetch:</span>
<span style="color:#cdcd00">http://127.0.0.1:8934/note.html</span>
<span style="color:#cdcd00">Confirm fetch? [y/N] → y</span>
<span style="color:#cdcd00">[tool call fetch → GeekAgent Study Notes, Day 12</span>
<span style="color:#cdcd00">Build GeekAgent from Scratch</span>
<span style="color:#cdcd00">Two new tools today: search searches the repo by content, fetch turns a web page into plain text.</span>
<span style="color:#cdcd00">search returns file:line: content, skipping node_modules and binary files</span>
<span style="color:#cdcd00">fetch uses built-in fetch + regex to strip tags, confirming before it connects</span>
<span style="color:#cdcd00">Next up: let the model read errors and self-heal after failed tool calls, and run several independent tools in parallel</span>
<span style="color:#cdcd00">]</span>
<span style="color:#00cd00">That's a page of GeekAgent study notes. It introduces two tools: search searches the repository by content, and fetch reads a web page and converts it to plain text.</span>
</pre>

`fetch` asks first, then returns plain text after confirmation. The page's headings, lists, and bold tags don't appear in the result.

### 4.2 The search Tool: Taking a Keyword

First, caps on search results, file size, and web wait time:

```ts
// day12/tools.ts
/** The max number of hit lines search returns; too many hits means the keyword isn't focused enough. */
const MAX_SEARCH_RESULTS = 50;
/** search only scans text files up to this size in bytes, skipping suspiciously large ones. */
const MAX_SEARCH_FILE_SIZE = 1024 * 1024;
/** The longest fetch wait; past the timeout, it's treated as a failure. */
const FETCH_TIMEOUT_MS = 15_000;
```

`search` takes two parameters: `pattern` is the keyword, `path` is an optional directory to search.

```ts
// day12/tools.ts
    {
        name: 'search',
        description: 'Search the repository by content (case-insensitive). Returns relative path:line: content — good for finding "which file contains this snippet or call". Skips node_modules, hidden paths, binaries, and files over 1MB by default.',
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'The keyword to search for, e.g. "safePath", a function name, or a line of error text.' },
                path: { type: 'string', description: 'The relative directory to search, defaults to the whole repo root; pass a subdirectory to speed things up.' },
            },
            required: ['pattern'],
            additionalProperties: false,
        },
        run: async (args) => {
            const pattern = String(args.pattern ?? '').trim();
            if (!pattern) return 'Missing argument: pattern';
            const sub = String(args.path ?? '').trim();
            try {
                const dir = sub ? await safePath(sub) : permissionRoot();
                const hits = await searchTree(dir, pattern.toLowerCase());
                if (hits.length === 0) return `No matches for "${pattern}"${sub ? ` (under ${sub})` : ''}`;
                const hint = hits.length >= MAX_SEARCH_RESULTS ? `\n...(hit the limit of ${MAX_SEARCH_RESULTS} lines; try a more focused keyword)` : '';
                return `Matched "${pattern}" on ${hits.length} lines:\n${hits.join('\n')}${hint}`;
            } catch (err) {
                return `search failed: ${(err as Error).message}`;
            }
        },
    },
```

`run` resolves the search directory first, then calls `searchTree`. Matching is case-insensitive; it stops at 50 lines and hints that the model should pick a more specific keyword.

### 4.3 searchTree: Hunting Content Line by Line

`searchTree` enumerates files with `glob('**/*')`, skips `node_modules` and hidden paths, then reads each text file and matches line by line:

```ts
// day12/tools.ts
/**
 * Search by content inside dir: enumerate files with Node's built-in glob (hidden paths and node_modules skipped
 * by default), skip binaries (containing null bytes) and oversized files, match case-insensitively line by line, and
 * stop at the cap. Returns a list of "path relative to root:line: content", in ripgrep's format.
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
            continue; // the file may have been deleted while walking
        }
        if (!st.isFile() || st.size > MAX_SEARCH_FILE_SIZE) continue;
        let text: string;
        try {
            text = await readFile(file, 'utf8');
        } catch {
            continue;
        }
        if (text.includes('\0')) continue; // null bytes mean it's basically binary; skip
        text.split('\n').forEach((line, i) => {
            if (hits.length >= MAX_SEARCH_RESULTS) return;
            if (line.toLowerCase().includes(pattern)) hits.push(`${rel}:${i + 1}: ${line.trimEnd()}`);
        });
    }
    return hits;
}
```

Every result's path is computed relative to the permission root. The model can pass that path straight to `read`. Each matching line in a file is recorded with its line number.

### 4.4 The fetch Tool: Read and Convert a Web Page

`fetch` takes a full URL and visits the page after confirmation:

```ts
// day12/tools.ts
    {
        name: 'fetch',
        description: 'Fetch a web page and convert it to plain text so the model can see information beyond the repo (docs, blog posts, error pages, etc.). Uses the ask policy by default and needs confirmation before running; only supports http/https.',
        parameters: {
            type: 'object',
            properties: { url: { type: 'string', description: 'The full URL to fetch, starting with http:// or https://.' } },
            required: ['url'],
            additionalProperties: false,
        },
        run: async (args) => {
            const input = String(args.url ?? '').trim();
            if (!input) return 'Missing argument: url';
            let target: URL;
            try {
                target = new URL(input);
            } catch {
                return `Invalid URL: ${input}`;
            }
            if (target.protocol !== 'http:' && target.protocol !== 'https:') return 'Only http/https links are supported';
            if (!(await authorize('fetch', `\nAbout to fetch:\n${input}\nConfirm fetch?`))) return 'Fetch cancelled';
            try {
                const res = await fetch(target, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
                if (!res.ok) return `Request failed: HTTP ${res.status} ${res.statusText}`;
                const text = await res.text();
                const contentType = res.headers.get('content-type') ?? '';
                const body = /\bhtml\b/.test(contentType) ? htmlToText(text) : text;
                return truncate(body);
            } catch (err) {
                const e = err as Error;
                return e.name === 'TimeoutError' ? `Fetch timed out (${FETCH_TIMEOUT_MS / 1000}s); try again later` : `Fetch failed: ${e.message}`;
            }
        },
        authorizes: true,
    },
```

`authorizes: true` means the confirmation is handled by the tool itself, which is why the prompt can show the URL about to be visited. When the response is HTML, `htmlToText` runs; otherwise the text is returned as is.

`htmlToText` strips scripts, styles, comments, and tags in order:

```ts
// day12/tools.ts
/**
 * Minimal HTML → plain text: strip scripts/styles/comments, turn block-level tags into line breaks,
 * decode common entities. No full parsing — just enough to read docs and posts as usable text.
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

Block-level tags become line breaks first, remaining tags are removed, then common HTML entities are decoded and empty lines cleaned up. That keeps the body's basic paragraphs.

### 4.5 permissions.ts and index.ts: Finishing the Wiring

Two tools join the permission table:

```ts
// day12/permissions.ts
    ls: 'allow',
    read: 'allow',
    glob: 'allow',
    search: 'allow',
    fetch: 'ask',
    write: 'ask',
```

The entry file updates the startup banner:

```ts
// day12/index.ts
tui.append('GeekAgent Day 12 — Code Search + Web Fetching', 'sys');
tui.append('Wondering where a piece of code lives? Just ask the model to search. Want to read docs or blog posts outside the repo? Have the model fetch them and convert to text. Results show path:line so you can follow along.', 'sys');
```

The full flow: `search` locates the code, then `read` views the context; or `fetch` reads a web page and the model answers straight from the plain text.

## 5. Verification

```bash
npm run typecheck
npm run dev -- day12/index.ts
```

1. Ask "search day12 for the definition and usages of `ensureToolPolicy`" and confirm the results include paths and line numbers;
2. Create `note.html` and run `python3 -m http.server 8934` in its directory:

```html
<!-- note.html -->
<!DOCTYPE html>
<html>
<head><title>GeekAgent Study Notes, Day 12</title></head>
<body>
<h1>Build GeekAgent from Scratch</h1>
<p>Two new tools today: <b>search</b> searches the repo by content, <b>fetch</b> turns a web page into plain text.</p>
<ul>
  <li>search returns file:line: content, skipping node_modules and binary files</li>
  <li>fetch uses built-in fetch + regex to strip tags, confirming before it connects</li>
  <li>Next up: let the model read errors and self-heal after failed tool calls, and run several independent tools in parallel</li>
</ul>
</body>
</html>
```

3. Have the model read `http://127.0.0.1:8934/note.html`;
4. Confirm the program shows the URL and asks first, and that after `y` it returns the body without HTML tags.

## 6. What We Didn't Do

- `search` supports no regex, no file-type filtering, and no result ranking;
- `search` doesn't read `.gitignore`;
- `fetch` returns plain text only — heading levels, links, and code block structure are lost;
- `fetch` doesn't handle pages that need a login or JavaScript rendering;
- Neither tool caches anything.

## 7. Next Step

Now the Agent can search the repository and read web pages. Next we can keep expanding how it uses long-term information, so saved content shows up on its own when needed.
