import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { Composio } from "@composio/core";
import { z } from "zod";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";
import type { IntegrationToolkit } from "../../db/schema";

const connectedAccountSchema = z.object({
  id: z.string(),
  status: z.string(),
  toolkit: z.object({ slug: z.string() }).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const connectedAccountListSchema = z.object({
  items: z.array(z.object({ id: z.string() })),
  nextCursor: z.string().nullable().optional(),
});

const toolkitVersionsSchema = z.object({
  meta: z.object({ availableVersions: z.array(z.string()) }),
});

const googleCalendarInfoSchema = z.object({
  calendar_data: z.object({ id: z.string().optional() }).optional(),
});

const gmailProfileSchema = z.object({
  emailAddress: z.string().optional(),
});

const outlookProfileSchema = z.object({
  mail: z.string().optional(),
  userPrincipalName: z.string().optional(),
});

function unwrapResponseData(value: unknown): unknown {
  if (value !== null && typeof value === "object" && "response_data" in value) {
    return (value as Record<string, unknown>).response_data;
  }
  return value;
}

export interface ComposioConnectedAccount {
  id: string;
  status: string;
  userId: string;
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
  private readonly toolkitVersionCache = new Map<string, Promise<string>>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.COMPOSIO_API_KEY);
  }

  authConfigIdFor(toolkit: IntegrationToolkit): string | null {
    if (toolkit === "googlecalendar") return this.config.COMPOSIO_AUTH_CONFIG_GOOGLE_CALENDAR ?? null;
    if (toolkit === "gmail") return this.config.COMPOSIO_AUTH_CONFIG_GMAIL ?? null;
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

  async getOwnedConnectedAccount(
    userId: string,
    connectedAccountId: string,
  ): Promise<ComposioConnectedAccount | null> {
    const client = this.getClient();
    if (!(await this.userOwnsConnectedAccount(userId, connectedAccountId))) {
      return null;
    }
    const raw: unknown = await client.connectedAccounts.get(connectedAccountId);
    const parsed = connectedAccountSchema.parse(raw);
    return {
      id: parsed.id,
      status: parsed.status,
      userId,
      toolkitSlug: parsed.toolkit?.slug ?? null,
      email: extractEmail(parsed.data) ?? extractEmail(parsed.params),
    };
  }

  private async userOwnsConnectedAccount(
    userId: string,
    connectedAccountId: string,
  ): Promise<boolean> {
    const client = this.getClient();
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const raw: unknown = await client.connectedAccounts.list({
        userIds: [userId],
        ...(cursor ? { cursor } : {}),
      });
      const parsed = connectedAccountListSchema.parse(raw);
      if (parsed.items.some((item) => item.id === connectedAccountId)) return true;
      if (!parsed.nextCursor) return false;
      cursor = parsed.nextCursor;
    }
    return false;
  }

  async deleteConnectedAccount(connectedAccountId: string): Promise<void> {
    await this.getClient().connectedAccounts.delete(connectedAccountId);
  }

  private resolveToolkitVersion(toolkitSlug: string): Promise<string> {
    const cached = this.toolkitVersionCache.get(toolkitSlug);
    if (cached) return cached;
    const promise = this.fetchLatestToolkitVersion(toolkitSlug);
    this.toolkitVersionCache.set(toolkitSlug, promise);
    promise.catch(() => this.toolkitVersionCache.delete(toolkitSlug));
    return promise;
  }

  private async fetchLatestToolkitVersion(toolkitSlug: string): Promise<string> {
    const raw: unknown = await this.getClient().toolkits.get(toolkitSlug);
    const parsed = toolkitVersionsSchema.parse(raw);
    const version = [...parsed.meta.availableVersions].sort((a, b) => b.localeCompare(a))[0];
    if (!version) {
      throw new ServiceUnavailableException(`No published toolkit versions for ${toolkitSlug}`);
    }
    return version;
  }

  async getAccountEmail(
    userId: string,
    connectedAccountId: string,
    toolkit: IntegrationToolkit,
  ): Promise<string | null> {
    try {
      if (toolkit === "googlecalendar") {
        const raw = await this.executeTool(
          "GOOGLECALENDAR_GET_CALENDAR",
          userId,
          {},
          connectedAccountId,
        );
        const parsed = googleCalendarInfoSchema.safeParse(unwrapResponseData(raw));
        const id = parsed.success ? parsed.data.calendar_data?.id : undefined;
        return id && id.includes("@") ? id : null;
      }
      if (toolkit === "gmail") {
        const raw = await this.executeTool(
          "GMAIL_GET_PROFILE",
          userId,
          { user_id: "me" },
          connectedAccountId,
        );
        const parsed = gmailProfileSchema.safeParse(unwrapResponseData(raw));
        return parsed.success ? (parsed.data.emailAddress ?? null) : null;
      }
      if (toolkit === "outlook") {
        const raw = await this.executeTool(
          "OUTLOOK_OUTLOOK_GET_PROFILE",
          userId,
          { user_id: "me" },
          connectedAccountId,
        );
        const parsed = outlookProfileSchema.safeParse(unwrapResponseData(raw));
        if (!parsed.success) return null;
        return parsed.data.mail ?? parsed.data.userPrincipalName ?? null;
      }
      return null;
    } catch {
      return null;
    }
  }

  async executeProxy(
    connectedAccountId: string,
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
    endpoint: string,
    body?: unknown,
  ): Promise<unknown> {
    const client = this.getClient();
    const result = await client.tools.proxyExecute({
      connectedAccountId,
      method,
      endpoint,
      ...(body !== undefined ? { body } : {}),
    });
    if (result.status >= 400) {
      const data: unknown = result.data;
      let message = `Proxy request failed with status ${result.status}`;
      if (typeof data === "object" && data !== null && "error" in data) {
        message = String(data.error);
      }
      const isAuthError = /auth|token|expired|unauthoriz|invalid_grant|reconnect/i.test(message) || result.status === 401;
      throw new ComposioToolError(message, isAuthError);
    }
    return result.data;
  }

  async executeTool(
    slug: string,
    userId: string,
    args: Record<string, unknown>,
    connectedAccountId: string,
  ): Promise<unknown> {
    const toolkitSlug = slug.split("_")[0]?.toLowerCase() ?? "";
    const version = await this.resolveToolkitVersion(toolkitSlug);
    const result = await this.getClient().tools.execute(slug, {
      userId,
      arguments: args,
      connectedAccountId,
      version,
    });
    if (!result.successful) {
      const message = typeof result.error === "string" && result.error.length > 0 ? result.error : "Composio tool execution failed";
      const isAuthError = /auth|token|expired|unauthoriz|invalid_grant|reconnect/i.test(message);
      throw new ComposioToolError(message, isAuthError);
    }
    return result.data;
  }
}
