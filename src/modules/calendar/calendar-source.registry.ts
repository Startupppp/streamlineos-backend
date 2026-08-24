import { Injectable } from "@nestjs/common";
import type { CalendarEventProjection, CalendarEventSource, CalendarSourceContext } from "./calendar-event-source";
import { EntitlementsService } from "../access/entitlements.service";
import { AccessService } from "../access/access.service";
import {
  moduleAvailability,
  moduleAvailabilityResolver,
} from "../../common/rbac/module-availability";

export interface CalendarSourceOutput {
  events: CalendarEventProjection[];
  toggleList: ReadonlyArray<{ key: string; label: string; module: string }>;
  failures: ReadonlyArray<{ key: string; error: unknown }>;
}

@Injectable()
export class CalendarSourceRegistry {
  private readonly sources = new Set<CalendarEventSource>();

  constructor(
    private readonly entitlements: EntitlementsService,
    private readonly access: AccessService,
  ) {}

  register(source: CalendarEventSource): void {
    this.sources.add(source);
  }

  async loadAll(ctx: CalendarSourceContext): Promise<CalendarSourceOutput> {
    const sources = [...this.sources];
    const toggleList = sources.map((s) => ({ key: s.key, label: s.label, module: s.module }));

    const available = (
      await Promise.all(
        sources.map(async (s) => {
          // moduleAvailability, not isModuleEnabled: the latter takes no userId, so a
          // person denied a module still received its events.
          const availability = await moduleAvailability(
            moduleAvailabilityResolver(this.entitlements, this.access),
            ctx.orgId,
            ctx.userId,
            s.module,
          );
          return availability.available ? s : null;
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
