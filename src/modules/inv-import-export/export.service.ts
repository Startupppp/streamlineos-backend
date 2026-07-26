import { Injectable, Inject, NotFoundException, BadRequestException } from "@nestjs/common";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../common/cache/cache-keys";
import { eq, and, desc, sql } from "drizzle-orm";
import { invExportJobs, invStockLevels, invStockTransactions, invProducts, invProductVariants, invLots } from "../../db/schema";
import { toCsv } from "./csv.util";
import type { ExportType, CreateExportJobInput, ListJobsQueryInput } from "./dto/import-export.schemas";
import type { Response } from "express";

const EXPORT_HEADERS: Record<ExportType, string[]> = {
  products: ["id", "sku", "name", "status", "costPrice"],
  stock: ["id", "orgId", "productVariantId", "locationId", "onHand", "committed", "onOrder", "blockedQty", "qualityHoldQty"],
  movements: ["id", "productVariantId", "locationId", "transactionType", "quantityChange", "quantityBefore", "quantityAfter", "createdAt"],
  "lots-serials": ["id", "productVariantId", "lotNumber", "status", "expiryDate"],
  reorder: ["info"],
  valuation: ["id", "orgId", "productVariantId", "locationId", "onHand", "committed", "onOrder", "blockedQty", "qualityHoldQty"],
};

@Injectable()
export class ExportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  async createExportJob(orgId: string, userId: string, input: CreateExportJobInput) {
    const [job] = await this.db
      .insert(invExportJobs)
      .values({
        orgId,
        jobType: input.exportType,
        status: "RUNNING",
        totalRows: 0,
        processedRows: 0,
        errorRows: 0,
        errors: null,
        createdBy: userId,
      })
      .returning();

    if (!job) throw new BadRequestException("Failed to create export job");

    const rows = await this._fetchExportRows(orgId, input.exportType);
    const headers = EXPORT_HEADERS[input.exportType];
    const csvText = toCsv(headers, rows as Record<string, unknown>[]);

    const truncated = rows.length === 10000;
    const jobErrors = truncated
      ? [{ row: 0, field: "info", message: "Truncated to 10000 rows" }]
      : null;

    const [updated] = await this.db
      .update(invExportJobs)
      .set({
        status: "COMPLETED",
        totalRows: rows.length,
        processedRows: rows.length,
        fileName: `${input.exportType}-export.csv`,
        resultUrl: csvText,
        errors: jobErrors,
      })
      .where(and(eq(invExportJobs.id, job.id), eq(invExportJobs.orgId, orgId)))
      .returning();

    await this.cache.invalidatePattern(`inv:export-jobs:list:${orgId}:*`);

