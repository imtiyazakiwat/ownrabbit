import { describe, expect, it } from "vitest";
import { isAdmin, isAdminEmail, isAdminLogin } from "./admin";

describe("admin authorization", () => {
  it("recognizes imtiyazakiwat as admin by default", () => {
    expect(isAdminLogin("imtiyazakiwat")).toBe(true);
    expect(isAdminLogin("ImtiyazAkiwat")).toBe(true);
    expect(isAdminLogin("  imtiyazakiwat  ")).toBe(true);
    expect(isAdmin({ login: "imtiyazakiwat" })).toBe(true);
  });

  it("recognizes imtiyazakiwat0@gmail.com as admin by default", () => {
    expect(isAdminEmail("imtiyazakiwat0@gmail.com")).toBe(true);
    expect(isAdminEmail("ImtiyazAkiwat0@Gmail.Com")).toBe(true);
    expect(isAdminEmail("  imtiyazakiwat0@gmail.com  ")).toBe(true);
    expect(isAdmin({ email: "imtiyazakiwat0@gmail.com" })).toBe(true);
  });

  it("recognizes admin when session matches either login or email", () => {
    expect(isAdmin({ login: "other", email: "imtiyazakiwat0@gmail.com" })).toBe(true);
    expect(isAdmin({ login: "imtiyazakiwat", email: "other@example.com" })).toBe(true);
    expect(isAdmin({ login: "random", email: "random@example.com" })).toBe(false);
  });

  it("handles null or undefined safely", () => {
    expect(isAdmin(null)).toBe(false);
    expect(isAdmin(undefined)).toBe(false);
    expect(isAdminLogin(null)).toBe(false);
    expect(isAdminLogin(undefined)).toBe(false);
    expect(isAdminEmail(null)).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
  });

  it("supports additional admins via env parameters", () => {
    expect(isAdminLogin("alice", "alice,bob")).toBe(true);
    expect(isAdminEmail("alice@example.com", "alice@example.com,bob@example.com")).toBe(true);
    expect(isAdmin({ login: "bob" }, { logins: "alice,bob" })).toBe(true);
  });
});
