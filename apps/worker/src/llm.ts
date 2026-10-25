/**
 * Minimal OpenAI-compatible chat client.
 *
 * The configured endpoint does not support native tool calling, so every
 * call asks for a JSON object and the agent loop implements tools on top.
 */
import { z } from "zod";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

const ResponseSchema = z.object({
  choices: z
    .array(z.object({ message: z.object({ content: z.string().nullable().optional() }).optional() }))
    .optional(),
  answer: z.string().optional(),
  usage: z.object({ total_tokens: z.number().optional() }).optional(),
});

export interface LlmClient {
  chat(options: ChatOptions): Promise<string>;
  chatJson<T>(options: ChatOptions, schema: z.ZodType<T>): Promise<T>;
  readonly tokensUsed: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createLlmClient(config: LlmConfig): LlmClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const maxRetries = config.maxRetries ?? 3;
  const url = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  let tokensUsed = 0;

  async function once(options: ChatOptions, json: boolean): Promise<string> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 120_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: options.model,
          messages: options.messages,
          temperature: options.temperature ?? 0.2,
          ...(json ? { response_format: { type: "json_object" } } : {}),
        }),
      });
    } catch (err) {
      if (options.signal?.aborted) throw err;
      throw new LlmError(`LLM request failed: ${(err as Error).message}`, undefined, true);
    }

    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 300);
      const retryable = res.status === 429 || res.status >= 500;
      throw new LlmError(`LLM HTTP ${res.status}: ${text}`, res.status, retryable);
    }

    const parsed = ResponseSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new LlmError("LLM returned an unexpected response shape", res.status, true);

    tokensUsed += parsed.data.usage?.total_tokens ?? 0;
    const content = parsed.data.choices?.[0]?.message?.content ?? parsed.data.answer ?? "";
    if (!content.trim()) throw new LlmError("LLM returned empty content", res.status, true);
    return content;
  }

  async function withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const retryable = err instanceof LlmError && err.retryable;
        if (!retryable || attempt === maxRetries || signal?.aborted) throw err;
        await sleep(Math.min(1000 * 2 ** attempt, 15_000) + Math.random() * 500);
      }
    }
    throw lastError;
  }

  return {
    get tokensUsed() {
      return tokensUsed;
    },
    chat: (options) => withRetry(() => once(options, false), options.signal),
    chatJson: (options, schema) =>
      withRetry(async () => {
        const text = await once(options, true);
        const value = extractJson(text);
        const result = schema.safeParse(value);
        if (!result.success) {
          throw new LlmError(`LLM JSON failed validation: ${result.error.message.slice(0, 300)}`, undefined, true);
        }
        return result.data;
      }, options.signal),
  };
}

/**
 * Parse JSON from model output, tolerating ```json fences and leading or
 * trailing prose.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // fall through
    }
  }
  const start = trimmed.search(/[{[]/);
  if (start === -1) throw new LlmError("No JSON found in LLM output", undefined, true);
  const open = trimmed[start]!;
  const close = open === "{" ? "}" : "]";
  const end = trimmed.lastIndexOf(close);
  if (end <= start) throw new LlmError("Unterminated JSON in LLM output", undefined, true);
  try {
    return JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    throw new LlmError("Invalid JSON in LLM output", undefined, true);
  }
}
