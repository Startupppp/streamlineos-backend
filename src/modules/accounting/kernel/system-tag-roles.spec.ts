import { BadRequestException } from "@nestjs/common";
import { glSystemTagEnum } from "../../../db/schema";
import { BASE_CHART_OF_ACCOUNTS, IN_GST_ACCOUNTS } from "../packs/coa-template";
import { AccountsService } from "./accounts.service";
import {
  ALL_SYSTEM_TAGS,
  INVENTORY_SEAM_ROLES,
  INVENTORY_SEAM_ROLES_PENDING,
  SYSTEM_TAG_ACCOUNT_TYPES,
  accountTypeFitsRole,
} from "./system-tag-roles";

/**
 * ACC-03. A system role is how a document names an account without knowing the
 * tenant's chart, and until now nothing said what kind of account a given role
 * belongs on. `cogs` on an equity account balances perfectly well; the journal
 * is fine and the P&L is quietly missing its cost of sales.
 *
 * The two chart assertions below are the ones that matter. A role map that
 * disagrees with the chart every book is seeded from would mean freshly created
 * books are born mis-mapped, and a validation that rejects the product's own
 * template is worse than none.
 */

describe("the system-role account-type map", () => {
  it("covers every member of gl_system_tag", () => {
    /*
      Exhaustiveness is a compile-time property of `Record<GlSystemTag, …>`, but
      it stops being one the moment someone widens the type to get a build
      through. This is the runtime floor under that.
    */
    expect(new Set(ALL_SYSTEM_TAGS)).toEqual(new Set(glSystemTagEnum.enumValues));
  });

  it("agrees with the chart every book is seeded from", () => {
    const tagged = [...BASE_CHART_OF_ACCOUNTS, ...IN_GST_ACCOUNTS].filter((a) => a.systemTag);
    /* Anti-vacuity: an empty filter would make the loop below assert nothing. */
    expect(tagged.length).toBeGreaterThan(25);

    const wrong = tagged
      .filter((a) => !accountTypeFitsRole(a.systemTag!, a.type))
      .map((a) => `${a.code} ${a.name}: "${a.systemTag}" on ${a.type}`);
    expect(wrong).toEqual([]);
  });

  it("never puts a role on a header account in the template", () => {
    /* A header takes no postings, so a role on one resolves to something unpostable. */
    const headersWithRoles = BASE_CHART_OF_ACCOUNTS.filter((a) => a.isHeader && a.systemTag);
    expect(headersWithRoles).toEqual([]);
  });
});

describe("the inventory seam's role lists", () => {
  it("seeds an account for every role it calls required", () => {
    /*
      A book created from the template must be `ready`, not `incomplete`. If a
      required role had no seeded account, every new org would open on a
      provisioning warning it could do nothing about.
    */
    const seeded = new Set(BASE_CHART_OF_ACCOUNTS.map((a) => a.systemTag).filter(Boolean));
    for (const role of INVENTORY_SEAM_ROLES) expect(seeded).toContain(role);
  });

  it("seeds the pending roles too, so mapping them is not the operator's job later", () => {
    const seeded = new Set(BASE_CHART_OF_ACCOUNTS.map((a) => a.systemTag).filter(Boolean));
    for (const role of INVENTORY_SEAM_ROLES_PENDING) expect(seeded).toContain(role);
  });

  it("keeps required and pending disjoint", () => {
    /*
      The distinction is the whole value of the pair: a book without `inventory`
      is broken today, a book without `grni` is not. A role in both lists would
      be reported as an urgent gap and a known-future one at once.
    */
    const overlap = INVENTORY_SEAM_ROLES.filter((r) =>
      (INVENTORY_SEAM_ROLES_PENDING as readonly string[]).includes(r),
    );
    expect(overlap).toEqual([]);
  });

  it("lists as pending exactly the roles no call site resolves yet", () => {
    /*
      Empty since ACC-21, which gave all three a call site: a quality scrap
      resolves `inventory_write_off`, adjustments and counts resolve
      `inventory_adjustment`, and a vendor return resolves `grni`. They moved
      into the required list in the same commit as those call sites, which is
      the rule the list was created to enforce.

      The list stays, empty, because the distinction still matters for the next
      role seeded ahead of its call site.
    */
    expect([...INVENTORY_SEAM_ROLES_PENDING]).toEqual([]);
  });

  it("requires every role a call site can actually resolve", () => {
    /*
      The other half, and the one that bites: a role that reached a call site
      without reaching this list would be demanded by a posting at runtime and
      never mentioned by provisioning — the tenant would discover it as a
      refused goods movement rather than as a setup step.
    */
    for (const role of ["grni", "inventory_write_off", "inventory_adjustment"] as const) {
      expect([...INVENTORY_SEAM_ROLES]).toContain(role);
    }
  });
});

