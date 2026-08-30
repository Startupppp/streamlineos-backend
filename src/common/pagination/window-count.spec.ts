import { PgDialect } from "drizzle-orm/pg-core";
import { resolveWindowedTotal, totalOverWindow, withoutTotal } from "./window-count";

const dialect = new PgDialect();

describe("totalOverWindow", () => {
  it("compiles to the window the read-cost baseline already proves", () => {
    expect(dialect.sqlToQuery(totalOverWindow).sql).toBe("count(*) OVER ()");
  });

  it("binds no parameters, so it composes with any page query", () => {
    expect(dialect.sqlToQuery(totalOverWindow).params).toEqual([]);
  });
});

describe("resolveWindowedTotal", () => {
  const never = () => {
    throw new Error("the fallback count ran when the window had already answered");
  };

  it("reads the total off the first row, so the page query is the only statement", async () => {
    await expect(resolveWindowedTotal([{ total: "42" }, { total: "42" }], 0, never)).resolves.toBe(42);
  });

  it("accepts a numeric total as well as the string postgres returns", async () => {
    await expect(resolveWindowedTotal([{ total: 7 }], 0, never)).resolves.toBe(7);
  });

  it("reports zero for an empty first page without a second statement", async () => {
    await expect(resolveWindowedTotal([], 0, never)).resolves.toBe(0);
  });

  it("falls back only for an empty page past the end of the results", async () => {
    const fallback = jest.fn().mockResolvedValue(130);

    await expect(resolveWindowedTotal([], 120, fallback)).resolves.toBe(130);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it("does not run the fallback when the page has rows, however deep the offset", async () => {
    const fallback = jest.fn().mockResolvedValue(0);

    await expect(resolveWindowedTotal([{ total: "500" }], 480, fallback)).resolves.toBe(500);
    expect(fallback).not.toHaveBeenCalled();
  });
});

describe("withoutTotal", () => {
  it("drops the window column so it never reaches the response", () => {
    expect(withoutTotal([{ id: 1, name: "a", total: "2" }])).toEqual([{ id: 1, name: "a" }]);
  });

  it("keeps every other column, including a falsy one", () => {
    expect(withoutTotal([{ id: 0, archived: false, total: "1" }])).toEqual([{ id: 0, archived: false }]);
  });

  it("returns an empty array for an empty page", () => {
    expect(withoutTotal([])).toEqual([]);
  });
});
