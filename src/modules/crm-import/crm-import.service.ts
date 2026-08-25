import { ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db, TenantTx } from "../../db/drizzle.types";
import { businessParties, crmImportRows, crmImports } from "../../db/schema";
import type { StoredColumnMapping } from "../../db/schema/crm/imports";
import type { PartyFingerprint } from "../party/party-duplicates";
import {
  duplicateFieldAssignments,
  isImportField,
  mapColumns,
  needsConfirmation,
  type MappedColumn,
} from "./column-mapping";
import { blockingKeysFor, isPartyType, planImport, type BlockingKeys } from "./import-plan";
import { softDeletePartyWithMirror, updatePartyWithMirror } from "../party/party-legacy-writer";

/** A file this size is a paste, not a migration; the connectors are Phase 2. */
const MAX_ROWS = 5_000;

/**
 * How many existing parties one preview will weigh a file against.
 *
 * A ceiling rather than a sample: candidates are fetched by identifier now, so
 * a tenant reaches this only by having thousands of parties that genuinely
 * share a tax number, an address or a phone line with the file. That is worth
 * saying out loud, which is what `warnings` is for.
 */
const MAX_CANDIDATES = 10_000;

/** Identifiers per statement, so a five-thousand-row file is a few queries. */
const KEYS_PER_QUERY = 500;

/**
 * How long one commit request will work for before reporting back.
 *
 * The commit runs inline in the request's transaction, and a proxy or a browser
 * gives up on a request long before five thousand rows of round trips finish.
 * Stopping deliberately turns that into an answer the caller can act on —
 * `complete: false` and the rows left — instead of a connection that dies
 * holding work nobody can see. See the note on `commit` about resuming.
 */
const COMMIT_BUDGET_MS = 20_000;

/**
 * The normalisations `party-duplicates` compares with, written in SQL.
 *
 * These may be WIDER than their TypeScript counterparts — an extra candidate
 * costs one comparison — but never narrower: a candidate this fails to fetch is
 * a duplicate party created in silence.
 */
const NORMALISED: Readonly<Record<"taxNumber" | "email" | "phone" | "host", SQL>> = {
  taxNumber: sql`upper(regexp_replace(coalesce(${businessParties.taxNumber}, ''), '[^A-Za-z0-9]', '', 'g'))`,
  email: sql`lower(trim(coalesce(${businessParties.email}, '')))`,
  phone: sql`right(regexp_replace(coalesce(${businessParties.phone}, ''), '[^0-9]', '', 'g'), 10)`,
  host: sql`regexp_replace(regexp_replace(regexp_replace(lower(trim(coalesce(${businessParties.website}, ''))), '^[a-z]+://', ''), '/.*$', ''), '^www\\.', '')`,
};

/**
 * The values these columns hold when nobody has chosen one.
 *
 * Read off the schema rather than repeated here, so a changed default cannot
 * quietly re-break the fields it governs.
 */
