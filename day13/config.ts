import 'dotenv/config';

export interface Config {
    baseURL: string;
    apiKey: string;
    model: string;
}

/** 从环境变量读取模型配置，缺少 API Key 时直接退出并提示。 */
export function loadConfig(): Config {
    const baseURL = process.env.OPENAI_BASE_URL?.trim() || 'https://api.deepseek.com';
    const apiKey = process.env.OPENAI_API_KEY?.trim() || '';
    const model = process.env.OPENAI_MODEL?.trim() || 'deepseek-v4-flash';

    if (!apiKey) {
        console.error('缺少 OPENAI_API_KEY：请复制 .env.example 为 .env 并填写。');
        process.exit(1);
    }

    return { baseURL, apiKey, model };
}