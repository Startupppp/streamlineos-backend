import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { hrDisciplinaryActions } from "../../../db/schema/hr/cases";
import { decodeCursor, buildCursorPage } from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import { HrAuditService } from "../core/hr-audit.service";
import { HrTemplatesService } from "../templates/hr-templates.service";
import type {
  CreateDisciplinaryActionInput,
  ListDisciplinaryInput,
} from "./dto/hr-cases.schemas";
import {
  checkProgressiveDiscipline,
  type DisciplinaryActionType,
} from "./lib/progressive-discipline";

@Injectable()
export class HrDisciplinaryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
    private readonly templatesService: HrTemplatesService,
  ) {}

  async list(orgId: string, input: ListDisciplinaryInput) {
    const { cursor, limit, employeeId, actionType } = input;
    const pos = decodeCursor(cursor);

    const conditions = [eq(hrDisciplinaryActions.orgId, orgId)];
    if (employeeId) conditions.push(eq(hrDisciplinaryActions.employeeId, employeeId));
    if (actionType) conditions.push(eq(hrDisciplinaryActions.actionType, actionType));
    if (pos) conditions.push(keysetBeforeId(hrDisciplinaryActions.createdAt, hrDisciplinaryActions.id, pos));

    const rows = await this.db
      .select()
      .from(hrDisciplinaryActions)
      .where(and(...conditions))
      .orderBy(desc(hrDisciplinaryActions.createdAt), desc(hrDisciplinaryActions.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: String(row.id),
    }));
  }

  /** Employee: actions issued against me. */
  async listMine(orgId: string, employeeId: string) {
    return this.db
      .select({
        id: hrDisciplinaryActions.id,
        actionType: hrDisciplinaryActions.actionType,
        effectiveDate: hrDisciplinaryActions.effectiveDate,
        note: hrDisciplinaryActions.note,
        caseId: hrDisciplinaryActions.caseId,
        acknowledgedAt: hrDisciplinaryActions.acknowledgedAt,
        createdAt: hrDisciplinaryActions.createdAt,
      })
      .from(hrDisciplinaryActions)
      .where(
        and(
          eq(hrDisciplinaryActions.orgId, orgId),
          eq(hrDisciplinaryActions.employeeId, employeeId),
        ),
      )
      .orderBy(desc(hrDisciplinaryActions.createdAt))
      .limit(50);
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
    const prior = await this.db
      .select({ actionType: hrDisciplinaryActions.actionType })
      .from(hrDisciplinaryActions)
      .where(
        and(
          eq(hrDisciplinaryActions.orgId, orgId),
          eq(hrDisciplinaryActions.employeeId, input.employeeId),
        ),
      );

    const progressive = checkProgressiveDiscipline(
      input.actionType as DisciplinaryActionType,
      prior.map((p) => p.actionType as DisciplinaryActionType),
      Boolean(input.forceEscalate),
    );

    if (!progressive.ok) {
      throw new BadRequestException({
        message: progressive.warning,
        missingPrior: progressive.missingPrior,
        honestyNote: progressive.honestyNote,
        code: "PROGRESSIVE_DISCIPLINE_SKIP",
      });
    }

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

    const noteParts = [input.note?.trim()].filter(Boolean) as string[];
    if (progressive.warning) {
      noteParts.push(`[progressive] ${progressive.warning}`);
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
        note: noteParts.length > 0 ? noteParts.join("\n") : null,
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
        forceEscalate: Boolean(input.forceEscalate),
        progressiveWarning: progressive.warning,
      },
      ipAddress,
    });

    return {
      ...action!,
      progressive: {
        warning: progressive.warning,
        honestyNote: progressive.honestyNote,
      },
    };
  }

  /**
   * Employee acknowledges receipt of a disciplinary action (not agreement).
   */
  async acknowledge(
    orgId: string,
    employeeId: string,
    actionId: number,
    note?: string,
  ) {
    const row = await this.getById(orgId, actionId);
    if (row.employeeId !== employeeId) {
      throw new ForbiddenException("You can only acknowledge actions issued to you");
    }
    if (row.acknowledgedAt) {
      return row;
    }

    const [updated] = await this.db
      .update(hrDisciplinaryActions)
      .set({
        acknowledgedAt: new Date(),
        acknowledgedBy: employeeId,
        note: note?.trim()
          ? [row.note, `[ack] ${note.trim()}`].filter(Boolean).join("\n")
          : row.note,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(hrDisciplinaryActions.id, actionId),
          eq(hrDisciplinaryActions.orgId, orgId),
          isNull(hrDisciplinaryActions.acknowledgedAt),
        ),
      )
      .returning();

    await this.audit.log({
      orgId,
      actorId: employeeId,
      entityType: "hr_disciplinary_action",
      entityId: String(actionId),
      action: "disciplinary.acknowledged",
      after: { acknowledged: true },
    });

    return updated ?? row;
  }

  async listUnacknowledgedCount(orgId: string, employeeId: string) {
    const [row] = await this.db
      .select({ total: count() })
      .from(hrDisciplinaryActions)
      .where(
        and(
          eq(hrDisciplinaryActions.orgId, orgId),
          eq(hrDisciplinaryActions.employeeId, employeeId),
          isNull(hrDisciplinaryActions.acknowledgedAt),
        ),
      );
    return { unacknowledged: row?.total ?? 0 };
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
