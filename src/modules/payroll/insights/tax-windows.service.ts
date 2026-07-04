import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { logger } from "../../../common/logger/logger.service";
import { and, desc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { payrollTaxWindows } from "../../../db/schema";
import { PayrollNotificationsService } from "./payroll-notifications.service";

type TaxWindowStatus = typeof payrollTaxWindows.$inferSelect["status"];
type TaxWindowInsert = typeof payrollTaxWindows.$inferInsert;

const VALID_TRANSITIONS: Record<TaxWindowStatus, TaxWindowStatus[]> = {
  DRAFT: ["OPEN"],
  OPEN: ["CLOSED"],
  CLOSED: ["LOCKED"],
  LOCKED: [],
};

@Injectable()
export class TaxWindowsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly notifications: PayrollNotificationsService,
  ) {}

  list(orgId: string) {
    return this.db
      .select()
      .from(payrollTaxWindows)
      .where(eq(payrollTaxWindows.orgId, orgId))
      .orderBy(desc(payrollTaxWindows.financialYear));
  }

  async create(
    orgId: string,
    data: {
      financialYear: string;
      opensAt: string;
      closesAt: string;
      proofDeadline?: string;
      lockDate?: string;
    },
  ) {
    const [existing] = await this.db
      .select({ id: payrollTaxWindows.id })
      .from(payrollTaxWindows)
      .where(
        and(
          eq(payrollTaxWindows.orgId, orgId),
          eq(payrollTaxWindows.financialYear, data.financialYear),
        ),
      );

    if (existing) {
      throw new ConflictException(`Tax window for ${data.financialYear} already exists`);
    }

    const [row] = await this.db
      .insert(payrollTaxWindows)
      .values({
        orgId,
        financialYear: data.financialYear,
        opensAt: new Date(data.opensAt),
        closesAt: new Date(data.closesAt),
        proofDeadline: data.proofDeadline ? new Date(data.proofDeadline) : null,
        lockDate: data.lockDate ?? null,
        status: "DRAFT",
      })
      .returning();

    return row;
  }

  async update(
    orgId: string,
    id: number,
    data: {
      opensAt?: string;
      closesAt?: string;
      proofDeadline?: string;
      lockDate?: string;
      status?: string;
    },
    actorId?: string,
  ) {
    const [existing] = await this.db
      .select()
      .from(payrollTaxWindows)
      .where(and(eq(payrollTaxWindows.id, id), eq(payrollTaxWindows.orgId, orgId)));

    if (!existing) throw new NotFoundException("Tax window not found");

    if (data.status !== undefined) {
      const allowed = VALID_TRANSITIONS[existing.status] as string[];
      if (!allowed.includes(data.status)) {
        throw new BadRequestException(
          `Cannot transition from ${existing.status} to ${data.status}`,
        );
      }
    }

    const patch: Partial<TaxWindowInsert> & { updatedAt?: Date } = {
      updatedAt: new Date(),
    };

    if (data.opensAt !== undefined) patch.opensAt = new Date(data.opensAt);
    if (data.closesAt !== undefined) patch.closesAt = new Date(data.closesAt);
    if (data.proofDeadline !== undefined) patch.proofDeadline = new Date(data.proofDeadline);
    if (data.lockDate !== undefined) patch.lockDate = data.lockDate;
    if (data.status !== undefined) patch.status = data.status as TaxWindowStatus;

    const [updated] = await this.db
      .update(payrollTaxWindows)
      .set(patch)
      .where(eq(payrollTaxWindows.id, id))
      .returning();

    if (data.status === "OPEN" && actorId && updated?.closesAt) {
      this.notifications
        .notifyDeclarationWindow(orgId, actorId, updated.financialYear, updated.closesAt)
        .catch((e: unknown) => logger.error("notifyDeclarationWindow failed", { error: String(e) }));
    }

    return updated;
  }

  async getActiveWindow(orgId: string) {
    const [row] = await this.db
      .select()
      .from(payrollTaxWindows)
      .where(and(eq(payrollTaxWindows.orgId, orgId), eq(payrollTaxWindows.status, "OPEN")))
      .limit(1);

    return row ?? null;
  }
}
