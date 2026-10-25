import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createLlmClient, extractJson, LlmError } from "./llm";

const reply = (content: string | null, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 7 }, ...extra }), {
    status: 200,
  });

describe("extractJson", () => {
  it("parses raw, fenced, and prose-wrapped JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! {"a":{"b":2}} hope it helps')).toEqual({ a: { b: 2 } });
  });

  it("throws on missing or broken JSON", () => {
    expect(() => extractJson("no json here")).toThrow(LlmError);
    expect(() => extractJson("{ broken")).toThrow(LlmError);
  });
});

describe("createLlmClient", () => {
  const schema = z.object({ ok: z.boolean() });

  it("returns validated JSON and counts tokens", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => reply('{"ok":true}'));
    const llm = createLlmClient({ baseUrl: "https://x/v1/", apiKey: "k", fetchImpl: fetchImpl as typeof fetch });
    await expect(llm.chatJson({ model: "m", messages: [] }, schema)).resolves.toEqual({ ok: true });
    expect(llm.tokensUsed).toBe(7);
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://x/v1/chat/completions");
  });

  it("falls back to the non-standard `answer` field", async () => {
    const fetchImpl = vi.fn(async () => reply(null, { answer: '{"ok":false}' }));
    const llm = createLlmClient({ baseUrl: "https://x/v1", apiKey: "k", fetchImpl });
    await expect(llm.chatJson({ model: "m", messages: [] }, schema)).resolves.toEqual({ ok: false });
  });

  it("retries 5xx and empty content, then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockResolvedValueOnce(reply(""))
      .mockResolvedValueOnce(reply('{"ok":true}'));
    vi.useFakeTimers();
    const llm = createLlmClient({ baseUrl: "https://x/v1", apiKey: "k", fetchImpl, maxRetries: 3 });
    const promise = llm.chatJson({ model: "m", messages: [] }, schema);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("does not retry 4xx client errors", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad key", { status: 401 }));
    const llm = createLlmClient({ baseUrl: "https://x/v1", apiKey: "k", fetchImpl });
    await expect(llm.chat({ model: "m", messages: [] })).rejects.toMatchObject({ status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
