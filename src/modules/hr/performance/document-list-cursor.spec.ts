import { BadRequestException } from "@nestjs/common";
import {
  decodeDocumentListCursor,
  encodeDocumentListCursor,
} from "./document-list-cursor";

describe("document list cursor", () => {
  it("round-trips a stable document position", () => {
    const cursor = {
      createdAt: "2026-08-18T10:30:00.000Z",
      documentId: 42,
    };

    expect(decodeDocumentListCursor(encodeDocumentListCursor(cursor))).toEqual(
      cursor,
    );
  });

  it.each([
    "not-base64",
    Buffer.from(JSON.stringify({ v: 2, createdAt: "2026-08-18", documentId: 1 })).toString("base64url"),
    Buffer.from(JSON.stringify({ v: 1, createdAt: "invalid", documentId: 1 })).toString("base64url"),
    Buffer.from(JSON.stringify({ v: 1, createdAt: "2026-08-18T10:30:00.000Z", documentId: 0 })).toString("base64url"),
  ])("rejects an invalid cursor", (value) => {
    expect(() => decodeDocumentListCursor(value)).toThrow(BadRequestException);
  });
});
