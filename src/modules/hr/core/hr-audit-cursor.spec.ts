import { BadRequestException } from "@nestjs/common";
import { decodeAuditLogCursor, encodeAuditLogCursor } from "./hr-audit-cursor";

describe("HR audit log cursor", () => {
  it("round-trips the stable timestamp and record identity", () => {
    const cursor = {
      asOf: "2026-08-18T08:00:00.000Z",
      createdAt: "2026-08-17T08:00:00.000Z",
      auditLogId: 42,
    };

    expect(decodeAuditLogCursor(encodeAuditLogCursor(cursor))).toEqual(cursor);
  });

  it.each([
    "not-a-cursor",
    Buffer.from(JSON.stringify({ version: 1 }), "utf8").toString("base64url"),
    Buffer.from(
      JSON.stringify({
        version: 1,
        asOf: "2026-08-17T08:00:00.000Z",
        createdAt: "2026-08-18T08:00:00.000Z",
        auditLogId: 42,
      }),
      "utf8",
    ).toString("base64url"),
  ])("rejects an invalid cursor", (encodedCursor) => {
    expect(() => decodeAuditLogCursor(encodedCursor)).toThrow(
      BadRequestException,
    );
  });
});
