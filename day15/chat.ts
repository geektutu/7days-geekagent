import OpenAI from 'openai';
import { execTool, toOpenAITools } from './tools.js';

/** 工具调用循环的最多轮数，防止模型陷入「调用工具 → 再调用」的死循环。 */
const MAX_TOOL_TURNS = 30;

const AGENT_SYSTEM = `你是一个本地编码 Agent。遇到需要多个步骤的任务时，先调用 todo_write 制定简短计划，再逐项执行并更新状态；用户明确要求 TODO 或任务清单时，必须先调用 todo_write。简单任务直接完成，不要为了形式创建 TODO。可把边界清楚的分析、设计或审查任务交给 delegate_task，多个子任务必须串行委派。用户偏好、项目事实或重要决定值得跨会话保留时，调用 memory_write；需要回忆这些信息时调用 memory_search，不要假设记忆内容。不要记录临时任务进度或可随时从文件读到的内容。`;

/** 单次请求的用量信息（同 OpenAI 的 usage 字段）。 */
export interface UsageInfo {
    prompt: number;
    completion: number;
    total: number;
}

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

/**
 * 对话会话：持有上下文记忆（history），以流式方式请求 OpenAI 兼容接口。
 * history 直接用 OpenAI 的消息类型，与接口零转换。
 * Day 2 起具备工具调用能力：模型要求 → 执行工具 → 结果回传 → 继续，直到模型给出最终回答。
 * Day 5 起具备历史压缩：history 超长时先让模型摘要旧消息，腾出上下文。
 * Day 6 起可导入、导出 history，供多会话管理器在切换时保存与恢复。
 * Day 7 起每次请求回报用量（usage），供面板实时展示。
 */
export class Chat {
  private client: OpenAI;
  private model: string;
  private instructions: string;
  private skillInstructions = '';
  /** Day 13：每轮用户输入触发的自动唤起记忆，拼进本轮 system prompt；空串表示无唤起。 */
  private recalled = '';
  private history: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  /** Day 7：每次请求拿到用量就回调出去，供 TUI 面板累计显示。 */
  private onUsage?: (u: UsageInfo) => void;

  constructor(baseURL: string, apiKey: string, model: string, instructions: string) {
    this.client = new OpenAI({ baseURL, apiKey });
    this.model = model;
    this.instructions = instructions;
  }

  /** Day 11：挂上当前技能的指令，拼接进每次请求的 system prompt；传空串表示无技能。 */
  setSkillInstructions(text: string): void {
    this.skillInstructions = text;
  }

  /** Day 13：挂上本轮自动唤起的记忆文本；主程序在每次用户提问前调用，空串表示无唤起。 */
  setRecall(text: string): void {
    this.recalled = text;
  }

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

  setUsageListener(fn: (u: UsageInfo) => void): void {
    this.onUsage = fn;
  }

  /** 子 Agent 使用独立上下文完成一个聚焦任务，结果回到主 Agent 后再继续 pipeline。 */
  async delegate(task: string): Promise<string> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: '你是子 Agent。只完成给定子任务，返回简洁、可直接交给主 Agent 使用的结果；不要寒暄。' },
        { role: 'user', content: task },
      ],
    });
    this.reportUsage(res.usage);
    return res.choices[0]?.message?.content?.trim() || '子 Agent 未返回结果';
  }

  exportHistory(): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    return this.history;
  }

  importHistory(messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): void {
    this.history = messages;
  }

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
    this.reportUsage(res.usage);
    const text = res.choices[0]?.message?.content?.trim();
    if (!text) return 0;
    this.history = [{ role: 'system', content: `【此前对话摘要】\n${text}` }, ...recent];
    return old.length;
  }

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

  /**
   * 携带 history 发送用户输入，逐段产出回复增量。
   * 增量中会混入「[调用工具 xxx → 结果]」「[历史压缩：…]」等进度行，仅作展示、不入 history。
   */
  async *streamReply(userInput: string): AsyncGenerator<string> {
    this.history.push({ role: 'user', content: userInput });
    const wantsTodo = /todo|任务清单|然后|最后|再.{0,12}(?:给出|总结|汇总)|并(?:给出|总结|汇总)/i.test(userInput);
    let mustUpdateTodo = false;
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
      for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        const forceTodo = (turn === 0 && wantsTodo) || mustUpdateTodo;
        mustUpdateTodo = false;
        const stream = await this.client.chat.completions.create({
          model: this.model,
          messages: [{ role: 'system', content: this.systemPrompt() }, ...this.history],
          tools: toOpenAITools(),
          tool_choice: forceTodo
              ? { type: 'function', function: { name: 'todo_write' } }
              : 'auto',
          stream: true,
          stream_options: { include_usage: true }, // Day 7：请求末尾的 chunk 里带上本次用量
        });

        // 流式边攒内容边聚拢工具调用（delta 按 index 碎片下发）
        let answer = '';
        const calls = new Map<number, { id: string; name: string; args: string }>();
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta;
          if (delta?.content) {
            answer += delta.content;
            yield delta.content;
          }
          for (const tc of delta?.tool_calls ?? []) {
            let call = calls.get(tc.index);
            if (!call) {
              call = { id: '', name: '', args: '' };
              calls.set(tc.index, call);
            }
            if (tc.id) call.id = tc.id;
            if (tc.function?.name) call.name += tc.function.name;
            if (tc.function?.arguments) call.args += tc.function.arguments;
          }
          if (chunk.usage) this.reportUsage(chunk.usage); // 只有最后一个 chunk 才带 usage
        }

        const toolCalls = [...calls.values()];
        if (toolCalls.length > 0 && toolCalls.every((c) => c.name)) {
          // 模型要动手：先把这条 assistant 消息（含 tool_calls）记入 history
          toolCalls.forEach((c, i) => {
            if (!c.id) c.id = `call_${i}`; // 个别模型不返回 id，补一个稳定值
          });
          this.history.push({
            role: 'assistant',
            content: answer || null,
            tool_calls: toolCalls.map((c) => ({
              id: c.id,
              type: 'function' as const,
              function: { name: c.name, arguments: c.args },
            })),
          });
          // 逐个执行并把结果以 role=tool 消息回传，然后进入下一轮
          for (const c of toolCalls) {
            const result = await execTool(c.name, c.args);
            yield `\n[调用工具 ${c.name} → ${result}]\n`;
            this.history.push({ role: 'tool', tool_call_id: c.id, content: result });
          }
          mustUpdateTodo = toolCalls.some((c) => c.name === 'delegate_task');
          continue;
        }

        // 没有工具调用，就是最终回答
        this.history.push({ role: 'assistant', content: answer });
        return;
      }
      // 轮次用尽仍未停下：兜底收尾，保持 history 有来有回
      yield '\n[工具调用轮次过多，已停止]';
      this.history.push({ role: 'assistant', content: '[工具调用轮次过多，已停止]' });
    } catch (err) {
      // 出错就回滚刚入队的用户消息，保持 history 只有「有来有回」的对话。
      this.history.pop();
      throw err;
    }
  }

  /** 把接口返回的 usage 归一化成 UsageInfo，回调给外部累计。 */
  private reportUsage(usage: OpenAI.CompletionUsage | null | undefined): void {
    if (!usage) return;
    this.onUsage?.({
      prompt: usage.prompt_tokens,
      completion: usage.completion_tokens,
      total: usage.total_tokens,
    });
  }

  reset(): void {
    this.history = [];
  }
}
