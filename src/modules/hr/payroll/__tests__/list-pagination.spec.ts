import { listPageQuerySchema } from "../../dto/payroll.schemas";

describe("listPageQuerySchema", () => {
  it("accepts empty query and coerces string params", () => {
    expect(listPageQuerySchema.parse({})).toEqual({});
    expect(listPageQuerySchema.parse({ page: "2", limit: "50" })).toEqual({ page: 2, limit: 50 });
  });

  it("caps limit at 100 and rejects non-positive pages", () => {
    expect(() => listPageQuerySchema.parse({ limit: "500" })).toThrow();
    expect(() => listPageQuerySchema.parse({ page: "0" })).toThrow();
    expect(() => listPageQuerySchema.parse({ page: "-1" })).toThrow();
  });
});
