"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.callOpenAIChat = callOpenAIChat;
exports.getEmbedding = getEmbedding;
const openai_1 = require("openai");
const logger_1 = require("./logger");
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
    logger_1.log.info(JSON.stringify(response));
    const content = response.choices[0].message?.content;
    if (!content)
        throw new Error('No completion from OpenAI');
    return content;
}
async function getEmbedding(text) {
    const apiKey = process.env.EMBEDDING_API_KEY || process.env.OPENAI_API_KEY;
    const baseURL = process.env.EMBEDDING_BASE_URL || process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1';
    if (!apiKey)
        throw new Error('API Key for embeddings is not set (EMBEDDING_API_KEY or OPENAI_API_KEY)');
    const embeddingClient = new openai_1.OpenAI({
        baseURL: baseURL.replace(/\/embeddings$/, ''), // Remove /embeddings suffix if present
        apiKey
    });
    const model = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
    // Prepare request options
    const requestOptions = {
        model,
        input: text,
    };
    // Add Silicon Flow specific parameters for Qwen models
    if (model.includes('Qwen/Qwen3-Embedding')) {
        requestOptions.encoding_format = 'float';
        requestOptions.dimensions = 1024;
    }
    const response = await embeddingClient.embeddings.create(requestOptions);
    return response.data[0].embedding;
}
