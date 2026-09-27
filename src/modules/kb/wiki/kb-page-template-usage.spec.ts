import { KbPagesService } from "./kb-pages.service";
import { KbPageWriterService } from "./kb-page-writer.service";
import type { Db } from "../../../db/drizzle.module";

jest.mock("../../build/core/project-crud/project-access", () => ({
  resolveProjectAccess: jest.fn(),
}));

const ORG_ID = "org-1";
const TEMPLATE_ID = 55;

function makeUser() {
  return {
    orgId: ORG_ID,
    userId: "user-1",
    isOrgOwner: false,
    principal: { kind: "human-session", membershipId: 1 },
  } as never;
}

const notifications = {} as never;
const planLimits = {
  assertWithinLimit: jest.fn().mockResolvedValue(undefined),
} as never;
const auth = {} as never;
const access = {} as never;

interface TemplateUsageDb {
  db: Db;
  update: jest.Mock;
  set: jest.Mock;
  where: jest.Mock;
}

function makeDb(template: { content: unknown } | undefined): TemplateUsageDb {
  const where = jest.fn().mockResolvedValue(undefined);
  const set = jest.fn().mockReturnValue({ where });
  const update = jest.fn().mockReturnValue({ set });

  const insert = jest.fn().mockReturnValue({
    values: jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: 100, orgId: ORG_ID }]),
    }),
  });

  const siblingSelectChain = {
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        orderBy: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
  };

  const db: Record<string, unknown> = {
    query: {
      kbPageTemplates: { findFirst: jest.fn().mockResolvedValue(template) },
      kbPages: { findFirst: jest.fn().mockResolvedValue(undefined) },
      kbSpaces: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
    select: jest.fn().mockReturnValue(siblingSelectChain),
    insert,
    update,
  };
  db["transaction"] = jest.fn(async (fn: (tx: unknown) => unknown) => fn(db));

  return { db: db as unknown as Db, update, set, where };
}

describe("KbPagesService.create — saved template usage stamp", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("increments useCount and sets lastUsedAt on the template the page was created from", async () => {
    const { db, update, set } = makeDb({ content: { type: "doc" } });
    const svc = new KbPagesService(
      db,
      planLimits,
      auth,
      access,
      {} as never,
      new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined), log: jest.fn() } as never),
    );

    await svc.create(makeUser(), { templateId: TEMPLATE_ID });

    expect(update).toHaveBeenCalledTimes(1);
    const patch = set.mock.calls[0]?.[0] as {
      useCount: unknown;
      lastUsedAt: unknown;
    };
    expect(patch).toBeDefined();
    expect(patch.useCount).toBeDefined();
    expect(patch.lastUsedAt).toBeInstanceOf(Date);
  });

  it("stamps usage only after the page insert succeeds, so a failed create records no use", async () => {
    const { db, update } = makeDb({ content: { type: "doc" } });
    (db as unknown as { insert: jest.Mock }).insert = jest
      .fn()
      .mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([]),
        }),
      });
    const svc = new KbPagesService(
      db,
      planLimits,
      auth,
      access,
      {} as never,
      new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined), log: jest.fn() } as never),
    );

    await expect(
      svc.create(makeUser(), { templateId: TEMPLATE_ID }),
    ).rejects.toThrow();

    expect(update).not.toHaveBeenCalled();
  });

  it("records no usage when the page was created without a template", async () => {
    const { db, update } = makeDb(undefined);
    const svc = new KbPagesService(
      db,
      planLimits,
      auth,
      access,
      {} as never,
      new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined), log: jest.fn() } as never),
    );

    await svc.create(makeUser(), { title: "Blank page" });

    expect(update).not.toHaveBeenCalled();
  });

  it("records no usage when the templateId does not resolve inside this organization", async () => {
    const { db, update } = makeDb(undefined);
    const svc = new KbPagesService(
      db,
      planLimits,
      auth,
      access,
      {} as never,
      new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined), log: jest.fn() } as never),
    );

    await svc.create(makeUser(), { templateId: TEMPLATE_ID });

    expect(update).not.toHaveBeenCalled();
  });
});