const COLUMN_DEFAULTS: Readonly<Record<string, unknown>> = {
  partyType: businessParties.partyType.default,
  status: businessParties.status.default,
};

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
    const candidates = await this.existingFingerprints(
      input.organizationId,
      blockingKeysFor(columns, input.rows),
    );
    const plan = planImport({ columns, rows: input.rows, existing: candidates.fingerprints });

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
      warnings,
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
   * Claimed by locking the import row rather than by a conditional update, so a
   * second submission waits for the first and then sees what it left, instead of
   * both reading the same outstanding rows and creating every party twice.
   *
   * The claim admits an import that is already `committing`, because this runs
   * inline in one HTTP request and a large file outlasts the patience of
   * whatever sits in front of it. A call that runs out of budget returns
   * `complete: false` with the rows left over; calling again continues, because
   * only rows without a `committed_at` are read. Without that, a timed-out
   * import was permanently stuck at `committing` and the retry hit the same
   * wall — the work having been committed regardless.
   *
   * Each row records what it did as it does it, because that record is the only
   * way the import can later be undone.
   */
  async commit(organizationId: string, crmImportId: string) {
    const [imported] = await this.db
      .select({ status: crmImports.status })
      .from(crmImports)
      .where(
        and(
          eq(crmImports.organizationId, organizationId),
          eq(crmImports.crmImportId, crmImportId),
        ),
      )
      .limit(1)
      .for("update");

    if (!imported) throw new NotFoundException("Import not found");
    if (imported.status !== "previewing" && imported.status !== "committing")
      throw new ConflictException(`That import is already ${imported.status}.`);

    if (imported.status === "previewing")
      await this.db
        .update(crmImports)
        .set({ status: "committing" })
        .where(
          and(
            eq(crmImports.organizationId, organizationId),
            eq(crmImports.crmImportId, crmImportId),
          ),
        );

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
    let remaining = 0;

    const deadline = Date.now() + COMMIT_BUDGET_MS;

    for (const [index, row] of rows.entries()) {
      if (Date.now() >= deadline) {
        remaining = rows.length - index;
        break;
      }

      try {
        /**
         * One savepoint per row, and this is the whole reason the loop has a
         * shape at all.
         *
         * `this.db` resolves to the request's ambient transaction, so this
         * opens a SAVEPOINT rather than a second transaction. Postgres aborts
         * the entire transaction on a statement error and Drizzle takes no
         * per-statement savepoint, so without one a single bad cell — a NUL
         * byte in a custom field is enough — poisons everything after it: the
         * `catch` below would throw `25P02` recording the error, that throw
         * would escape `commit`, and a five-hundred-row import would land zero
         * rows with no per-row explanation and the import still `previewing`.
         * The counter and the `error` column were unreachable in exactly the
         * case they exist for.
         *
         * It also makes each row atomic: a party is never created without the
         * row that records how to undo it.
         */
        const outcome = await this.db.transaction((tx) =>
          this.commitRow(tx, organizationId, row),
        );

        if (outcome === "created") created += 1;
        else if (outcome === "updated") updated += 1;
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`import ${crmImportId} row ${row.rowNumber}: ${message}`);
        // Runs in the outer transaction, which the savepoint's rollback left
        // usable. This is the statement that used to throw.
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

    // A failed row does not hold the import open: its `error` is the record,
    // and re-running it would only fail the same way. Unattempted rows do.
    if (remaining === 0)
      await this.db
        .update(crmImports)
        .set({ status: "committed", committedAt: new Date() })
        .where(
          and(
            eq(crmImports.organizationId, organizationId),
            eq(crmImports.crmImportId, crmImportId),
          ),
        );

    return { created, updated, failed, remaining, complete: remaining === 0 };
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
        await softDeletePartyWithMirror(this.db, organizationId, row.createdPartyId);
        deleted += 1;
        continue;
      }

      if (row.previous && row.matchedPartyId) {
        const before = row.previous as Record<string, unknown>;
        await updatePartyWithMirror(this.db, organizationId, row.matchedPartyId, {
          name: String(before.name ?? ""),
          legalName: (before.legalName as string | null) ?? null,
          displayName: (before.displayName as string | null) ?? null,
          email: (before.email as string | null) ?? null,
          phone: (before.phone as string | null) ?? null,
          website: (before.website as string | null) ?? null,
          taxNumber: (before.taxNumber as string | null) ?? null,
          notes: (before.notes as string | null) ?? null,
          customFields: (before.customFields as Record<string, unknown> | null) ?? null,
          ...(isPartyType(before.partyType) ? { partyType: before.partyType } : {}),
          ...(typeof before.status === "string" ? { status: before.status } : {}),
        });
        restored += 1;
      }
    }

    return { deleted, restored };
  }

  /**
   * One row of the file, inside its own savepoint.
   *
   * Everything here writes through `tx` rather than `this.db`: `this.db` is the
   * ambient outer transaction, and a write that went there would survive the
   * savepoint's rollback and leave half a row behind.
   */
  private async commitRow(
    tx: TenantTx,
    organizationId: string,
    row: typeof crmImportRows.$inferSelect,
  ): Promise<"created" | "updated" | "skipped"> {
    const values = row.values ?? {};

    if (row.action === "skip") {
      await this.markRowDone(tx, organizationId, row.crmImportRowId, {});
      return "skipped";
    }

    if (row.action === "create") {
      const [party] = await tx
        .insert(businessParties)
        .values({
          organizationId,
          name: values.name ?? "",
          legalName: values.legalName ?? null,
          displayName: values.displayName ?? null,
          email: values.email ?? null,
          phone: values.phone ?? null,
          website: values.website ?? null,
          taxNumber: values.taxNumber ?? null,
          notes: values.notes ?? null,
          /**
           * The file's answer, not a constant.
           *
           * `partyType` and `status` are mapped columns with synonyms, so a
           * file whose Type column says VENDOR is previewed as VENDOR — and
           * hard-coding CUSTOMER here turned a supplier list into a customer
           * list, which is the preview-versus-commit divergence this module
           * exists to prevent. Checked again rather than trusted: `values` is
           * stored JSONB and may have been planned before the enum was.
           * `undefined` leaves the column's own default in place.
           */
          partyType: isPartyType(values.partyType) ? values.partyType : undefined,
          status: values.status || undefined,
          customFields: row.customFields ?? null,
        })
        .returning({ partyId: businessParties.partyId });

      if (!party) throw new Error("insert returned no row");

      await this.markRowDone(tx, organizationId, row.crmImportRowId, {
        createdPartyId: party.partyId,
      });
      return "created";
    }

    if (!row.matchedPartyId) throw new Error("an update row with nothing to update");

    const [before] = await tx
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
     *
     * A column's default counts as blank. `party_type` and `status` are NOT
     * NULL with defaults, so their `current` is never empty and the rule above
     * would never fill either — leaving two advertised import fields silently
     * unfillable on every update row.
     */
    const patch: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      if (!value) continue;
      // An enum column takes the values the enum has and no others, whatever an
      // older stored plan may hold.
      if (key === "partyType" && !isPartyType(value)) continue;

      const current = (before as unknown as Record<string, unknown>)[key];
      const untouched =
        current === null ||
        current === undefined ||
        current === "" ||
        current === COLUMN_DEFAULTS[key];

      if (untouched) patch[key] = value;
    }

    // The import matched an existing party, which may already answer for a lead,
    // a client or a contact; those rows are derived from it and have to move with
    // it inside this row's savepoint.
    await updatePartyWithMirror(tx, organizationId, row.matchedPartyId, {
      ...patch,
      customFields: { ...(before.customFields ?? {}), ...(row.customFields ?? {}) },
    });

    await this.markRowDone(tx, organizationId, row.crmImportRowId, {
      previous: before as unknown as Record<string, unknown>,
    });
    return "updated";
  }

  private async markRowDone(
    tx: TenantTx,
    organizationId: string,
    rowId: string,
    outcome: { createdPartyId?: string; previous?: Record<string, unknown> },
  ): Promise<void> {
    await tx
      .update(crmImportRows)
      .set({ committedAt: new Date(), ...outcome })
      .where(
        and(
          eq(crmImportRows.organizationId, organizationId),
          eq(crmImportRows.crmImportRowId, rowId),
        ),
      );
  }

  /**
   * The parties this file could match, projected to what matters.
   *
   * Fetched by identifier rather than as the first ten thousand rows the table
   * happened to return. Postgres does not promise an order without one, and
   * that slice shifts as rows are updated and vacuumed — so the same file
   * previewed twice could plan a row as `update` on Monday and `create` on
   * Tuesday, and quietly grow a second copy of a customer. The determinism the
   * plan is tested for held only for tenants under the cap.
   *
   * `blockingKeysFor` explains why these four identifiers are sufficient rather
   * than merely convenient.
   */
  private async existingFingerprints(
    organizationId: string,
    keys: BlockingKeys,
  ): Promise<{ fingerprints: PartyFingerprint[]; truncated: boolean }> {
    const lookups = [
      { expression: NORMALISED.taxNumber, values: keys.taxNumbers },
      { expression: NORMALISED.email, values: keys.emails },
      { expression: NORMALISED.phone, values: keys.phones },
      { expression: NORMALISED.host, values: keys.hosts },
    ].filter((lookup) => lookup.values.length > 0);

    // A file with no identifier in it cannot match anything, so there is
    // nothing to compare against and no query worth issuing.
    if (lookups.length === 0) return { fingerprints: [], truncated: false };

    const found = new Map<string, PartyFingerprint>();
    const passes = Math.max(
      ...lookups.map((lookup) => Math.ceil(lookup.values.length / KEYS_PER_QUERY)),
    );

    for (let pass = 0; pass < passes && found.size <= MAX_CANDIDATES; pass += 1) {
      const conditions = lookups
        .map((lookup) => ({
          expression: lookup.expression,
          slice: lookup.values.slice(pass * KEYS_PER_QUERY, (pass + 1) * KEYS_PER_QUERY),
        }))
        .filter((lookup) => lookup.slice.length > 0)
        .map((lookup) => inArray(lookup.expression, [...lookup.slice]));

      if (conditions.length === 0) continue;

      const rows = await this.db
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
            or(...conditions),
          ),
        )
        // One past the ceiling, so "there are more" is known rather than guessed.
        .limit(MAX_CANDIDATES + 1 - found.size);

      for (const party of rows) found.set(party.partyId, party);
    }

    return {
      fingerprints: [...found.values()].slice(0, MAX_CANDIDATES),
      truncated: found.size > MAX_CANDIDATES,
    };
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
  const answered = !overrides
    ? columns
    : columns.map((column): MappedColumn => {
        const answer = overrides[column.header];
        if (!answer) return column;
        if (answer === "__ignore__")
          return { header: column.header, mapping: { kind: "unmapped" } };

        // Narrowed rather than asserted. The preview DTO enumerates these, so
        // every answer arriving today is a field — but "safe because one caller
        // validates it" is the coupling that breaks in silence when a second
        // caller appears.
        if (!isImportField(answer))
          throw new ConflictException(`"${answer}" is not a field this import can fill.`);

        return {
          header: column.header,
          // A person's answer is certain by definition; that is what asking was for.
          mapping: { kind: "mapped", field: answer, confidence: 1 },
        };
      });

  /**
   * `mapColumns` refuses to map one field twice, but it runs before these
   * answers are applied and an answer names a field outright — so two columns
   * can still end up claiming `name`, and the rightmost would silently win for
   * every row of the file. Asking again is pointless when the answer to the
   * question caused it, so this is a refusal with the way out in it.
   */
  const [collision] = duplicateFieldAssignments(answered);
  if (collision)
    throw new ConflictException(
      `"${collision.headers.join('" and "')}" are both set to ${collision.field}. ` +
        `One field can only be filled from one column — set the others to "__ignore__" or give them a field of their own.`,
    );

  return answered;
}
