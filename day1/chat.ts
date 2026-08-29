import OpenAI from 'openai';

/**
 * 对话会话：持有上下文记忆（history），以流式方式请求 OpenAI 兼容接口。
 * history 直接用 OpenAI 的消息类型，与接口零转换（Day 2+ 的工具消息同样适用）。
 */
export class Chat {
  private client: OpenAI;
  private model: string;
  private history: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  constructor(baseURL: string, apiKey: string, model: string) {
    this.client = new OpenAI({ baseURL, apiKey });
    this.model = model;
  }

  /** 携带 history 发送用户输入，逐段产出回复增量；结束后把完整回答写入 history。 */
  async *streamReply(userInput: string): AsyncGenerator<string> {
    this.history.push({ role: 'user', content: userInput });
    try {
      const stream = await this.client.chat.completions.create({
        model: this.model,
        messages: this.history,
        stream: true,
      });
      let answer = '';
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? '';
        if (delta) {
          answer += delta;
          yield delta;
        }
      }
      this.history.push({ role: 'assistant', content: answer });
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