describe("accountTypeFitsRole", () => {
  it("accepts the type a role belongs on", () => {
    expect(accountTypeFitsRole("inventory", "ASSET")).toBe(true);
    expect(accountTypeFitsRole("grni", "LIABILITY")).toBe(true);
  });

  it("rejects a role on the wrong side of the statements", () => {
    expect(accountTypeFitsRole("cogs", "EQUITY")).toBe(false);
    expect(accountTypeFitsRole("grni", "ASSET")).toBe(false);
    expect(accountTypeFitsRole("inventory", "EXPENSE")).toBe(false);
  });

  it("allows a role that genuinely lives on either side", () => {
    expect(SYSTEM_TAG_ACCOUNT_TYPES.rounding).toEqual(["INCOME", "EXPENSE"]);
    expect(accountTypeFitsRole("rounding", "INCOME")).toBe(true);
    expect(accountTypeFitsRole("rounding", "EXPENSE")).toBe(true);
  });
});

/** Drive the guard through the service, since it is private. */
function serviceForAccount(account: Record<string, unknown>) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "from", "where"]) chain[m] = () => chain;
  chain["limit"] = () => Promise.resolve([account]);
  const db = {
    select: () => chain,
    transaction: () => {
      throw new Error("reached the write");
    },
  } as never;
  return new AccountsService(db, { log: () => undefined } as never);
}

describe("assigning a role to an account", () => {
  it("refuses a role the account type cannot carry, and says which side", async () => {
    const service = serviceForAccount({
      id: "acc-1",
      code: "3100",
      accountType: "EQUITY",
      isHeader: false,
      systemTag: null,
    });

    await expect(
      service.setSystemTag("org-1", "user-1", "book-1", "acc-1", "cogs"),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.setSystemTag("org-1", "user-1", "book-1", "acc-1", "cogs"),
    ).rejects.toThrow(/belongs on EXPENSE account, not EQUITY/);
  });

  it("lets a correct mapping through to the write", async () => {
    /*
      The stub throws on `transaction`, so reaching that error is the proof the
      guard passed — otherwise this test would also pass with the guard
      rejecting everything.
    */
    const service = serviceForAccount({
      id: "acc-2",
      code: "1300",
      accountType: "ASSET",
      isHeader: false,
      systemTag: null,
    });
    await expect(
      service.setSystemTag("org-1", "user-1", "book-1", "acc-2", "inventory"),
    ).rejects.toThrow("reached the write");
  });

  it("still refuses a header account before looking at its type", async () => {
    const service = serviceForAccount({
      id: "acc-3",
      code: "1000",
      accountType: "ASSET",
      isHeader: true,
      systemTag: null,
    });
    await expect(
      service.setSystemTag("org-1", "user-1", "book-1", "acc-3", "inventory"),
    ).rejects.toThrow(/header account cannot fill a posting role/);
  });

  it("allows clearing a role without type-checking null", async () => {
    const service = serviceForAccount({
      id: "acc-4",
      code: "3100",
      accountType: "EQUITY",
      isHeader: false,
      systemTag: "cogs",
    });
    await expect(
      service.setSystemTag("org-1", "user-1", "book-1", "acc-4", null),
    ).rejects.toThrow("reached the write");
  });
});
