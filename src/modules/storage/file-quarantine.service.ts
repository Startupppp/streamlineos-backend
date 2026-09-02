import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { buildCursorPage, decodeCursor, type CursorPage } from "../../common/pagination/cursor";
import { keysetBeforeUuid } from "../../common/pagination/keyset";

const fileQuarantineRecords = pgTable(
  "file_quarantine_records",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id").notNull(),
    storageKey: text("storage_key").notNull(),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    fileSizeBytes: integer("file_size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    status: text("status")
      .$type<QuarantineStatus>()
      .notNull()
      .default("pending_scan"),
    threatName: text("threat_name"),
    idempotencyKey: text("idempotency_key"),
    uploadedBy: text("uploaded_by").notNull(),
    scannedAt: timestamp("scanned_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("idx_fqr_org_status_created").on(
      table.orgId,
      table.status,
      table.createdAt,
    ),
    index("idx_fqr_org_sha256").on(table.orgId, table.sha256),
    index("idx_fqr_idempotency_key").on(table.orgId, table.idempotencyKey),
  ],
);

export type QuarantineStatus = "pending_scan" | "clean" | "infected" | "error";

export interface QuarantineRecord {
  id: string;
  orgId: string;
  storageKey: string;
  filename: string;
  mimeType: string;
  fileSizeBytes: number;
  sha256: string;
  status: QuarantineStatus;
  threatName: string | null;
  idempotencyKey: string | null;
  uploadedBy: string;
  createdAt: Date;
}

export interface BeginQuarantineParams {
  orgId: string;
  storageKey: string;
  filename: string;
  mimeType: string;
  fileSizeBytes: number;
  sha256: string;
  uploadedBy: string;
  idempotencyKey?: string;
}

export interface ListQuarantineOptions {
  limit: number;
  cursor?: string;
  status?: QuarantineStatus;
}

