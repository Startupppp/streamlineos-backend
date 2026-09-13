import { NotFoundException } from "@nestjs/common";
import { type Db } from "../../db/drizzle.module";
import { SignEnvelopeLifecycleService } from "./sign-envelope-lifecycle.service";
import { SignAuditService } from "./sign-audit.service";
import { SignRecipientsService } from "./sign-recipients.service";
import { SignNotificationsService } from "./sign-notifications.service";
import { SignIntegrationsService } from "./sign-integrations.service";
import { SignEnvelopeDispatchService } from "./sign-envelope-dispatch.service";
import type { VoidEnvelopeInput } from "./dto/e-sign.schemas";
import type { RequestActorContext } from "../../common/audit/actor-context";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((i) => sqlValues(i, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const r = value as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

const VOID_INPUT: VoidEnvelopeInput = { reason: "test void" };
const ACTOR: RequestActorContext = { orgId: ATTACKER_ORG, userId: "user-x", membershipId: 1 };

function makeService(findFirstResult: unknown) {
  const findFirst = jest.fn().mockResolvedValue(findFirstResult);
  const db = {
    query: { signEnvelopes: { findFirst } },
  } as unknown as Db;
  const svc = new SignEnvelopeLifecycleService(
    db,
    {} as unknown as SignAuditService,
    {} as unknown as SignRecipientsService,
    {} as unknown as SignNotificationsService,
    {} as unknown as SignIntegrationsService,
    {} as unknown as SignEnvelopeDispatchService,
  );
  return { svc, findFirst };
}

describe("SignEnvelopeLifecycleService — cross-tenant isolation", () => {
  it("voidEnvelope throws NotFoundException for a foreign-org envelopeId (cross-tenant isolation)", async () => {
    const { svc, findFirst } = makeService(null);

    await expect(svc.voidEnvelope(ATTACKER_ORG, 999, VOID_INPUT, ACTOR)).rejects.toThrow(NotFoundException);

    expect(findFirst).toHaveBeenCalled();
    const whereArg = (findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined)?.where;
    expect(sqlValues(whereArg)).toContain(ATTACKER_ORG);
  });

  it("mustGet includes orgId in the envelope lookup predicate (predicate-presence assertion)", async () => {
    const { svc, findFirst } = makeService(null);

    await expect(svc.voidEnvelope(OWNER_ORG, 1, VOID_INPUT, { ...ACTOR, orgId: OWNER_ORG })).rejects.toThrow(NotFoundException);

    const whereArg = (findFirst.mock.calls[0]?.[0] as { where?: unknown } | undefined)?.where;
    const vals = sqlValues(whereArg);
    expect(vals).toContain(OWNER_ORG);
    expect(vals).not.toContain(ATTACKER_ORG);
  });
});
