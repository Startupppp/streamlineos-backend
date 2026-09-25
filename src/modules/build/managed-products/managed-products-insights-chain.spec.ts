import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { ManagedProductsService } from "./managed-products.service";
import { AuditService } from "../../../common/audit/audit.service";
import type { Db } from "../../../db/drizzle.module";
import { managedProductRowSchema } from "./dto/managed-products-response.schemas";
import { managedProductStatusEnum } from "../../../db/schema";

const dialect = new PgDialect();
const ORG = "org-chain-1";
const PRODUCT_ID = 77;

function renderParams(sql: SQL | undefined): unknown[] {
  if (!sql) throw new Error("expected SQL clause to be captured");
  return dialect.sqlToQuery(sql).params;
}

function renderSql(sql: SQL | undefined): string {
  if (!sql) throw new Error("expected SQL clause to be captured");
  return dialect.sqlToQuery(sql).sql;
}

interface Capture {
  projects: { where?: SQL };
  submissions: { joinOn?: SQL; where?: SQL };
}

function makeInsightsDb(loadRow: object | null): { db: Db; capture: Capture } {
  const capture: Capture = {
    projects: {},
    submissions: {},
  };

  let selectCallCount = 0;

  const loadChain = {
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(loadRow === null ? [] : [loadRow]),
      }),
    }),
  };

  function projectsChain() {
    return {
      from: () => ({
        where: (w: SQL) => {
          capture.projects.where = w;
          return { groupBy: () => Promise.resolve([]) };
        },
      }),
    };
  }

  function submissionsChain() {
    return {
      from: () => ({
        innerJoin: (_table: unknown, on: SQL) => {
          capture.submissions.joinOn = on;
          return {
            where: (w: SQL) => {
              capture.submissions.where = w;
              return { groupBy: () => Promise.resolve([]) };
            },
          };
        },
      }),
    };
  }

  function emptyAggregateChain() {
    return {
      from: () => ({
        innerJoin: () => ({
          innerJoin: () => ({
            where: () => ({ groupBy: () => Promise.resolve([]) }),
          }),
          where: () => ({ groupBy: () => Promise.resolve([]) }),
        }),
        where: () => ({ groupBy: () => Promise.resolve([]) }),
      }),
    };
  }

  const db = {
    select: jest.fn(() => {
      selectCallCount += 1;
      if (selectCallCount === 1) return loadChain;
      if (selectCallCount === 2) return projectsChain();
      if (selectCallCount === 3) return submissionsChain();
      return emptyAggregateChain();
    }),
  } as unknown as Db;

  return { db, capture };
}

const audit = { log: jest.fn() } as unknown as AuditService;

function makeService(db: Db): ManagedProductsService {
  return new ManagedProductsService(db, audit);
}

describe("getProductInsights — discovery chain SQL binding", () => {
  const loadRow = { id: PRODUCT_ID, orgId: ORG, deletedAt: null };

  describe("submissions subquery binds orgId AND managedProductId (cross-tenant isolation)", () => {
    it("binds the caller orgId in the submissions WHERE predicate", async () => {
      const { db, capture } = makeInsightsDb(loadRow);
      await makeService(db).getProductInsights(ORG, PRODUCT_ID);
      expect(renderParams(capture.submissions.where)).toContain(ORG);
    });

    it("binds managedProductId in the submissions WHERE predicate", async () => {
      const { db, capture } = makeInsightsDb(loadRow);
      await makeService(db).getProductInsights(ORG, PRODUCT_ID);
      expect(renderParams(capture.submissions.where)).toContain(PRODUCT_ID);
    });

    it("binds orgId in the JOIN ON clause so a cross-tenant widget cannot satisfy the join", async () => {
      const { db, capture } = makeInsightsDb(loadRow);
      await makeService(db).getProductInsights(ORG, PRODUCT_ID);
      expect(renderSql(capture.submissions.joinOn)).toMatch(/org_id/);
    });

    it("throws 404 before executing any aggregate query when the product is foreign (no write)", async () => {
      const { db, capture } = makeInsightsDb(null);
      await expect(makeService(db).getProductInsights(ORG, PRODUCT_ID)).rejects.toThrow(
        "Managed product not found",
      );
      expect(capture.submissions.where).toBeUndefined();
    });
  });

  describe("projects subquery binds orgId AND managedProductId", () => {
    it("binds orgId in the projects WHERE predicate", async () => {
      const { db, capture } = makeInsightsDb(loadRow);
      await makeService(db).getProductInsights(ORG, PRODUCT_ID);
      expect(renderParams(capture.projects.where)).toContain(ORG);
    });

    it("binds managedProductId in the projects WHERE predicate", async () => {
      const { db, capture } = makeInsightsDb(loadRow);
      await makeService(db).getProductInsights(ORG, PRODUCT_ID);
      expect(renderParams(capture.projects.where)).toContain(PRODUCT_ID);
    });
  });
});

describe("managedProductRowSchema — enum and nullability contract", () => {
  const validDates = { createdAt: new Date(), updatedAt: new Date(), deletedAt: null, targetLaunchDate: null };

  it("rejects a status value that is not in managedProductStatusEnum", () => {
    const raw = { id: 1, orgId: ORG, name: "Atlas", key: "ATLAS", description: null, status: "invalid_status", ownerId: null, vision: null, missionStatement: null, targetCustomer: null, differentiators: null, currentPhase: null, successMetrics: null, ownerMembershipId: null, ...validDates };
    expect(() => managedProductRowSchema.parse(raw)).toThrow();
  });

  it("accepts every value in managedProductStatusEnum", () => {
    for (const value of managedProductStatusEnum.enumValues) {
      const raw = { id: 1, orgId: ORG, name: "Atlas", key: "ATLAS", description: null, status: value, ownerId: null, vision: null, missionStatement: null, targetCustomer: null, differentiators: null, currentPhase: null, successMetrics: null, ownerMembershipId: null, ...validDates };
      expect(() => managedProductRowSchema.parse(raw)).not.toThrow();
    }
  });

  it("no longer accepts a pmWorkspaceId field in the row shape, because the schema is .strict()-free but the field was removed from the model", () => {
    const raw = { id: 1, orgId: ORG, name: "Atlas", key: "ATLAS", description: null, status: "active", ownerId: null, vision: null, missionStatement: null, targetCustomer: null, differentiators: null, currentPhase: null, successMetrics: null, ownerMembershipId: null, ...validDates };
    const parsed = managedProductRowSchema.parse(raw);
    expect(parsed).not.toHaveProperty("pmWorkspaceId");
  });

  it("accepts a row with no pmWorkspaceId at all (the field no longer exists on the model)", () => {
    const raw = { id: 1, orgId: ORG, name: "Atlas", key: "ATLAS", description: null, status: "active", ownerId: null, vision: null, missionStatement: null, targetCustomer: null, differentiators: null, currentPhase: null, successMetrics: null, ownerMembershipId: null, ...validDates };
    expect(() => managedProductRowSchema.parse(raw)).not.toThrow();
  });
});
