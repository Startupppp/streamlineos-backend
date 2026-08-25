import { Injectable } from "@nestjs/common";
import type { CalendarEventProjection, CalendarEventSource, CalendarSourceContext } from "./calendar-event-source";
import { EntitlementsService } from "../access/entitlements.service";
import { AccessService } from "../access/access.service";
import {
  moduleAvailability,
} from "../../common/rbac/module-availability";
import { CalendarSourcePreferencesService } from "./calendar-source-preferences.service";

export interface ToggleEntry {
  key: string;
  label: string;
  module: string;
  enabled: boolean;
}

export interface CalendarSourceOutput {
  events: CalendarEventProjection[];
  toggleList: ReadonlyArray<ToggleEntry>;
  failures: ReadonlyArray<{ key: string; error: unknown }>;
}

@Injectable()
export class CalendarSourceRegistry {
  private readonly sources = new Set<CalendarEventSource>();

  constructor(
    private readonly entitlements: EntitlementsService,
    private readonly access: AccessService,
    private readonly preferences: CalendarSourcePreferencesService,
  ) {}

  register(source: CalendarEventSource): void {
    this.sources.add(source);
  }

  private async resolveAvailable(ctx: CalendarSourceContext): Promise<CalendarEventSource[]> {
    const sources = [...this.sources];
    return (
      await Promise.all(
        sources.map(async (s) => {
          // moduleAvailability, not isModuleEnabled: the latter takes no userId, so a
          // person denied a module still received its events.
          const availability = await moduleAvailability(
            this.access.buildModuleAvailabilityResolver(
              (orgId) => this.entitlements.getModuleMap(orgId),
            ),
            ctx.orgId,
            ctx.userId,
            s.module,
          );
          return availability.available ? s : null;
        }),
      )
    ).filter((s): s is CalendarEventSource => s !== null);
  }

  async getToggleList(ctx: CalendarSourceContext): Promise<ReadonlyArray<ToggleEntry>> {
    const available = await this.resolveAvailable(ctx);
    const disabledKeys = await this.preferences.getDisabledKeys(ctx.orgId, ctx.userId);
    return available.map((s) => ({
      key: s.key,
      label: s.label,
      module: s.module,
      enabled: !disabledKeys.has(s.key),
    }));
  }

  async loadAll(ctx: CalendarSourceContext): Promise<CalendarSourceOutput> {
    const available = await this.resolveAvailable(ctx);

    const disabledKeys = await this.preferences.getDisabledKeys(ctx.orgId, ctx.userId);

    const toggleList: ToggleEntry[] = available.map((s) => ({
      key: s.key,
      label: s.label,
      module: s.module,
      enabled: !disabledKeys.has(s.key),
    }));

    const enabledSources = available.filter((s) => !disabledKeys.has(s.key));
    const keys = enabledSources.map((s) => s.key);
    const settled = await Promise.allSettled(enabledSources.map((s) => s.load(ctx)));

    const events: CalendarEventProjection[] = [];
    const failures: Array<{ key: string; error: unknown }> = [];

    for (const [i, result] of settled.entries()) {
      const key = keys[i];
      if (!key) continue;
      if (result.status === "fulfilled")
        events.push(...result.value);
      else
        failures.push({ key, error: result.reason });
    }

    return { events, toggleList, failures };
  }
}
