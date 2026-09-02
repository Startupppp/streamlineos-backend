import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, ilike, isNull, sql } from "drizzle-orm";
import { testCases, testSuites } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import { assertProjectAccess } from "../core/project-access";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import type {
  CreateTestCaseInput,
  CreateTestSuiteInput,
  TestCaseListQuery,
  UpdateTestCaseInput,
  UpdateTestSuiteInput,
} from "./dto/qa.schemas";

@Injectable()
export class TestManagementService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async listSuites(u: CurrentUserContext, projectId: number) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    return this.db
      .select()
      .from(testSuites)
      .where(
        and(
          eq(testSuites.orgId, u.orgId),
          eq(testSuites.projectId, projectId),
          isNull(testSuites.deletedAt),
        ),
      )
      .orderBy(testSuites.position, testSuites.id)
      .limit(100);
  }

  async createSuite(u: CurrentUserContext, projectId: number, input: CreateTestSuiteInput) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    if (input.parentId !== undefined) {
      const parent = await this.db.query.testSuites.findFirst({
        where: and(
          eq(testSuites.id, input.parentId),
          eq(testSuites.orgId, u.orgId),
          eq(testSuites.projectId, projectId),
          isNull(testSuites.deletedAt),
        ),
        columns: { id: true },
      });
      if (!parent) throw new NotFoundException("Parent suite not found");
    }
    const [suite] = await this.db
      .insert(testSuites)
      .values({
        orgId: u.orgId,
        projectId,
        name: input.name,
        description: input.description,
        parentId: input.parentId ?? null,
        createdBy: u.userId,
      })
      .returning();
    return suite;
  }

  async updateSuite(orgId: string, projectId: number, suiteId: number, input: UpdateTestSuiteInput) {
    const existing = await this.db.query.testSuites.findFirst({
      where: and(
        eq(testSuites.id, suiteId),
        eq(testSuites.orgId, orgId),
        eq(testSuites.projectId, projectId),
        isNull(testSuites.deletedAt),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Test suite not found");
    const [updated] = await this.db
      .update(testSuites)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.parentId !== undefined && { parentId: input.parentId }),
        updatedAt: new Date(),
      })
      .where(and(eq(testSuites.id, suiteId), eq(testSuites.orgId, orgId)))
      .returning();
    return updated;
  }

  async deleteSuite(orgId: string, projectId: number, suiteId: number) {
    const existing = await this.db.query.testSuites.findFirst({
      where: and(
        eq(testSuites.id, suiteId),
        eq(testSuites.orgId, orgId),
        eq(testSuites.projectId, projectId),
        isNull(testSuites.deletedAt),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Test suite not found");
    await this.db
      .update(testSuites)
      .set({ deletedAt: new Date() })
      .where(and(eq(testSuites.id, suiteId), eq(testSuites.orgId, orgId)));
    return { success: true };
  }

  async listCases(u: CurrentUserContext, projectId: number, query: TestCaseListQuery) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const conditions = [
      eq(testCases.orgId, u.orgId),
      eq(testCases.projectId, projectId),
      isNull(testCases.deletedAt),
    ];
    if (query.suiteId !== undefined) conditions.push(eq(testCases.suiteId, query.suiteId));
    if (query.priority) conditions.push(eq(testCases.priority, query.priority));
    if (query.automationStatus) conditions.push(eq(testCases.automationStatus, query.automationStatus));
    if (query.q) conditions.push(ilike(testCases.title, `%${query.q}%`));
    return this.db
      .select()
      .from(testCases)
      .where(and(...conditions))
      .orderBy(testCases.caseNumber)
      .limit(100);
  }

  async getCase(orgId: string, projectId: number, caseId: number) {
    const tc = await this.db.query.testCases.findFirst({
      where: and(
        eq(testCases.id, caseId),
        eq(testCases.orgId, orgId),
        eq(testCases.projectId, projectId),
        isNull(testCases.deletedAt),
      ),
    });
    if (!tc) throw new NotFoundException("Test case not found");
    return tc;
  }

  async createCase(u: CurrentUserContext, projectId: number, input: CreateTestCaseInput) {
    await assertProjectAccess(this.db, this.access, u, projectId);
    const [tc] = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${projectId})`);
      const [maxRow] = await tx
        .select({ maxNum: sql<number>`COALESCE(MAX(${testCases.caseNumber}), 0)` })
        .from(testCases)
        .where(and(eq(testCases.projectId, projectId), eq(testCases.orgId, u.orgId)));
      const nextNumber = (maxRow?.maxNum ?? 0) + 1;
      return tx
        .insert(testCases)
        .values({
          orgId: u.orgId,
          projectId,
          caseNumber: nextNumber,
          suiteId: input.suiteId ?? null,
          title: input.title,
          preconditions: input.preconditions,
          steps: input.steps ?? [],
          expectedResult: input.expectedResult,
          priority: input.priority ?? "medium",
          component: input.component,
          linkedTicketId: input.linkedTicketId ?? null,
          automationStatus: input.automationStatus ?? "manual",
          createdBy: u.userId,
        })
        .returning();
    });
    return tc;
  }

  async updateCase(orgId: string, projectId: number, caseId: number, input: UpdateTestCaseInput) {
    const existing = await this.db.query.testCases.findFirst({
      where: and(
        eq(testCases.id, caseId),
        eq(testCases.orgId, orgId),
        eq(testCases.projectId, projectId),
        isNull(testCases.deletedAt),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Test case not found");
    const [updated] = await this.db
      .update(testCases)
      .set({
        ...(input.suiteId !== undefined && { suiteId: input.suiteId }),
        ...(input.title !== undefined && { title: input.title }),
        ...(input.preconditions !== undefined && { preconditions: input.preconditions }),
        ...(input.steps !== undefined && { steps: input.steps }),
        ...(input.expectedResult !== undefined && { expectedResult: input.expectedResult }),
        ...(input.priority !== undefined && { priority: input.priority }),
        ...(input.component !== undefined && { component: input.component }),
        ...(input.linkedTicketId !== undefined && { linkedTicketId: input.linkedTicketId }),
        ...(input.automationStatus !== undefined && { automationStatus: input.automationStatus }),
        updatedAt: new Date(),
      })
      .where(and(eq(testCases.id, caseId), eq(testCases.orgId, orgId)))
      .returning();
    return updated;
  }

  async deleteCase(orgId: string, projectId: number, caseId: number) {
    const existing = await this.db.query.testCases.findFirst({
      where: and(
        eq(testCases.id, caseId),
        eq(testCases.orgId, orgId),
        eq(testCases.projectId, projectId),
        isNull(testCases.deletedAt),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Test case not found");
    await this.db
      .update(testCases)
      .set({ deletedAt: new Date() })
      .where(and(eq(testCases.id, caseId), eq(testCases.orgId, orgId)));
    return { success: true };
  }
}
