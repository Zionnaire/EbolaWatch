import { AppError } from '../../utils/appError.js';

export interface GroqOptions {
  apiKey: string;
  model: string;
  /** OpenAI-compatible base, e.g. https://api.groq.com/openai/v1 */
  baseUrl: string;
  timeoutMs: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  content: string;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Retry-After in seconds (or an HTTP date), clamped so a bad header can never stall a request for minutes. */
export function retryAfterSeconds(header: string | null, fallback: number): number {
  if (!header) return fallback;
  const n = Number(header);
  const secs = Number.isFinite(n) ? n : (Date.parse(header) - Date.now()) / 1000;
  return Number.isFinite(secs) ? Math.min(20, Math.max(1, Math.ceil(secs))) : fallback;
}

/**
 * Minimal client for Groq's OpenAI-compatible chat API (plain fetch: no SDK dependency). It asks for JSON output,
 * retries rate limits and transient failures with backoff, and turns every failure into an AppError whose message
 * is safe to show a person. The API key is never logged or included in an error.
 */
export class GroqClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(private readonly opts: GroqOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxRetries = opts.maxRetries ?? 2;
  }

  get model(): string {
    return this.opts.model;
  }

  async chatJson(
    messages: ChatMessage[],
    {
      temperature = 0.2,
      maxTokens = 600,
      reasoningEffort,
    }: { temperature?: number; maxTokens?: number; reasoningEffort?: 'low' | 'medium' | 'high' } = {},
  ): Promise<ChatResult> {
    let lastStatus = 0;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.opts.apiKey}` },
          body: JSON.stringify({
            model: this.opts.model,
            messages,
            temperature,
            max_tokens: maxTokens,
            response_format: { type: 'json_object' },
            // reasoning models spend tokens thinking before they answer: keep that small for short structured jobs
            ...(reasoningEffort && /gpt-oss/i.test(this.opts.model)
              ? { reasoning_effort: reasoningEffort }
              : {}),
          }),
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
      } catch {
        // timeout or network error: worth another try
        lastStatus = 0;
        if (attempt < this.maxRetries) await this.sleep(500 * 2 ** attempt + Math.random() * 250);
        continue;
      }

      if (res.ok) {
        const body = (await res.json().catch(() => null)) as {
          choices?: Array<{ message?: { content?: string } }>;
          model?: string;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        } | null;
        const content = body?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.trim() === '') {
          throw new AppError(502, 'The writing service returned an empty answer', 'generator_empty');
        }
        return {
          content,
          model: body?.model ?? this.opts.model,
          promptTokens: body?.usage?.prompt_tokens ?? null,
          completionTokens: body?.usage?.completion_tokens ?? null,
        };
      }

      lastStatus = res.status;
      if (res.status === 401 || res.status === 403) {
        throw new AppError(
          502,
          'The writing service rejected our credentials. Ask an administrator to check the API key.',
          'generator_unauthorized',
        );
      }
      if (res.status === 400 || res.status === 404 || res.status === 422) {
        // a bad request or an unknown model will not get better by retrying
        const detail = await res.text().catch(() => '');
        throw new AppError(
          502,
          `The writing service could not process the request (${res.status}). ${detail.slice(0, 160)}`.trim(),
          'generator_bad_request',
        );
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt < this.maxRetries) {
          const wait =
            res.status === 429
              ? retryAfterSeconds(res.headers.get('retry-after'), 2) * 1000
              : 500 * 2 ** attempt;
          await this.sleep(wait + Math.random() * 250);
        }
        continue;
      }
      throw new AppError(
        502,
        `The writing service answered with an unexpected status (${res.status})`,
        'generator_error',
      );
    }

    throw new AppError(
      503,
      lastStatus === 429
        ? 'The writing service is busy right now. Wait a minute and try again.'
        : 'The writing service is not reachable right now. Try again shortly, or write the reply by hand.',
      'generator_unavailable',
    );
  }
}
