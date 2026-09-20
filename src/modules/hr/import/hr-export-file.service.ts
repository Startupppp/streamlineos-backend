import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, ilike, or, sql, type SQL } from "drizzle-orm";
import { createReadStream } from "node:fs";
import { open, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hrEmployments,
  hrPeople,
  organizationMembers,
  orgUnits,
  users,
  type HrEmployeeExportFilters,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { withTenant } from "../../../common/tenant";
import { StorageService } from "../../storage/storage.service";
import type { ScopedRead } from "../../access/scoped-read";
import {
  serializeEmployeeExportHeader,
  serializeEmployeeExportRow,
  type EmployeeExportCsvRow,
} from "./hr-export-csv";
import {
  ephemeralJobIdFromFileKey,
  hrExportEphemeralStore,
  isEphemeralFileKey,
} from "./hr-export-ephemeral-store";
import { livePersonOfUser, primaryEmploymentOfPerson } from "../../directory/employment-query";

interface EmployeeExportCursor {
  name: string;
  employeeUserId: string;
}

interface EmployeeExportBatch {
  rows: EmployeeExportCsvRow[];
  nextCursor: EmployeeExportCursor | null;
}

export interface GeneratedEmployeeExport {
  fileKey: string;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  rowCount: number;
}

/** Local CSV only — no object-storage upload. Caller owns cleanup of `tempPath`. */
export interface LocalEmployeeExport {
  tempPath: string;
  fileName: string;
  mimeType: string;
  fileSizeBytes: number;
  rowCount: number;
}

const BATCH_SIZE = 500;
const CSV_MIME = "text/csv; charset=utf-8";

type GenerateInput = {
  exportJobId: string;
  read: ScopedRead;
  filters: HrEmployeeExportFilters;
  createdAt: Date;
};

@Injectable()
export class HrExportFileService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  /**
   * Writes the employee CSV to a temp file without uploading. Used when private
   * object storage is unset (in-process ephemeral download path).
   */
  async generateLocal(
    input: GenerateInput,
    onProgress: (processedRows: number) => Promise<void>,
  ): Promise<LocalEmployeeExport> {
    const fileName = `employee-directory-${input.createdAt.toISOString().slice(0, 10)}-${input.exportJobId.slice(0, 8)}.csv`;
    const tempPath = join(
      tmpdir(),
      `streamlineos-hr-export-${input.exportJobId}.csv`,
    );
    const file = await open(tempPath, "w", 0o600);
    let rowCount = 0;
    let closed = false;

    try {
      await file.write(serializeEmployeeExportHeader());
      let cursor: EmployeeExportCursor | null = null;

      do {
        const batch = await this.fetchBatch(input, cursor);
        if (batch.rows.length > 0) {
          await file.write(batch.rows.map(serializeEmployeeExportRow).join(""));
          rowCount += batch.rows.length;
          await onProgress(rowCount);
        }
        cursor = batch.nextCursor;
      } while (cursor);

      await file.close();
      closed = true;
      const fileStat = await stat(tempPath);
      return {
        tempPath,
        fileName,
        mimeType: CSV_MIME,
        fileSizeBytes: fileStat.size,
        rowCount,
      };
    } catch (error) {
      if (!closed) await file.close().catch(() => undefined);
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  async generate(
    input: GenerateInput,
    onProgress: (processedRows: number) => Promise<void>,
  ): Promise<GeneratedEmployeeExport> {
    const orgId = input.read.orgId;
    const local = await this.generateLocal(input, onProgress);
    try {
      const uploaded = await this.storage.uploadFileStream(
        orgId,
        createReadStream(local.tempPath),
        local.fileSizeBytes,
        `hr-exports/${orgId}`,
        local.fileName,
        local.mimeType,
      );
      return {
        fileKey: uploaded.key,
        fileName: local.fileName,
        mimeType: uploaded.mimeType,
        fileSizeBytes: uploaded.size,
        rowCount: local.rowCount,
      };
    } finally {
      await unlink(local.tempPath).catch(() => undefined);
    }
  }

  delete(orgId: string, fileKey: string): Promise<void> {
    if (isEphemeralFileKey(fileKey)) {
      return hrExportEphemeralStore.delete(
        orgId,
        ephemeralJobIdFromFileKey(fileKey),
      );
    }
    return this.storage.deleteFile(orgId, fileKey);
  }

  private async fetchBatch(
    input: {
      read: ScopedRead;
      filters: HrEmployeeExportFilters;
    },
    cursor: EmployeeExportCursor | null,
  ): Promise<EmployeeExportBatch> {
    const orgId = input.read.orgId;
    return withTenant(
      this.db,
      { orgId, audience: "INTERNAL" },
      async (tx) => {
        const normalizedName = sql<string>`lower(coalesce(${users.name}, ''))`;
        const conditions: SQL[] = [];

        if (input.filters.isActive === "true") conditions.push(eq(users.isActive, true));
        if (input.filters.isActive === "false") conditions.push(eq(users.isActive, false));
        if (input.filters.departmentId) {
          conditions.push(eq(hrEmployments.departmentId, input.filters.departmentId));
        }
        if (input.filters.role) conditions.push(eq(organizationMembers.role, input.filters.role));
        if (input.filters.search) {
          const term = `%${input.filters.search}%`;
          conditions.push(
            or(
              ilike(users.name, term),
              ilike(users.email, term),
              ilike(hrEmployments.employeeNumber, term),
              ilike(hrEmployments.designation, term),
              ilike(users.firstName, term),
              ilike(users.lastName, term),
            )!,
          );
        }
        if (cursor) {
          conditions.push(
            or(
              gt(normalizedName, cursor.name),
              and(
                eq(normalizedName, cursor.name),
                gt(users.id, cursor.employeeUserId),
              ),
            )!,
          );
        }

        const rows = await tx
          .select({
            employeeUserId: users.id,
            cursorName: normalizedName,
            name: users.name,
            firstName: users.firstName,
            lastName: users.lastName,
            email: users.email,
            employeeId: hrEmployments.employeeNumber,
            designation: hrEmployments.designation,
            role: organizationMembers.role,
            department: orgUnits.name,
            isActive: users.isActive,
          })
          .from(organizationMembers)
          .innerJoin(users, eq(organizationMembers.userId, users.id))
          .leftJoin(hrPeople, livePersonOfUser(orgId, users.id))
          .leftJoin(hrEmployments, primaryEmploymentOfPerson(orgId, hrPeople, hrEmployments))
          .leftJoin(
            orgUnits,
            and(
              eq(orgUnits.id, hrEmployments.departmentId),
              eq(orgUnits.orgId, orgId),
              eq(orgUnits.kind, "DEPARTMENT"),
            ),
          )
          .where(
            input.read.compose(
              {
                tenant: organizationMembers.orgId,
                scope: { columns: { ownerColumn: organizationMembers.userId } },
                and: conditions,
              },
              ({ sql: where }) => where,
              () => sql`false`,
            ),
          )
          .orderBy(asc(normalizedName), asc(users.id))
          .limit(BATCH_SIZE);

        const last = rows.at(-1);
        return {
          rows: rows.map((row) => ({
            name:
              row.firstName && row.lastName
                ? `${row.firstName} ${row.lastName}`
                : (row.name ?? row.email),
            email: row.email,
            employeeId: row.employeeId ?? "",
            designation: row.designation ?? "",
            role: row.role,
            department: row.department ?? "",
            status: row.isActive ? "Active" : "Inactive",
          })),
          nextCursor:
            rows.length === BATCH_SIZE && last
              ? {
                  name: last.cursorName,
                  employeeUserId: last.employeeUserId,
                }
              : null,
        };
      },
    );
  }
}
