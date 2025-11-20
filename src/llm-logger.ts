import { callOpenAIChat } from './llm';

// Enhanced LLM calling function with detailed logging
export async function callOpenAIChatWithLogging(system: string, userPrompt: string): Promise<string> {
  const log = {
    llm: (phase: string, data?: any) => {
      console.error(`[LLM] ${new Date().toISOString()} - ${phase}`);
      if (data) console.error(JSON.stringify(data, null, 2));
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
    const completion = await callOpenAIChat(system, userPrompt);
    const duration = Date.now() - startTime;
    
    log.llm('LLM Response', { 
      completion,
      duration_ms: duration,
      responseLength: completion.length
    });

    return completion;
  } catch (error: any) {
    log.llm('LLM Error', { error: error.message });
    throw error;
  }
}