    const result = updated ?? job;
    return { ...result, resultUrl: undefined };
  }

  private async _fetchExportRows(orgId: string, exportType: ExportType): Promise<unknown[]> {
    if (exportType === "products") {
      return this.db
        .select({
          id: invProductVariants.id,
          sku: invProducts.sku,
          name: invProducts.name,
          status: invProducts.status,
          costPrice: invProducts.costPrice,
        })
        .from(invProductVariants)
        .innerJoin(invProducts, eq(invProductVariants.productId, invProducts.id))
        .where(eq(invProducts.orgId, orgId))
        .limit(10000);
    }

    if (exportType === "stock" || exportType === "valuation") {
      return this.db
        .select({
          id: invStockLevels.id,
          orgId: invStockLevels.orgId,
          productVariantId: invStockLevels.productVariantId,
          locationId: invStockLevels.locationId,
          onHand: invStockLevels.onHand,
          committed: invStockLevels.committed,
          onOrder: invStockLevels.onOrder,
          blockedQty: invStockLevels.blockedQty,
          qualityHoldQty: invStockLevels.qualityHoldQty,
        })
        .from(invStockLevels)
        .where(eq(invStockLevels.orgId, orgId))
        .limit(10000);
    }

    if (exportType === "movements") {
      return this.db
        .select({
          id: invStockTransactions.id,
          productVariantId: invStockTransactions.productVariantId,
          locationId: invStockTransactions.locationId,
          transactionType: invStockTransactions.transactionType,
          quantityChange: invStockTransactions.quantityChange,
          quantityBefore: invStockTransactions.quantityBefore,
          quantityAfter: invStockTransactions.quantityAfter,
          createdAt: invStockTransactions.createdAt,
        })
        .from(invStockTransactions)
        .where(eq(invStockTransactions.orgId, orgId))
        .orderBy(desc(invStockTransactions.createdAt))
        .limit(10000);
    }

    if (exportType === "lots-serials") {
      return this.db
        .select({
          id: invLots.id,
          productVariantId: invLots.productVariantId,
          lotNumber: invLots.lotNumber,
          status: invLots.status,
          expiryDate: invLots.expiryDate,
        })
        .from(invLots)
        .where(eq(invLots.orgId, orgId))
        .limit(10000);
    }

    return [];
  }

  async list(orgId: string, query: ListJobsQueryInput) {
    const { page, limit } = query;
    const offset = (page - 1) * limit;
    const hash = `${limit}:${offset}`;
    const key = CACHE_KEYS.invExportJobsList(orgId, hash);

    return this.cache.cached(key, async () => {
      const [items, countResult] = await Promise.all([
        this.db
          .select({
            id: invExportJobs.id,
            orgId: invExportJobs.orgId,
            jobType: invExportJobs.jobType,
            status: invExportJobs.status,
            fileName: invExportJobs.fileName,
            totalRows: invExportJobs.totalRows,
            processedRows: invExportJobs.processedRows,
            errorRows: invExportJobs.errorRows,
            errors: invExportJobs.errors,
            createdBy: invExportJobs.createdBy,
            createdAt: invExportJobs.createdAt,
            updatedAt: invExportJobs.updatedAt,
          })
          .from(invExportJobs)
          .where(eq(invExportJobs.orgId, orgId))
          .orderBy(desc(invExportJobs.createdAt))
          .limit(limit)
          .offset(offset),
        this.db
          .select({ count: sql<number>`count(*)::int` })
          .from(invExportJobs)
          .where(eq(invExportJobs.orgId, orgId)),
      ]);

      const total = countResult[0]?.count ?? 0;
      return { items, total, page, totalPages: Math.ceil(total / limit) };
    }, CACHE_TTL.SHORT);
  }

  async findOne(orgId: string, jobId: number) {
    const jobs = await this.db
      .select({
        id: invExportJobs.id,
        orgId: invExportJobs.orgId,
        jobType: invExportJobs.jobType,
        status: invExportJobs.status,
        fileName: invExportJobs.fileName,
        totalRows: invExportJobs.totalRows,
        processedRows: invExportJobs.processedRows,
        errorRows: invExportJobs.errorRows,
        errors: invExportJobs.errors,
        createdBy: invExportJobs.createdBy,
        createdAt: invExportJobs.createdAt,
        updatedAt: invExportJobs.updatedAt,
      })
      .from(invExportJobs)
      .where(and(eq(invExportJobs.id, jobId), eq(invExportJobs.orgId, orgId)))
      .limit(1);

    if (jobs.length === 0) throw new NotFoundException("Export job not found");
    return jobs[0]!;
  }

  async download(orgId: string, jobId: number, res: Response) {
    const jobs = await this.db
      .select()
      .from(invExportJobs)
      .where(and(eq(invExportJobs.id, jobId), eq(invExportJobs.orgId, orgId)))
      .limit(1);

    if (jobs.length === 0) throw new NotFoundException("Export job not found");
    const job = jobs[0]!;

    if (job.status !== "COMPLETED") throw new BadRequestException("Export not ready");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="${job.fileName ?? "export.csv"}"`);
    res.send(job.resultUrl ?? "");
  }
}
