"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.callOpenAIChatWithLogging = callOpenAIChatWithLogging;
const llm_1 = require("./llm");
// Enhanced LLM calling function with detailed logging
async function callOpenAIChatWithLogging(system, userPrompt) {
    const log = {
        llm: (phase, data) => {
            console.error(`[LLM] ${new Date().toISOString()} - ${phase}`);
            if (data)
                console.error(JSON.stringify(data, null, 2));
        }
    };
    log.llm('Starting LLM call', {
        model: process.env.OPENAI_MODEL,
        baseUrl: process.env.OPENAI_BASE_URL,
        systemPromptLength: system.length,
        userPromptLength: userPrompt.length
    });
    log.llm('System Prompt', { system: system.substring(0, 500) + (system.length > 500 ? '...' : '') });
    log.llm('User Prompt', { userPrompt });
    try {
        const startTime = Date.now();
        const completion = await (0, llm_1.callOpenAIChat)(system, userPrompt);
        const duration = Date.now() - startTime;
        log.llm('LLM Response', {
            completion,
            duration_ms: duration,
            responseLength: completion.length
        });
        return completion;
    }
    catch (error) {
        log.llm('LLM Error', { error: error.message });
        throw error;
    }
}
