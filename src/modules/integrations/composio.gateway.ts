import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { Composio } from "@composio/core";
import { z } from "zod";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";
import type { IntegrationToolkit } from "../../db/schema";

const connectedAccountSchema = z.object({
  id: z.string(),
  status: z.string(),
  wordId: z.string().nullable().optional(),
  toolkit: z.object({ slug: z.string() }).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

export interface ComposioConnectedAccount {
  id: string;
  status: string;
  userId: string | null;
  toolkitSlug: string | null;
  email: string | null;
}

export class ComposioToolError extends Error {
  constructor(
    message: string,
    readonly isAuthError: boolean,
  ) {
    super(message);
  }
}

function extractEmail(record: Record<string, unknown> | undefined): string | null {
  if (!record) return null;
  const candidate = record.email ?? record.userEmail ?? record.user_email;
  return typeof candidate === "string" ? candidate : null;
}

@Injectable()
export class ComposioGateway {
  private client: Composio | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.COMPOSIO_API_KEY);
  }

  authConfigIdFor(toolkit: IntegrationToolkit): string | null {
    if (toolkit === "googlecalendar") return this.config.COMPOSIO_AUTH_CONFIG_GOOGLE_CALENDAR ?? null;
    return this.config.COMPOSIO_AUTH_CONFIG_OUTLOOK ?? null;
  }

  private getClient(): Composio {
    if (!this.config.COMPOSIO_API_KEY) {
      throw new ServiceUnavailableException("Composio integration is not configured");
    }
    this.client ??= new Composio({ apiKey: this.config.COMPOSIO_API_KEY });
    return this.client;
  }

  async initiateConnection(
    userId: string,
    toolkit: IntegrationToolkit,
    callbackUrl: string,
  ): Promise<{ redirectUrl: string }> {
    const authConfigId = this.authConfigIdFor(toolkit);
    if (!authConfigId) {
      throw new ServiceUnavailableException(`Composio auth config for ${toolkit} is not configured`);
    }
    const request = await this.getClient().connectedAccounts.link(userId, authConfigId, {
      callbackUrl,
      allowMultiple: true,
    });
    if (!request.redirectUrl) {
      throw new ServiceUnavailableException("Composio did not return a redirect URL");
    }
    return { redirectUrl: request.redirectUrl };
  }

  async getConnectedAccount(connectedAccountId: string): Promise<ComposioConnectedAccount> {
    const raw: unknown = await this.getClient().connectedAccounts.get(connectedAccountId);
    const parsed = connectedAccountSchema.parse(raw);
    return {
      id: parsed.id,
      status: parsed.status,
      userId: parsed.wordId ?? null,
      toolkitSlug: parsed.toolkit?.slug ?? null,
      email: extractEmail(parsed.data) ?? extractEmail(parsed.params),
    };
  }

  async deleteConnectedAccount(connectedAccountId: string): Promise<void> {
    await this.getClient().connectedAccounts.delete(connectedAccountId);
  }

  async executeTool(
    slug: string,
    userId: string,
    args: Record<string, unknown>,
    connectedAccountId: string,
  ): Promise<unknown> {
    const result = await this.getClient().tools.execute(slug, {
      userId,
      arguments: args,
      connectedAccountId,
    });
    if (!result.successful) {
      const message = typeof result.error === "string" && result.error.length > 0 ? result.error : "Composio tool execution failed";
      const isAuthError = /auth|token|expired|unauthoriz|invalid_grant|reconnect/i.test(message);
      throw new ComposioToolError(message, isAuthError);
    }
    return result.data;
  }
}
