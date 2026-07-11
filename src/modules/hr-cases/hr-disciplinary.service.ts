import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, count, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { hrDisciplinaryActions } from "../../db/schema/hr/cases";
import { HrAuditService } from "../hr-core/hr-audit.service";
import { HrTemplatesService } from "../hr-templates/hr-templates.service";
import type {
  CreateDisciplinaryActionInput,
  ListDisciplinaryInput,
} from "./dto/hr-cases.schemas";

@Injectable()
export class HrDisciplinaryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
    private readonly templatesService: HrTemplatesService,
  ) {}

  async list(orgId: string, input: ListDisciplinaryInput) {
    const { page, limit, employeeId, actionType } = input;
    const offset = (page - 1) * limit;

    const conditions = [eq(hrDisciplinaryActions.orgId, orgId)];
    if (employeeId) conditions.push(eq(hrDisciplinaryActions.employeeId, employeeId));
    if (actionType) conditions.push(eq(hrDisciplinaryActions.actionType, actionType));

    const where = and(...conditions);

    const [rows, totalResult] = await Promise.all([
      this.db
        .select()
        .from(hrDisciplinaryActions)
        .where(where)
        .orderBy(desc(hrDisciplinaryActions.createdAt))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(hrDisciplinaryActions).where(where),
    ]);

    return {
      data: rows,
      pagination: {
        page,
        limit,
        total: totalResult[0]?.total ?? 0,
        totalPages: Math.ceil((totalResult[0]?.total ?? 0) / limit),
      },
    };
  }

  async getById(orgId: string, id: number) {
    const [row] = await this.db
      .select()
      .from(hrDisciplinaryActions)
      .where(and(eq(hrDisciplinaryActions.orgId, orgId), eq(hrDisciplinaryActions.id, id)))
      .limit(1);

    if (!row) throw new NotFoundException("Disciplinary action not found");
    return row;
  }

  async create(
    orgId: string,
    issuedByUserId: string,
    input: CreateDisciplinaryActionInput,
    ipAddress?: string,
  ) {
    let letterRenderId: number | null = null;

    if (input.generateLetter && input.letterTemplateId) {
      const rendered = await this.templatesService.render(
        orgId,
        issuedByUserId,
        input.letterTemplateId,
        {
          employeeId: undefined,
          extraContext: input.letterContext ?? {},
          includeSensitive: false,
        },
      );
      letterRenderId = rendered.renderId ?? null;
    }

    const [action] = await this.db
      .insert(hrDisciplinaryActions)
      .values({
        orgId,
        caseId: input.caseId ?? null,
        employeeId: input.employeeId,
        actionType: input.actionType,
        letterRenderId,
        effectiveDate: new Date(input.effectiveDate),
        issuedBy: issuedByUserId,
        note: input.note ?? null,
      })
      .returning();

    await this.audit.log({
      orgId,
      actorId: issuedByUserId,
      entityType: "hr_disciplinary_action",
      entityId: String(action!.id),
      action: "disciplinary.issued",
      after: {
        actionType: input.actionType,
        employeeId: input.employeeId,
        effectiveDate: input.effectiveDate,
      },
      ipAddress,
    });

    return action!;
  }

  async delete(orgId: string, id: number, actorId: string) {
    await this.getById(orgId, id);

    await this.db
      .delete(hrDisciplinaryActions)
      .where(and(eq(hrDisciplinaryActions.orgId, orgId), eq(hrDisciplinaryActions.id, id)));

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_disciplinary_action",
      entityId: String(id),
      action: "disciplinary.deleted",
    });
  }
}
