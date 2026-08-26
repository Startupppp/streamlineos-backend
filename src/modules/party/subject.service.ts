import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, ilike, isNull } from "drizzle-orm";
import { keysetBefore } from "../../common/pagination/keyset";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import {
  businessParties,
  subjectPartyLinks,
  subjectTypes,
  subjects,
} from "../../db/schema";
import type { SubjectFieldDefinition } from "../../db/schema/party/subjects";
import { AuditService } from "../../common/audit/audit.service";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { isSubjectResolved, resolveSubject } from "./subject-seam";
import {
  deriveTitle,
  normaliseSubjectValues,
  validateFieldDefinitions,
  validateSubjectValues,
} from "./subject-values";
import type {
  CreateSubjectInput,
  CreateSubjectTypeInput,
  LinkPartyInput,
  ListSubjectsQuery,
  UpdateSubjectInput,
  UpdateSubjectTypeInput,
} from "./dto/subject.schemas";

const PG_UNIQUE_VIOLATION = "23505";

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

@Injectable()
export class SubjectService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  // ── Types ──────────────────────────────────────────────────────────────────

  async listTypes(organizationId: string) {
    return this.db
      .select()
      .from(subjectTypes)
      .where(
        and(eq(subjectTypes.organizationId, organizationId), isNull(subjectTypes.deletedAt)),
      )
      .orderBy(subjectTypes.singular);
  }

  async createType(organizationId: string, userId: string, input: CreateSubjectTypeInput) {
    this.assertDeclaration(input.fields, input.titleField);

    try {
      const [row] = await this.db
        .insert(subjectTypes)
        .values({
          organizationId,
          key: input.key,
          singular: input.singular,
          plural: input.plural,
          titleField: input.titleField,
          fields: input.fields,
        })
        .returning();

      this.audit.log({
        action: "party.subject_type.created",
        userId,
        orgId: organizationId,
        resourceType: "subject_type",
        resourceId: row?.subjectTypeId ?? input.key,
        metadata: { key: input.key, fieldCount: input.fields.length },
      });

      return row;
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException(`A subject type with key "${input.key}" already exists`);
      throw error;
    }
  }

  async updateType(
    organizationId: string,
    subjectTypeId: string,
    userId: string,
    input: UpdateSubjectTypeInput,
  ) {
    const existing = await this.requireType(organizationId, subjectTypeId);

    const fields = input.fields ?? existing.fields;
    const titleField = input.titleField ?? existing.titleField;
    this.assertDeclaration(fields, titleField);

    const [row] = await this.db
      .update(subjectTypes)
      .set({
        ...(input.key === undefined ? {} : { key: input.key }),
        ...(input.singular === undefined ? {} : { singular: input.singular }),
        ...(input.plural === undefined ? {} : { plural: input.plural }),
        titleField,
        fields,
      })
      .where(
        and(
          eq(subjectTypes.organizationId, organizationId),
          eq(subjectTypes.subjectTypeId, subjectTypeId),
        ),
      )
      .returning();

    this.audit.log({
      action: "party.subject_type.updated",
      userId,
      orgId: organizationId,
      resourceType: "subject_type",
      resourceId: subjectTypeId,
      metadata: { fieldCount: fields.length },
    });

    return row;
  }

  /**
   * Retires a type.
   *
   * Soft, and it deliberately leaves its subjects in place: deleting the records
   * with the declaration would destroy a tenant's data because they tidied a
   * settings screen.
   */
  async deleteType(organizationId: string, subjectTypeId: string, userId: string) {
    await this.requireType(organizationId, subjectTypeId);

    await this.db
      .update(subjectTypes)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(subjectTypes.organizationId, organizationId),
          eq(subjectTypes.subjectTypeId, subjectTypeId),
        ),
      );

    this.audit.log({
      action: "party.subject_type.deleted",
      userId,
      orgId: organizationId,
      resourceType: "subject_type",
      resourceId: subjectTypeId,
    });
  }

  // ── Subjects ───────────────────────────────────────────────────────────────

  async listSubjects(organizationId: string, query: ListSubjectsQuery) {
    const { limit, cursor, search, subjectTypeId, typeKey } = query;
    const position = decodeCursor(cursor);

    const resolvedTypeId = subjectTypeId ?? (typeKey ? await this.typeIdForKey(organizationId, typeKey) : undefined);

    /**
     * A `typeKey` that names nothing returns nothing.
     *
     * `resolvedTypeId` was fed straight into `resolvedTypeId ? eq(...) :
     * undefined`, so an unresolvable key dropped the predicate entirely and the
     * caller got **every subject in the organisation** — properties, tickets and
     * candidates in one list — instead of an empty page. A typo or a retired key
     * turned a scoped read into a full dump, and it looked like a working list
     * rather than an error.
     */
    if (typeKey && !resolvedTypeId)
      return buildCursorPage([], limit, () => ({ sortValue: "", id: "" }));

    const conditions = and(
      eq(subjects.organizationId, organizationId),
      isNull(subjects.deletedAt),
      resolvedTypeId ? eq(subjects.subjectTypeId, resolvedTypeId) : undefined,
      search ? ilike(subjects.title, `%${search}%`) : undefined,
      position
        ? keysetBefore(subjects.createdAt, subjects.subjectId, position)
        : undefined,
    );

    const rows = await this.db
      .select()
      .from(subjects)
      .where(conditions)
      .orderBy(desc(subjects.createdAt), desc(subjects.subjectId))
      .limit(limit + 1);

    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: row.subjectId,
    }));
  }

  async getSubject(organizationId: string, subjectId: string) {
    const resolution = await resolveSubject(this.db, organizationId, { kind: "subject", subjectId });
    if (!isSubjectResolved(resolution)) throw new NotFoundException("Subject not found");

    const parties = await this.db
      .select({
        partyId: businessParties.partyId,
        name: businessParties.name,
        relationship: subjectPartyLinks.relationship,
        subjectPartyLinkId: subjectPartyLinks.subjectPartyLinkId,
      })
      .from(subjectPartyLinks)
      .innerJoin(
        businessParties,
        and(
          eq(businessParties.partyId, subjectPartyLinks.partyId),
          eq(businessParties.organizationId, subjectPartyLinks.organizationId),
          isNull(businessParties.deletedAt),
        ),
      )
      .where(
        and(
          eq(subjectPartyLinks.organizationId, organizationId),
          eq(subjectPartyLinks.subjectId, subjectId),
        ),
      );

    return { ...resolution.subject, parties };
  }

  async createSubject(organizationId: string, userId: string, input: CreateSubjectInput) {
    const type = await this.requireType(organizationId, input.subjectTypeId);
    const values = this.assertValues(type.fields, input.values);

    try {
      const [row] = await this.db
        .insert(subjects)
        .values({
          organizationId,
          subjectTypeId: type.subjectTypeId,
          title: deriveTitle(type.titleField, values, `Untitled ${type.singular.toLowerCase()}`),
          reference: input.reference ?? null,
          status: input.status ?? null,
          customFields: values,
        })
        .returning();

      this.audit.log({
        action: "party.subject.created",
        userId,
        orgId: organizationId,
        resourceType: "subject",
        resourceId: row?.subjectId ?? "",
        metadata: { typeKey: type.key, title: row?.title },
      });

      return row;
    } catch (error) {
      if (isUniqueViolation(error))
        throw new ConflictException(
          `A ${type.singular.toLowerCase()} with reference "${String(input.reference)}" already exists`,
        );
      throw error;
    }
  }

  async updateSubject(
    organizationId: string,
    subjectId: string,
    userId: string,
    input: UpdateSubjectInput,
  ) {
    const current = await this.getSubject(organizationId, subjectId);
    const type = await this.requireType(organizationId, current.subjectTypeId);

    // Merged, not replaced: a caller sending one field must not clear the rest.
    const merged =
      input.values === undefined
        ? (current.customFields ?? {})
        : { ...(current.customFields ?? {}), ...input.values };
    const values = this.assertValues(type.fields, merged);

    const [row] = await this.db
      .update(subjects)
      .set({
        ...(input.reference === undefined ? {} : { reference: input.reference ?? null }),
        ...(input.status === undefined ? {} : { status: input.status ?? null }),
        customFields: values,
        title: deriveTitle(type.titleField, values, current.title),
      })
      .where(
        and(eq(subjects.organizationId, organizationId), eq(subjects.subjectId, subjectId)),
      )
      .returning();

    this.audit.log({
      action: "party.subject.updated",
      userId,
      orgId: organizationId,
      resourceType: "subject",
      resourceId: subjectId,
      metadata: { changed: Object.keys(input.values ?? {}) },
    });

    return row;
  }

  async deleteSubject(organizationId: string, subjectId: string, userId: string) {
    await this.getSubject(organizationId, subjectId);

    await this.db
      .update(subjects)
      .set({ deletedAt: new Date() })
      .where(and(eq(subjects.organizationId, organizationId), eq(subjects.subjectId, subjectId)));

    this.audit.log({
      action: "party.subject.deleted",
      userId,
      orgId: organizationId,
      resourceType: "subject",
      resourceId: subjectId,
    });
  }

  // ── Links ──────────────────────────────────────────────────────────────────

  async linkParty(
    organizationId: string,
    subjectId: string,
    userId: string,
    input: LinkPartyInput,
  ) {
    await this.getSubject(organizationId, subjectId);
    await this.requireParty(organizationId, input.partyId);

    const [row] = await this.db
      .insert(subjectPartyLinks)
      .values({
        organizationId,
        subjectId,
        partyId: input.partyId,
        relationship: input.relationship,
        linkedBy: userId,
      })
      .onConflictDoNothing()
      .returning();

    this.audit.log({
      action: "party.subject.linked",
      userId,
      orgId: organizationId,
      resourceType: "subject",
      resourceId: subjectId,
      metadata: { partyId: input.partyId, relationship: input.relationship },
    });

    return row ?? null;
  }

  async unlinkParty(organizationId: string, subjectPartyLinkId: string, userId: string) {
    const removed = await this.db
      .delete(subjectPartyLinks)
      .where(
        and(
          eq(subjectPartyLinks.organizationId, organizationId),
          eq(subjectPartyLinks.subjectPartyLinkId, subjectPartyLinkId),
        ),
      )
      .returning({ subjectId: subjectPartyLinks.subjectId });

    if (removed.length === 0) throw new NotFoundException("Link not found");

    this.audit.log({
      action: "party.subject.unlinked",
      userId,
      orgId: organizationId,
      resourceType: "subject",
      resourceId: removed[0]?.subjectId ?? "",
      metadata: { subjectPartyLinkId },
    });
  }

  /** Everything this party is attached to, whichever way round it was linked. */
  async listForParty(organizationId: string, partyId: string) {
    return this.db
      .select({
        subjectId: subjects.subjectId,
        title: subjects.title,
        status: subjects.status,
        subjectTypeId: subjects.subjectTypeId,
        typeKey: subjectTypes.key,
        relationship: subjectPartyLinks.relationship,
        subjectPartyLinkId: subjectPartyLinks.subjectPartyLinkId,
      })
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
        ),
      )
      .where(
        and(
          eq(subjectPartyLinks.organizationId, organizationId),
          eq(subjectPartyLinks.partyId, partyId),
        ),
      )
      .limit(100);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private assertDeclaration(fields: SubjectFieldDefinition[], titleField: string): void {
    const problems = validateFieldDefinitions(fields, titleField);
    if (problems.length > 0)
      throw new BadRequestException({
        code: "INVALID_SUBJECT_TYPE",
        message: "The subject type declaration is not valid.",
        details: problems,
      });
  }

  private assertValues(
    fields: SubjectFieldDefinition[],
    values: Record<string, unknown>,
  ): Record<string, unknown> {
    const problems = validateSubjectValues(fields, values);
    if (problems.length > 0)
      throw new BadRequestException({
        code: "INVALID_SUBJECT_VALUES",
        message: "The values do not match this subject type.",
        details: problems,
      });
    return normaliseSubjectValues(fields, values);
  }

  private async typeIdForKey(organizationId: string, key: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ subjectTypeId: subjectTypes.subjectTypeId })
      .from(subjectTypes)
      .where(
        and(
          eq(subjectTypes.organizationId, organizationId),
          eq(subjectTypes.key, key),
          isNull(subjectTypes.deletedAt),
        ),
      )
      .limit(1);
    return row?.subjectTypeId;
  }

  private async requireType(organizationId: string, subjectTypeId: string) {
    const [row] = await this.db
      .select()
      .from(subjectTypes)
      .where(
        and(
          eq(subjectTypes.organizationId, organizationId),
          eq(subjectTypes.subjectTypeId, subjectTypeId),
          isNull(subjectTypes.deletedAt),
        ),
      )
      .limit(1);

    if (!row) throw new NotFoundException("Subject type not found");
    return row;
  }

  private async requireParty(organizationId: string, partyId: string) {
    const [row] = await this.db
      .select({ partyId: businessParties.partyId })
      .from(businessParties)
      .where(
        and(
          eq(businessParties.organizationId, organizationId),
          eq(businessParties.partyId, partyId),
          isNull(businessParties.deletedAt),
        ),
      )
      .limit(1);

    if (!row) throw new NotFoundException("Party not found");
    return row;
  }
}
