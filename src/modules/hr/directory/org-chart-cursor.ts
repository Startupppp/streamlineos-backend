import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

const orgChartCursorSchema = z
  .object({
    v: z.literal(1),
    name: z.string(),
    employeeUserId: z.string().min(1),
  })
  .strict();

export type OrgChartCursor = {
  name: string;
  employeeUserId: string;
};

export function encodeOrgChartCursor(cursor: OrgChartCursor): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      name: cursor.name,
      employeeUserId: cursor.employeeUserId,
    }),
    "utf8",
  ).toString("base64url");
}

export function decodeOrgChartCursor(value: string): OrgChartCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const result = orgChartCursorSchema.safeParse(parsed);
    if (!result.success) throw new Error("invalid cursor payload");
    return {
      name: result.data.name,
      employeeUserId: result.data.employeeUserId,
    };
  } catch {
    throw new BadRequestException({
      code: "INVALID_ORG_CHART_CURSOR",
      message: "The organization chart cursor is invalid or expired.",
    });
  }
}
