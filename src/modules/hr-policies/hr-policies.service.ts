import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq, ilike, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { hrPolicies, hrPolicyScopes, hrPolicyAssignments } from "../../db/schema";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import type {
  CreatePolicyInput,
  PoliciesListQuery,
  UpdatePolicyInput,
} from "./dto/hr-policy.schemas";
import { validatePolicyRules, buildDefaultRules } from "./hr-policy-types";
import type { PolicyType } from "./hr-policy-types";
import { buildDefaultPolicies } from "./seed-default-policies";
import { HrPolicyEvaluationService } from "./hr-policy-evaluation.service";

const POLICIES_CACHE = (orgId: string) => `hr:policies:list:${orgId}`;
const POLICY_CACHE = (orgId: string, id: number) => `hr:policies:detail:${orgId}:${id}`;

@Injectable()
export class HrPoliciesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly evaluation: HrPolicyEvaluationService,
  ) {}

  async list(orgId: string, query: PoliciesListQuery) {
    const { page, limit, type, status, search } = query;
    const offset = (page - 1) * limit;

    const conditions = [eq(hrPolicies.orgId, orgId), isNull(hrPolicies.deletedAt)];
    if (type) conditions.push(eq(hrPolicies.policyType, type));
    if (status) conditions.push(eq(hrPolicies.status, status));
    if (search) {
      const searchFilter = or(
        ilike(hrPolicies.name, `%${search}%`),
        ilike(hrPolicies.description, `%${search}%`),
      );
      if (searchFilter) conditions.push(searchFilter);
    }

    const where = and(...conditions);

    const [rows, countRows] = await Promise.all([
      this.db.query.hrPolicies.findMany({
        where,
        with: { scopes: true },
        orderBy: [desc(hrPolicies.priority), desc(hrPolicies.createdAt)],
        limit,
        offset,
      }),
      this.db
        .select({ total: count() })
        .from(hrPolicies)
        .where(where),
    ]);

    return { data: rows, total: Number(countRows[0]?.total ?? 0), page, limit };
  }

  async getById(orgId: string, policyId: number) {
    const key = POLICY_CACHE(orgId, policyId);
    return this.cache.cached(
      key,
      async () => {
        const policy = await this.db.query.hrPolicies.findFirst({
          where: and(
            eq(hrPolicies.id, policyId),
            eq(hrPolicies.orgId, orgId),
            isNull(hrPolicies.deletedAt),
          ),
          with: { scopes: true },
        });
        if (!policy) throw new NotFoundException("Policy not found");
        return policy;
      },
      CACHE_TTL.SHORT,
    );
  }

  async create(orgId: string, userId: string, input: CreatePolicyInput) {
    const validatedRules = this.parseRules(input.policyType, input.rules);

    const [policy] = await this.db
      .insert(hrPolicies)
      .values({
        orgId,
        policyType: input.policyType,
        name: input.name,
        description: input.description,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo,
        priority: input.priority,
        rules: validatedRules,
        createdBy: userId,
        status: "draft",
        version: 1,
      })
      .returning()
      .catch((e: { code?: string }) => {
        if (e.code === "23505") {
          throw new ConflictException(
            "A policy with this name, type, and version already exists",
          );
        }
        throw e;
      });

    await this.upsertScopes(orgId, policy.id, input.scopes);
    await this.cache.invalidate(POLICIES_CACHE(orgId));
    return this.getById(orgId, policy.id);
  }

  async update(orgId: string, policyId: number, input: UpdatePolicyInput) {
    const existing = await this.getById(orgId, policyId);

    if (existing.status === "active") {
      throw new BadRequestException(
        "Active policies are immutable. Create a new version instead.",
      );
    }

    const validatedRules =
      input.rules !== undefined
        ? this.parseRules(existing.policyType, input.rules)
        : undefined;

    await this.db
      .update(hrPolicies)
      .set({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.effectiveFrom !== undefined && { effectiveFrom: input.effectiveFrom }),
        ...(input.effectiveTo !== undefined && { effectiveTo: input.effectiveTo }),
        ...(input.priority !== undefined && { priority: input.priority }),
        ...(validatedRules !== undefined && { rules: validatedRules }),
      })
      .where(and(eq(hrPolicies.id, policyId), eq(hrPolicies.orgId, orgId)));

    if (input.scopes) {
      await this.upsertScopes(orgId, policyId, input.scopes);
    }

    await Promise.all([
      this.cache.invalidate(POLICIES_CACHE(orgId)),
      this.cache.invalidate(POLICY_CACHE(orgId, policyId)),
    ]);
    return this.getById(orgId, policyId);
  }

  async createVersion(orgId: string, userId: string, policyId: number) {
    const existing = await this.getById(orgId, policyId);

    const nextVersion = await this.db
      .select({ maxVersion: sql<number>`max(${hrPolicies.version})` })
      .from(hrPolicies)
      .where(
        and(
          eq(hrPolicies.orgId, orgId),
          eq(hrPolicies.policyType, existing.policyType),
          eq(hrPolicies.name, existing.name),
        ),
      )
      .then(([r]) => (r?.maxVersion ?? 0) + 1);

    const [newPolicy] = await this.db
      .insert(hrPolicies)
      .values({
        orgId,
        policyType: existing.policyType,
        name: existing.name,
        description: existing.description,
        effectiveFrom: existing.effectiveFrom,
        effectiveTo: existing.effectiveTo ?? undefined,
        priority: existing.priority,
        rules: existing.rules,
        createdBy: userId,
        status: "draft",
        version: nextVersion,
        parentPolicyId: policyId,
      })
      .returning()
      .catch((e: { code?: string }) => {
        if (e.code === "23505") throw new ConflictException("Version already exists");
        throw e;
      });

    const scopesToCopy = existing.scopes.map((s) => ({
      scopeType: s.scopeType,
      scopeValue: s.scopeValue,
    }));
    await this.upsertScopes(orgId, newPolicy.id, scopesToCopy);
    await this.cache.invalidate(POLICIES_CACHE(orgId));
    return this.getById(orgId, newPolicy.id);
  }

  async activate(orgId: string, policyId: number) {
    const policy = await this.getById(orgId, policyId);

    if (!policy.effectiveFrom) {
      throw new BadRequestException("Policy must have an effective_from date before activation");
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(hrPolicies)
        .set({ status: "active" })
        .where(and(eq(hrPolicies.id, policyId), eq(hrPolicies.orgId, orgId)));

      const lowerPriorityConflicts = await tx
        .select({ id: hrPolicies.id })
        .from(hrPolicies)
        .where(
          and(
            eq(hrPolicies.orgId, orgId),
            eq(hrPolicies.policyType, policy.policyType),
            eq(hrPolicies.status, "active"),
            ne(hrPolicies.id, policyId),
            sql`${hrPolicies.priority} < ${policy.priority}`,
          ),
        );

      if (lowerPriorityConflicts.length > 0) {
        const ids = lowerPriorityConflicts.map((r) => r.id);
        await tx
          .update(hrPolicies)
          .set({ status: "archived" })
          .where(
            and(
              eq(hrPolicies.orgId, orgId),
              inArray(hrPolicies.id, ids),
            ),
          );
      }
    });

    await Promise.all([
      this.cache.invalidate(POLICIES_CACHE(orgId)),
      this.cache.invalidate(POLICY_CACHE(orgId, policyId)),
    ]);
    return this.getById(orgId, policyId);
  }

  async archive(orgId: string, policyId: number) {
    await this.db
      .update(hrPolicies)
      .set({ status: "archived" })
      .where(and(eq(hrPolicies.id, policyId), eq(hrPolicies.orgId, orgId)));

    await Promise.all([
      this.cache.invalidate(POLICIES_CACHE(orgId)),
      this.cache.invalidate(POLICY_CACHE(orgId, policyId)),
    ]);
    return { success: true };
  }

  async preview(orgId: string, employeeId: string, policyType: PolicyType, date: string) {
    return this.evaluation.evaluatePolicy(orgId, employeeId, policyType, date);
  }

  async seedDefaults(orgId: string, userId: string) {
    const existing = await this.db
      .select({ id: hrPolicies.id })
      .from(hrPolicies)
      .where(and(eq(hrPolicies.orgId, orgId), isNull(hrPolicies.deletedAt)))
      .limit(1);

    if (existing.length > 0) {
      return { seeded: false, message: "Policies already exist for this organisation" };
    }

    const defaults = buildDefaultPolicies(orgId);
    const today = new Date().toISOString().split("T").at(0) ?? new Date().toISOString().substring(0, 10);
    let seededCount = 0;

    for (const spec of defaults) {
      const [policy] = await this.db
        .insert(hrPolicies)
        .values({
          orgId,
          policyType: spec.policyType,
          name: spec.name,
          description: spec.description,
          effectiveFrom: today,
          rules: spec.rules,
          priority: spec.priority,
          createdBy: userId,
          status: "active",
          version: 1,
        })
        .returning();

      await this.db.insert(hrPolicyScopes).values({
        orgId,
        policyId: policy.id,
        scopeType: "organization",
        scopeValue: orgId,
      });
      seededCount++;
    }

    await this.cache.invalidate(POLICIES_CACHE(orgId));
    return { seeded: true, count: seededCount };
  }

  private parseRules(policyType: PolicyType, rules: Record<string, unknown>) {
    try {
      return validatePolicyRules(policyType, rules);
    } catch {
      throw new BadRequestException("Invalid rules for policy type: " + policyType);
    }
  }

  private async upsertScopes(
    orgId: string,
    policyId: number,
    scopes: Array<{ scopeType: string; scopeValue: string }>,
  ) {
    await this.db
      .delete(hrPolicyScopes)
      .where(eq(hrPolicyScopes.policyId, policyId));

    if (scopes.length > 0) {
      await this.db.insert(hrPolicyScopes).values(
        scopes.map((s) => ({
          orgId,
          policyId,
          scopeType: s.scopeType as typeof hrPolicyScopes.$inferInsert["scopeType"],
          scopeValue: s.scopeValue,
        })),
      );
    }
  }
}
