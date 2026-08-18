import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, ilike, or, sql, type SQL } from "drizzle-orm";
import { createReadStream } from "node:fs";
import { open, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  organizationMembers,
  orgUnits,
  users,
  type HrEmployeeExportFilters,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { withTenant } from "../../../common/tenant";
import { StorageService } from "../../storage/storage.service";
import { applyScope } from "../../access/apply-scope";
import type { DataScope } from "../../access/access.types";
import {
  serializeEmployeeExportHeader,
  serializeEmployeeExportRow,
  type EmployeeExportCsvRow,
} from "./hr-export-csv";

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

const BATCH_SIZE = 500;

@Injectable()
export class HrExportFileService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
  ) {}

  async generate(
    input: {
      exportJobId: string;
      orgId: string;
      actorUserId: string;
      scope: DataScope;
      filters: HrEmployeeExportFilters;
      createdAt: Date;
    },
    onProgress: (processedRows: number) => Promise<void>,
  ): Promise<GeneratedEmployeeExport> {
    const fileName = `employee-directory-${input.createdAt.toISOString().slice(0, 10)}-${input.exportJobId.slice(0, 8)}.csv`;
    const tempPath = join(
      tmpdir(),
      `streamlineos-hr-export-${input.exportJobId}.csv`,
    );
    const file = await open(tempPath, "w", 0o600);
    let rowCount = 0;

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
      const fileStat = await stat(tempPath);
      const uploaded = await this.storage.uploadFileStream(
        createReadStream(tempPath),
        fileStat.size,
        `hr-exports/${input.orgId}`,
        fileName,
        "text/csv; charset=utf-8",
      );
      return {
        fileKey: uploaded.key,
        fileName,
        mimeType: uploaded.mimeType,
        fileSizeBytes: uploaded.size,
        rowCount,
      };
    } finally {
      await file.close().catch(() => undefined);
      await unlink(tempPath).catch(() => undefined);
    }
  }

  delete(fileKey: string): Promise<void> {
    return this.storage.deleteFile(fileKey);
  }

  private async fetchBatch(
    input: {
      orgId: string;
      actorUserId: string;
      scope: DataScope;
      filters: HrEmployeeExportFilters;
    },
    cursor: EmployeeExportCursor | null,
  ): Promise<EmployeeExportBatch> {
    return withTenant(
      this.db,
      { orgId: input.orgId, audience: "INTERNAL" },
      async (tx) => {
        const normalizedName = sql<string>`lower(coalesce(${users.name}, ''))`;
        const conditions: SQL[] = [
          eq(organizationMembers.orgId, input.orgId),
          applyScope(input.scope, input.orgId, input.actorUserId, {
            ownerColumn: organizationMembers.userId,
          }),
        ];

        if (input.filters.isActive === "true") conditions.push(eq(users.isActive, true));
        if (input.filters.isActive === "false") conditions.push(eq(users.isActive, false));
        if (input.filters.departmentId) {
          conditions.push(eq(users.orgDepartmentId, input.filters.departmentId));
        }
        if (input.filters.role) conditions.push(eq(organizationMembers.role, input.filters.role));
        if (input.filters.search) {
          const term = `%${input.filters.search}%`;
          conditions.push(
            or(
              ilike(users.name, term),
              ilike(users.email, term),
              ilike(users.employeeId, term),
              ilike(users.designation, term),
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
            employeeId: users.employeeId,
            designation: users.designation,
            role: organizationMembers.role,
            department: orgUnits.name,
            isActive: users.isActive,
          })
          .from(organizationMembers)
          .innerJoin(users, eq(organizationMembers.userId, users.id))
          .leftJoin(
            orgUnits,
            and(
              eq(orgUnits.id, users.orgDepartmentId),
              eq(orgUnits.orgId, input.orgId),
              eq(orgUnits.kind, "DEPARTMENT"),
            ),
          )
          .where(and(...conditions))
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
