import { and, asc, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.module";
import { documents, hrPeople, organizationPeople } from "../../../db/schema";
import type { DocumentMetadataRow } from "./schemas/entity-row-schemas";
import type { CommitRef } from "./hr-import-commit.types";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The one definition of "the same name" for a document sheet: case-folded, every run of whitespace one space, ends
 * trimmed. It is written in SQL and applied to the stored column AND to the incoming value alike, so the two sides
 * cannot disagree about what counts as whitespace or as a lower-case letter. (A JavaScript normaliser on one side and
 * `lower(trim())` on the other is how a name with a double space became a second document on every re-import.)
 */
export function nameKey(value: SQL | PgColumn | string): SQL {
  // The non-breaking space is named outright: whether `[[:space:]]` covers it depends on the database's locale.
  return sql`lower(btrim(regexp_replace(${value}, '[[:space:]\u00a0]+', ' ', 'g')))`;
}

/**
 * One row of a document sheet. A document imported here belongs to a person, so the person has to exist: a row
 * whose email matches nobody is an error the operator can fix, never a document that quietly becomes the whole
 * organisation's. It is stored as Personal (the column's default), so an import can never make a document
 * shareable by itself.
 */
export async function commitDocumentRow(tx: Tx, orgId: string, row: DocumentMetadataRow): Promise<CommitRef> {
  const [person] = await tx
    .select({ userId: hrPeople.userId })
    .from(hrPeople)
    .innerJoin(
      organizationPeople,
      and(
        eq(organizationPeople.organizationId, hrPeople.orgId),
        eq(organizationPeople.organizationPersonId, hrPeople.organizationPersonId),
      ),
    )
    .where(
      and(
        eq(hrPeople.orgId, orgId),
        isNull(hrPeople.deletedAt),
        isNull(organizationPeople.deletedAt),
        sql`lower(btrim(${organizationPeople.workEmail})) = lower(btrim(${row.employeeEmail}))`,
      ),
    )
    .orderBy(asc(hrPeople.id))
    .limit(1);

  if (!person) throw new Error(`No employee has the work email ${row.employeeEmail}. Add the person first, or correct the address. This document was not imported.`);
  if (!person.userId) throw new Error(`${row.employeeEmail} is an employee with no user account yet, so a personal document cannot be attached. This document was not imported.`);
  const userId = person.userId;

  const incoming = {
    name: row.name,
    type: row.type,
    category: row.category ?? null,
    fileUrl: row.fileUrl,
    expiryDate: row.expiryDate || null,
  };

  // PROVISIONAL identity — open product decision #2. A document is the same document when it is the same person's, in
  // the same category, under the same name. Only an ACTIVE document can be matched: one that was removed stays
  // removed, and the sheet creates a new one rather than reviving it. No unique index backs this yet.
  const [existing] = await tx
    .select({
      id: documents.id,
      name: documents.name,
      type: documents.type,
      category: documents.category,
      fileUrl: documents.fileUrl,
      expiryDate: documents.expiryDate,
      classification: documents.classification,
    })
    .from(documents)
    .where(
      and(
        eq(documents.orgId, orgId),
        eq(documents.userId, userId),
        eq(documents.isActive, true),
        sql`${nameKey(sql`coalesce(${documents.category}, '')`)} = ${nameKey(incoming.category ?? "")}`,
        sql`${nameKey(documents.name)} = ${nameKey(incoming.name)}`,
      ),
    )
    .orderBy(asc(documents.id))
    .limit(1);

  if (existing) {
    // A blank expiry cell means "not stated", not "clear it": a sheet that leaves the column empty must not erase a
    // date someone entered in the app.
    const same =
      existing.name === incoming.name &&
      existing.type === incoming.type &&
      existing.category === incoming.category &&
      existing.fileUrl === incoming.fileUrl &&
      (incoming.expiryDate === null || existing.expiryDate === incoming.expiryDate);
    if (same) return { table: "documents", id: existing.id, outcome: "unchanged" };
    // Someone classified this document (it may be in the knowledge base), and a sheet has no say over that: rewriting its file
    // or type here would change what readers get without the publish permission, a new version, or an audit row of the change.
    if (existing.classification !== "PERSONAL")
      throw new Error(`"${incoming.name}" has been classified for the Knowledge Base, so an import will not change it. Change it in the Document Library instead. This row was not imported.`);

    await tx
      .update(documents)
      .set({
        name: incoming.name,
        type: incoming.type,
        category: incoming.category,
        fileUrl: incoming.fileUrl,
        ...(incoming.expiryDate === null ? {} : { expiryDate: incoming.expiryDate }),
        updatedAt: new Date(),
      })
      .where(and(eq(documents.id, existing.id), eq(documents.orgId, orgId)));
    return { table: "documents", id: existing.id, outcome: "updated" };
  }

  const [doc] = await tx
    .insert(documents)
    .values({ orgId, userId, ...incoming })
    .returning({ id: documents.id });

  if (!doc) throw new Error("Failed to insert document metadata");
  return { table: "documents", id: doc.id, outcome: "created" };
}
