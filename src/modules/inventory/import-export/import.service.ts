import { Injectable, Inject, NotFoundException, BadRequestException } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { eq, and, desc, sql } from "drizzle-orm";
import { invImportJobs, invProducts, invProductVariants, invLocations } from "../../../db/schema";
import { parseCsv } from "./csv.util";
import type { ImportType, CreateImportJobInput, ListJobsQueryInput } from "./dto/import-export.schemas";

export interface RowError {
  row: number;
  field: string;
  message: string;
}

const EXPECTED_COLUMNS: Record<ImportType, string[]> = {
  products: ["sku", "name", "description", "category", "uom", "type", "reorderPoint", "costPrice"],
  vendors: ["name", "code", "email", "phone", "address"],
  categories: ["name", "parentName", "description"],
  uom: ["name", "abbreviation"],
  locations: ["warehouseName", "name", "code", "type"],
  "opening-stock": ["sku", "locationCode", "quantity", "unitCost", "lotNumber", "serialNumber"],
  "reorder-rules": ["sku", "warehouseName", "minQty", "maxQty", "reorderQty"],
};

@Injectable()
export class ImportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly stockEngine: StockEngineService,
  ) {}

  async previewImport(orgId: string, file: Express.Multer.File, importType: ImportType) {
    const text = file.buffer.toString("utf-8");
    const { headers, rows } = parseCsv(text);
    const expectedColumns = EXPECTED_COLUMNS[importType];

    const mappedFields = expectedColumns.filter((col) =>
      headers.some((h) => h.toLowerCase() === col.toLowerCase()),
    );

    const errors: RowError[] = [];
    for (let i = 0; i < rows.length; i++) {
      const rowErrors = this.validateRow(importType, rows[i]!, i + 2);
      errors.push(...rowErrors);
    }

    const sample = rows.slice(0, 20);

    return {
      importType,
      columns: headers,
      mappedFields,
      validRows: rows.length - new Set(errors.map((e) => e.row)).size,
      errors,
      sample,
    };
  }

  async createImportJob(orgId: string, userId: string, input: CreateImportJobInput) {
    const [job] = await this.db
      .insert(invImportJobs)
      .values({
        orgId,
        jobType: input.importType,
        status: "RUNNING",
        totalRows: input.rows.length,
        processedRows: 0,
        errorRows: 0,
        errors: null,
        createdBy: userId,
      })
      .returning();

    if (!job) throw new BadRequestException("Failed to create import job");

    const jobErrors: RowError[] = [];
    let processedRows = 0;
    let errorRows = 0;

    const BATCH_SIZE = 50;
    for (let batchStart = 0; batchStart < input.rows.length; batchStart += BATCH_SIZE) {
      const batch = input.rows.slice(batchStart, batchStart + BATCH_SIZE);
      for (let batchIdx = 0; batchIdx < batch.length; batchIdx++) {
        const rowIndex = batchStart + batchIdx;
        const row = batch[batchIdx]!;
        const rowErrors = this.validateRow(input.importType, row, rowIndex + 1);
        if (rowErrors.length > 0) {
          jobErrors.push(...rowErrors);
          errorRows++;
          continue;
        }

        if (input.importType === "opening-stock") {
          const rowError = await this.processOpeningStockRow(orgId, userId, job.id, row, rowIndex);
          if (rowError) {
            jobErrors.push(rowError);
            errorRows++;
            continue;
          }
        }

        processedRows++;
      }
    }

    const finalStatus = errorRows === input.rows.length ? "FAILED" : "COMPLETED";

    const [updated] = await this.db
      .update(invImportJobs)
      .set({
        status: finalStatus,
        processedRows,
        errorRows,
        errors: jobErrors.length > 0 ? jobErrors : null,
      })
      .where(and(eq(invImportJobs.id, job.id), eq(invImportJobs.orgId, orgId)))
      .returning();

    await this.cache.invalidateNamespace(CACHE_KEYS.invImportJobsNamespace(orgId));

    return updated;
  }

  private async processOpeningStockRow(
    orgId: string,
    userId: string,
    jobId: number,
    row: Record<string, string>,
    rowIndex: number,
  ): Promise<RowError | null> {
    try {
      const variant = await this.db
        .select({ id: invProductVariants.id })
        .from(invProductVariants)
        .innerJoin(invProducts, eq(invProductVariants.productId, invProducts.id))
        .where(and(eq(invProducts.orgId, orgId), eq(invProducts.sku, row["sku"] ?? "")))
        .limit(1);

      if (variant.length === 0 || !variant[0]) {
        return { row: rowIndex, field: "sku", message: `Product variant not found for SKU: ${row["sku"] ?? ""}` };
      }

      const loc = await this.db
        .select({ id: invLocations.id })
        .from(invLocations)
        .where(and(eq(invLocations.orgId, orgId), eq(invLocations.code, row["locationCode"] ?? "")))
        .limit(1);

      if (loc.length === 0 || !loc[0]) {
        return { row: rowIndex, field: "locationCode", message: `Location not found for code: ${row["locationCode"] ?? ""}` };
      }

      const qty = parseFloat(row["quantity"] ?? "0");
      const unitCost = row["unitCost"] ? parseFloat(row["unitCost"]) : 0;

      await this.stockEngine.execute(orgId, userId, {
        idempotencyKey: `import:${jobId}:${rowIndex}`,
        sourceType: "IMPORT",
        sourceId: String(jobId),
        movements: [
          {
            transactionType: "OPENING_BALANCE",
            productVariantId: variant[0].id,
            locationId: loc[0].id,
            quantityDelta: String(qty),
            unitCost: unitCost > 0 ? String(unitCost) : undefined,
          },
        ],
      });

      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return { row: rowIndex, field: "opening-stock", message };
    }
  }

  private validateRow(importType: ImportType, row: Record<string, string>, rowIndex: number): RowError[] {
    const errors: RowError[] = [];

    if (importType === "products") {
      if (!row["sku"] || row["sku"].trim() === "") {
        errors.push({ row: rowIndex, field: "sku", message: "sku is required" });
      }
      if (!row["name"] || row["name"].trim() === "") {
        errors.push({ row: rowIndex, field: "name", message: "name is required" });
      }
    } else if (importType === "opening-stock") {
      if (!row["sku"] || row["sku"].trim() === "") {
        errors.push({ row: rowIndex, field: "sku", message: "sku is required" });
      }
      if (!row["quantity"] || row["quantity"].trim() === "") {
        errors.push({ row: rowIndex, field: "quantity", message: "quantity is required" });
      } else {
        const qty = parseFloat(row["quantity"]);
        if (isNaN(qty) || qty <= 0) {
          errors.push({ row: rowIndex, field: "quantity", message: "quantity must be a positive number" });
        }
      }
    } else if (importType === "vendors") {
      if (!row["name"] || row["name"].trim() === "") {
        errors.push({ row: rowIndex, field: "name", message: "name is required" });
      }
    } else if (importType === "categories") {
      if (!row["name"] || row["name"].trim() === "") {
        errors.push({ row: rowIndex, field: "name", message: "name is required" });
      }
    } else if (importType === "uom") {
      if (!row["name"] || row["name"].trim() === "") {
        errors.push({ row: rowIndex, field: "name", message: "name is required" });
      }
      if (!row["abbreviation"] || row["abbreviation"].trim() === "") {
        errors.push({ row: rowIndex, field: "abbreviation", message: "abbreviation is required" });
      }
    } else if (importType === "locations") {
      if (!row["name"] || row["name"].trim() === "") {
        errors.push({ row: rowIndex, field: "name", message: "name is required" });
      }
      if (!row["code"] || row["code"].trim() === "") {
        errors.push({ row: rowIndex, field: "code", message: "code is required" });
      }
    } else if (importType === "reorder-rules") {
      if (!row["sku"] || row["sku"].trim() === "") {
        errors.push({ row: rowIndex, field: "sku", message: "sku is required" });
      }
    }

    return errors;
  }

  async list(orgId: string, query: ListJobsQueryInput) {
    const { page, limit } = query;
    const offset = (page - 1) * limit;
    const hash = `${limit}:${offset}`;
    return this.cache.cachedVersioned(CACHE_KEYS.invImportJobsNamespace(orgId), hash, async () => {
      const rows = await this.db
        .select({
          id: invImportJobs.id,
          orgId: invImportJobs.orgId,
          jobType: invImportJobs.jobType,
          status: invImportJobs.status,
          fileName: invImportJobs.fileName,
          totalRows: invImportJobs.totalRows,
          processedRows: invImportJobs.processedRows,
          errorRows: invImportJobs.errorRows,
          errors: invImportJobs.errors,
          resultUrl: invImportJobs.resultUrl,
          createdBy: invImportJobs.createdBy,
          createdAt: invImportJobs.createdAt,
          updatedAt: invImportJobs.updatedAt,
          windowTotal: sql<string>`count(*) OVER ()`,
        })
        .from(invImportJobs)
        .where(eq(invImportJobs.orgId, orgId))
        .orderBy(desc(invImportJobs.createdAt))
        .limit(limit)
        .offset(offset);

      const first = rows[0];
      let total: number;
      if (first) {
        total = Number(first.windowTotal);
      } else if (offset === 0) {
        total = 0;
      } else {
        const fallback = await this.db
          .select({ n: sql<string>`count(*)` })
          .from(invImportJobs)
          .where(eq(invImportJobs.orgId, orgId));
        total = Number(fallback[0]?.n ?? 0);
      }

      const items = rows.map(({ windowTotal: _, ...rest }) => rest);
      return { items, total, page, totalPages: Math.ceil(total / limit) };
    }, CACHE_TTL.SHORT);
  }

  async findOne(orgId: string, jobId: number) {
    const job = await this.db
      .select()
      .from(invImportJobs)
      .where(and(eq(invImportJobs.id, jobId), eq(invImportJobs.orgId, orgId)))
      .limit(1);

    if (job.length === 0) throw new NotFoundException("Import job not found");
    return job[0]!;
  }
}
