import {
  loadRouteSurface,
  isObjectAddressable,
  parseController,
  handlerBody,
  joinMultilineDecorators,
  parseInjectedProperties,
  extractServiceCalls,
} from "./route-surface";

/**
 * The BOLA sweep is only as honest as its enumeration. A parser that silently
 * loses routes reports a smaller unbound set and reads as a pass, so these
 * numbers are pinned against `pnpm check:route-classification`, which is the
 * repository's own authority on the route surface.
 */
const OFFICIAL_TOTALS = {
  total: 3602,
  public: 236,
  universal: 100,
  permissioned: 3206,
  inService: 60,
  undeclared: 0,
} as const;

describe("BOLA sweep — route surface enumeration", () => {
  const routes = loadRouteSurface();

  it("ANTI-VACUITY: the walk finds a real controller surface, not an empty one", () => {
    expect(routes.length).toBeGreaterThan(3000);
    expect(new Set(routes.map((r) => r.file)).size).toBeGreaterThan(400);
  });

  it("AGREES-WITH-GATE: totals match pnpm check:route-classification exactly", () => {
    const byClass = routes.reduce<Record<string, number>>((acc, r) => {
      acc[r.classification] = (acc[r.classification] ?? 0) + 1;
      return acc;
    }, {});
    expect(routes.length).toBe(OFFICIAL_TOTALS.total);
    expect(byClass.public).toBe(OFFICIAL_TOTALS.public);
    expect(byClass.universal).toBe(OFFICIAL_TOTALS.universal);
    expect(byClass.permissioned).toBe(OFFICIAL_TOTALS.permissioned);
    expect(byClass["in-service"]).toBe(OFFICIAL_TOTALS.inService);
    expect(byClass.UNDECLARED ?? 0).toBe(OFFICIAL_TOTALS.undeclared);
  });

  it("OBJECT-ADDRESSABLE: every route naming a record in its path is enumerated", () => {
    const addressable = routes.filter(isObjectAddressable);
    expect(addressable.length).toBeGreaterThan(1800);
    expect(addressable.every((r) => r.pathParams.length > 0)).toBe(true);
    expect(addressable.every((r) => r.path.includes(":"))).toBe(true);
  });

  it("RESOLVABLE: an object-addressable route resolves to code, not an empty body", () => {
    const addressable = routes.filter(isObjectAddressable);
    const empty = addressable.filter((r) => r.body.trim().length === 0);
    expect(empty).toEqual([]);
  });
});

describe("BOLA sweep — parser self-test", () => {
  it("does not truncate a handler whose parameter carries an inline object type", () => {
    const source = [
      '@Controller("chat")',
      "export class C {",
      "  constructor(private readonly members: MembersService) {}",
      '  @Patch(":channelId/role")',
      "  updateRole(",
      '    @Param("channelId") channelId: number,',
      "    @Body() body: { role: string },",
      "    @CurrentUser() u: CurrentUserContext,",
      "  ) {",
      "    return this.members.updateMemberRole(channelId, u.orgId, body.role);",
      "  }",
      "}",
    ].join("\n");
    const [route] = parseController("/tmp/x.controller.ts", source);
    expect(route?.serviceCalls).toHaveLength(1);
    expect(route?.serviceCalls[0]?.args).toContain("u.orgId");
  });

  it("does not truncate a method whose generic return type ends a line with a semicolon", () => {
    const lines = [
      "  async getCallerPermissions(",
      "    actor: CurrentUserContext,",
      "  ): Promise<{",
      "    permissions: { key: string; scope: DataScope }[];",
      "    isOrgOwner: boolean;",
      "  }> {",
      "    return this.db.query.organizationMembers.findFirst({",
      "      where: eq(organizationMembers.orgId, actor.orgId),",
      "    });",
      "  }",
    ];
    const { body } = handlerBody(lines, 0);
    expect(body).toContain("organizationMembers.orgId");
  });

  it("joins a decorator whose argument sits on the next line", () => {
    const joined = joinMultilineDecorators([
      "  @AuthorizedInService(",
      '    "JWT sub is the subject",',
      "  )",
      '  @Post("export/me")',
    ]);
    expect(joined[0]).toContain("@AuthorizedInService(");
    expect(joined[0]).toContain("JWT sub is the subject");
  });

  it("reads the constructor of the named class, not the file's first constructor", () => {
    const source = [
      "export class FirstController {",
      "  constructor(private readonly a: AService) {}",
      "}",
      "export class SecondController {",
      "  constructor(private readonly b: BService) {}",
      "}",
    ].join("\n");
    const second = parseInjectedProperties(source, source.indexOf("class SecondController"));
    expect(second.get("b")).toBe("BService");
    expect(second.has("a")).toBe(false);
  });

  it("captures a service call's full argument list across nested parentheses", () => {
    const calls = extractServiceCalls(
      "return this.svc.run(u.orgId, build({ a: 1 }), id);",
    );
    expect(calls[0]?.args).toBe("u.orgId, build({ a: 1 }), id");
  });
});
