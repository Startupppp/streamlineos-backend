import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { resolvePoolConfig } from "../../db/pool.config";
import * as schema from "../../db/schema";
import { organizations } from "../../db/schema";
import { runOutsideTenantContext } from "../tenant/tenant-context";
import { resolveRegionTopology, type RegionTopology } from "./region.config";
import {
  RegionRegistry,
  setRegionRegistry,
  type OrgRegionLookup,
  type RegionBinding,
} from "./region-registry";

export const REGION_TOPOLOGY = "REGION_TOPOLOGY";
export const REGION_REGISTRY = "REGION_REGISTRY";

interface SecondaryClient {
  key: string;
  end: (options: { timeout: number }) => Promise<void>;
}

const secondaryClients: SecondaryClient[] = [];

/**
 * Reads an organisation's placement from the control plane.
 *
 * Deliberately outside any ambient tenant transaction: this runs *before* one is
 * opened, and letting the proxy route it into a caller's transaction would tie
 * the control-plane read to a tenant's connection — which is the wrong database
 * the moment a second region exists.
 */
function orgRegionLookup(primaryDb: Db): OrgRegionLookup {
  return async (orgId: string) =>
    runOutsideTenantContext(async () => {
      const rows = await primaryDb
        .select({ region: organizations.region })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .limit(1);

      return rows[0]?.region ?? null;
    });
}

function buildRegistry(topology: RegionTopology, primaryDb: Db): RegionRegistry {
  const logger = new Logger("Region");
  const bindings = new Map<string, RegionBinding>();
  const poolOptions = resolvePoolConfig(process.env).options;

  for (const definition of Object.values(topology.regions)) {
    if (definition.key === topology.primary) {
      // Reuses the connection DrizzleModule already owns, so a single-region
      // deployment opens exactly the pool it opens today.
      bindings.set(definition.key, { definition, db: primaryDb });
      continue;
    }

    const client = postgres(definition.databaseUrl, poolOptions);
    secondaryClients.push({ key: definition.key, end: (options) => client.end(options) });
    bindings.set(definition.key, {
      definition,
      db: drizzle(client, { schema }) as unknown as Db,
    });
  }

  logger.log(
    `Regions ready — ${Object.keys(topology.regions).join(", ")} (primary: ${topology.primary})`,
  );

  return new RegionRegistry(topology, bindings, orgRegionLookup(primaryDb));
}

@Global()
@Module({
  providers: [
    {
      provide: REGION_TOPOLOGY,
      useFactory: (): RegionTopology => resolveRegionTopology(process.env),
    },
    {
      provide: REGION_REGISTRY,
      inject: [REGION_TOPOLOGY, DRIZZLE],
      useFactory: (topology: RegionTopology, primaryDb: Db): RegionRegistry => {
        const registry = buildRegistry(topology, primaryDb);
        // Set here rather than in a lifecycle hook: `withTenant` is a plain
        // function and may be reached by a cron sweep the moment the app boots.
        setRegionRegistry(registry);
        return registry;
      },
    },
  ],
  exports: [REGION_REGISTRY, REGION_TOPOLOGY],
})
export class RegionModule implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger("Region");

  constructor(@Inject(REGION_REGISTRY) private readonly registry: RegionRegistry) {}

  /**
   * Refuses to serve traffic with placement silently unenforced, for the same
   * reason DrizzleModule refuses to serve it with RLS inert: the failure is
   * invisible otherwise.
   */
  onApplicationBootstrap(): void {
    if (this.registry.keys.length === 0)
      throw new Error("[region] no regions configured; refusing to start");

    if (this.registry.keys.length === 1) {
      this.logger.log(
        `Single region "${this.registry.primary}" — placement is resolved on every ` +
          `tenant transaction, so a second region is configuration rather than a refactor`,
      );
    }
  }

  async onApplicationShutdown(): Promise<void> {
    // The primary is owned and drained by DrizzleModule.
    await Promise.all(
      secondaryClients.splice(0).map(async (client) => {
        this.logger.log(`Draining region "${client.key}"`);
        await client.end({ timeout: 5 });
      }),
    );
  }
}
