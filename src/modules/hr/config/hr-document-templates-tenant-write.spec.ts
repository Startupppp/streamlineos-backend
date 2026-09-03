import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { HrDocumentTemplatesService } from "./hr-document-templates.service";
import type { Db } from "../../../db/drizzle.module";

const dialect = new PgDialect();
const ORG = "org-tpl-a";
const OTHER = "org-tpl-b";

const EXISTING = {
  id: 41,
  orgId: ORG,
  title: "Offer letter",
  type: "OFFER" as const,
  htmlContent: "<p>hi</p>",
  variables: [],
  version: 3,
};

function makeDb(captured: { wheres: unknown[] }) {
  const update = jest.fn().mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    chain["set"] = jest.fn().mockReturnValue(chain);
    chain["where"] = jest.fn().mockImplementation((cond: unknown) => {
      captured.wheres.push(cond);
      const withReturning = {
        returning: jest.fn().mockResolvedValue([{ ...EXISTING }]),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve([]).then(resolve),
      };
      return withReturning;
    });
    return chain;
  });
  return {
    transaction: jest.fn(async (cb: (t: unknown) => Promise<unknown>) =>
      cb({ update, insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }) }),
    ),
    select: jest.fn(),
  } as unknown as Db;
}

/**
 * Both writes read the template org-scoped and then wrote it back keyed on the
 * surrogate id alone, which throws away the authorization the read performed and
 * leaves RLS as the only thing between the statement and another tenant's row.
 */
describe("HrDocumentTemplatesService — tenant-correlated writes", () => {
  it("binds org_id on setDefault, not the template id alone", async () => {
    const captured = { wheres: [] as unknown[] };
    const service = new HrDocumentTemplatesService(makeDb(captured));

    await service.setDefault(EXISTING as never, true);

    const last = captured.wheres[captured.wheres.length - 1];
    const query = dialect.sqlToQuery(last as SQL);
    expect(query.params).toContain(ORG);
    expect(query.params).not.toContain(OTHER);
    expect(query.params).toContain(41);
  });

  it("binds org_id on updateVersion, not the template id alone", async () => {
    const captured = { wheres: [] as unknown[] };
    const service = new HrDocumentTemplatesService(makeDb(captured));

    await service.updateVersion("user-1", EXISTING as never, { htmlContent: "<p>new</p>" } as never);

    const last = captured.wheres[captured.wheres.length - 1];
    const query = dialect.sqlToQuery(last as SQL);
    expect(query.params).toContain(ORG);
    expect(query.params).toContain(41);
  });
});
