import { OpenAI } from 'openai';

const client = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.deepseek.com/v1',
  apiKey: process.env.OPENAI_API_KEY
});

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

export async function callOpenAIChat(system: string, userPrompt: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');

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
  if (!content) throw new Error('No completion from OpenAI');
  return content;
}
