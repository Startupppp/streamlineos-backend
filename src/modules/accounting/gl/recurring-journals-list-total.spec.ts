import { RecurringJournalsService } from "./recurring-journals.service";
import type { Db } from "../../../db/drizzle.module";
import type { AuditService } from "../../../common/audit/audit.service";

/**
 * `listTemplates` renders a total, and it used to pay for it with a second
 * sequential statement: the page query was awaited, then a bare `count(*)` was
 * awaited after it, so one screen cost two round trips in series. The window in
 * the page query answers the same question in one.
 *
 * The statement counter is the assertion that bites — the double will happily
 * serve a second read, so a regression shows up as a count, not as a type error.
 */

const ORG_ID = "org-1";

interface Harness {
  readonly service: RecurringJournalsService;
  readonly statements: () => number;
  readonly lastOffset: () => number | undefined;
}

function buildHarness(page: { rows: number; total: number }, fallbackTotal = 0): Harness {
  let statements = 0;
  let lastOffset: number | undefined;

  const templateRows = Array.from({ length: page.rows }, (_, i) => ({
    id: i + 1,
    orgId: ORG_ID,
    name: `Template ${i + 1}`,
    total: String(page.total),
  }));

  const chain = (result: unknown): Record<string, unknown> => {
    const link: Record<string, unknown> = {};
    for (const method of ["from", "where", "orderBy", "innerJoin", "leftJoin"])
      link[method] = jest.fn(() => link);
    link["offset"] = jest.fn((value: number) => {
      lastOffset = value;
      return link;
    });
    link["limit"] = jest.fn(() => Promise.resolve(result));
    link["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return link;
  };

  let call = 0;
  const db = {
    select: jest.fn(() => {
      statements += 1;
      call += 1;
      return chain(call === 1 ? templateRows : [{ c: fallbackTotal }]);
    }),
  } as unknown as Db;

  return {
    service: new RecurringJournalsService(db, {} as unknown as AuditService),
    statements: () => statements,
    lastOffset: () => lastOffset,
  };
}

describe("recurring journal templates — the total costs no extra round trip", () => {
  it("reads the total out of the page query rather than a second statement", async () => {
    const harness = buildHarness({ rows: 12, total: 88 });

    const result = await harness.service.listTemplates(ORG_ID, 1, 50);

    expect(result.total).toBe(88);
    expect(harness.statements()).toBe(1);
  });

  it("never returns the window column as part of a template", async () => {
    const harness = buildHarness({ rows: 2, total: 2 });

    const result = await harness.service.listTemplates(ORG_ID, 1, 50);

    for (const item of result.items) expect(item).not.toHaveProperty("total");
  });

  it("reports zero for an empty first page without counting again", async () => {
    const harness = buildHarness({ rows: 0, total: 0 });

    const result = await harness.service.listTemplates(ORG_ID, 1, 50);

    expect(result.total).toBe(0);
    expect(harness.statements()).toBe(1);
  });

  it("counts once more only for an empty page past the end of the results", async () => {
    const harness = buildHarness({ rows: 0, total: 0 }, 61);

    const result = await harness.service.listTemplates(ORG_ID, 4, 20);

    expect(result.total).toBe(61);
    expect(harness.statements()).toBe(2);
    expect(harness.lastOffset()).toBe(60);
  });
});
