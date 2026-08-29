#!/usr/bin/env node
/**
 * doc/*.md → doc/geekagent-book.pdf
 *
 * Typst 一站式排版：本脚本只负责列出 doc/ 下的 md、拼一个 .typ 壳子（封面 +
 * 目录 + 逐篇渲染），Markdown → Typst 交给 cmarker 包，PDF 由 typst CLI 编译。
 */
import { execFileSync } from "node:child_process";
import { readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DOC = join(resolve(import.meta.dirname, ".."), "doc");
const OUT = join(DOC, "geekagent-book.pdf");

const TEMPLATE = `#import "@preview/cmarker:0.1.6": render
#set page(paper: "a4", margin: (x: 2.8cm, y: 2cm), numbering: "1", number-align: center)
#set text(font: "Noto Sans CJK SC", size: 10pt, lang: "zh")
#set par(leading: 1em, spacing: 1.2em)
// 本机 Noto Sans CJK SC 只有 Regular 字重，用描边模拟粗体
#show heading: set text(stroke: 0.6pt)
#show heading: set block(above: 2em, below: 1.6em)

#text(size: 20pt, weight: "bold", stroke: 0.6pt)[GeekAgent：28 天从零实现 Agent]
#v(1em)
#outline(depth: 1)
#pagebreak()

{items}
`;

const mdFiles = readdirSync(DOC).filter(f => f.endsWith(".md")).sort((a, b) => {
  const num = (f: string) => Number(f.match(/\d+/)?.[0] ?? 0);
  return num(a) - num(b);
});
if (mdFiles.length === 0) {
  console.error("doc/ 下没有 .md 文件");
  process.exit(1);
}

// 逐篇渲染、篇间分页；✅ 是 emoji（U+2705），Noto 无此字形，替换为 ✓
const items = mdFiles
  .map(f => `#render(read("${f}").replace("✅", "✓"), html: (
  // 让 Markdown 里的 <span style="color:#hex">…</span> 在 Typst 里也上色，
  // 与 HTML 博客共用同一套写法（HTML 侧原生支持，无需此处理）。
  span: (attrs, body) => {
    let raw = attrs.at("style", default: "color:#000000")
    let hex = raw.split("color:").at(1, default: "#000000").trim()
    text(fill: rgb(hex), body)
  },
  // 终端效果 demo 用 <pre> 包裹：HTML 侧原生等宽保留换行；
  // Typst 侧这里按行解析 <span style="color:#hex">…</span> 并上色，整体包成灰底终端块。
  pre: ("raw-text", (attrs, body) => {
    let lines = body.split("\\n").filter(l => l.trim() != "")
    let out = ()
    let row = (left-color, left, right-color, right) => {
      let right = right.replace(regex("^ +"), "")
      let left-box = box(width: 65%, text(fill: rgb(left-color), left.replace(regex(" +$"), "")))
      let right-box = box(width: 35%, text(size: 7.5pt, fill: rgb(right-color), right))
      left-box + right-box
    }
    for l in lines {
      let rule = l.match(regex("^<span style=\\"grid-column:1/-1;border-top:1px solid (#[0-9a-fA-F]+);height:0\\"></span>$"))
      if rule != none {
        out.push(line(length: 100%, stroke: 0.5pt + rgb(rule.captures.at(0))))
      } else {
        let pair = l.match(regex("^<span style=\\"color:(#[0-9a-fA-F]+)\\">(.*?)</span><span style=\\"color:(#[0-9a-fA-F]+)\\">(.*?)</span>$"))
        if pair != none {
          out.push(row(pair.captures.at(0), pair.captures.at(1), pair.captures.at(2), pair.captures.at(3)))
        } else {
          let single = l.match(regex("^<span style=\\"color:(#[0-9a-fA-F]+)\\">(.*)</span>$"))
          if single == none {
            out.push(l)
          } else {
            let split = single.captures.at(1).match(regex("^(.*?)│(.*)$"))
            if split == none {
              if single.captures.at(1).match(regex("^─+$")) != none {
                out.push(line(length: 100%, stroke: 0.5pt + rgb(single.captures.at(0))))
              } else {
                out.push(text(fill: rgb(single.captures.at(0)), single.captures.at(1)))
              }
            } else {
              out.push(row(single.captures.at(0), split.captures.at(0), single.captures.at(0), "│" + split.captures.at(1)))
            }
          }
        }
      }
    }
    block(inset: 8pt, fill: rgb("#1e1e1e"), radius: 4pt, text(fill: rgb("#d4d4d4"), out.join(linebreak())))
  }),
))`)
  .join("\n#pagebreak()\n");

const build = join(DOC, ".book.typ");
writeFileSync(build, TEMPLATE.replace("{items}", items));
try {
  execFileSync("typst", ["compile", build, OUT], { stdio: "inherit" });
} finally {
  unlinkSync(build);
}

console.log(`已生成 doc/geekagent-book.pdf（${mdFiles.length} 篇）`);
