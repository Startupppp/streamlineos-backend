import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import { crmImportRows, crmImports, subjectTypes } from "../../../db/schema";
import type { StoredColumnMapping } from "../../../db/schema/crm/imports";
import { mapColumns, needsConfirmation } from "./column-mapping";
import type { ImportEntity } from "./import-entities";
import {
  existingFingerprints,
  MAX_CANDIDATES,
  partiesByName,
  subjectsByReference,
} from "./import-lookups";
import { applyOverrides } from "./import-overrides";
import { blockingKeysFor, lookupKeysFor, planImport } from "./import-plan";
import type { PartyFingerprint } from "../../party/party-duplicates";

/**
 * How many rows one preview accepts.
 *
 * Not the commit's ceiling any more — that is durable, chunked and bounded only
 * by how long the tenant is willing to wait. This is the *preview's* ceiling,
 * and it is a property of the transport: the whole file arrives as one JSON body
 * and `main.ts` caps a JSON body at 3mb.
 */
export const MAX_ROWS = 5_000;

/** Rows per INSERT, so a five-thousand-row plan is ten statements, not one. */
const PLAN_INSERT_CHUNK = 500;

@Injectable()
export class CrmImportPreviewService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Work out what this file would do, and store the answer.
   *
   * Nothing is written to the CRM here. The plan is persisted because the
   * commit executes *these rows* rather than re-deriving them.
   */
  async preview(input: {
    organizationId: string;
    userId: string;
    filename?: string;
    entity?: ImportEntity;
    subjectTypeId?: string;
    headers: readonly string[];
    rows: readonly (readonly string[])[];
    overrides?: Readonly<Record<string, string>>;
  }) {
    if (input.rows.length > MAX_ROWS)
      throw new ConflictException(
        `That file has ${input.rows.length} rows; ${MAX_ROWS} is the most this import handles.`,
      );

    const entity = input.entity ?? "party";
    const subjectTypeId = await this.resolveSubjectType(
      input.organizationId,
      entity,
      input.subjectTypeId,
    );

    const columns = applyOverrides(entity, mapColumns(input.headers, entity), input.overrides);
    const unanswered = needsConfirmation(columns);

    const candidates =
      entity === "party"
        ? await existingFingerprints(
            this.db,
            input.organizationId,
            blockingKeysFor(columns, input.rows),
          )
        : { fingerprints: [] as PartyFingerprint[], truncated: false };

    const keys = lookupKeysFor(entity, columns, input.rows);
    const plan = planImport({
      entity,
      columns,
      rows: input.rows,
      existing: candidates.fingerprints,
      existingByKey: await subjectsByReference(
        this.db,
        input.organizationId,
        subjectTypeId,
        keys.naturalKeys,
      ),
      anchors: await partiesByName(this.db, input.organizationId, keys.anchorKeys),
    });

    const warnings = candidates.truncated
      ? [
          `This file matches more than ${MAX_CANDIDATES} existing records on an identifier, so only the first ${MAX_CANDIDATES} were compared. Some rows shown as new may already exist.`,
        ]
      : [];

    const [imported] = await this.db
      .insert(crmImports)
      .values({
        organizationId: input.organizationId,
        status: "previewing",
        sourceFilename: input.filename ?? null,
        targetEntity: entity,
        targetSubjectTypeId: subjectTypeId,
        columns: columns as unknown as StoredColumnMapping[],
        summary: plan.summary,
        createdByUserId: input.userId,
      })
      .returning({ id: crmImports.crmImportId });

    if (!imported) throw new ConflictException("Could not start the import.");

    const values = plan.rows.map((row) => ({
      organizationId: input.organizationId,
      crmImportId: imported.id,
      rowNumber: row.rowNumber,
      action: row.action,
      reason: row.reason,
      values: row.values as Record<string, string>,
      customFields: row.customFields as Record<string, string>,
      matchedRecordId: row.matchedRecordId ?? null,
      duplicateOfRow: row.duplicateOfRow ?? null,
      match: row.match ? { ...row.match, signals: [...row.match.signals] } : null,
    }));

    for (let index = 0; index < values.length; index += PLAN_INSERT_CHUNK)
      await this.db.insert(crmImportRows).values(values.slice(index, index + PLAN_INSERT_CHUNK));

    return {
      crmImportId: imported.id,
      entity,
      subjectTypeId,
      columns,
      needsConfirmation: unanswered,
      summary: plan.summary,
      warnings,
      rows: plan.rows.slice(0, 50),
    };
  }

  private async resolveSubjectType(
    organizationId: string,
    entity: ImportEntity,
    subjectTypeId: string | undefined,
  ): Promise<string | null> {
    if (entity !== "subject") return null;

    if (!subjectTypeId)
      throw new BadRequestException(
        "A subject import has to say which subject type these rows are, because nothing in the file can.",
      );

    const [type] = await this.db
      .select({ subjectTypeId: subjectTypes.subjectTypeId })
      .from(subjectTypes)
      .where(
        and(
          eq(subjectTypes.organizationId, organizationId),
          eq(subjectTypes.subjectTypeId, subjectTypeId),
          isNull(subjectTypes.deletedAt),
        ),
      )
      .limit(1);

    if (!type) throw new NotFoundException("Subject type not found");
    return type.subjectTypeId;
  }

  async getImport(organizationId: string, crmImportId: string) {
    const [imported] = await this.db
      .select()
      .from(crmImports)
      .where(
        and(
          eq(crmImports.organizationId, organizationId),
          eq(crmImports.crmImportId, crmImportId),
        ),
      )
      .limit(1);

    if (!imported) throw new NotFoundException("Import not found");

    const rows = await this.db
      .select()
      .from(crmImportRows)
      .where(
        and(
          eq(crmImportRows.organizationId, organizationId),
          eq(crmImportRows.crmImportId, crmImportId),
        ),
      )
      .orderBy(asc(crmImportRows.rowNumber))
      .limit(200);

    return { ...imported, rows };
  }

  async targetEntityOf(organizationId: string, crmImportId: string): Promise<ImportEntity> {
    const [imported] = await this.db
      .select({ targetEntity: crmImports.targetEntity })
      .from(crmImports)
      .where(
        and(
          eq(crmImports.organizationId, organizationId),
          eq(crmImports.crmImportId, crmImportId),
        ),
      )
      .limit(1);

    if (!imported) throw new NotFoundException("Import not found");
    return imported.targetEntity;
  }
}
