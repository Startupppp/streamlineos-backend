import { BadRequestException } from "@nestjs/common";
import {
  decodeEmployeeListCursor,
  encodeEmployeeListCursor,
} from "./employee-list-cursor";

describe("employee list cursor", () => {
  it("round-trips the normalized name and stable employee id", () => {
    const cursor = encodeEmployeeListCursor({
      name: "aditya",
      employeeUserId: "user-42",
    });

    expect(decodeEmployeeListCursor(cursor)).toEqual({
      name: "aditya",
      employeeUserId: "user-42",
    });
  });

  it("rejects malformed and unsupported cursors with a stable public error", () => {
    expect(() => decodeEmployeeListCursor("not-json")).toThrow(BadRequestException);
    let error: unknown;
    try {
      decodeEmployeeListCursor(
        Buffer.from(
          JSON.stringify({ v: 2, name: "a", employeeUserId: "b" }),
        ).toString("base64url"),
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({
      code: "INVALID_EMPLOYEE_CURSOR",
    });
  });
});
