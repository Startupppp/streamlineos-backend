import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { HrInterviewersService } from "./hr-interviewers.service";
import type { Db } from "../../../db/drizzle.module";

const dialect = new PgDialect();
const ORG = "org-int-a";

/**
 * cancelBookingLink read the link org-scoped, 404'd on a miss, then cancelled it
 * by id alone — the write discarded the authorization the read had just performed.
 */
describe("HrInterviewersService.cancelBookingLink — tenant-correlated write", () => {
  it("binds org_id, not the link id alone", async () => {
    const wheres: unknown[] = [];
    const db = {
      query: {
        interviewBookingLinks: { findFirst: jest.fn().mockResolvedValue({ id: 12 }) },
      },
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((cond: unknown) => {
            wheres.push(cond);
            return Promise.resolve(undefined);
          }),
        }),
      }),
    } as unknown as Db;

    await new HrInterviewersService(db).cancelBookingLink(ORG, 12);

    const query = dialect.sqlToQuery(wheres[0] as SQL);
    expect(query.params).toEqual(expect.arrayContaining([ORG, 12]));
  });
});
