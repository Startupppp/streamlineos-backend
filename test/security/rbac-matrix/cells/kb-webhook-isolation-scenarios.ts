import { getTableName, type Table } from "drizzle-orm";
import { kbPages, kbSpaces } from "src/db/schema";
import {
  integrationWebhookDeliveries,
  integrationWebhookEndpointCredentials,
} from "src/db/schema/integrations/webhook-delivery";
import type { OutboxEventRow } from "src/common/outbox/outbox-consumer.registry";
import { KbContentGapService } from "src/modules/kb/help-centre/kb-content-gap.service";
import { gapCreateFixBodySchema } from "src/modules/kb/help-centre/dto/kb-analytics.schemas";
import type { KnowledgeAuthorizationService } from "src/modules/kb/core/authorization/knowledge-authorization.service";
import {
  MISSING_SIGNING_SECRET_ERROR,
  WebhookDeliveryService,
} from "src/modules/integrations/core/webhook-delivery.service";
import type { Observation, Scenario } from "../matrix.types";
import { ORG_A, ORG_B, actorFor } from "../standings";
import { standIn, type Row, type WorldDb } from "../world-db";
import { TENANT_ONLY, boundBy, markOf, pair, reached, standingWorld, victimOf } from "./isolation-kit";

const SPACE_A = 8101;
const DELIVERY_A = 8201;
const FOREIGN_CREDENTIAL = 8301;
const DELIVERIES = getTableName(integrationWebhookDeliveries);
const PAGES = getTableName(kbPages);

function rows(): Map<Table, Row[]> {
  return new Map<Table, Row[]>([
    [kbSpaces, [{ id: SPACE_A, orgId: ORG_A, deletedAt: null }]],
    [
      integrationWebhookDeliveries,
      [
        {
          id: DELIVERY_A,
          orgId: ORG_A,
          event: "ticket.created",
          payload: { ticketId: 1 },
          status: "pending",
          credentialId: FOREIGN_CREDENTIAL,
          targetUrl: "https://hooks.invalid/a",
          attempts: 0,
          lastError: null,
        },
      ],
    ],
    [integrationWebhookEndpointCredentials, [{ id: FOREIGN_CREDENTIAL, orgId: ORG_B, signingSecret: "secret-of-org-b" }]],
  ]);
}

function rowOf(world: WorldDb, table: Table, id: number): Row | undefined {
  return (world.rows.get(table) ?? []).find((row) => row.id === id);
}

function insertedPages(world: WorldDb, writeMark: number): Row[] {
  return world.writes
    .slice(writeMark)
    .filter((write) => write.table === PAGES && write.verb === "insert")
    .flatMap((write) => {
      const values = write.values;
      return typeof values === "object" && values !== null && !Array.isArray(values) ? [{ ...values }] : [];
    });
}

function contentGapFix(): Scenario[] {
  const body = gapCreateFixBodySchema.parse({ query: "reset my password" });
  const run = (callerOrg: string) => async (): Promise<Observation> => {
    const world = standingWorld(rows());
    const service = new KbContentGapService(world.db, standIn<KnowledgeAuthorizationService>({}));
    const mark = markOf(world);
    return reached(
      () => service.createFix(actorFor("org:admin", callerOrg), body),
      () => insertedPages(world, mark.writes).some((page) => page.spaceId === SPACE_A),
      () => {
        const bound = boundBy(world, mark, getTableName(kbSpaces));
        const pages = insertedPages(world, mark.writes);
        return {
          defaultSpaceReadBindsCallerOrg: bound.includes(callerOrg),
          defaultSpaceReadNeverBindsVictimOrg: !bound.includes(victimOf(callerOrg)),
          draftPageCarriesCallerOrg: pages.length === 1 && pages.every((page) => page.orgId === callerOrg),
          noForeignSpaceAdopted: callerOrg === ORG_A || pages.every((page) => page.spaceId === null),
        };
      },
    );
  };
  const entry = "KbContentGapService.createFix(actor) <- POST /kb/analytics/gaps/fix";
  return pair(
    { actor: "org:admin", state: "normal", resource: "kb:content-gap", action: "create-fix" },
    "kb-content-gap-create-fix",
    {
      because: "a draft fix with no space named lands in the caller's own first live space",
      bindings: [{ adapter: "service", entry, run: run(ORG_A) }],
    },
    {
      because: "the default space is resolved under the caller's org, so another organisation's space is never adopted and the draft is filed without one",
      bindings: [{ adapter: "service", entry, run: run(ORG_B) }],
    },
  );
}

function webhookDelivery(): Scenario[] {
  const run = (callerOrg: string) => async (): Promise<Observation> => {
    const world = standingWorld(rows());
    const service = new WebhookDeliveryService(world.db);
    const event = standIn<OutboxEventRow>({ organizationId: callerOrg, payload: { deliveryId: DELIVERY_A } });
    const mark = markOf(world);
    const updates = (): number =>
      world.writes.slice(mark.writes).filter((write) => write.table === DELIVERIES && write.verb === "update").length;
    return reached(
      () => service.handle(event),
      () => updates() === 1,
      () => {
        const bound = boundBy(world, mark, DELIVERIES);
        const delivery = rowOf(world, integrationWebhookDeliveries, DELIVERY_A);
        return {
          deliveryStatementsBindCallerOrgAndId: bound.includes(callerOrg) && bound.includes(DELIVERY_A),
          deliveryStatementsNeverBindVictimOrg: !bound.includes(victimOf(callerOrg)),
          foreignCredentialSecretNeverJoined: callerOrg !== ORG_A || delivery?.lastError === MISSING_SIGNING_SECRET_ERROR,
          foreignDeliveryUntouched: callerOrg === ORG_A || (updates() === 0 && delivery?.status === "pending"),
        };
      },
    );
  };
  const entry = "WebhookDeliveryService.handle(event) <- integrations.webhook.delivery.requested outbox consumer";
  return pair(
    { ...TENANT_ONLY, resource: "integrations:webhook-delivery", action: "deliver" },
    "integrations-webhook-delivery",
    {
      because: "an event in the delivery's own organisation loads it, refuses to sign with another organisation's credential, and records the outcome",
      bindings: [{ adapter: "service", entry, run: run(ORG_A) }],
    },
    {
      because: "the delivery is loaded under the event's org, so an event in another organisation naming this delivery id finds nothing and never sends or rewrites it",
      bindings: [{ adapter: "service", entry, run: run(ORG_B) }],
    },
  );
}

export function kbWebhookIsolationScenarios(): Scenario[] {
  return [...contentGapFix(), ...webhookDelivery()];
}
