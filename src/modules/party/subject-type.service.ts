import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { subjectTypes } from "../../db/schema";
import type { SubjectFieldDefinition } from "../../db/schema/party/subjects";
import { AuditService } from "../../common/audit/audit.service";
import {
  validateFieldDefinitions,
} from "./subject-values";
import type {
  CreateSubjectTypeInput,
  UpdateSubjectTypeInput,
} from "./dto/subject.schemas";
import { isUniqueViolation } from "../../common/db/postgres-error";

@Injectable()
export class SubjectTypeService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

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

  async requireType(organizationId: string, subjectTypeId: string) {
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

  private assertDeclaration(fields: SubjectFieldDefinition[], titleField: string): void {
    const problems = validateFieldDefinitions(fields, titleField);
    if (problems.length > 0)
      throw new BadRequestException({
        code: "INVALID_SUBJECT_TYPE",
        message: "The subject type declaration is not valid.",
        details: problems,
      });
  }
}
