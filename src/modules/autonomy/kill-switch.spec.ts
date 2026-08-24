import { resolveSwitch, switchesFor, type SwitchRow } from "./kill-switch";

const ORG = "org-1";

describe("resolveSwitch", () => {
  /** Autonomy is the product's premise; the switches exist to stop it. */
  it("allows by default when nothing has been turned off", () => {
    expect(resolveSwitch(ORG, "stage.advanced", [])).toMatchObject({
      allowed: true,
      decidedBy: "default",
    });
  });

  it("stops one action type for one organisation", () => {
    const rows: SwitchRow[] = [
      { organizationId: ORG, kind: "stage.advanced", enabled: false, reason: "too eager" },
    ];

    expect(resolveSwitch(ORG, "stage.advanced", rows)).toMatchObject({
      allowed: false,
      decidedBy: "org-kind",
      reason: "too eager",
    });
    // Everything else keeps working.
    expect(resolveSwitch(ORG, "task.extracted", rows).allowed).toBe(true);
  });

  it("stops everything for one organisation with a wildcard", () => {
    const rows: SwitchRow[] = [{ organizationId: ORG, kind: "*", enabled: false }];

    expect(resolveSwitch(ORG, "stage.advanced", rows).allowed).toBe(false);
    expect(resolveSwitch(ORG, "task.extracted", rows).allowed).toBe(false);
  });

  it("stops one action type across the platform", () => {
    const rows: SwitchRow[] = [
      { organizationId: null, kind: "quote.sent", enabled: false, reason: "incident 41" },
    ];

    expect(resolveSwitch(ORG, "quote.sent", rows)).toMatchObject({
      allowed: false,
      decidedBy: "platform-kind",
      reason: "incident 41",
    });
  });

  /**
   * The precedence that matters at 3am.
   *
   * An operator killing an action platform-wide must not be overridden by a
   * tenant who had explicitly enabled it.
   */
  it("lets a platform veto beat an organisation's explicit enable", () => {
    const rows: SwitchRow[] = [
      { organizationId: null, kind: "stage.advanced", enabled: false },
      { organizationId: ORG, kind: "stage.advanced", enabled: true },
    ];

    expect(resolveSwitch(ORG, "stage.advanced", rows)).toMatchObject({
      allowed: false,
      decidedBy: "platform-kind",
    });
  });

  it("lets a platform wildcard beat everything else", () => {
    const rows: SwitchRow[] = [
      { organizationId: null, kind: "*", enabled: false },
      { organizationId: null, kind: "stage.advanced", enabled: true },
      { organizationId: ORG, kind: "*", enabled: true },
    ];

    expect(resolveSwitch(ORG, "stage.advanced", rows).decidedBy).toBe("platform-all");
  });

  it("reports which row decided it, for the operator asking why nothing happens", () => {
    const rows: SwitchRow[] = [{ organizationId: ORG, kind: "*", enabled: false }];
    expect(resolveSwitch(ORG, "task.extracted", rows).decidedBy).toBe("org-all");
  });

  it("ignores an enabled row, which is the same as no row", () => {
    const rows: SwitchRow[] = [{ organizationId: ORG, kind: "stage.advanced", enabled: true }];
    expect(resolveSwitch(ORG, "stage.advanced", rows).decidedBy).toBe("default");
  });
});

describe("switchesFor", () => {
  /** One tenant's kill switch must never stop another tenant's product. */
  it("keeps only this organisation's rows and the platform's", () => {
    const rows: SwitchRow[] = [
      { organizationId: null, kind: "*", enabled: true },
      { organizationId: ORG, kind: "stage.advanced", enabled: false },
      { organizationId: "org-2", kind: "*", enabled: false },
    ];

    const scoped = switchesFor(ORG, rows);

    expect(scoped).toHaveLength(2);
    expect(scoped.every((row) => row.organizationId === null || row.organizationId === ORG)).toBe(
      true,
    );
  });

  it("means another tenant's veto cannot leak in", () => {
    const rows: SwitchRow[] = [{ organizationId: "org-2", kind: "*", enabled: false }];
    expect(resolveSwitch(ORG, "stage.advanced", switchesFor(ORG, rows)).allowed).toBe(true);
  });
});
