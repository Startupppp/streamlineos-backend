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
    const peopleScope = {
      orgId: "org-1",
      actorUserId: "actor-1",
      scope: "all" as const,
      search: "Ada",
    };
    const employmentScope = {
      orgId: "org-1",
      actorUserId: "actor-1",
      scope: "team" as const,
    };
    const peopleCursor = encodePeopleListCursor({ personId: 41, ...peopleScope });
    const employmentCursor = encodeEmploymentListCursor({
      employmentId: 73,
      ...employmentScope,
    });

    expect(decodePeopleListCursor(peopleCursor, peopleScope)).toEqual({
      personId: 41,
      ...peopleScope,
    });
    expect(decodeEmploymentListCursor(employmentCursor, employmentScope)).toEqual({
      employmentId: 73,
      ...employmentScope,
    });
  });

  it.each([
    [
      () =>
        decodePeopleListCursor("not-a-cursor", {
          orgId: "org-1",
          actorUserId: "actor-1",
          scope: "all",
          search: null,
        }),
      "INVALID_PEOPLE_CURSOR",
    ],
    [
      () =>
        decodeEmploymentListCursor("not-a-cursor", {
          orgId: "org-1",
          actorUserId: "actor-1",
          scope: "all",
        }),
      "INVALID_EMPLOYMENT_CURSOR",
    ],
  ])("rejects invalid cursor payloads with code %s", (decodeCursor, errorCode) => {
    let caughtError: unknown;
    try {
      decodeCursor();
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(BadRequestException);
    if (!(caughtError instanceof BadRequestException)) return;
    expect(caughtError.getResponse()).toMatchObject({ code: errorCode });
  });

  it("defaults list requests to cursor mode and rejects offset parameters", () => {
    expect(listPeopleSchema.parse({})).toEqual({ limit: 20 });
    expect(listEmploymentsSchema.parse({ limit: "25" })).toEqual({ limit: 25 });
    expect(() => listPeopleSchema.parse({ page: "2" })).toThrow();
    expect(() => listEmploymentsSchema.parse({ page: "2" })).toThrow();
  });

  it("rejects cross-tenant and filter-changed cursors", () => {
    const cursor = encodePeopleListCursor({
      personId: 41,
      orgId: "org-1",
      actorUserId: "actor-1",
      scope: "all",
      search: "Ada",
    });

    expect(() =>
      decodePeopleListCursor(cursor, {
        orgId: "org-2",
        actorUserId: "actor-1",
        scope: "all",
        search: "Ada",
      }),
    ).toThrow(BadRequestException);
    expect(() =>
      decodePeopleListCursor(cursor, {
        orgId: "org-1",
        actorUserId: "actor-1",
        scope: "all",
        search: "Grace",
      }),
    ).toThrow(BadRequestException);
  });
});
