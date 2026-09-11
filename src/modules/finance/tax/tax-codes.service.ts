import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { accTaxCodes } from "../../../db/schema/accounting/finance-tax";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS } from "../../../common/cache/cache-keys";
import { AuditService } from "../../../common/audit/audit.service";
import { isUniqueViolation } from "../../../common/db/postgres-error";
import { FinancePostingService } from "../../accounting/posting/finance-posting.service";
import { buildCursorPage, decodeCursor, type CursorPage } from "../../../common/pagination/cursor";
import { keysetAfterValue } from "../../../common/pagination/keyset";
import type { CreateTaxCodeInput, ListTaxCodesQuery, UpdateTaxCodeInput } from "./dto/tax-codes.schemas";

const DEFAULT_CODES = [
  { code: "GST0", name: "GST 0%", rate: "0.00", taxType: "GST" as const, isReverseCharge: false },
  { code: "GST5", name: "GST 5%", rate: "5.00", taxType: "CGST_SGST" as const, isReverseCharge: false },
  { code: "IGST5", name: "IGST 5%", rate: "5.00", taxType: "IGST" as const, isReverseCharge: false },
  { code: "GST12", name: "GST 12%", rate: "12.00", taxType: "CGST_SGST" as const, isReverseCharge: false },
  { code: "IGST12", name: "IGST 12%", rate: "12.00", taxType: "IGST" as const, isReverseCharge: false },
  { code: "GST18", name: "GST 18%", rate: "18.00", taxType: "CGST_SGST" as const, isReverseCharge: false },
  { code: "IGST18", name: "IGST 18%", rate: "18.00", taxType: "IGST" as const, isReverseCharge: false },
  { code: "GST28", name: "GST 28%", rate: "28.00", taxType: "CGST_SGST" as const, isReverseCharge: false },
  { code: "IGST28", name: "IGST 28%", rate: "28.00", taxType: "IGST" as const, isReverseCharge: false },
  { code: "GST18RC", name: "GST 18% (Reverse Charge)", rate: "18.00", taxType: "CGST_SGST" as const, isReverseCharge: true },
  { code: "IGST18RC", name: "IGST 18% (Reverse Charge)", rate: "18.00", taxType: "IGST" as const, isReverseCharge: true },
  { code: "EXEMPT", name: "Exempt", rate: "0.00", taxType: "EXEMPT" as const, isReverseCharge: false },
  { code: "ZERO_RATED", name: "Zero Rated", rate: "0.00", taxType: "ZERO_RATED" as const, isReverseCharge: false },
];

