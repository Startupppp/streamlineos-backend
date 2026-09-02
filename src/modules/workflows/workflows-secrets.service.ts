import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { workflows, workflowSecrets } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CreateSecretDto, SecretListQueryDto } from "./dto/workflow.schemas";
import { encryptSecret } from "../../common/security/secret-encryption.util";
import { buildCursorPage, decodeCursor } from "../../common/pagination/cursor";
import { PAGE_SIZE_CAP } from "../../common/pagination/list-query.schema";

const SECRET_COLUMNS = {
  id: workflowSecrets.id,
  orgId: workflowSecrets.orgId,
  name: workflowSecrets.name,
  description: workflowSecrets.description,
  createdAt: workflowSecrets.createdAt,
  updatedAt: workflowSecrets.updatedAt,
} as const;

@Injectable()
export class WorkflowsSecretsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listSecrets(orgId: string, workflowId: string, query: SecretListQueryDto) {
    const workflow = await this.db.query.workflows.findFirst({
      where: and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)),
      columns: { id: true },
    });
    if (!workflow) throw new NotFoundException("Workflow not found");

    const { cursor, limit: rawLimit } = query;
    const limit = Math.min(rawLimit, PAGE_SIZE_CAP);
    const position = decodeCursor(cursor);
    const conditions = [eq(workflowSecrets.orgId, orgId)];
    if (position) {
      const cursorDate = new Date(position.sortValue);
      const cursorId = position.id;
      conditions.push(
        or(
          lt(workflowSecrets.createdAt, cursorDate),
          and(eq(workflowSecrets.createdAt, cursorDate), lt(workflowSecrets.id, cursorId)),
        )!,
      );
    }
    const rows = await this.db
      .select(SECRET_COLUMNS)
      .from(workflowSecrets)
      .where(and(...conditions))
      .orderBy(desc(workflowSecrets.createdAt), desc(workflowSecrets.id))
      .limit(limit + 1);
    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt ?? ""),
      id: row.id,
    }));
  }

  async createSecret(orgId: string, workflowId: string, dto: CreateSecretDto) {
    const workflow = await this.db.query.workflows.findFirst({
      where: and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)),
      columns: { id: true },
    });
    if (!workflow) throw new NotFoundException("Workflow not found");

    const [secret] = await this.db
      .insert(workflowSecrets)
      .values({
        orgId,
        name: dto.name,
        encryptedValue: encryptSecret(dto.value),
        description: dto.description,
      })
      .returning(SECRET_COLUMNS);

    return secret;
  }

  async deleteSecret(orgId: string, workflowId: string, secretId: string) {
    const workflow = await this.db.query.workflows.findFirst({
      where: and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)),
      columns: { id: true },
    });
    if (!workflow) throw new NotFoundException("Workflow not found");

    const [deleted] = await this.db
      .delete(workflowSecrets)
      .where(
        and(eq(workflowSecrets.id, secretId), eq(workflowSecrets.orgId, orgId)),
      )
      .returning({ id: workflowSecrets.id });
    if (!deleted) throw new NotFoundException("Secret not found");
  }

  async listGlobalSecrets(orgId: string, query: SecretListQueryDto) {
    const { cursor, limit: rawLimit } = query;
    const limit = Math.min(rawLimit, PAGE_SIZE_CAP);
    const position = decodeCursor(cursor);
    const conditions = [eq(workflowSecrets.orgId, orgId)];
    if (position) {
      const cursorDate = new Date(position.sortValue);
      const cursorId = position.id;
      conditions.push(
        or(
          lt(workflowSecrets.createdAt, cursorDate),
          and(eq(workflowSecrets.createdAt, cursorDate), lt(workflowSecrets.id, cursorId)),
        )!,
      );
    }
    const rows = await this.db
      .select(SECRET_COLUMNS)
      .from(workflowSecrets)
      .where(and(...conditions))
      .orderBy(desc(workflowSecrets.createdAt), desc(workflowSecrets.id))
      .limit(limit + 1);
    return buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt ?? ""),
      id: row.id,
    }));
  }

  async createGlobalSecret(orgId: string, dto: CreateSecretDto) {
    const [secret] = await this.db
      .insert(workflowSecrets)
      .values({
        orgId,
        name: dto.name,
        encryptedValue: encryptSecret(dto.value),
        description: dto.description,
      })
      .returning(SECRET_COLUMNS);
    return secret;
  }

  async deleteGlobalSecret(orgId: string, secretId: string) {
    const [deleted] = await this.db
      .delete(workflowSecrets)
      .where(
        and(eq(workflowSecrets.id, secretId), eq(workflowSecrets.orgId, orgId)),
      )
      .returning({ id: workflowSecrets.id });
    if (!deleted) throw new NotFoundException("Secret not found");
  }
}
