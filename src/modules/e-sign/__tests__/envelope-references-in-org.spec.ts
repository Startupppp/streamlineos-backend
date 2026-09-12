import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { SignEnvelopesService } from "../sign-envelopes.service";
import type { CreateEnvelopeInput } from "../dto/e-sign.schemas";
import type { RequestActorContext } from "../../../common/audit/actor-context";

const ORG = "org-refs";

/**
 * `templateId` and `watermarkPolicyId` arrive in the request body and are
 * written into columns that carry composite tenant foreign keys. Another
 * organisation's id — or none — was refused by the database, which the caller
 * saw as a 500 and which confirmed that the row exists somewhere. Read through
 * the owning services first, a missing target and an out-of-tenant one answer
 * the same 404 and nothing is written.
 */
function harness(opts: { templateFound: boolean; policyFound: boolean }) {
  const inserted: unknown[] = [];
  const db = {
    insert: () => ({
      values: (row: unknown) => ({
        returning: () => {
          inserted.push(row);
          return Promise.resolve([{ id: 1, title: "T", ...(row as object) }]);
        },
      }),
    }),
    update: () => ({ set: () => ({ where: () => ({ returning: () => Promise.resolve([{ id: 1 }]) }) }) }),
    query: {
      signEnvelopes: { findFirst: jest.fn(async () => ({ id: 1, orgId: ORG, status: "draft" })) },
    },
  } as unknown as Db;
  const templates = {
    get: jest.fn(async () => {
      if (!opts.templateFound) throw new NotFoundException("Template not found");
      return { id: 5 };
    }),
  };
  const watermarks = {
    get: jest.fn(async () => {
      if (!opts.policyFound) throw new NotFoundException("Watermark policy not found");
      return { id: 9 };
    }),
  };
  const service = new SignEnvelopesService(
    db,
    { record: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    { assertWithinLimit: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    { getOrCreate: jest.fn(async () => ({ defaultReminderFirstAfterDays: 3, defaultReminderRepeatDays: 3, defaultReminderMaxCount: 5 })) } as never,
    templates as never,
    watermarks as never,
  );
  return { service, inserted, templates, watermarks };
}

const input: CreateEnvelopeInput = {
  title: "Contract",
  routingMode: "parallel",
  ccTiming: "on_send",
  allowDecline: true,
  reminderEnabled: true,
};
const actor: RequestActorContext = { orgId: ORG, userId: "u" };

describe("an envelope's template and watermark policy are read under the caller's organisation", () => {
  it("404s a template the organisation does not have, and writes nothing", async () => {
    const { service, inserted, templates } = harness({ templateFound: false, policyFound: true });

    await expect(service.create(ORG, 1, { ...input, templateId: 5 })).rejects.toBeInstanceOf(NotFoundException);

    expect(templates.get).toHaveBeenCalledWith(ORG, 5);
    expect(inserted).toHaveLength(0);
  });

  it("404s a watermark policy the organisation does not have, and writes nothing", async () => {
    const { service, inserted, watermarks } = harness({ templateFound: true, policyFound: false });

    await expect(service.create(ORG, 1, { ...input, watermarkPolicyId: 9 })).rejects.toBeInstanceOf(NotFoundException);

    expect(watermarks.get).toHaveBeenCalledWith(ORG, 9);
    expect(inserted).toHaveLength(0);
  });

  it("writes when both resolve, and reads neither when neither is given", async () => {
    const { service, inserted, templates, watermarks } = harness({ templateFound: true, policyFound: true });

    await service.create(ORG, 1, { ...input, templateId: 5, watermarkPolicyId: 9 });
    await service.create(ORG, 1, input);

    expect(inserted).toHaveLength(2);
    expect(templates.get).toHaveBeenCalledTimes(1);
    expect(watermarks.get).toHaveBeenCalledTimes(1);
  });

  it("checks an update's ids the same way before the row is touched", async () => {
    const { service, watermarks } = harness({ templateFound: true, policyFound: false });

    await expect(
      service.update(ORG, 1, { watermarkPolicyId: 9 }, actor),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(watermarks.get).toHaveBeenCalledWith(ORG, 9);
  });
});
