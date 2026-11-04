import { describe, expect, it } from "vitest";
import { averageTokens, docId, exportId, monthKey, type UsageRecord } from "./usage";

describe("averageTokens", () => {
  it("returns 0 for an empty array of records", () => {
    expect(averageTokens([])).toBe(0);
  });

  it("returns 0 when reviews count is 0 to avoid division by zero", () => {
    const records: UsageRecord[] = [
      { installationId: 1, month: "2026-11", reviews: 0, tokens: 0 },
    ];
    expect(averageTokens(records)).toBe(0);
  });

  it("computes average tokens per review for a single record", () => {
    const records: UsageRecord[] = [
      { installationId: 1, month: "2026-11", reviews: 10, tokens: 50_000 },
    ];
    expect(averageTokens(records)).toBe(5000);
  });

  it("computes average tokens per review across multiple records without off-by-one error", () => {
    const records: UsageRecord[] = [
      { installationId: 1, month: "2026-10", reviews: 2, tokens: 4000 },
      { installationId: 1, month: "2026-11", reviews: 8, tokens: 16_000 },
    ];
    // Total tokens: 20000, Total reviews: 10 -> average: 2000
    expect(averageTokens(records)).toBe(2000);
  });
});

describe("monthKey", () => {
  it("produces standard YYYY-MM with zero padding in UTC", () => {
    const jan = new Date(Date.UTC(2026, 0, 15));
    expect(monthKey(jan)).toBe("2026-01");

    const oct = new Date(Date.UTC(2026, 9, 31));
    expect(monthKey(oct)).toBe("2026-10");

    const dec = new Date(Date.UTC(2026, 11, 25));
    expect(monthKey(dec)).toBe("2026-12");
  });
});

describe("docId and exportId", () => {
  it("generates correct document ID format", () => {
    expect(docId(12345, "2026-11")).toBe("12345_2026-11");
  });

  it("generates stable hash for exportId", () => {
    const record: UsageRecord = { installationId: 42, month: "2026-11", reviews: 5, tokens: 1000 };
    const id1 = exportId(record);
    const id2 = exportId(record);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[a-f0-9]{32}$/);
  });
});
