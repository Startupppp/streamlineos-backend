import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import { subjectPartyLinks, subjectTypes, subjects } from "../../db/schema";
import type { SubjectFieldDefinition } from "../../db/schema/party/subjects";

/**
 * One way to resolve a subject, whichever identifier you hold.
 *
 * Same contract as the party and person seams. Organisation scope is re-asserted
 * on every query rather than leaning on row-level security, so a subject from
 * another tenant resolves unresolved even where policies are not yet enabled —
 * surface that as 404, because a 403 confirms the record exists.
 *
 * Unresolved is a value, not a throw: a caller checking whether a link target
 * exists should not need a try/catch.
 */

export type SubjectSubject =
  | { readonly kind: "subject"; readonly subjectId: string }
  | { readonly kind: "link"; readonly subjectPartyLinkId: string };

export interface ResolvedSubject {
  readonly subjectId: string;
  readonly organizationId: string;
  readonly subjectTypeId: string;
  readonly typeKey: string;
  /** The type's own singular noun, so a caller can label the record. */
  readonly typeSingular: string;
  readonly title: string;
  readonly reference: string | null;
  readonly status: string | null;
  readonly fields: SubjectFieldDefinition[];
  readonly customFields: Record<string, unknown> | null;
  /** The detail view labels the record with it, so the projection carries it. */
  readonly createdAt: Date;
  /** Present only when resolution started from a link. */
  readonly linkedPartyId: string | null;
  readonly resolvedVia: "subject-record" | "link-record";
}

export type SubjectResolution =
  | { readonly status: "resolved"; readonly subject: ResolvedSubject }
  | { readonly status: "unresolved"; readonly subject: SubjectSubject };

function unresolved(subject: SubjectSubject): SubjectResolution {
  return { status: "unresolved", subject };
}

export function isSubjectResolved(
  resolution: SubjectResolution,
): resolution is Extract<SubjectResolution, { status: "resolved" }> {
  return resolution.status === "resolved";
}

const SELECTION = {
  subjectId: subjects.subjectId,
  organizationId: subjects.organizationId,
  subjectTypeId: subjects.subjectTypeId,
  title: subjects.title,
  reference: subjects.reference,
  status: subjects.status,
  customFields: subjects.customFields,
  createdAt: subjects.createdAt,
  typeKey: subjectTypes.key,
  typeSingular: subjectTypes.singular,
  fields: subjectTypes.fields,
} as const;

export async function resolveSubject(
  db: Db,
  organizationId: string,
  subject: SubjectSubject,
): Promise<SubjectResolution> {
  if (!organizationId) return unresolved(subject);

  if (subject.kind === "subject") {
    if (!subject.subjectId) return unresolved(subject);

    const [row] = await db
      .select(SELECTION)
      .from(subjects)
      .innerJoin(
        subjectTypes,
        and(
          eq(subjectTypes.subjectTypeId, subjects.subjectTypeId),
          // The tenant travels through the join too: a tampered type id must not
          // reach another organisation's declaration.
          eq(subjectTypes.organizationId, subjects.organizationId),
          isNull(subjectTypes.deletedAt),
        ),
      )
      .where(
        and(
          eq(subjects.subjectId, subject.subjectId),
          eq(subjects.organizationId, organizationId),
          isNull(subjects.deletedAt),
        ),
      )
      .limit(1);

    if (!row) return unresolved(subject);

    return {
      status: "resolved",
      subject: { ...row, linkedPartyId: null, resolvedVia: "subject-record" },
    };
  }

  if (!subject.subjectPartyLinkId) return unresolved(subject);

  const [row] = await db
    .select({ ...SELECTION, linkedPartyId: subjectPartyLinks.partyId })
    .from(subjectPartyLinks)
    .innerJoin(
      subjects,
      and(
        eq(subjects.subjectId, subjectPartyLinks.subjectId),
        eq(subjects.organizationId, subjectPartyLinks.organizationId),
        isNull(subjects.deletedAt),
      ),
    )
    .innerJoin(
      subjectTypes,
      and(
        eq(subjectTypes.subjectTypeId, subjects.subjectTypeId),
        eq(subjectTypes.organizationId, subjects.organizationId),
        isNull(subjectTypes.deletedAt),
      ),
    )
    .where(
      and(
        eq(subjectPartyLinks.subjectPartyLinkId, subject.subjectPartyLinkId),
        eq(subjectPartyLinks.organizationId, organizationId),
      ),
    )
    .limit(1);

  if (!row) return unresolved(subject);

  return { status: "resolved", subject: { ...row, resolvedVia: "link-record" } };
}
