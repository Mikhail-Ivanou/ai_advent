/**
 * Minimal OpenAI-compatible chat completion call.
 * Works with OpenAI, OpenRouter, Groq, and other providers exposing the same API shape —
 * just point LLM_API_URL/LLM_MODEL/LLM_API_KEY at the provider you want.
 * LLM_API_URL is the provider's base URL (e.g. https://api.openai.com/v1) —
 * "/chat/completions" is appended automatically.
 */
export async function callLlm(prompt: string): Promise<string> {
  const baseUrl = (process.env.LLM_API_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const apiUrl = `${baseUrl}/chat/completions`;
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL ?? 'gpt-4o-mini';

  if (!apiKey) {
    throw new Error('LLM_API_KEY is not set. Add it to backend/.env');
  }

  let response: Response;
  try {
    response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: 'Always reply in the same language the user wrote their message in.',
          },
          { role: 'user', content: prompt },
        ],
      }),
    });
  } catch (error) {
    const errorCause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
    const cause = errorCause instanceof Error ? `: ${errorCause.message}` : '';
    throw new Error(`Could not reach LLM API at ${apiUrl}${cause}`);
  }

  if (!response.ok) {
    throw new Error(`LLM request failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content ?? '';
}
