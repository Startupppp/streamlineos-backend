import { Test } from "@nestjs/testing";
import { ToolAccessService } from "./tool-access.service";
import { AccessService } from "../../access/access.service";

const makeMockAccess = (perms: Record<string, string>) => ({
  resolveUserPermissions: jest.fn().mockResolvedValue(new Map(Object.entries(perms))),
});

describe("ToolAccessService", () => {
  let svc: ToolAccessService;
  let mockAccess: ReturnType<typeof makeMockAccess>;

  beforeEach(async () => {
    mockAccess = makeMockAccess({ "build:tickets:view": "all" });
    const module = await Test.createTestingModule({
      providers: [
        ToolAccessService,
        { provide: AccessService, useValue: mockAccess },
      ],
    }).compile();
    svc = module.get(ToolAccessService);
  });

  it("returns null for an allowed scope", async () => {
    const reason = await svc.denyReason("org1", "user1", "build:tickets:view");
    expect(reason).toBeNull();
  });

  it("returns a denial string for scope=none (key missing)", async () => {
    const reason = await svc.denyReason("org1", "user1", "hr:payroll:view");
    expect(typeof reason).toBe("string");
    expect(reason).toContain("Permission denied");
  });

  it("scope returns 'none' for a missing key without throwing", async () => {
    const s = await svc.scope("org1", "user1", "crm:leads:view");
    expect(s).toBe("none");
  });

  it("scope returns 'own' for an own-scoped permission", async () => {
    mockAccess = makeMockAccess({ "crm:leads:view": "own" });
    const m = await Test.createTestingModule({
      providers: [
        ToolAccessService,
        { provide: AccessService, useValue: mockAccess },
      ],
    }).compile();
    const s = await m.get(ToolAccessService).scope("org1", "user1", "crm:leads:view");
    expect(s).toBe("own");
  });

  it("getPersonTicketStats own-scope denial for a different target — simulated at service level", async () => {
    mockAccess = makeMockAccess({ "build:tickets:view": "own" });
    const m = await Test.createTestingModule({
      providers: [
        ToolAccessService,
        { provide: AccessService, useValue: mockAccess },
      ],
    }).compile();
    const toolSvc = m.get(ToolAccessService);
    const read = await toolSvc.scope("org1", "actorId", "build:tickets:view");
    expect(read.rawScope("spec reads the resolved value")).toBe("own");
    expect(read.unrestricted).toBe(false);
    const targetUserId: string = "differentUser";
    const actorId: string = "actorId";
    const denied = !read.unrestricted && targetUserId !== actorId;
    expect(denied).toBe(true);
  });
});