@Injectable()
export class TaxCodesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly audit: AuditService,
    private readonly posting: FinancePostingService,
  ) {}

  async list(orgId: string, query: ListTaxCodesQuery): Promise<CursorPage<{
    id: number; name: string; code: string; rate: string; taxType: string;
    isReverseCharge: boolean; collectedAccountId: number | null;
    paidAccountId: number | null; isActive: boolean;
    createdAt: Date | null; updatedAt: Date | null;
  }>> {
    const cacheKey = `${query.cursor ?? ""}:${query.limit ?? ""}:${query.taxType ?? ""}:${query.isActive ?? ""}`;
    return this.cache.cachedVersioned(CACHE_KEYS.finTaxCodesNamespace(orgId), cacheKey, async () => {
      const pos = decodeCursor(query.cursor);
      const conditions = [eq(accTaxCodes.orgId, orgId)];
      if (query.taxType) conditions.push(eq(accTaxCodes.taxType, query.taxType));
      if (query.isActive !== undefined) conditions.push(eq(accTaxCodes.isActive, query.isActive));
      if (pos) conditions.push(keysetAfterValue(accTaxCodes.code, accTaxCodes.id, pos));
      const projection = {
        id: accTaxCodes.id,
        name: accTaxCodes.name,
        code: accTaxCodes.code,
        rate: accTaxCodes.rate,
        taxType: accTaxCodes.taxType,
        isReverseCharge: accTaxCodes.isReverseCharge,
        collectedAccountId: accTaxCodes.collectedAccountId,
        paidAccountId: accTaxCodes.paidAccountId,
        isActive: accTaxCodes.isActive,
        createdAt: accTaxCodes.createdAt,
        updatedAt: accTaxCodes.updatedAt,
      };
      const items = await this.db
        .select(projection)
        .from(accTaxCodes)
        .where(and(...conditions))
        .orderBy(asc(accTaxCodes.code), asc(accTaxCodes.id))
        .limit(query.limit + 1);
      return buildCursorPage(items, query.limit, (r) => ({ sortValue: r.code, id: String(r.id) }));
    }, 300);
  }

  async get(orgId: string, taxCodeId: number) {
    const [row] = await this.db
      .select({
        id: accTaxCodes.id,
        name: accTaxCodes.name,
        code: accTaxCodes.code,
        rate: accTaxCodes.rate,
        taxType: accTaxCodes.taxType,
        isReverseCharge: accTaxCodes.isReverseCharge,
        collectedAccountId: accTaxCodes.collectedAccountId,
        paidAccountId: accTaxCodes.paidAccountId,
        isActive: accTaxCodes.isActive,
        createdAt: accTaxCodes.createdAt,
        updatedAt: accTaxCodes.updatedAt,
      })
      .from(accTaxCodes)
      .where(and(eq(accTaxCodes.id, taxCodeId), eq(accTaxCodes.orgId, orgId)))
      .limit(1);
    if (!row) throw new NotFoundException(`Tax code ${taxCodeId} not found`);
    return row;
  }

  async create(orgId: string, userId: string, input: CreateTaxCodeInput) {
    let collectedAccountId: number | null;
    let paidAccountId: number | null;

    if (!input.collectedAccountId) {
      collectedAccountId = await this.posting.resolveSystemAccount(orgId, "TAX_PAYABLE");
    } else {
      collectedAccountId = input.collectedAccountId;
    }

    if (!input.paidAccountId) {
      paidAccountId = await this.posting.resolveSystemAccount(orgId, "TAX_RECEIVABLE");
    } else {
      paidAccountId = input.paidAccountId;
    }

    try {
      const [row] = await this.db
        .insert(accTaxCodes)
        .values({
          orgId,
          name: input.name,
          code: input.code,
          rate: input.rate,
          taxType: input.taxType,
          isReverseCharge: input.isReverseCharge,
          collectedAccountId,
          paidAccountId,
          isActive: input.isActive,
        })
        .returning();

      await this.cache.invalidateNamespace(CACHE_KEYS.finTaxCodesNamespace(orgId));

      this.audit.log({
        action: "accounting.tax_code.create",
        userId,
        orgId,
        resourceType: "tax_code",
        resourceId: String(row?.id),
        metadata: { code: input.code, rate: input.rate, taxType: input.taxType },
        result: "SUCCESS",
      });

      return row;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(`Tax code '${input.code}' already exists for this organization`);
      }
      throw error;
    }
  }

  async update(orgId: string, taxCodeId: number, userId: string, input: UpdateTaxCodeInput) {
    await this.get(orgId, taxCodeId);
    try {
      const [row] = await this.db
        .update(accTaxCodes)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(accTaxCodes.id, taxCodeId), eq(accTaxCodes.orgId, orgId)))
        .returning();

      await this.cache.invalidateNamespace(CACHE_KEYS.finTaxCodesNamespace(orgId));

      this.audit.log({
        action: "accounting.tax_code.update",
        userId,
        orgId,
        resourceType: "tax_code",
        resourceId: String(taxCodeId),
        metadata: { changes: input },
        result: "SUCCESS",
      });

      return row;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(`Tax code '${input.code}' already exists for this organization`);
      }
      throw error;
    }
  }

  async seedDefaults(orgId: string, userId: string) {
    let collectedAccountId: number | null = null;
    let paidAccountId: number | null = null;

    try {
      collectedAccountId = await this.posting.resolveSystemAccount(orgId, "TAX_PAYABLE");
    } catch {
      collectedAccountId = null;
    }
    try {
      paidAccountId = await this.posting.resolveSystemAccount(orgId, "TAX_RECEIVABLE");
    } catch {
      paidAccountId = null;
    }

    const existing = await this.db
      .select({ code: accTaxCodes.code })
      .from(accTaxCodes)
      .where(eq(accTaxCodes.orgId, orgId));
    const existingCodes = new Set(existing.map((r) => r.code));

    const toInsert = DEFAULT_CODES.filter((c) => !existingCodes.has(c.code));
    if (toInsert.length === 0) return { seeded: 0, skipped: DEFAULT_CODES.length };

    await this.db.insert(accTaxCodes).values(
      toInsert.map((c) => ({
        orgId,
        name: c.name,
        code: c.code,
        rate: c.rate,
        taxType: c.taxType,
        isReverseCharge: c.isReverseCharge,
        collectedAccountId,
        paidAccountId,
        isActive: true,
      })),
    );

    await this.cache.invalidateNamespace(CACHE_KEYS.finTaxCodesNamespace(orgId));

    this.audit.log({
      action: "accounting.tax_code.seed_defaults",
      userId,
      orgId,
      resourceType: "tax_code",
      metadata: { seeded: toInsert.length },
      result: "SUCCESS",
    });

    return { seeded: toInsert.length, skipped: existingCodes.size };
  }
}
