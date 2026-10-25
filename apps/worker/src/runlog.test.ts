import { describe, expect, it, vi } from "vitest";
import { createRunLog, MAX_EVENTS, type RunEvent } from "./runlog";

function memorySink() {
  const writes: { events: RunEvent[]; stage: string }[] = [];
  return { writes, write: vi.fn(async (events: RunEvent[], stage: string) => void writes.push({ events, stage })) };
}

describe("createRunLog", () => {
  it("batches events in order and tags them with the current stage", async () => {
    const sink = memorySink();
    const run = createRunLog(sink, () => 1000);
    run.stage("triage", "start triage");
    run.log("warn", "slow model");
    run.stage("review", "start review");
    await run.close();

    expect(sink.writes).toHaveLength(1);
    const { events, stage } = sink.writes[0]!;
    expect(stage).toBe("review");
    expect(events.map((e) => [e.seq, e.stage, e.level])).toEqual([
      [1, "triage", "info"],
      [2, "triage", "warn"],
      [3, "review", "info"],
    ]);
  });

  it("does not write when there is nothing new", async () => {
    const sink = memorySink();
    const run = createRunLog(sink);
    await run.flush();
    expect(sink.write).not.toHaveBeenCalled();
  });

  it("swallows sink failures so the review keeps going", async () => {
    const run = createRunLog({ write: async () => Promise.reject(new Error("firestore down")) });
    run.log("info", "x");
    await expect(run.close()).resolves.toBeUndefined();
  });

  it("caps the number of events and records that it did", async () => {
    const sink = memorySink();
    const run = createRunLog(sink);
    for (let i = 0; i < MAX_EVENTS + 50; i++) run.log("info", `e${i}`);
    await run.close();
    const events = sink.writes.flatMap((w) => w.events);
    expect(events).toHaveLength(MAX_EVENTS + 1);
    expect(events.at(-1)!.message).toContain("Event limit reached");
  });

  it("truncates large data values and drops undefined ones", async () => {
    const sink = memorySink();
    const run = createRunLog(sink);
    run.log("error", "boom", { error: "x".repeat(5000), skip: undefined });
    await run.close();
    const data = sink.writes[0]!.events[0]!.data!;
    expect(Object.keys(data)).toEqual(["error"]);
    expect((data.error as string).length).toBeLessThan(2100);
  });
});
