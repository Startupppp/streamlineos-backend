import { BadRequestException } from "@nestjs/common";
import { decodeOrgChartCursor, encodeOrgChartCursor } from "./org-chart-cursor";
import { orgChartQuerySchema } from "./dto/hr-directory.schemas";

describe("organization chart cursor", () => {
  it("round-trips a stable normalized-name and employee-id position", () => {
    const cursor = encodeOrgChartCursor({
      name: "aditya",
      employeeUserId: "user-42",
    });

    expect(decodeOrgChartCursor(cursor)).toEqual({
      name: "aditya",
      employeeUserId: "user-42",
    });
  });

  it("rejects malformed or unsupported cursors with a stable public error", () => {
    expect(() => decodeOrgChartCursor("not-json")).toThrow(BadRequestException);

    let error: unknown;
    try {
      decodeOrgChartCursor(
        Buffer.from(
          JSON.stringify({ v: 2, name: "a", employeeUserId: "b" }),
        ).toString("base64url"),
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BadRequestException);
    if (!(error instanceof BadRequestException)) throw new Error("Expected a bad request");
    expect(error.getResponse()).toMatchObject({
      code: "INVALID_ORG_CHART_CURSOR",
    });
  });

  it("bounds requests and rejects ambiguous parent plus search modes", () => {
    expect(() => orgChartQuerySchema.parse({ limit: "51" })).toThrow();
    expect(() =>
      orgChartQuerySchema.parse({ parentId: "manager-1", search: "Ada" }),
    ).toThrow();
    expect(orgChartQuerySchema.parse({ limit: "20", search: "Ada" })).toEqual({
      limit: 20,
      search: "Ada",
    });
  });
});
