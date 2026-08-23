import { Inject, Injectable } from "@nestjs/common";
import type { CalendarEventProjection, CalendarEventSource, CalendarSourceContext } from "./calendar-event-source";
import { EntitlementsService } from "../access/entitlements.service";

export const CALENDAR_SOURCE_TOKEN: unique symbol = Symbol("CalendarEventSource");

export interface CalendarSourceOutput {
  events: CalendarEventProjection[];
  toggleList: ReadonlyArray<{ key: string; label: string; module: string }>;
  failures: ReadonlyArray<{ key: string; error: unknown }>;
}

@Injectable()
export class CalendarSourceRegistry {
  constructor(
    @Inject(CALENDAR_SOURCE_TOKEN)
    private readonly sources: CalendarEventSource[],
    private readonly entitlements: EntitlementsService,
  ) {}

  async loadAll(ctx: CalendarSourceContext): Promise<CalendarSourceOutput> {
    const toggleList = this.sources.map((s) => ({ key: s.key, label: s.label, module: s.module }));

    const available = (
      await Promise.all(
        this.sources.map(async (s) => {
          const enabled = await this.entitlements.isModuleEnabled(ctx.orgId, s.module);
          return enabled ? s : null;
        }),
      )
    ).filter((s): s is CalendarEventSource => s !== null);

    const keys = available.map((s) => s.key);
    const settled = await Promise.allSettled(available.map((s) => s.load(ctx)));

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