@Injectable()
export class FileQuarantineService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async begin(params: BeginQuarantineParams): Promise<string> {
    const rows = await this.db
      .insert(fileQuarantineRecords)
      .values({
        orgId: params.orgId,
        storageKey: params.storageKey,
        filename: params.filename,
        mimeType: params.mimeType,
        fileSizeBytes: params.fileSizeBytes,
        sha256: params.sha256,
        uploadedBy: params.uploadedBy,
        idempotencyKey: params.idempotencyKey ?? null,
        status: "pending_scan",
      })
      .returning({ id: fileQuarantineRecords.id });
    const row = rows[0];
    if (!row) throw new Error("Quarantine record insert returned no row");
    return row.id;
  }

  async findByIdempotencyKey(
    orgId: string,
    idempotencyKey: string,
  ): Promise<QuarantineRecord | null> {
    const rows = await this.db
      .select({
        id: fileQuarantineRecords.id,
        orgId: fileQuarantineRecords.orgId,
        storageKey: fileQuarantineRecords.storageKey,
        filename: fileQuarantineRecords.filename,
        mimeType: fileQuarantineRecords.mimeType,
        fileSizeBytes: fileQuarantineRecords.fileSizeBytes,
        sha256: fileQuarantineRecords.sha256,
        status: fileQuarantineRecords.status,
        threatName: fileQuarantineRecords.threatName,
        idempotencyKey: fileQuarantineRecords.idempotencyKey,
        uploadedBy: fileQuarantineRecords.uploadedBy,
        createdAt: fileQuarantineRecords.createdAt,
      })
      .from(fileQuarantineRecords)
      .where(
        and(
          eq(fileQuarantineRecords.orgId, orgId),
          eq(fileQuarantineRecords.idempotencyKey, idempotencyKey),
          isNull(fileQuarantineRecords.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async markClean(id: string): Promise<void> {
    await this.db
      .update(fileQuarantineRecords)
      .set({ status: "clean", scannedAt: new Date(), releasedAt: new Date() })
      .where(eq(fileQuarantineRecords.id, id));
  }

  async markInfected(id: string, threatName: string): Promise<void> {
    await this.db
      .update(fileQuarantineRecords)
      .set({ status: "infected", threatName, scannedAt: new Date() })
      .where(eq(fileQuarantineRecords.id, id));
  }

  async markError(id: string): Promise<void> {
    await this.db
      .update(fileQuarantineRecords)
      .set({ status: "error", scannedAt: new Date() })
      .where(eq(fileQuarantineRecords.id, id));
  }

  async softDelete(id: string): Promise<void> {
    await this.db
      .update(fileQuarantineRecords)
      .set({ deletedAt: new Date() })
      .where(eq(fileQuarantineRecords.id, id));
  }

  async isKeyBlocked(orgId: string, storageKey: string): Promise<boolean> {
    const rows = await this.db
      .select({ status: fileQuarantineRecords.status })
      .from(fileQuarantineRecords)
      .where(
        and(
          eq(fileQuarantineRecords.orgId, orgId),
          eq(fileQuarantineRecords.storageKey, storageKey),
          isNull(fileQuarantineRecords.deletedAt),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) return false;
    return row.status !== "clean";
  }

  async getTotalUsageBytes(orgId: string): Promise<number> {
    const rows = await this.db
      .select({
        total: sql<number>`COALESCE(SUM(${fileQuarantineRecords.fileSizeBytes}), 0)`,
      })
      .from(fileQuarantineRecords)
      .where(
        and(
          eq(fileQuarantineRecords.orgId, orgId),
          eq(fileQuarantineRecords.status, "clean"),
          isNull(fileQuarantineRecords.deletedAt),
        ),
      );
    return Number(rows[0]?.total ?? 0);
  }

  async getTotalUsageBytesForUser(orgId: string, userId: string): Promise<number> {
    const rows = await this.db
      .select({
        total: sql<number>`COALESCE(SUM(${fileQuarantineRecords.fileSizeBytes}), 0)`,
      })
      .from(fileQuarantineRecords)
      .where(
        and(
          eq(fileQuarantineRecords.orgId, orgId),
          eq(fileQuarantineRecords.uploadedBy, userId),
          eq(fileQuarantineRecords.status, "clean"),
          isNull(fileQuarantineRecords.deletedAt),
        ),
      );
    return Number(rows[0]?.total ?? 0);
  }

  async findById(orgId: string, id: string): Promise<QuarantineRecord | null> {
    const rows = await this.db
      .select({
        id: fileQuarantineRecords.id,
        orgId: fileQuarantineRecords.orgId,
        storageKey: fileQuarantineRecords.storageKey,
        filename: fileQuarantineRecords.filename,
        mimeType: fileQuarantineRecords.mimeType,
        fileSizeBytes: fileQuarantineRecords.fileSizeBytes,
        sha256: fileQuarantineRecords.sha256,
        status: fileQuarantineRecords.status,
        threatName: fileQuarantineRecords.threatName,
        idempotencyKey: fileQuarantineRecords.idempotencyKey,
        uploadedBy: fileQuarantineRecords.uploadedBy,
        createdAt: fileQuarantineRecords.createdAt,
      })
      .from(fileQuarantineRecords)
      .where(
        and(
          eq(fileQuarantineRecords.orgId, orgId),
          eq(fileQuarantineRecords.id, id),
          isNull(fileQuarantineRecords.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async list(
    orgId: string,
    opts: ListQuarantineOptions,
  ): Promise<CursorPage<QuarantineRecord>> {
    const position = decodeCursor(opts.cursor);
    const conditions = [
      eq(fileQuarantineRecords.orgId, orgId),
      isNull(fileQuarantineRecords.deletedAt),
    ];
    if (opts.status) conditions.push(eq(fileQuarantineRecords.status, opts.status));
    if (position)
      conditions.push(
        keysetBeforeUuid(
          fileQuarantineRecords.createdAt,
          fileQuarantineRecords.id,
          position,
        ),
      );

    const rows = await this.db
      .select({
        id: fileQuarantineRecords.id,
        orgId: fileQuarantineRecords.orgId,
        storageKey: fileQuarantineRecords.storageKey,
        filename: fileQuarantineRecords.filename,
        mimeType: fileQuarantineRecords.mimeType,
        fileSizeBytes: fileQuarantineRecords.fileSizeBytes,
        sha256: fileQuarantineRecords.sha256,
        status: fileQuarantineRecords.status,
        threatName: fileQuarantineRecords.threatName,
        idempotencyKey: fileQuarantineRecords.idempotencyKey,
        uploadedBy: fileQuarantineRecords.uploadedBy,
        createdAt: fileQuarantineRecords.createdAt,
      })
      .from(fileQuarantineRecords)
      .where(and(...conditions))
      .orderBy(desc(fileQuarantineRecords.createdAt), desc(fileQuarantineRecords.id))
      .limit(opts.limit + 1);

    return buildCursorPage(rows, opts.limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: row.id,
    }));
  }
}
