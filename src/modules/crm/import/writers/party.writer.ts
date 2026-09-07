import { and, eq } from "drizzle-orm";
import { businessParties } from "../../../../db/schema";
import { claimIdentifiers, identifierClaimsOfColumns } from "../../../party/party-identifiers";
import { softDeletePartyWithMirror, updatePartyWithMirror } from "../../../party/party-legacy-writer";
import { isPartyType } from "../import-entities";
import { recordOrNull, rowToRecord, stringOrNull, type EntityWriter } from "./entity-writer";

/**
 * Landing a row as a party.
 *
 * Lifted out of `crm-import.service` unchanged in behaviour. It was the only
 * writer when there was only one entity; it is one of four now, and having it
 * inline was what made "add another entity" look like "add another code path".
 */

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

export const PARTY_WRITER: EntityWriter = {
  async create(tx, context, row) {
    const values = row.values;

    const [party] = await tx
      .insert(businessParties)
      .values({
        organizationId: context.organizationId,
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
         * `partyType` and `status` are mapped columns with synonyms, so a file
         * whose Type column says VENDOR is previewed as VENDOR — and hard-coding
         * CUSTOMER here turned a supplier list into a customer list, which is
         * the preview-versus-commit divergence this module exists to prevent.
         * Checked again rather than trusted: `values` is stored JSONB and may
         * have been planned before the enum was. `undefined` leaves the column's
         * own default in place.
         */
        partyType: isPartyType(values.partyType) ? values.partyType : undefined,
        status: values.status || undefined,
        acquisitionSource: values.acquisitionSource ?? null,
        customFields: row.customFields ?? null,
      })
      .returning({
        partyId: businessParties.partyId,
        email: businessParties.email,
        phone: businessParties.phone,
        whatsappPhone: businessParties.whatsappPhone,
      });

    if (!party) throw new Error("insert returned no row");

    /**
     * The identifiers the new party is reachable at, claimed here.
     *
     * `applyPartyPatch` claims on every update, so the update path is already
     * covered — but this insert writes `business_parties` directly and would
     * otherwise be the one uncovered path in the codebase. An imported party
     * whose e-mail address nothing had claimed matches no inbound channel at
     * all, which is exactly the record a tenant most wants matched: the one they
     * just migrated in.
     */
    await claimIdentifiers(
      tx,
      context.organizationId,
      party.partyId,
      identifierClaimsOfColumns(party),
    );

    return party.partyId;
  },

  async remove(tx, context, recordId) {
    await softDeletePartyWithMirror(tx, context.organizationId, recordId);
  },

  updates: {
    async before(tx, context, recordId) {
      const [party] = await tx
        .select()
        .from(businessParties)
        .where(
          and(
            eq(businessParties.organizationId, context.organizationId),
            eq(businessParties.partyId, recordId),
          ),
        )
        .limit(1);

      return party ? rowToRecord(party) : null;
    },

    async fillGaps(tx, context, recordId, before, row) {
      /**
       * Only fills gaps.
       *
       * A column's default counts as blank. `party_type` and `status` are NOT
       * NULL with defaults, so their current value is never empty and a plain
       * "is it blank" rule would never fill either — leaving two advertised
       * import fields silently unfillable on every update row.
       */
      const patch: Record<string, string> = {};
      for (const [key, value] of Object.entries(row.values)) {
        if (!value) continue;
        // An enum column takes the values the enum has and no others, whatever
        // an older stored plan may hold.
        if (key === "partyType" && !isPartyType(value)) continue;

        const current = before[key];
        const untouched =
          current === null ||
          current === undefined ||
          current === "" ||
          current === COLUMN_DEFAULTS[key];

        if (untouched) patch[key] = value;
      }

      // The import matched an existing party, which may already answer for a
      // lead, a client or a contact; those rows are derived from it and have to
      // move with it inside this row's savepoint.
      await updatePartyWithMirror(tx, context.organizationId, recordId, {
        ...patch,
        customFields: {
          ...(recordOrNull(before.customFields) ?? {}),
          ...(row.customFields ?? {}),
        },
      });
    },

    async restore(tx, context, recordId, before) {
      await updatePartyWithMirror(tx, context.organizationId, recordId, {
        name: String(before.name ?? ""),
        legalName: stringOrNull(before.legalName),
        displayName: stringOrNull(before.displayName),
        email: stringOrNull(before.email),
        phone: stringOrNull(before.phone),
        website: stringOrNull(before.website),
        taxNumber: stringOrNull(before.taxNumber),
        notes: stringOrNull(before.notes),
        customFields: recordOrNull(before.customFields),
        acquisitionSource: stringOrNull(before.acquisitionSource),
        ...(isPartyType(before.partyType) ? { partyType: before.partyType } : {}),
        ...(typeof before.status === "string" ? { status: before.status } : {}),
      });
    },
  },
};
