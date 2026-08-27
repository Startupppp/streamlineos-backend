import { Module } from "@nestjs/common";
import { ActivitiesModule } from "../activities/activities.module";
import { AttributionModule } from "../attribution/attribution.module";
import { DealsModule } from "../deals/deals.module";
import { AgentTokenGuard } from "../agent-access/agent-token.guard";
import { CrmMcpAdminController } from "./crm-mcp-admin.controller";
import { CrmMcpController } from "./crm-mcp.controller";
import { CrmMcpEnablementService } from "./crm-mcp-enablement.service";
import { CrmMcpGrantsService } from "./crm-mcp-grants.service";
import { CrmMcpService } from "./crm-mcp.service";

/**
 * The MCP surface over the CRM, phase 6 ticket 19.
 *
 * The imports ARE the fourth criterion. Every capability reaches its data
 * through one of these three modules' exported services and through nothing
 * else — there is no `DrizzleModule` here and no schema import in the capability
 * layer, so "the protocol layer never reaches past the service boundary" is a
 * property of the module graph rather than a rule somebody has to remember at
 * review time. `capabilities-cannot-reach-the-database.spec.ts` walks that graph
 * and fails if a path to `DRIZZLE` ever appears.
 *
 * The two services that DO hold a database handle — enablement and grants — are
 * not reachable from a capability. They are the executor's collaborators, and
 * they own the two facts the platform did not already store.
 *
 * `AgentTokenGuard` is declared here rather than exported from
 * `AgentAccessModule` because that module does not export it. It is the same
 * class, so hashing, expiry, revocation, account status and membership are still
 * decided in exactly one place; only the provider instance differs, and a guard
 * with no state has nothing to differ about. Exporting it from its own module
 * would be tidier and is a change to that module.
 *
 * Not imported, deliberately: nothing from `src/modules/ai`. See
 * `ai-is-barred-from-authorization.spec.ts` — this module decides what an agent
 * may do, so it is the last place a model client belongs.
 */
@Module({
  imports: [ActivitiesModule, DealsModule, AttributionModule],
  controllers: [CrmMcpController, CrmMcpAdminController],
  providers: [CrmMcpService, CrmMcpEnablementService, CrmMcpGrantsService, AgentTokenGuard],
  exports: [CrmMcpEnablementService],
})
export class CrmMcpModule {}
