import { ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, asc, eq, isNotNull, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { businessParties, crmImportRows, crmImports } from "../../db/schema";
import type { StoredColumnMapping } from "../../db/schema/crm/imports";
import type { PartyFingerprint } from "../party/party-duplicates";
import { mapColumns, needsConfirmation, type MappedColumn } from "./column-mapping";
import { planImport } from "./import-plan";

/** A file this size is a paste, not a migration; the connectors are Phase 2. */
const MAX_ROWS = 5_000;
/** Enough to fingerprint against without reading an entire tenant into memory. */
const MAX_EXISTING = 10_000;

@Injectable()
export class CrmImportService {
  private readonly logger = new Logger("CrmImport");

  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * Work out what this file would do, and store the answer.
   *
   * Nothing is written to the CRM here. The plan is persisted because the
   * commit executes *these rows* rather than re-deriving them — re-deriving
   * would let the answer change between the preview and the commit, which is
   * precisely what the criterion forbids.
   */
  async preview(input: {
    organizationId: string;
    userId: string;
    filename?: string;
    headers: readonly string[];
    rows: readonly (readonly string[])[];
    /** A person's answers to ambiguous columns, from a previous preview. */
    overrides?: Readonly<Record<string, string>>;
  }) {
    if (input.rows.length > MAX_ROWS)
      throw new ConflictException(
        `That file has ${input.rows.length} rows; ${MAX_ROWS} is the most this import handles.`,
      );

    const columns = applyOverrides(mapColumns(input.headers), input.overrides);
    const unanswered = needsConfirmation(columns);
    const existing = await this.existingFingerprints(input.organizationId);
    const plan = planImport({ columns, rows: input.rows, existing });

    const [imported] = await this.db
      .insert(crmImports)
      .values({
        organizationId: input.organizationId,
        status: "previewing",
        sourceFilename: input.filename ?? null,
        columns: columns as unknown as StoredColumnMapping[],
        summary: plan.summary,
        createdByUserId: input.userId,
      })
      .returning({ id: crmImports.crmImportId });

    if (!imported) throw new ConflictException("Could not start the import.");

    if (plan.rows.length > 0)
      await this.db.insert(crmImportRows).values(
        plan.rows.map((row) => ({
          organizationId: input.organizationId,
          crmImportId: imported.id,
          rowNumber: row.rowNumber,
          action: row.action,
          reason: row.reason,
          values: row.values as Record<string, string>,
          customFields: row.customFields as Record<string, string>,
          matchedPartyId: row.matchedPartyId ?? null,
          duplicateOfRow: row.duplicateOfRow ?? null,
        })),
      );

    return {
      crmImportId: imported.id,
      columns,
      needsConfirmation: unanswered,
      summary: plan.summary,
      // A sample, not the file. A preview that ships ten thousand rows to a
      // browser is a preview nobody waits for.
      rows: plan.rows.slice(0, 50),
    };
  }

  /** The stored plan, for the preview screen and for the commit. */
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

  /**
   * Execute the stored plan.
   *
   * Claimed with a conditional update so a double submission commits once. Each
   * row records what it did as it does it, because that record is the only way
   * the import can later be undone.
   */
  async commit(organizationId: string, crmImportId: string) {
    const claimed = await this.db
      .update(crmImports)
      .set({ status: "committing" })
      .where(
        and(
          eq(crmImports.organizationId, organizationId),
          eq(crmImports.crmImportId, crmImportId),
          eq(crmImports.status, "previewing"),
        ),
      )
      .returning({ id: crmImports.crmImportId });

    if (claimed.length === 0) {
      const [existing] = await this.db
        .select({ status: crmImports.status })
        .from(crmImports)
        .where(
          and(
            eq(crmImports.organizationId, organizationId),
            eq(crmImports.crmImportId, crmImportId),
          ),
        )
        .limit(1);

      if (!existing) throw new NotFoundException("Import not found");
      throw new ConflictException(`That import is already ${existing.status}.`);
    }

    const rows = await this.db
      .select()
      .from(crmImportRows)
      .where(
        and(
          eq(crmImportRows.organizationId, organizationId),
          eq(crmImportRows.crmImportId, crmImportId),
          isNull(crmImportRows.committedAt),
        ),
      )
      .orderBy(asc(crmImportRows.rowNumber));

    let created = 0;
    let updated = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        if (row.action === "skip") {
          await this.markRowDone(organizationId, row.crmImportRowId, {});
          continue;
        }

        if (row.action === "create") {
          const [party] = await this.db
            .insert(businessParties)
            .values({
              organizationId,
              name: row.values?.name ?? "",
              legalName: row.values?.legalName ?? null,
              displayName: row.values?.displayName ?? null,
              email: row.values?.email ?? null,
              phone: row.values?.phone ?? null,
              website: row.values?.website ?? null,
              taxNumber: row.values?.taxNumber ?? null,
              notes: row.values?.notes ?? null,
              partyType: "CUSTOMER",
              customFields: row.customFields ?? null,
            })
            .returning({ partyId: businessParties.partyId });

          if (!party) throw new Error("insert returned no row");
          await this.markRowDone(organizationId, row.crmImportRowId, {
            createdPartyId: party.partyId,
          });
          created += 1;
          continue;
        }

        // update
        if (!row.matchedPartyId) throw new Error("an update row with nothing to update");

        const [before] = await this.db
          .select()
          .from(businessParties)
          .where(
            and(
              eq(businessParties.organizationId, organizationId),
              eq(businessParties.partyId, row.matchedPartyId),
            ),
          )
          .limit(1);

        if (!before) throw new Error("the matched party no longer exists");

        /**
         * Only fills gaps.
         *
         * An import is somebody else's export, and overwriting a value a person
         * curated here with a staler one from another system is the complaint
         * this avoids. A blank stays blank until the file has something for it.
         */
        const patch: Record<string, string> = {};
        for (const [key, value] of Object.entries(row.values ?? {})) {
          const current = (before as unknown as Record<string, unknown>)[key];
          if (value && (current === null || current === undefined || current === "")) patch[key] = value;
        }

        await this.db
          .update(businessParties)
          .set({
            ...patch,
            customFields: { ...(before.customFields ?? {}), ...(row.customFields ?? {}) },
          })
          .where(
            and(
              eq(businessParties.organizationId, organizationId),
              eq(businessParties.partyId, row.matchedPartyId),
            ),
          );

        await this.markRowDone(organizationId, row.crmImportRowId, {
          previous: before as unknown as Record<string, unknown>,
        });
        updated += 1;
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`import ${crmImportId} row ${row.rowNumber}: ${message}`);
        await this.db
          .update(crmImportRows)
          .set({ error: message })
          .where(
            and(
              eq(crmImportRows.organizationId, organizationId),
              eq(crmImportRows.crmImportRowId, row.crmImportRowId),
            ),
          );
      }
    }

    await this.db
      .update(crmImports)
      .set({ status: "committed", committedAt: new Date() })
      .where(
        and(
          eq(crmImports.organizationId, organizationId),
          eq(crmImports.crmImportId, crmImportId),
        ),
      );

    return { created, updated, failed };
  }

  /**
   * Take the whole thing back.
   *
   * In reverse row order, so a later row that updated a party an earlier row
   * created is undone before the party it points at disappears.
   */
  async revert(organizationId: string, userId: string, crmImportId: string) {
    const claimed = await this.db
      .update(crmImports)
      .set({ status: "reverted", revertedAt: new Date(), revertedByUserId: userId })
      .where(
        and(
          eq(crmImports.organizationId, organizationId),
          eq(crmImports.crmImportId, crmImportId),
          eq(crmImports.status, "committed"),
        ),
      )
      .returning({ id: crmImports.crmImportId });

    if (claimed.length === 0)
      throw new ConflictException("Only a committed import can be taken back.");

    const rows = await this.db
      .select()
      .from(crmImportRows)
      .where(
        and(
          eq(crmImportRows.organizationId, organizationId),
          eq(crmImportRows.crmImportId, crmImportId),
          isNotNull(crmImportRows.committedAt),
        ),
      )
      .orderBy(asc(crmImportRows.rowNumber));

    let deleted = 0;
    let restored = 0;

    for (const row of [...rows].reverse()) {
      if (row.createdPartyId) {
        // Soft delete, as everywhere else: the row leaves the product without
        // leaving the database, so a wrong undo is itself recoverable.
        await this.db
          .update(businessParties)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(businessParties.organizationId, organizationId),
              eq(businessParties.partyId, row.createdPartyId),
            ),
          );
        deleted += 1;
        continue;
      }

      if (row.previous && row.matchedPartyId) {
        const before = row.previous as Record<string, unknown>;
        await this.db
          .update(businessParties)
          .set({
            name: String(before.name ?? ""),
            legalName: (before.legalName as string | null) ?? null,
            displayName: (before.displayName as string | null) ?? null,
            email: (before.email as string | null) ?? null,
            phone: (before.phone as string | null) ?? null,
            website: (before.website as string | null) ?? null,
            taxNumber: (before.taxNumber as string | null) ?? null,
            notes: (before.notes as string | null) ?? null,
            customFields: (before.customFields as Record<string, unknown> | null) ?? null,
          })
          .where(
            and(
              eq(businessParties.organizationId, organizationId),
              eq(businessParties.partyId, row.matchedPartyId),
            ),
          );
        restored += 1;
      }
    }

    return { deleted, restored };
  }

  private async markRowDone(
    organizationId: string,
    rowId: string,
    outcome: { createdPartyId?: string; previous?: Record<string, unknown> },
  ): Promise<void> {
    await this.db
      .update(crmImportRows)
      .set({ committedAt: new Date(), ...outcome })
      .where(
        and(
          eq(crmImportRows.organizationId, organizationId),
          eq(crmImportRows.crmImportRowId, rowId),
        ),
      );
  }

  /** Enough of the tenant to fingerprint against, projected to what matters. */
  private async existingFingerprints(organizationId: string): Promise<PartyFingerprint[]> {
    return this.db
      .select({
        partyId: businessParties.partyId,
        name: businessParties.name,
        legalName: businessParties.legalName,
        email: businessParties.email,
        phone: businessParties.phone,
        taxNumber: businessParties.taxNumber,
        website: businessParties.website,
      })
      .from(businessParties)
      .where(
        and(
          eq(businessParties.organizationId, organizationId),
          isNull(businessParties.deletedAt),
        ),
      )
      .limit(MAX_EXISTING);
  }
}

/**
 * A person's answers to the columns the system would not guess.
 *
 * Applied to the mapping rather than remembered separately, so there is one
 * description of what each column means by the time anything is planned.
 */
function applyOverrides(
  columns: MappedColumn[],
  overrides: Readonly<Record<string, string>> | undefined,
): MappedColumn[] {
  if (!overrides) return columns;

  return columns.map((column) => {
    const answer = overrides[column.header];
    if (!answer) return column;
    if (answer === "__ignore__") return { header: column.header, mapping: { kind: "unmapped" } };
    return {
      header: column.header,
      // A person's answer is certain by definition; that is what asking was for.
      mapping: { kind: "mapped", field: answer as never, confidence: 1 },
    };
  });
}
