import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { workflows, workflowSecrets } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CreateSecretDto } from "./dto/workflow.schemas";
import { encryptSecret } from "../../common/security/secret-encryption.util";

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

  async listSecrets(orgId: string, workflowId: string) {
    const workflow = await this.db.query.workflows.findFirst({
      where: and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)),
      columns: { id: true },
    });
    if (!workflow) throw new NotFoundException("Workflow not found");

    return this.db
      .select(SECRET_COLUMNS)
      .from(workflowSecrets)
      .where(eq(workflowSecrets.orgId, orgId));
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

    const existing = await this.db.query.workflowSecrets.findFirst({
      where: and(
        eq(workflowSecrets.id, secretId),
        eq(workflowSecrets.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Secret not found");

    await this.db
      .delete(workflowSecrets)
      .where(eq(workflowSecrets.id, secretId));
  }

  listGlobalSecrets(orgId: string) {
    return this.db
      .select({
        id: workflowSecrets.id,
        name: workflowSecrets.name,
        description: workflowSecrets.description,
        createdAt: workflowSecrets.createdAt,
        updatedAt: workflowSecrets.updatedAt,
      })
      .from(workflowSecrets)
      .where(eq(workflowSecrets.orgId, orgId))
      .orderBy(desc(workflowSecrets.createdAt));
  }

  async createGlobalSecret(orgId: string, dto: CreateSecretDto) {
    const [secret] = await this.db
      .insert(workflowSecrets)
      .values({
        orgId,
        name: dto.name,
        encryptedValue: dto.value,
        description: dto.description,
      })
      .returning({
        id: workflowSecrets.id,
        name: workflowSecrets.name,
        description: workflowSecrets.description,
        createdAt: workflowSecrets.createdAt,
        updatedAt: workflowSecrets.updatedAt,
      });
    return secret;
  }

  async deleteGlobalSecret(orgId: string, secretId: string) {
    const existing = await this.db.query.workflowSecrets.findFirst({
      where: and(
        eq(workflowSecrets.id, secretId),
        eq(workflowSecrets.orgId, orgId),
      ),
      columns: { id: true },
    });
    if (!existing) throw new NotFoundException("Secret not found");
    await this.db
      .delete(workflowSecrets)
      .where(eq(workflowSecrets.id, secretId));
  }
}
