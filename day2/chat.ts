import OpenAI from 'openai';
import { execTool, toOpenAITools } from './tools.js';

/** 工具调用循环的最多轮数，防止模型陷入「调用工具 → 再调用」的死循环。 */
const MAX_TOOL_TURNS = 5;

/**
 * 对话会话：持有上下文记忆（history），以流式方式请求 OpenAI 兼容接口。
 * history 直接用 OpenAI 的消息类型，与接口零转换。
 * Day 2 起具备工具调用能力：模型要求 → 执行工具 → 结果回传 → 继续，直到模型给出最终回答。
 */
export class Chat {
  private client: OpenAI;
  private model: string;
  private history: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  constructor(baseURL: string, apiKey: string, model: string) {
    this.client = new OpenAI({ baseURL, apiKey });
    this.model = model;
  }

  /**
   * 携带 history 发送用户输入，逐段产出回复增量。
   * 增量中会混入「[调用工具 xxx → 结果]」的进度行，仅作展示、不入 history。
   */
  async *streamReply(userInput: string): AsyncGenerator<string> {
    this.history.push({ role: 'user', content: userInput });
    try {
      for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        const stream = await this.client.chat.completions.create({
          model: this.model,
          messages: this.history,
          tools: toOpenAITools(),
          stream: true,
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

  reset(): void {
    this.history = [];
  }
}