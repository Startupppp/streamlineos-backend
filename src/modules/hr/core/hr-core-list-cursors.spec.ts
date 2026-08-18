import { BadRequestException } from "@nestjs/common";
import {
  decodeEmploymentListCursor,
  decodePeopleListCursor,
  encodeEmploymentListCursor,
  encodePeopleListCursor,
} from "./hr-core-list-cursors";
import {
  listEmploymentsSchema,
  listPeopleSchema,
} from "./dto/hr-core.schemas";

describe("HR core list cursors", () => {
  it("round-trips descriptive person and employment identifiers", () => {
    const peopleCursor = encodePeopleListCursor({ personId: 41 });
    const employmentCursor = encodeEmploymentListCursor({ employmentId: 73 });

    expect(decodePeopleListCursor(peopleCursor)).toEqual({ personId: 41 });
    expect(decodeEmploymentListCursor(employmentCursor)).toEqual({
      employmentId: 73,
    });
  });

  it.each([
    [decodePeopleListCursor, "INVALID_PEOPLE_CURSOR"],
    [decodeEmploymentListCursor, "INVALID_EMPLOYMENT_CURSOR"],
  ])("rejects invalid cursor payloads with code %s", (decodeCursor, errorCode) => {
    let caughtError: unknown;
    try {
      decodeCursor("not-a-cursor");
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(BadRequestException);
    if (!(caughtError instanceof BadRequestException)) return;
    expect(caughtError.getResponse()).toMatchObject({ code: errorCode });
  });

  it("defaults list requests to cursor mode and rejects mixed pagination", () => {
    expect(listPeopleSchema.parse({})).toEqual({ limit: 20 });
    expect(listEmploymentsSchema.parse({ limit: "25" })).toEqual({ limit: 25 });
    expect(() =>
      listPeopleSchema.parse({ page: "2", cursor: "cursor-value" }),
    ).toThrow();
  });
});
