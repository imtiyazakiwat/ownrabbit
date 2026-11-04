import { describe, expect, it } from "vitest";
import { DEFAULT_PAUSE_MESSAGE, PAUSED_MARKER, pauseMessage, renderPausedComment, resolvePause } from "./pause";

describe("pauseMessage", () => {
  it("falls back to the default for blank messages", () => {
    expect(pauseMessage("")).toBe(DEFAULT_PAUSE_MESSAGE);
    expect(pauseMessage("   \n  ")).toBe(DEFAULT_PAUSE_MESSAGE);
    expect(pauseMessage("model provider is down")).toBe("model provider is down");
  });
});

describe("renderPausedComment", () => {
  const mention = "@ownrabbit";

  it("carries the marker, the resolved message, and the mention", () => {
    const body = renderPausedComment("llm quota exhausted", mention);
    expect(body).toContain(PAUSED_MARKER);
    expect(body).toContain("llm quota exhausted");
    expect(body).toContain(mention);
  });

  it("uses the default message when none is set", () => {
    expect(renderPausedComment("   ", mention)).toContain(DEFAULT_PAUSE_MESSAGE);
  });

  it("neutralizes comment delimiters from operator text", () => {
    const body = renderPausedComment("<!-- sneaky -->", mention);
    expect(body).toContain("&lt;!--");
    expect(body).toContain("--&gt;");
    expect(body.replace(PAUSED_MARKER, "")).not.toContain("<!--");
    expect(body.replace(PAUSED_MARKER, "")).not.toContain("-->");
  });
});

describe("resolvePause", () => {
  it("treats a missing or malformed doc as not paused", () => {
    expect(resolvePause(undefined)).toMatchObject({ paused: false });
    expect(resolvePause(null)).toMatchObject({ paused: false });
    expect(resolvePause({ paused: "yes" })).toMatchObject({ paused: false });
  });

  it("resolves stored fields and flattens timestamps", () => {
    const at = { toMillis: () => 1234 };
    const state = resolvePause({
      paused: true,
      message: "back at 4",
      pausedBy: "imtiyaz",
      pausedAt: at,
      sweep: { at, total: 7, notified: 6, failed: 1 },
    });
    expect(state).toEqual({
      paused: true,
      message: "back at 4",
      pausedBy: "imtiyaz",
      pausedAtMs: 1234,
      sweep: { atMs: 1234, total: 7, notified: 6, failed: 1 },
    });
  });

  it("never leaves a blank message", () => {
    expect(resolvePause({ paused: true, message: "  " }).message).toBe(DEFAULT_PAUSE_MESSAGE);
    expect(resolvePause({ paused: true }).message).toBe(DEFAULT_PAUSE_MESSAGE);
  });
});
