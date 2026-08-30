import { PayrollComponentsService } from "./components.service";
import { PayrollTemplatesService } from "./templates.service";
import type { Db } from "../../../db/drizzle.module";

// Both list methods awaited the page, then awaited a separate count — two round trips in series for one screen.

const ORG = "org-1";

interface Harness<T> {
  readonly service: T;
  readonly statements: () => number;
}

function componentsHarness(rows: number, total: number): Harness<PayrollComponentsService> {
  let statements = 0;
  const pageRows = Array.from({ length: rows }, (_, i) => ({
    id: i + 1,
    orgId: ORG,
    name: `Component ${i + 1}`,
    total: String(total),
  }));
  const chain = (result: unknown): Record<string, unknown> => {
    const link: Record<string, unknown> = {};
    for (const m of ["from", "where", "orderBy"]) link[m] = jest.fn(() => link);
    link["limit"] = jest.fn(() => link);
    link["offset"] = jest.fn(() => Promise.resolve(result));
    link["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return link;
  };
  const db = {
    select: jest.fn(() => {
      statements += 1;
      return chain(pageRows);
    }),
  } as unknown as Db;
  return { service: new PayrollComponentsService(db), statements: () => statements };
}

describe("salary component list — the total costs no extra round trip", () => {
  it("reads the total out of the page query", async () => {
    const harness = componentsHarness(10, 42);

    const result = await harness.service.list(ORG, { page: 1, pageSize: 20 } as never);

    expect(result.total).toBe(42);
    expect(harness.statements()).toBe(1);
  });

  it("never returns the window column as part of a component", async () => {
    const harness = componentsHarness(3, 3);

    const result = await harness.service.list(ORG, { page: 1, pageSize: 20 } as never);

    for (const item of result.items) expect(item).not.toHaveProperty("total");
  });

  it("reports zero on an empty first page without counting again", async () => {
    const harness = componentsHarness(0, 0);

    const result = await harness.service.list(ORG, { page: 1, pageSize: 20 } as never);

    expect(result.total).toBe(0);
    expect(harness.statements()).toBe(1);
  });
});

describe("payroll template list — the total costs no extra round trip", () => {
  function templatesHarness(rows: number, total: number) {
    let statements = 0;
    const pageRows = Array.from({ length: rows }, (_, i) => ({
      id: i + 1,
      orgId: ORG,
      name: `Template ${i + 1}`,
      category: "earning",
      complexity: "simple",
      total: String(total),
    }));
    const chain = (result: unknown): Record<string, unknown> => {
      const link: Record<string, unknown> = {};
      for (const m of ["from", "where", "orderBy"]) link[m] = jest.fn(() => link);
      link["limit"] = jest.fn(() => link);
      link["offset"] = jest.fn(() => Promise.resolve(result));
      link["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve);
      return link;
    };
    let call = 0;
    const db = {
      select: jest.fn(() => {
        statements += 1;
        call += 1;
        // The first statement is ensureSystemTemplatesExist's seeded-row count.
        return chain(call === 1 ? [{ count: 99 }] : pageRows);
      }),
    } as unknown as Db;
    return { service: new PayrollTemplatesService(db), statements: () => statements };
  }

  it("reads the total out of the page query, adding no statement beyond the seed check", async () => {
    const harness = templatesHarness(10, 77);

    const result = await harness.service.list(ORG, { page: 1, pageSize: 20 } as never);

    expect(result.total).toBe(77);
    expect(harness.statements()).toBe(2);
  });

  it("never returns the window column as part of a template", async () => {
    const harness = templatesHarness(2, 2);

    const result = await harness.service.list(ORG, { page: 1, pageSize: 20 } as never);

    for (const item of result.items) expect(item).not.toHaveProperty("total");
  });

  it("still computes isRecommended on every row", async () => {
    const harness = templatesHarness(2, 2);

    const result = await harness.service.list(ORG, { page: 1, pageSize: 20 } as never);

    for (const item of result.items) expect(item).toHaveProperty("isRecommended");
  });
});
