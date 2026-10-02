import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, ilike, or } from "drizzle-orm";
import { gitConnections, integrationGitConnectionCredentials } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import {
  buildCursorPage,
  decodeCursor,
} from "../../../common/pagination/cursor";
import { keysetBeforeId } from "../../../common/pagination/keyset";
import {
  generateWebhookSecret,
  gitWebhookUrl,
  maskSecret,
} from "./git-connections.helpers";
import type {
  CreateGitConnectionInput,
  GitConnectionsListInput,
  UpdateGitConnectionInput,
} from "./dto/git-connections.schemas";

@Injectable()
export class GitConnectionsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listConnections(orgId: string, params: GitConnectionsListInput) {
    const limit = params.limit;
    const position = decodeCursor(params.cursor);
    const search = params.search?.trim();
    const searchCond = search
      ? or(
          ilike(gitConnections.repoUrl, `%${search}%`),
          ilike(gitConnections.repoName, `%${search}%`),
        )
      : undefined;

    const rows = await this.db
      .select({
        id: gitConnections.id,
        provider: gitConnections.provider,
        projectId: gitConnections.projectId,
        repoUrl: gitConnections.repoUrl,
        repoName: gitConnections.repoName,
        isActive: gitConnections.isActive,
        signingSecret: integrationGitConnectionCredentials.signingSecret,
        createdAt: gitConnections.createdAt,
        updatedAt: gitConnections.updatedAt,
      })
      .from(gitConnections)
      .leftJoin(
        integrationGitConnectionCredentials,
        and(
          eq(integrationGitConnectionCredentials.orgId, gitConnections.orgId),
          eq(integrationGitConnectionCredentials.gitConnectionId, gitConnections.id),
        ),
      )
      .where(
        and(
          eq(gitConnections.orgId, orgId),
          searchCond,
          position
            ? keysetBeforeId(
                gitConnections.createdAt,
                gitConnections.id,
                position,
              )
            : undefined,
        ),
      )
      .orderBy(desc(gitConnections.createdAt), desc(gitConnections.id))
      .limit(limit + 1);

    const page = buildCursorPage(rows, limit, (row) => ({
      sortValue: row.createdAt.toISOString(),
      id: String(row.id),
    }));

    return {
      data: page.data.map((row) => ({
        id: row.id,
        provider: row.provider,
        projectId: row.projectId,
        repoUrl: row.repoUrl,
        repoName: row.repoName,
        isActive: row.isActive,
        maskedSecret: row.signingSecret !== null ? maskSecret(row.signingSecret) : "••••••••••••",
        webhookUrl: gitWebhookUrl(row.id),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })),
      pagination: page.pagination,
    };
  }

  async createConnection(
    orgId: string,
    userId: string,
    input: CreateGitConnectionInput,
  ) {
    const secret = generateWebhookSecret();

    const [created] = await this.db
      .insert(gitConnections)
      .values({
        orgId,
        provider: input.provider,
        repoUrl: input.repoUrl,
        repoName: input.repoName ?? null,
        projectId: input.projectId ?? null,
        createdBy: userId,
      })
      .returning();

    const now = new Date();
    await this.db.insert(integrationGitConnectionCredentials).values({
      orgId,
      gitConnectionId: created.id,
      signingSecret: secret,
      secretSetAt: now,
    });

    return {
      id: created.id,
      provider: created.provider,
      projectId: created.projectId,
      repoUrl: created.repoUrl,
      repoName: created.repoName,
      isActive: created.isActive,
      webhookUrl: gitWebhookUrl(created.id),
      webhookSecret: secret,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    };
  }

  async updateConnection(
    orgId: string,
    connectionId: number,
    input: UpdateGitConnectionInput,
  ) {
    if (
      input.isActive === undefined &&
      input.repoUrl === undefined &&
      input.repoName === undefined &&
      input.projectId === undefined
    ) {
      throw new BadRequestException("No fields to update");
    }

    const [updated] = await this.db
      .update(gitConnections)
      .set({
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.repoUrl !== undefined ? { repoUrl: input.repoUrl } : {}),
        ...(input.repoName !== undefined ? { repoName: input.repoName } : {}),
        ...(input.projectId !== undefined
          ? { projectId: input.projectId }
          : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(gitConnections.id, connectionId),
          eq(gitConnections.orgId, orgId),
        ),
      )
      .returning();

    if (!updated) throw new NotFoundException("Connection not found");

    return {
      id: updated.id,
      provider: updated.provider,
      projectId: updated.projectId,
      repoUrl: updated.repoUrl,
      repoName: updated.repoName,
      isActive: updated.isActive,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }

  async deleteConnection(orgId: string, connectionId: number) {
    const [deleted] = await this.db
      .delete(gitConnections)
      .where(
        and(
          eq(gitConnections.id, connectionId),
          eq(gitConnections.orgId, orgId),
        ),
      )
      .returning({ id: gitConnections.id });

    if (!deleted) throw new NotFoundException("Connection not found");
    return { success: true };
  }
}
