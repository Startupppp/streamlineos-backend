import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { notificationTemplates } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { CacheService } from "../../common/cache/cache.service";
import { CACHE_TTL } from "../../common/cache/cache-keys";
import { NOTIF_CACHE } from "./notification-cache-keys";
import type { NotificationChannel, NotificationEventDefinition } from "./notification.types";
import { resolveAvailableLocale } from "../../common/i18n/locale-fallback";

type RenderedTemplate = { subject: string | null; body: string };
export type TemplateMap = Map<NotificationChannel, RenderedTemplate>;
type RawTemplate = { channel: NotificationChannel; subject: string | null; body: string; locale: string };
type OrgTemplateMap = Record<string, RawTemplate[]>;

/**
 * Template loading and placeholder rendering, extracted from
 * NotificationDispatchService when that file passed the §9 500-line cap. Rendering is
 * a distinct responsibility from deciding who gets notified, and it is the half with
 * the locale (PIPE-014) and undeclared-variable (REG-007) rules in it.
 */
@Injectable()
export class NotificationTemplateRenderer {
  private readonly logger = new Logger(NotificationTemplateRenderer.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
  ) {}

  private loadOrgTemplateMap(orgId: string): Promise<OrgTemplateMap> {
    return this.cache.cached(
      NOTIF_CACHE.templates(orgId),
      async () => {
        const rows = await this.db
          .select({
            templateKey: notificationTemplates.templateKey,
            channel: notificationTemplates.channel,
            subject: notificationTemplates.subject,
            body: notificationTemplates.body,
            locale: notificationTemplates.locale,
          })
          .from(notificationTemplates)
          .where(and(eq(notificationTemplates.orgId, orgId), eq(notificationTemplates.isActive, true)));
        const map: OrgTemplateMap = {};
        for (const row of rows) {
          (map[row.templateKey] ??= []).push({
            channel: row.channel,
            subject: row.subject,
            body: row.body,
            locale: row.locale,
          });
        }
        return map;
      },
      CACHE_TTL.MEDIUM,
    );
  }

  async loadTemplates(
    orgId: string,
    definition: NotificationEventDefinition,
    variables: Record<string, unknown>,
    locale: string,
  ): Promise<TemplateMap> {
    if (!definition.templateKey) return new Map();

    const orgTemplates = await this.loadOrgTemplateMap(orgId);
    const rows = orgTemplates[definition.templateKey];
    if (!rows || rows.length === 0) return new Map();

    const stringVars: Record<string, string> = Object.fromEntries(
      Object.entries(variables).map(([k, v]) => [k, v == null ? "" : String(v)]),
    );

    const byChannel = new Map<NotificationChannel, RawTemplate[]>();
    for (const row of rows) {
      const ch = row.channel;
      const existing = byChannel.get(ch);
      if (!existing) {
        byChannel.set(ch, [row]);
      } else {
        existing.push(row);
      }
    }

    const map: TemplateMap = new Map();
    for (const [channel, channelRows] of byChannel) {
      // PIPE-014: the recipient's locale, not the actor's and not a hardcoded "en".
      // English remains the fallback because it is the only locale templates are
      // authored in today; `channelRows[0]` is the last resort.
      const resolvedLocale = resolveAvailableLocale(
        locale,
        channelRows.map((row) => row.locale),
      );
      const preferred = channelRows.find((row) => row.locale === resolvedLocale);
      if (!preferred) continue;
      const subject =
        preferred.subject != null ? this.renderPlaceholders(preferred.subject, stringVars) : null;
      const body = this.renderPlaceholders(preferred.body, stringVars);
      const missing = [...new Set([...(subject?.missing ?? []), ...body.missing])];
      if (missing.length > 0) {
        // Fall back to the catalog's static copy rather than send a template with
        // holes in it. Logged, never silent — a blank in a customer's email is the
        // failure mode this replaces.
        this.logger.error(
          `template ${definition.templateKey} (${channel}, ${locale}) references undeclared variables: ` +
            `${missing.join(", ")} — falling back to the catalog copy for ${definition.eventKey}`,
        );
        continue;
      }
      map.set(channel, { subject: subject?.text ?? null, body: body.text });
    }

    return map;
  }

  /**
   * REG-007. An unknown `{{var}}` used to render as an empty string, so a renamed or
   * misspelled variable silently produced a blank in a live email and nothing said so.
   * Missing variables are now reported to the caller, which decides whether to send a
   * half-rendered template — see `renderTemplateOrFallback`.
   */
  private renderPlaceholders(
    template: string,
    variables: Record<string, string>,
  ): { text: string; missing: string[] } {
    const missing: string[] = [];
    const text = template.replace(/\{\{([^}]+)\}\}/g, (_, raw: string) => {
      const key = raw.trim();
      const value = variables[key];
      if (value === undefined) {
        missing.push(key);
        return "";
      }
      return value;
    });
    return { text, missing };
  }

}
