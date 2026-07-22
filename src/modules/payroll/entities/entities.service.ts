import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { payrollEntities, payrollPeriods } from "../../../db/schema";

@Injectable()
export class PayrollEntitiesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  list(orgId: string) {
    return this.db
      .select()
      .from(payrollEntities)
      .where(eq(payrollEntities.orgId, orgId))
      .orderBy(desc(payrollEntities.createdAt));
  }

  async create(
    orgId: string,
    actorId: string,
    body: {
      legalName: string;
      countryCode?: string;
      stateCode?: string;
      baseCurrency?: string;
      pan?: string;
      tan?: string;
      pfEstablishmentCode?: string;
      esiCode?: string;
      ptStateCode?: string;
    },
  ) {
    try {
      const [row] = await this.db
        .insert(payrollEntities)
        .values({
          orgId,
          legalName: body.legalName,
          countryCode: body.countryCode ?? "IN",
          stateCode: body.stateCode ?? null,
          baseCurrency: body.baseCurrency ?? "INR",
          pan: body.pan ?? null,
          tan: body.tan ?? null,
          pfEstablishmentCode: body.pfEstablishmentCode ?? null,
          esiCode: body.esiCode ?? null,
          ptStateCode: body.ptStateCode ?? body.stateCode ?? null,
          createdBy: actorId,
        })
        .returning();
      return row;
    } catch {
      throw new ConflictException("A payroll entity with this legal name already exists");
    }
  }

  async ensurePeriod(
    orgId: string,
    periodKey: string,
    opts?: { entityId?: number | null; payDate?: string | null },
  ) {
    const [y, m] = periodKey.split("-").map(Number);
    const startDate = `${periodKey}-01`;
    const lastDay = new Date(y!, m!, 0).getDate();
    const endDate = `${periodKey}-${String(lastDay).padStart(2, "0")}`;

    const conditions = [
      eq(payrollPeriods.orgId, orgId),
      eq(payrollPeriods.periodKey, periodKey),
    ];
    if (opts?.entityId != null) {
      conditions.push(eq(payrollPeriods.entityId, opts.entityId));
    }
    const existing = await this.db.query.payrollPeriods.findFirst({
      where: and(...conditions),
    });
    if (existing) return existing;

    const [row] = await this.db
      .insert(payrollPeriods)
      .values({
        orgId,
        entityId: opts?.entityId ?? null,
        periodKey,
        startDate,
        endDate,
        payDate: opts?.payDate ?? endDate,
        status: "OPEN",
      })
      .returning();
    return row!;
  }

  async getEntity(orgId: string, entityId: number) {
    const row = await this.db.query.payrollEntities.findFirst({
      where: and(eq(payrollEntities.id, entityId), eq(payrollEntities.orgId, orgId)),
    });
    if (!row) throw new NotFoundException("Payroll entity not found");
    return row;
  }
}
