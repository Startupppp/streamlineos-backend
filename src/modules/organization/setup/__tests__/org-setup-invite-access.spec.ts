import { setupSchema, MAX_SETUP_INVITATION_BATCHES } from "../dto/org.schemas";
import { orgSetupCompletedPayloadSchema } from "../dto/org-setup-completed-payload.schema";

const setupInput = {
  fullName: "Asha Rao",
  companyName: "Acme",
  industry: "IT Services",
  companySize: "1-10",
  enabledModules: ["build", "crm", "hr"],
};

const completedPayload = {
  orgId: "org-1",
  userId: "user-1",
  moduleKeys: ["build", "crm", "hr"],
  sessionAction: "complete",
  skipReason: null,
  sendWelcome: true,
  industry: "IT Services",
};

describe("organization setup invitation access boundary", () => {
  it("accepts a selected Build grant and an explicit no-grant Member invite", () => {
    const result = setupSchema.safeParse({
      ...setupInput,
      invitees: [
        { email: "builder@acme.test", role: "MEMBER", moduleAccess: [{ moduleKey: "build", standing: "MEMBER" }] },
        { email: "later@acme.test", role: "MEMBER", moduleAccess: [] },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects OWNER at request time before the setup stamp is claimed", () => {
    expect(setupSchema.safeParse({
      ...setupInput,
      invitees: [{ email: "owner@acme.test", role: "OWNER" }],
    }).success).toBe(false);
    expect(setupSchema.safeParse({
      ...setupInput,
      invitees: [{ email: "admin@acme.test", role: "ORG_ADMIN" }],
    }).success).toBe(true);
  });

  it("rejects a grant for an unselected module and duplicate grants", () => {
    expect(setupSchema.safeParse({
      ...setupInput,
      enabledModules: ["build"],
      invitees: [{ email: "a@acme.test", moduleAccess: [{ moduleKey: "hr", standing: "MEMBER" }] }],
    }).success).toBe(false);
    expect(setupSchema.safeParse({
      ...setupInput,
      invitees: [{
        email: "a@acme.test",
        moduleAccess: [
          { moduleKey: "build", standing: "MEMBER" },
          { moduleKey: "build", standing: "ADMIN" },
        ],
      }],
    }).success).toBe(false);
  });

  it("bounds distinct role and grant batches without dropping invitees", () => {
    const combinations = [
      [],
      [{ moduleKey: "build", standing: "MEMBER" }],
      [{ moduleKey: "crm", standing: "MEMBER" }],
      [{ moduleKey: "hr", standing: "MEMBER" }],
      [{ moduleKey: "build", standing: "ADMIN" }],
      [{ moduleKey: "crm", standing: "ADMIN" }],
      [{ moduleKey: "hr", standing: "ADMIN" }],
      [{ moduleKey: "build", standing: "MEMBER" }, { moduleKey: "crm", standing: "MEMBER" }],
      [{ moduleKey: "build", standing: "MEMBER" }, { moduleKey: "hr", standing: "MEMBER" }],
    ];
    const invitees = combinations.map((moduleAccess, index) => ({
      email: `person${index}@acme.test`,
      role: "MEMBER",
      moduleAccess,
    }));
    expect(MAX_SETUP_INVITATION_BATCHES).toBe(8);
    expect(setupSchema.safeParse({ ...setupInput, invitees: invitees.slice(0, 8) }).success).toBe(true);
    expect(setupSchema.safeParse({ ...setupInput, invitees }).success).toBe(false);
    expect(orgSetupCompletedPayloadSchema.safeParse({ ...completedPayload, invitees }).success).toBe(false);
  });

  it("accepts legacy events without grants but rejects event grants outside activated modules", () => {
    const legacy = orgSetupCompletedPayloadSchema.safeParse({
      ...completedPayload,
      invitees: [{ email: "old@acme.test", role: "MEMBER" }],
    });
    expect(legacy.success).toBe(true);
    if (legacy.success) expect(legacy.data.invitees[0]?.moduleAccess).toBeUndefined();
    expect(orgSetupCompletedPayloadSchema.safeParse({
      ...completedPayload,
      invitees: [{ email: "old-owner@acme.test", role: "OWNER" }],
    }).success).toBe(true);

    expect(orgSetupCompletedPayloadSchema.safeParse({
      ...completedPayload,
      moduleKeys: ["build"],
      invitees: [{ email: "bad@acme.test", role: "MEMBER", moduleAccess: [{ moduleKey: "hr", standing: "MEMBER" }] }],
    }).success).toBe(false);
  });
});
