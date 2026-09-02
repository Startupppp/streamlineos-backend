import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, sum } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { invoices, purchaseBills } from "../../../db/schema/crm/invoicing";
import { organizations } from "../../../db/schema/common/auth";
import { CacheService } from "../../../common/cache/cache.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { logSideEffectFailure } from "../../../common/logger/side-effect";
import { getTenantContext } from "../../../common/tenant";

const INVOICE_POSTED = ["ISSUED", "PAID", "FAILED"] as const;
const BILL_POSTED = ["POSTED", "PARTIALLY_PAID", "PAID"] as const;
const DUE_WARNING_DAYS = 5;
const TAX_DEDUPE_KEY = (orgId: string, gstr1Due: string) =>
  `fin:tax-due-notified:${orgId}:${gstr1Due}`;
const TAX_DEDUPE_TTL = 60 * 60 * 24 * 7;

interface DueResult {
  orgId: string;
  liabilityAmount: number;
  gstr1DueDate: string;
  gstr3bDueDate: string;
  daysUntilGstr1: number;
  daysUntilGstr3b: number;
}

@Injectable()
export class TaxComplianceService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async checkTaxDue(orgId?: string): Promise<DueResult[]> {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const todayIso = today.toISOString().slice(0, 10);

    const prevMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0);
    const prevMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const from = prevMonthStart.toISOString().slice(0, 10);
    const to = prevMonthEnd.toISOString().slice(0, 10);

    const nextYear = today.getMonth() === 11 ? today.getFullYear() + 1 : today.getFullYear();
    const nextMonth = today.getMonth() === 11 ? 0 : today.getMonth() + 1;
    const monthStr = String(nextMonth + 1).padStart(2, "0");
    const gstr1Due = `${nextYear}-${monthStr}-11`;
    const gstr3bDue = `${nextYear}-${monthStr}-20`;

    const gstr1Days = this.daysBetween(todayIso, gstr1Due);
    const gstr3bDays = this.daysBetween(todayIso, gstr3bDue);

    if (gstr1Days > DUE_WARNING_DAYS && gstr3bDays > DUE_WARNING_DAYS) {
      return [];
    }

    const effectiveOrgId = orgId ?? getTenantContext()?.orgId;
    const orgIds = effectiveOrgId ? [effectiveOrgId] : await this.getAllActiveOrgIds();
    const results: DueResult[] = [];

    for (const oid of orgIds) {
      const liability = await this.computeNetLiability(oid);
      if (liability <= 0) continue;

      const dedupeKey = TAX_DEDUPE_KEY(oid, gstr1Due);
      let alreadyNotified: boolean;
      try {
        const stored = await this.cache.cached<string>(dedupeKey, async () => "PENDING", TAX_DEDUPE_TTL);
        alreadyNotified = stored === "SENT";
      } catch (err: unknown) {
        logSideEffectFailure("tax-due dedup cache read", { orgId: oid })(err);
        continue;
      }

      if (alreadyNotified) continue;

      const result: DueResult = {
        orgId: oid,
        liabilityAmount: liability,
        gstr1DueDate: gstr1Due,
        gstr3bDueDate: gstr3bDue,
        daysUntilGstr1: gstr1Days,
        daysUntilGstr3b: gstr3bDays,
      };
      results.push(result);

      await this.dispatch.emit({
        eventKey: "accounting.tax.due",
        orgId: oid,
        actorUserId: "system",
        targetUserIds: [],
        entityType: "tax_compliance",
        entityId: oid,
        variables: {
          liabilityAmount: String(liability.toFixed(2)),
          gstr1DueDate: gstr1Due,
          gstr3bDueDate: gstr3bDue,
          daysUntilGstr1: String(gstr1Days),
          daysUntilGstr3b: String(gstr3bDays),
          period: `${from} to ${to}`,
        },
      }).catch(logSideEffectFailure("tax compliance notification dispatch", { orgId: oid }));

      await this.cache.set(dedupeKey, "SENT", TAX_DEDUPE_TTL)
        .catch(logSideEffectFailure("tax-due dedup cache write", { orgId: oid }));
    }

    return results;
  }

  private async computeNetLiability(orgId: string): Promise<number> {
    const [outwardAgg, inwardAgg] = await Promise.all([
      this.db
        .select({
          cgst: sum(invoices.cgstAmount),
          sgst: sum(invoices.sgstAmount),
          igst: sum(invoices.igstAmount),
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.orgId, orgId),
            inArray(invoices.status, [...INVOICE_POSTED]),
          ),
        ),
      this.db
        .select({
          cgst: sum(purchaseBills.cgstAmount),
          sgst: sum(purchaseBills.sgstAmount),
          igst: sum(purchaseBills.igstAmount),
        })
        .from(purchaseBills)
        .where(
          and(
            eq(purchaseBills.orgId, orgId),
            inArray(purchaseBills.status, [...BILL_POSTED]),
          ),
        ),
    ]);

    const outward = outwardAgg[0] ?? { cgst: "0", sgst: "0", igst: "0" };
    const inward = inwardAgg[0] ?? { cgst: "0", sgst: "0", igst: "0" };

    const outTax = Number(outward.cgst ?? 0) + Number(outward.sgst ?? 0) + Number(outward.igst ?? 0);
    const inTax = Number(inward.cgst ?? 0) + Number(inward.sgst ?? 0) + Number(inward.igst ?? 0);

    return Math.max(0, outTax - inTax);
  }

  private async getAllActiveOrgIds(): Promise<string[]> {
    const rows = await this.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(isNull(organizations.deletedAt), eq(organizations.status, "ACTIVE")))
      .orderBy(asc(organizations.id));
    return rows.map((r) => r.id);
  }

  private daysBetween(from: string, to: string): number {
    const a = new Date(from).getTime();
    const b = new Date(to).getTime();
    return Math.ceil((b - a) / (1000 * 60 * 60 * 24));
  }
}
