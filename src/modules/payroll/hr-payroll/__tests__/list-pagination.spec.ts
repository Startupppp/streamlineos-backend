import {
  cursorListQuerySchema,
  listPageQuerySchema,
} from "../dto/payroll.schemas";

describe("listPageQuerySchema", () => {
  it("accepts empty query and coerces string params", () => {
    expect(listPageQuerySchema.parse({})).toEqual({});
    expect(listPageQuerySchema.parse({ page: "2", limit: "50" })).toEqual({ page: 2, limit: 50 });
  });

  it("caps limit at 100 and rejects non-positive pages", () => {
    expect(listPageQuerySchema.parse({ limit: "500" }).limit).toBe(100);
    expect(() => listPageQuerySchema.parse({ page: "0" })).toThrow();
    expect(() => listPageQuerySchema.parse({ page: "-1" })).toThrow();
  });
});

describe("cursorListQuerySchema", () => {
  it("accepts an opaque cursor, clamps the limit, and has no page field", () => {
    expect(
      cursorListQuerySchema.parse({ cursor: "opaque", limit: "500" }),
    ).toEqual({ cursor: "opaque", limit: 100 });
  });

  it("rejects empty or oversized cursors", () => {
    expect(() => cursorListQuerySchema.parse({ cursor: "" })).toThrow();
    expect(() =>
      cursorListQuerySchema.parse({ cursor: "x".repeat(2049) }),
    ).toThrow();
  });
});
