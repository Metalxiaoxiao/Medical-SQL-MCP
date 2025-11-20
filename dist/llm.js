"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.callOpenAIChat = callOpenAIChat;
const openai_1 = require("openai");
const client = new openai_1.OpenAI({
    baseURL: process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1',
    apiKey: process.env.OPENAI_API_KEY
});
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
async function callOpenAIChat(system, userPrompt) {
    if (!process.env.OPENAI_API_KEY)
        throw new Error('OPENAI_API_KEY is not set');
    const response = await client.chat.completions.create({
        model: MODEL,
        messages: [
            {
                role: 'system',
                content: system
            },
            {
                role: 'user',
                content: userPrompt
            }
        ]
    });
    console.log(JSON.stringify(response));
    const content = response.choices[0].message?.content;
    if (!content)
        throw new Error('No completion from OpenAI');
    return content;
}
