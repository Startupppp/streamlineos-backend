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
  validateSubjectValues,
} from "./subject-values";
import type {
  CreateSubjectInput,
  LinkPartyInput,
  ListSubjectsQuery,
  UpdateSubjectInput,
} from "./dto/subject.schemas";
import { SubjectTypeService } from "./subject-type.service";
import { assertPartyInOrg } from "./party-tenant";
import { isUniqueViolation } from "../../common/db/postgres-error";

@Injectable()
export class SubjectService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly types: SubjectTypeService,
  ) {}

  async listSubjects(organizationId: string, query: ListSubjectsQuery) {
    const { limit, cursor, search, subjectTypeId, typeKey } = query;
    const position = decodeCursor(cursor);

    const resolvedTypeId = subjectTypeId ?? (typeKey ? await this.typeIdForKey(organizationId, typeKey) : undefined);

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
          eq(subjectPartyLinks.subjectId, subjectId),
          eq(subjectPartyLinks.organizationId, organizationId),
        ),
      );

    return { ...resolution.subject, parties };
  }

  async createSubject(organizationId: string, userId: string, input: CreateSubjectInput) {
    const type = await this.types.requireType(organizationId, input.subjectTypeId);
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
    const type = await this.types.requireType(organizationId, current.subjectTypeId);

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
      resourceType: "subject_party_link",
      resourceId: row?.subjectPartyLinkId ?? "",
      metadata: { partyId: input.partyId, relationship: input.relationship },
    });

    return row;
  }

  async unlinkParty(organizationId: string, subjectPartyLinkId: string, userId: string) {
    const [link] = await this.db
      .select()
      .from(subjectPartyLinks)
      .where(
        and(
          eq(subjectPartyLinks.organizationId, organizationId),
          eq(subjectPartyLinks.subjectPartyLinkId, subjectPartyLinkId),
        ),
      )
      .limit(1);

    if (!link) throw new NotFoundException("Link not found");

    await this.db
      .delete(subjectPartyLinks)
      .where(
        and(
          eq(subjectPartyLinks.organizationId, organizationId),
          eq(subjectPartyLinks.subjectPartyLinkId, subjectPartyLinkId),
        ),
      );

    this.audit.log({
      action: "party.subject.unlinked",
      userId,
      orgId: organizationId,
      resourceType: "subject_party_link",
      resourceId: subjectPartyLinkId,
    });
  }

  async listForParty(organizationId: string, partyId: string) {
    await assertPartyInOrg(this.db, organizationId, partyId);
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
}
