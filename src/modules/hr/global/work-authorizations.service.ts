import {
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, isNull, lte } from "drizzle-orm";
import { decodeCursor, buildCursorPage } from "../../../common/pagination/cursor";
import { keysetAfterValue } from "../../../common/pagination/keyset";
import { hrWorkAuthorizations } from "../../../db/schema/hr/global-compliance";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { HrAuditService } from "../core/hr-audit.service";
import type {
  CreateWorkAuthInput,
  UpdateWorkAuthInput,
  ListWorkAuthInput,
} from "./dto/hr-global.schemas";

@Injectable()
export class WorkAuthorizationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: HrAuditService,
  ) {}

  async list(orgId: string, input: ListWorkAuthInput) {
    const { cursor, limit, employmentId, status, days } = input;
    const pos = decodeCursor(cursor);

    const conditions = [
      eq(hrWorkAuthorizations.orgId, orgId),
      isNull(hrWorkAuthorizations.deletedAt),
    ];

    if (employmentId) conditions.push(eq(hrWorkAuthorizations.employmentId, employmentId));
    if (status) conditions.push(eq(hrWorkAuthorizations.status, status));

    if (days !== undefined) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() + days);
      conditions.push(lte(hrWorkAuthorizations.validUntil, cutoff.toISOString().split("T")[0]));
    }

    if (pos) conditions.push(keysetAfterValue(hrWorkAuthorizations.validUntil, hrWorkAuthorizations.id, pos));

    const rows = await this.db
      .select()
      .from(hrWorkAuthorizations)
      .where(and(...conditions))
      .orderBy(asc(hrWorkAuthorizations.validUntil), asc(hrWorkAuthorizations.id))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: String(row.validUntil ?? ""),
      id: String(row.id),
    }));
  }

  async getOne(orgId: string, id: number) {
    const row = await this.db.query.hrWorkAuthorizations.findFirst({
      where: and(
        eq(hrWorkAuthorizations.id, id),
        eq(hrWorkAuthorizations.orgId, orgId),
        isNull(hrWorkAuthorizations.deletedAt),
      ),
    });
    if (!row) throw new NotFoundException("Work authorization not found");
    return row;
  }

  async create(orgId: string, actorId: string, input: CreateWorkAuthInput) {
    const [created] = await this.db
      .insert(hrWorkAuthorizations)
      .values({
        orgId,
        employmentId: input.employmentId,
        authType: input.authType,
        countryCode: input.countryCode,
        documentNumberMasked: input.documentNumberMasked ?? null,
        validFrom: input.validFrom ?? null,
        validUntil: input.validUntil ?? null,
        status: input.status,
        note: input.note ?? null,
        createdBy: actorId,
      })
      .returning();

    if (!created) throw new Error("Failed to create work authorization");

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_work_authorizations",
      entityId: String(created.id),
      action: "created",
      after: { ...created, documentNumberMasked: "[masked]" },
    });

    return created;
  }

  async update(orgId: string, id: number, actorId: string, input: UpdateWorkAuthInput) {
    const existing = await this.getOne(orgId, id);

    const [updated] = await this.db
      .update(hrWorkAuthorizations)
      .set({
        ...(input.authType !== undefined && { authType: input.authType }),
        ...(input.countryCode !== undefined && { countryCode: input.countryCode }),
        ...(input.documentNumberMasked !== undefined && { documentNumberMasked: input.documentNumberMasked }),
        ...(input.validFrom !== undefined && { validFrom: input.validFrom }),
        ...(input.validUntil !== undefined && { validUntil: input.validUntil }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.note !== undefined && { note: input.note }),
        updatedAt: new Date(),
      })
      .where(and(eq(hrWorkAuthorizations.id, id), eq(hrWorkAuthorizations.orgId, orgId)))
      .returning();

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_work_authorizations",
      entityId: String(id),
      action: "updated",
      before: { ...existing, documentNumberMasked: "[masked]" },
      after: { ...updated, documentNumberMasked: "[masked]" },
    });

    return updated;
  }

  async remove(orgId: string, id: number, actorId: string) {
    const existing = await this.getOne(orgId, id);

    await this.db
      .update(hrWorkAuthorizations)
      .set({ deletedAt: new Date() })
      .where(and(eq(hrWorkAuthorizations.id, id), eq(hrWorkAuthorizations.orgId, orgId)));

    await this.audit.log({
      orgId,
      actorId,
      entityType: "hr_work_authorizations",
      entityId: String(id),
      action: "deleted",
      before: existing,
    });

    return { ok: true };
  }

  async refreshExpiredStatuses(orgId: string) {
    const today = new Date().toISOString().split("T")[0];
    const expiringCutoff = new Date();
    expiringCutoff.setDate(expiringCutoff.getDate() + 30);
    const cutoffStr = expiringCutoff.toISOString().split("T")[0];

    await this.db.transaction(async (tx) => {
      await tx
        .update(hrWorkAuthorizations)
        .set({ status: "expired" })
        .where(
          and(
            eq(hrWorkAuthorizations.orgId, orgId),
            eq(hrWorkAuthorizations.status, "active"),
            lte(hrWorkAuthorizations.validUntil, today),
            isNull(hrWorkAuthorizations.deletedAt),
          ),
        );

      await tx
        .update(hrWorkAuthorizations)
        .set({ status: "expiring" })
        .where(
          and(
            eq(hrWorkAuthorizations.orgId, orgId),
            eq(hrWorkAuthorizations.status, "active"),
            lte(hrWorkAuthorizations.validUntil, cutoffStr),
            isNull(hrWorkAuthorizations.deletedAt),
          ),
        );
    });
  }
}
