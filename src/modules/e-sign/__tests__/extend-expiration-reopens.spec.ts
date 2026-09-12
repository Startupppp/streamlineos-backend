import { ConflictException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { SignEnvelopesService } from "../sign-envelopes.service";
import type { RequestActorContext } from "../../../common/audit/actor-context";

const ORG = "org-extend";
const ACTOR: RequestActorContext = { orgId: ORG, userId: "u", membershipId: 7 };
const TOMORROW = new Date(Date.now() + 86_400_000).toISOString();

/**
 * The expiration sweep marks every unfinished recipient `expired` and revokes
 * their tokens. Moving `expiresAt` forward used to flip the envelope back to
 * `sent` and touch nothing else, so the reopened envelope had nobody left who
 * could sign: every session closed on the revoked token and no new link went
 * out. It also moved the expiry of completed and voided envelopes, which are
 * closed history.
 */
function harness(status: string) {
  const updates: { table: unknown; set: Record<string, unknown> }[] = [];
  const db = {
    query: {
      signEnvelopes: { findFirst: jest.fn(async () => ({ id: 1, orgId: ORG, status, title: "T" })) },
    },
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        updates.push({ table, set: values });
        const chain = { where: () => ({ returning: () => Promise.resolve([{ id: 1, status: values["status"] ?? status }]) }) };
        return { where: () => Object.assign(Promise.resolve(undefined), chain.where()) };
      },
    }),
  } as unknown as Db;
  const dispatch = { reviveExpiredRecipients: jest.fn(async () => 2) };
  const audit = { record: jest.fn() };
  const service = new SignEnvelopesService(
    db,
    audit as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    dispatch as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, updates, dispatch, audit };
}

describe("extending an envelope's expiration", () => {
  it.each(["completed", "voided", "declined"])("refuses a %s envelope with a 409 and writes nothing", async (status) => {
    const { service, updates, dispatch } = harness(status);

    await expect(service.extendExpiration(ORG, 1, { expiresAt: TOMORROW }, ACTOR)).rejects.toBeInstanceOf(ConflictException);

    expect(updates).toHaveLength(0);
    expect(dispatch.reviveExpiredRecipients).not.toHaveBeenCalled();
  });

  it("reopens an expired envelope and brings its expired recipients back with new invitations", async () => {
    const { service, updates, dispatch } = harness("expired");

    const result = await service.extendExpiration(ORG, 1, { expiresAt: TOMORROW }, ACTOR);

    expect(result.status).toBe("sent");
    expect(dispatch.reviveExpiredRecipients).toHaveBeenCalledWith(ORG, 1, new Date(TOMORROW), ACTOR);
    expect(updates.some((u) => u.set["status"] === "sent")).toBe(true);
  });

  it("moves the expiry of a live envelope without reinviting anyone", async () => {
    const { service, dispatch } = harness("partially_completed");

    const result = await service.extendExpiration(ORG, 1, { expiresAt: TOMORROW }, ACTOR);

    expect(result.status).toBe("partially_completed");
    expect(dispatch.reviveExpiredRecipients).not.toHaveBeenCalled();
  });

  it("refuses a date that is not in the future", async () => {
    const { service, updates } = harness("sent");

    await expect(
      service.extendExpiration(ORG, 1, { expiresAt: new Date(Date.now() - 1000).toISOString() }, ACTOR),
    ).rejects.toThrow(/future/);
    expect(updates).toHaveLength(0);
  });
});
