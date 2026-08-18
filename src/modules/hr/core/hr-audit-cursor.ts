import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

const auditCursorSchema = z
  .object({
    version: z.literal(1),
    asOf: z.string().datetime(),
    createdAt: z.string().datetime(),
    auditLogId: z.number().int().positive(),
  })
  .strict();

export type AuditLogCursor = {
  asOf: string;
  createdAt: string;
  auditLogId: number;
};

export function encodeAuditLogCursor(cursor: AuditLogCursor): string {
  return Buffer.from(
    JSON.stringify({ version: 1, ...cursor }),
    "utf8",
  ).toString("base64url");
}

export function decodeAuditLogCursor(encodedCursor: string): AuditLogCursor {
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(encodedCursor, "base64url").toString("utf8"),
    );
    const cursor = auditCursorSchema.parse(payload);
    const asOf = new Date(cursor.asOf);
    const createdAt = new Date(cursor.createdAt);
    if (
      asOf.getTime() > Date.now() + 60_000 ||
      createdAt.getTime() > asOf.getTime()
    ) {
      throw new Error("invalid cursor time boundary");
    }
    return {
      asOf: cursor.asOf,
      createdAt: cursor.createdAt,
      auditLogId: cursor.auditLogId,
    };
  } catch {
    throw new BadRequestException({
      code: "INVALID_AUDIT_LOG_CURSOR",
      message: "The audit log cursor is invalid or expired.",
    });
  }
}
