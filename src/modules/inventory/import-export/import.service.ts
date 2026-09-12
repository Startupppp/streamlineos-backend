import { Injectable, Inject, NotFoundException, BadRequestException } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { CACHE_KEYS, CACHE_TTL } from "../../../common/cache/cache-keys";
import { StockEngineService } from "../stock-engine/stock-engine.service";
import { eq, and, desc, isNull, sql } from "drizzle-orm";
import { invImportJobs, invProducts, invProductVariants, invLocations } from "../../../db/schema";
import { parseCsv } from "./csv.util";
import type { ImportType, CreateImportJobInput, ListJobsQueryInput } from "./dto/import-export.schemas";
import { isImportType } from "./dto/import-export.schemas";
import { readOpeningStockRow, validateOpeningStockRow } from "./lib/opening-stock-row";
import { resolveLotId, resolveSerialIds } from "../purchase-orders/lib/receipt-lots-serials";
import { StagedImportService } from "./staged-import.service";

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
    private readonly staged: StagedImportService,
  ) {}

  /**
   * Applies the next chunk of a staged job — INV-108.
   *
   * The per-row validation and the opening-stock applier are the same ones the
   * in-request importer uses; what changed is where the rows come from and that
   * each one's outcome is durable. A row that fails is recorded and skipped, so
   * one bad line in a hundred thousand does not discard the rest.
   */
  async processStagedChunk(orgId: string, userId: string, jobId: number) {
    const job = await this.staged.progress(orgId, jobId);
    if (!isImportType(job.importType))
      throw new BadRequestException(
        `Import job ${jobId} was staged as "${job.importType}", which is not an import type this release can apply.`,
      );
    const importType: ImportType = job.importType;

    return this.staged.processChunk(orgId, userId, jobId, async (org, user, id, rowNumber, payload) => {
      const errors = this.validateRow(importType, payload, rowNumber);
      const first = errors[0];
      if (first)
        return { status: "FAILED", code: "VALIDATION_FAILED", field: first.field, message: first.message };

      if (importType === "opening-stock") {
        const failure = await this.processOpeningStockRow(org, user, id, payload, rowNumber - 1);
        if (failure)
          return { status: "FAILED", code: "OPENING_STOCK_FAILED", field: failure.field, message: failure.message };
      }
      return null;
    });
  }

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

  /**
   * INV-37 — posts one opening balance at the grain the file named.
   *
   * The lot and the serial are the point. `EXPECTED_COLUMNS` has advertised
   * both since this importer was written and neither was ever read, so the
   * movement carried a variant and a location and nothing else: two batches of
   * one SKU merged onto one anonymous stock row, and no recall, FEFO pick or
   * genealogy walk could tell them apart afterwards. Measured before the fix at
   * 40 + 15 arriving as a single row of 55.
   *
   * Handling unit and ownership stay absent because the file has no column for
   * them, and that is the right answer rather than a second collapse: an
   * opening balance is this organisation's own stock standing loose on a shelf.
   *
   * The quantity is passed through as written. It used to go through
   * `parseFloat` and back out through `String`, and `parseFloat` returns what it
   * could read instead of failing — so "1,000", the separator a spreadsheet
   * writes by default, imported as one unit and the row was marked APPLIED.
   * `validateOpeningStockRow` now refuses the string that `decimal.ts` cannot
   * read, which is the same grammar the engine will parse it with.
   */
  private async processOpeningStockRow(
    orgId: string,
    userId: string,
    jobId: number,
    row: Record<string, string>,
    rowIndex: number,
  ): Promise<RowError | null> {
    const line = readOpeningStockRow(row);
    try {
      const variant = await this.db
        .select({ id: invProductVariants.id })
        .from(invProductVariants)
        .innerJoin(invProducts, eq(invProductVariants.productId, invProducts.id))
        // A deleted product keeps its SKU, and only the LIVE uniqueness index is
        // partial on `deleted_at IS NULL` — so without this an opening-stock row
        // could resolve to a deleted product and post stock onto it, and a SKU
        // reused after a deletion would match the wrong one of the two.
        .where(
          and(
            eq(invProducts.orgId, orgId),
            eq(invProducts.sku, line.sku),
            isNull(invProducts.deletedAt),
            isNull(invProductVariants.deletedAt),
          ),
        )
        .limit(1);

      if (variant.length === 0 || !variant[0]) {
        return { row: rowIndex, field: "sku", message: `Product variant not found for SKU: ${line.sku}` };
      }

      const loc = await this.db
        .select({ id: invLocations.id })
        .from(invLocations)
        .where(and(eq(invLocations.orgId, orgId), eq(invLocations.code, line.locationCode)))
        .limit(1);

      if (loc.length === 0 || !loc[0]) {
        return { row: rowIndex, field: "locationCode", message: `Location not found for code: ${line.locationCode}` };
      }

      const productVariantId = variant[0].id;
      const locationId = loc[0].id;

      // Through the receipt's own resolvers, so an opening balance and a goods
      // receipt agree about when a lot number is reused and when a new batch is
      // opened. A second copy here is the duplication INV-48 deletes.
      const lotId = await resolveLotId(this.db, orgId, productVariantId, {
        lotNumber: line.lotNumber,
        expiryDate: null,
        manufactureDate: null,
      });
      const serialIds = line.serialNumber
        ? await resolveSerialIds(this.db, orgId, productVariantId, locationId, lotId, [line.serialNumber])
        : [];
      const serialId = serialIds[0];

      await this.stockEngine.execute(orgId, userId, {
        idempotencyKey: `import:${jobId}:${rowIndex}`,
        sourceType: "IMPORT",
        sourceId: String(jobId),
        movements: [
          {
            transactionType: "OPENING_BALANCE",
            productVariantId,
            locationId,
            ...(lotId === undefined ? {} : { lotId }),
            ...(serialId === undefined ? {} : { serialId }),
            quantityDelta: line.quantity,
            ...(line.unitCost === null ? {} : { unitCost: line.unitCost }),
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
      // INV-37. Read through the same function the applier reads the row with,
      // so the pass that decides a row is acceptable and the pass that posts it
      // cannot hold different opinions of what it says.
      errors.push(...validateOpeningStockRow(row, rowIndex));
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
          createdByMembershipId: invImportJobs.createdByMembershipId,
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
