import { actorIn, portfoliosService, programsService } from "./__tests__/portfolio-spec-fixtures";
import { PortfoliosService } from "./portfolios.service";
import { ProgramsService } from "./programs.service";
import type { Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { portfolioPageSchema, programPageSchema } from "./dto/portfolios-response.schemas";
import { listPortfoliosQuerySchema, listProgramsQuerySchema } from "./dto/portfolios.schemas";
import { checkResponseAgainstContract } from "../../../common/openapi/response-contract.interceptor";

const STORED_PORTFOLIO = {
  id: 3,
  orgId: "org-1",
  name: "Platform",
  description: null,
  ownerId: null,
  status: "active",
  health: null,
  strategicGoal: null,
  createdBy: "user-1",
  createdAt: new Date("2026-09-19T10:00:00.000Z"),
  updatedAt: new Date("2026-09-19T10:00:00.000Z"),
  deletedAt: null,
  projectCount: 2,
};

const STORED_PROGRAM = {
  id: 5,
  orgId: "org-1",
  portfolioId: 3,
  name: "Onboarding",
  description: null,
  ownerId: null,
  status: "active",
  health: null,
  createdBy: "user-1",
  createdAt: new Date("2026-09-19T10:00:00.000Z"),
  updatedAt: new Date("2026-09-19T10:00:00.000Z"),
  deletedAt: null,
  projectCount: 4,
};

const PROGRAM_LIST_QUERY = listProgramsQuerySchema.parse({ limit: 50 });

function dbProjecting(row: Record<string, unknown>): Db {
  const builder: Record<string, unknown> = {};
  const project = (projection: Record<string, unknown>) =>
    Object.fromEntries(Object.keys(projection).map((key) => [key, row[key]]));
  builder["select"] = jest.fn((projection: Record<string, unknown>) => {
    const projected = [project(projection)];
    const chain: Record<string, unknown> = {
      from: jest.fn(() => chain),
      where: jest.fn(() => chain),
      orderBy: jest.fn(() => chain),
      limit: jest.fn(() => Promise.resolve(projected)),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(projected).then(resolve),
    };
    return chain;
  });
  return builder as unknown as Db;
}

describe("listPortfoliosQuerySchema — BUG-056: sort param is accepted so the frontend toolbar does not generate a 400", () => {
  it("accepts sort=createdAt so the default toolbar value is not rejected as an unknown key", () => {
    expect(() => listPortfoliosQuerySchema.parse({ sort: "createdAt" })).not.toThrow();
  });

  it("accepts sort=updatedAt so the updatedAt toolbar option is not rejected as an unknown key", () => {
    expect(() => listPortfoliosQuerySchema.parse({ sort: "updatedAt" })).not.toThrow();
  });

  it("accepts sort=name so the name toolbar option is not rejected as an unknown key", () => {
    expect(() => listPortfoliosQuerySchema.parse({ sort: "name" })).not.toThrow();
  });

  it("rejects an unrecognised sort value so random inputs are still validated", () => {
    expect(() => listPortfoliosQuerySchema.parse({ sort: "random" })).toThrow();
  });

  it("still rejects a completely unknown key so the .strict() contract is preserved", () => {
    expect(() => listPortfoliosQuerySchema.parse({ unknown: "value" })).toThrow();
  });
});

describe("the portfolio and program lists return the page their contracts promise", () => {
  it("satisfies portfolioPageSchema once a single portfolio exists, so creating the first one does not break the page", async () => {
    const svc = (await portfoliosService(dbProjecting(STORED_PORTFOLIO), {} as AuditService));
    const page = await svc.listPortfolios(actorIn("org-1"), { cursor: undefined, limit: 50, status: undefined });
    expect(checkResponseAgainstContract(portfolioPageSchema, page)).toBeNull();
  });

  it("satisfies programPageSchema once a single program exists, so the program list is a cursor page like the portfolio list", async () => {
    const svc = (await programsService(dbProjecting(STORED_PROGRAM), {} as AuditService));
    const page = await svc.listPrograms(actorIn("org-1"), PROGRAM_LIST_QUERY);
    expect(checkResponseAgainstContract(programPageSchema, page)).toBeNull();
  });

  it("carries the project count each list renders in its own column, rather than dropping it at the contract", async () => {
    const svc = (await programsService(dbProjecting(STORED_PROGRAM), {} as AuditService));
    const page = await svc.listPrograms(actorIn("org-1"), PROGRAM_LIST_QUERY);
    expect(programPageSchema.parse(page).data[0]).toHaveProperty("projectCount", 4);
  });

  it("bite proof: a row missing a field its contract requires is reported, not waved through", () => {
    const missingName = {
      data: [{ ...STORED_PORTFOLIO, name: undefined }],
      pagination: { limit: 50, hasMore: false, nextCursor: null },
    };
    expect(checkResponseAgainstContract(portfolioPageSchema, missingName)).not.toBeNull();
  });

  it("bite proof: a status the portfolio pgEnum never emits is reported, where z.string() waved it through", () => {
    const wrongStatus = {
      data: [{ ...STORED_PORTFOLIO, status: "ACTIVE" }],
      pagination: { limit: 50, hasMore: false, nextCursor: null },
    };
    expect(checkResponseAgainstContract(portfolioPageSchema, wrongStatus)).not.toBeNull();
  });

  it("bite proof: a health value outside the portfolio health pgEnum is reported", () => {
    const wrongHealth = {
      data: [{ ...STORED_PORTFOLIO, health: "green" }],
      pagination: { limit: 50, hasMore: false, nextCursor: null },
    };
    expect(checkResponseAgainstContract(portfolioPageSchema, wrongHealth)).not.toBeNull();
  });
});
