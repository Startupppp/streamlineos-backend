import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { salaryStructures } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { AuditService } from "../../common/audit/audit.service";
import { CacheService } from "../../common/cache/cache.service";
import { formatDateOnly } from "./hr-config.helpers";
import type { CreateSalaryStructureInput } from "./dto/salary-structures.schemas";

@Injectable()
export class HrSalaryStructuresService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly cache: CacheService,
  ) {}

  list(orgId: string, userId: string | undefined, requestingUserId: string, isAdmin: boolean) {
    const conditions = [eq(salaryStructures.orgId, orgId)];
    if (userId) {
      conditions.push(eq(salaryStructures.userId, userId));
    } else if (!isAdmin && requestingUserId) {
      conditions.push(eq(salaryStructures.userId, requestingUserId));
    }

    return this.db.query.salaryStructures.findMany({
      where: and(...conditions),
      orderBy: [desc(salaryStructures.effectiveFrom)],
    });
  }

  async create(orgId: string, actorId: string, input: CreateSalaryStructureInput) {
    if (!input.userId || !input.effectiveFrom) {
      throw new BadRequestException("userId, basicSalary, and effectiveFrom are required.");
    }

    const [structure] = await this.db.transaction(async (tx) => {
      await tx
        .update(salaryStructures)
        .set({ isActive: false })
        .where(
          and(
            eq(salaryStructures.userId, input.userId),
            eq(salaryStructures.orgId, orgId),
            eq(salaryStructures.isActive, true),
          ),
        );

      return tx
        .insert(salaryStructures)
        .values({
          orgId,
          userId: input.userId,
          basicSalary: input.basicSalary.toString(),
          hraPercentage: input.hraPercentage.toString(),
          allowances: input.allowances.toString(),
          deductions: input.deductions.toString(),
          effectiveFrom: formatDateOnly(new Date(input.effectiveFrom)),
          effectiveTo: input.effectiveTo ? formatDateOnly(new Date(input.effectiveTo)) : undefined,
          isActive: true,
        })
        .returning();
    });

    void this.cache.del(`hr:salary-bands:${orgId}`);

    this.audit.log({
      action: "hr.salary_changed",
      userId: actorId,
      orgId,
      targetId: input.userId,
      targetType: "salary_structure",
      metadata: { basicSalary: input.basicSalary, effectiveFrom: input.effectiveFrom },
    });

    return structure;
  }
}
