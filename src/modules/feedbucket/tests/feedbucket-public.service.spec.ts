import { FeedbucketPublicService } from "../feedbucket-public.service";
import type { Db } from "../../../db/drizzle.module";

function makeDb(widgetRow: unknown): Db {
  return {
    query: {
      feedbucketWidgets: {
        findFirst: jest.fn().mockResolvedValue(widgetRow),
      },
    },
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 42 }]),
      }),
    }),
  } as unknown as Db;
}

const activeWidget = {
  id: 1,
  orgId: "org_1",
  name: "Test Widget",
  publicKey: "fb_valid_key",
  projectId: 10,
  managedProductId: null,
  allowedDomains: [],
  autoCreateTicket: false,
  aiAssistEnabled: false,
  defaultTicketType: "BUG",
  isActive: true,
  theme: null,
  createdBy: "user_1",
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
};

describe("FeedbucketPublicService", () => {
  describe("resolveWidget", () => {
    it("returns null when no widget found", async () => {
      const db = makeDb(undefined);
      const service = new FeedbucketPublicService(db);
      const result = await service.resolveWidget("bad_key");
      expect(result).toBeNull();
    });

    it("returns the widget when found and active", async () => {
      const db = makeDb(activeWidget);
      const service = new FeedbucketPublicService(db);
      const result = await service.resolveWidget("fb_valid_key");
      expect(result).toEqual(activeWidget);
    });
  });

  describe("createSubmission", () => {
    it("inserts and returns the new submission id", async () => {
      const db = makeDb(activeWidget);
      const service = new FeedbucketPublicService(db);

      const id = await service.createSubmission(activeWidget, {
        type: "bug",
        message: "Something broke",
      });

      expect(id).toBe(42);
    });

    it("stores screenshotUrl when provided", async () => {
      const db = makeDb(activeWidget);
      const insertValuesMock = jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 99 }]),
      });
      (db.insert as jest.Mock).mockReturnValue({ values: insertValuesMock });

      const service = new FeedbucketPublicService(db);
      await service.createSubmission(activeWidget, { type: "idea", message: "A cool idea" }, "https://cdn.example.com/screenshot.png");

      expect(insertValuesMock).toHaveBeenCalledWith(
        expect.objectContaining({ screenshotUrl: "https://cdn.example.com/screenshot.png" }),
      );
    });
  });
});

describe("Feedbucket public gate chain", () => {
  it("resolveWidget returns null for inactive widget", async () => {
    const inactiveWidget = { ...activeWidget, isActive: false };
    const db = makeDb(inactiveWidget);
    (db.query.feedbucketWidgets.findFirst as jest.Mock).mockResolvedValue(undefined);
    const service = new FeedbucketPublicService(db);
    const result = await service.resolveWidget("fb_valid_key");
    expect(result).toBeNull();
  });

  it("resolveWidget returns null for deleted widget", async () => {
    const db = makeDb(undefined);
    const service = new FeedbucketPublicService(db);
    const result = await service.resolveWidget("fb_deleted_key");
    expect(result).toBeNull();
  });
});
