// day16/plugins/echo/plugin.ts
import type { Plugin, Tool } from '../../plugin-sdk.js';

const plugin: Plugin = {
    name: 'echo',
    description: '回显与工具注册演示',
    commands: [
        {
            name: 'echo',
            description: '回显文本（/echo <内容>）',
            handler: (args: string) => `回声：${args || '（空）'}`,
        },
    ],
    onStart: async (ctx) => {
        ctx.registerTool(echoTool);
    },
};

export default plugin;

const echoTool: Tool = {
    name: 'echo_repeat',
    description: '重复输入文本，用于测试工具调用',
    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: (args: { text: string }) => `重复：${args.text}`,
};
