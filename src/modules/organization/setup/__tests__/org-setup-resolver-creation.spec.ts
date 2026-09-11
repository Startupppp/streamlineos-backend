import { OrgSetupResolverService } from "../org-setup-resolver.service";

describe("OrgSetupResolverService organization creation", () => {
  it("delegates setup creation to the shared organization saga owner", async () => {
    const creation = {
      createFromSetup: jest.fn().mockResolvedValue({
        id: "org-created",
        name: "Acme",
        slug: "acme-stable",
      }),
    };
    const audit = { log: jest.fn() };
    const resolver = new OrgSetupResolverService(
      {},
      {},
      audit,
      creation,
    );
    jest.spyOn(resolver, "listSetupMemberships").mockResolvedValue([]);

    await expect(
      resolver.resolveOrCreateOrg(
        { userId: "user-1", orgId: null },
        { companyName: "  Acme  " },
      ),
    ).resolves.toEqual({ orgId: "org-created", isOwner: true });

    expect(creation.createFromSetup).toHaveBeenCalledTimes(1);
    expect(creation.createFromSetup).toHaveBeenCalledWith({
      userId: "user-1",
      name: "Acme",
    });
    expect(audit.log).toHaveBeenCalledWith({
      action: "org.created",
      userId: "user-1",
      orgId: "org-created",
      targetId: "org-created",
      targetType: "organization",
    });
  });
});
