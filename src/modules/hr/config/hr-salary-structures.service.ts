import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { employeeSalaryProfiles } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
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
    const conditions = [eq(employeeSalaryProfiles.orgId, orgId)];
    if (userId) {
      conditions.push(eq(employeeSalaryProfiles.userId, userId));
    } else if (!isAdmin && requestingUserId) {
      conditions.push(eq(employeeSalaryProfiles.userId, requestingUserId));
    }

    return this.db.query.employeeSalaryProfiles.findMany({
      where: and(...conditions),
      orderBy: [desc(employeeSalaryProfiles.effectiveFrom)],
    });
  }

  async create(orgId: string, actorId: string, input: CreateSalaryStructureInput) {
    if (!input.userId || !input.effectiveFrom) {
      throw new BadRequestException("userId, basicSalary, and effectiveFrom are required.");
    }

    const annualCtc = (input.basicSalary * 12).toFixed(2);

    const [profile] = await this.db.transaction(async (tx) => {
      await tx
        .update(employeeSalaryProfiles)
        .set({ status: "SUPERSEDED" })
        .where(
          and(
            eq(employeeSalaryProfiles.userId, input.userId),
            eq(employeeSalaryProfiles.orgId, orgId),
            eq(employeeSalaryProfiles.status, "ACTIVE"),
          ),
        );

      return tx
        .insert(employeeSalaryProfiles)
        .values({
          orgId,
          userId: input.userId,
          annualCtc,
          basicSalary: input.basicSalary.toString(),
          hraPercentage: input.hraPercentage.toString(),
          allowances: input.allowances.toString(),
          deductions: input.deductions.toString(),
          effectiveFrom: formatDateOnly(new Date(input.effectiveFrom)),
          effectiveTo: input.effectiveTo ? formatDateOnly(new Date(input.effectiveTo)) : undefined,
          status: "ACTIVE",
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

    return profile;
  }
}
