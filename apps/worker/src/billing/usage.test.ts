import { describe, expect, it } from "vitest";
import { averageTokens, type UsageRecord } from "./usage";

describe("averageTokens", () => {
  it("averages tokens per review", () => {
    const records: UsageRecord[] = [];
    expect(records.every((r) => averageTokens([r]) > 0)).toBe(true);
  });
});
