import { Injectable } from "@nestjs/common";
import type { CalendarEventProjection, CalendarEventSource, CalendarSourceContext } from "./calendar-event-source";
import { AccessService } from "../access/access.service";
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

export const CALENDAR_PER_SOURCE_CAP = 400;

@Injectable()
export class CalendarSourceRegistry {
  private readonly sources = new Set<CalendarEventSource>();

  constructor(
    private readonly access: AccessService,
    private readonly preferences: CalendarSourcePreferencesService,
  ) {}

  register(source: CalendarEventSource): void {
    const existing = [...this.sources].find((candidate) => candidate.key === source.key);
    if (existing && existing !== source) {
      throw new Error(`Calendar source key already registered: ${source.key}`);
    }
    this.sources.add(source);
  }

  private async resolveAvailable(ctx: CalendarSourceContext): Promise<CalendarEventSource[]> {
    const sources = [...this.sources];
    return (
      await Promise.all(
        sources.map(async (s) => {
          // moduleAvailability, not isModuleEnabled: the latter takes no userId, so a
          // person denied a module still received its events.
          const availability = await this.access.moduleAvailabilityFor(
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

  async getOrgLevelSources(orgId: string): Promise<ReadonlyArray<{ key: string; label: string; module: string; moduleEnabled: boolean }>> {
    const sources = [...this.sources];
    return Promise.all(
      sources.map(async (s) => ({
        key: s.key,
        label: s.label,
        module: s.module,
        moduleEnabled: await this.access.isModuleEnabled(orgId, s.module),
      })),
    );
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
      if (result.status === "fulfilled") {
        const sourceEvents = result.value;
        events.push(
          ...(sourceEvents.length > CALENDAR_PER_SOURCE_CAP
            ? sourceEvents.slice(0, CALENDAR_PER_SOURCE_CAP)
            : sourceEvents),
        );
      } else
        failures.push({ key, error: result.reason });
    }

    return { events, toggleList, failures };
  }
}
