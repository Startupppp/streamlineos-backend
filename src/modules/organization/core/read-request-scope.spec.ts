import type { Request } from "express";
import { readRequestScope } from "./read-request-scope";

describe("readRequestScope", () => {
  it("returns 'none' when req.rbacScope is absent (fail-closed default)", () => {
    const req = {} as Request;
    expect(readRequestScope(req)).toBe("none");
  });

  it.each(["all", "team", "own", "none"] as const)(
    "propagates the scope '%s' when set by the guard",
    (scope) => {
      const req = { rbacScope: scope } as Request;
      expect(readRequestScope(req)).toBe(scope);
    },
  );
});
