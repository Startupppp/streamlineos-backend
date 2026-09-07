import { and, eq } from "drizzle-orm";
import { subjects } from "../../../../db/schema";
import { recordOrNull, rowToRecord, stringOrNull, type EntityWriter } from "./entity-writer";

/**
 * Landing a row as a subject.
 *
 * A subject is whatever the tenant declared — a property, a candidate, a
 * shipment — so the file's columns split two ways and both are deliberate.
 * `title`, `reference` and `status` are columns on the record itself;
 * everything else lands in `custom_fields`, which is exactly where a subject
 * type's declared field values live. So an "unrecognised" column here is not a
 * recall failure, it is the right destination: `subject-values.ts` reserves
 * those same three names precisely because a declared field may not shadow them.
 *
 * `subject_type_id` cannot come from the file — no column of somebody else's
 * export names one of this tenant's types — so it comes from the import, which
 * is why `crm_imports.target_subject_type_id` exists and why a subject import
 * that names no type is refused before a row is planned.
 */
export const SUBJECT_WRITER: EntityWriter = {
  async create(tx, context, row) {
    if (!context.subjectTypeId) throw new Error("a subject import with no subject type");

    const [subject] = await tx
      .insert(subjects)
      .values({
        organizationId: context.organizationId,
        subjectTypeId: context.subjectTypeId,
        title: row.values.title ?? "",
        reference: row.values.reference ?? null,
        status: row.values.status ?? null,
        customFields: row.customFields ?? null,
      })
      .returning({ subjectId: subjects.subjectId });

    if (!subject) throw new Error("insert returned no row");
    return subject.subjectId;
  },

  async remove(tx, context, recordId) {
    // Soft, as everywhere else: the record leaves the product without leaving
    // the database, so a wrong undo is itself recoverable.
    await tx
      .update(subjects)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(subjects.organizationId, context.organizationId),
          eq(subjects.subjectId, recordId),
        ),
      );
  },

  updates: {
    async before(tx, context, recordId) {
      const [subject] = await tx
        .select()
        .from(subjects)
        .where(
          and(
            eq(subjects.organizationId, context.organizationId),
            eq(subjects.subjectId, recordId),
          ),
        )
        .limit(1);

      return subject ? rowToRecord(subject) : null;
    },

    async fillGaps(tx, context, recordId, before, row) {
      const patch: Record<string, string> = {};
      for (const key of ["title", "reference", "status"] as const) {
        const value = row.values[key];
        if (!value) continue;

        const current = before[key];
        if (current === null || current === undefined || current === "") patch[key] = value;
      }

      await tx
        .update(subjects)
        .set({
          ...patch,
          /**
           * Merged rather than replaced, and the file loses ties.
           *
           * A subject's declared field values live here, so replacing the object
           * would erase every field this particular export did not carry — which
           * is most of them, most of the time.
           */
          customFields: {
            ...(recordOrNull(before.customFields) ?? {}),
            ...(row.customFields ?? {}),
          },
        })
        .where(
          and(
            eq(subjects.organizationId, context.organizationId),
            eq(subjects.subjectId, recordId),
          ),
        );
    },

    async restore(tx, context, recordId, before) {
      await tx
        .update(subjects)
        .set({
          title: String(before.title ?? ""),
          reference: (before.reference as string | null) ?? null,
          status: (before.status as string | null) ?? null,
          customFields: (before.customFields as Record<string, unknown> | null) ?? null,
        })
        .where(
          and(
            eq(subjects.organizationId, context.organizationId),
            eq(subjects.subjectId, recordId),
          ),
        );
    },
  },
};
