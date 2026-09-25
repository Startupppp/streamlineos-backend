/**
 * HRMS-KB PR 6 (Phase 0 SEC-06) — importing a document sheet, against a real Postgres.
 *
 * Before this, a row whose `employeeEmail` matched nobody stored the document with `user_id = NULL`: an
 * organisation-wide document, from a typo. The email match was case-sensitive, the name match ignored double spaces
 * on one side only, a removed document could be revived by a sheet, a blank expiry cell erased a stored date, and an
 * exact repeat was reported as `updated`. Every case below fails on that code.
 *
 * Run with:
 *   DATABASE_URL=postgres://user@localhost:5432/scratch_… ALLOW_DESTRUCTIVE_DB_TESTS=1 \
 *     npx jest --config ./jest-db.json --runInBand --testPathPattern=hr-import-document-commit
 */
import { randomUUID } from "node:crypto";
import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { dbSpecClient, dbSpecSuite } from "../../../test/db-spec-gate";
import { requireApprovedDatabaseUrl } from "../../../test/db-spec-guard";
import * as schema from "../../../db/schema";
import { HrImportCommitService } from "./hr-import-commit.service";
import { nameKey } from "./hr-import-document-commit";
import { importContext, stubAdmission, stubPersonEmployment, stubRelationships } from "./import-commit-test-harness";
import type { CommitRef } from "./hr-import-commit.types";

const describeDb = dbSpecSuite();

describeDb("HR document import — real database", () => {
  const raw = process.env.DATABASE_URL
    ? requireApprovedDatabaseUrl({ spec: "hr-import-document-commit.db.spec.ts", vars: ["DATABASE_URL", "APP_DATABASE_URL"] })
    : "";
  let sql: ReturnType<typeof dbSpecClient>;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  const service = new HrImportCommitService(stubAdmission(), stubPersonEmployment(), stubRelationships());
  const orgA = `doc-import-a-${randomUUID()}`;
  const orgB = `doc-import-b-${randomUUID()}`;
  const owners: string[] = [];
  const users: string[] = [];

  beforeAll(async () => {
    sql = dbSpecClient(raw, { max: 4 });
    db = drizzle(sql, { schema });
    for (const orgId of [orgA, orgB]) {
      const ownerId = `owner-${randomUUID()}`;
      owners.push(ownerId);
      await sql.begin(async (tx) => {
        await tx`insert into users (id, email, name) values (${ownerId}, ${`${ownerId}@example.com`}, ${"Owner"})`;
        const [membership] = await tx`select nextval(pg_get_serial_sequence('organization_members', 'id'))::int as id`;
        const membershipId = Number(membership?.id);
        await tx`insert into organizations (id, name, slug, owner_membership_id) values (${orgId}, ${"Doc Import Co"}, ${orgId}, ${membershipId})`;
        await tx`insert into organization_members (id, org_id, user_id, role, status, is_owner) values (${membershipId}, ${orgId}, ${ownerId}, ${"ORG_ADMIN"}, ${"ACTIVE"}, true)`;
      });
    }
  }, 60_000);

  afterAll(async () => {
    if (!sql) return;
    for (const orgId of [orgA, orgB]) await sql`delete from organizations where id = ${orgId}`;
    for (const id of [...owners, ...users]) await sql`delete from users where id = ${id}`;
    await sql.end({ timeout: 5 });
  }, 120_000);

  /** An employee with a work email; with an account by default. Returns the user id. */
  async function employee(orgId: string, workEmail: string, withAccount = true): Promise<string | null> {
    const userId = withAccount ? `emp-${randomUUID()}` : null;
    if (userId) {
      users.push(userId);
      await sql`insert into users (id, email, name) values (${userId}, ${`${userId}@example.com`}, ${"Employee"})`;
    }
    const personId = randomUUID();
    await sql`insert into organization_people (organization_person_id, organization_id, user_id, first_name, last_name, work_email) values (${personId}, ${orgId}, ${userId}, ${"Ada"}, ${"Lovelace"}, ${workEmail})`;
    await sql`insert into hr_people (org_id, user_id, organization_person_id) values (${orgId}, ${userId}, ${personId})`;
    return userId;
  }

  const row = (over: Record<string, unknown> = {}) => ({
    employeeEmail: "ada@example.com",
    name: "Offer Letter",
    type: "OFFER_LETTER",
    fileUrl: "https://example.com/offer.pdf",
    category: "Onboarding",
    ...over,
  });

  async function commit(orgId: string, over: Record<string, unknown> = {}): Promise<CommitRef | null> {
    return db.transaction((tx) => service.commitRow(tx, importContext(orgId), "document_metadata", row(over)));
  }

  const documentsOf = (orgId: string) => sql`select id, user_id, name, type, category, file_url, expiry_date::text as expiry, is_active, classification, updated_at from documents where org_id = ${orgId} order by id`;

  describe("who the document belongs to", () => {
    it("refuses a row whose email matches nobody, and stores no document at all, least of all an organisation-wide one", async () => {
      await expect(commit(orgA, { employeeEmail: "nobody@example.com" })).rejects.toThrow(/No employee has the work email nobody@example\.com/);

      expect((await documentsOf(orgA)).length).toBe(0);
      const [orphans] = await sql`select count(*)::int as n from documents where org_id = ${orgA} and user_id is null`;
      expect(Number(orphans?.n)).toBe(0);
    });

    it("matches the email whatever its case", async () => {
      const userId = await employee(orgA, "Ada.Case@Example.com");

      const created = await commit(orgA, { employeeEmail: "ADA.CASE@EXAMPLE.COM", name: "Case Test" });

      expect(created?.outcome).toBe("created");
      const [stored] = await sql`select user_id from documents where org_id = ${orgA} and name = 'Case Test'`;
      expect(stored?.user_id).toBe(userId);
    });

    it("refuses an employee who has no account yet, since a personal document needs an owner", async () => {
      await employee(orgA, "noaccount@example.com", false);

      await expect(commit(orgA, { employeeEmail: "noaccount@example.com", name: "No Account" })).rejects.toThrow(/no user account yet/);
      const [stored] = await sql`select count(*)::int as n from documents where org_id = ${orgA} and name = 'No Account'`;
      expect(Number(stored?.n)).toBe(0);
    });

    it("does not match an employee of another organisation with the same email", async () => {
      await employee(orgB, "shared@example.com");

      await expect(commit(orgA, { employeeEmail: "shared@example.com", name: "Cross Tenant" })).rejects.toThrow(/No employee has the work email/);

      expect((await documentsOf(orgA)).some((doc) => doc.name === "Cross Tenant")).toBe(false);
      expect((await documentsOf(orgB)).length).toBe(0);
    });

    it("does not attach a document to an employee who was deleted", async () => {
      await employee(orgA, "gone@example.com");
      await sql`update organization_people set deleted_at = now() where organization_id = ${orgA} and work_email = 'gone@example.com'`;

      await expect(commit(orgA, { employeeEmail: "gone@example.com", name: "Gone" })).rejects.toThrow(/No employee has the work email/);
    });

    it("stores every imported document as Personal, so an import can never make one shareable", async () => {
      await employee(orgA, "ada@example.com");

      await commit(orgA, { name: "Personal By Default" });

      const [stored] = await sql`select classification from documents where org_id = ${orgA} and name = 'Personal By Default'`;
      expect(stored?.classification).toBe("PERSONAL");
    });
  });

  describe("re-importing", () => {
    it("reports an exact repeat as unchanged, touches nothing, and creates no second document", async () => {
      await employee(orgA, "repeat@example.com");
      const first = await commit(orgA, { employeeEmail: "repeat@example.com", name: "Repeat" });
      const [before] = await sql`select updated_at from documents where id = ${first?.id ?? 0}`;

      const second = await commit(orgA, { employeeEmail: "repeat@example.com", name: "Repeat" });

      expect(first?.outcome).toBe("created");
      expect(second).toMatchObject({ id: first?.id, outcome: "unchanged" });
      const [after] = await sql`select updated_at from documents where id = ${first?.id ?? 0}`;
      expect(new Date(after?.updated_at).getTime()).toBe(new Date(before?.updated_at).getTime());
      const [count] = await sql`select count(*)::int as n from documents where org_id = ${orgA} and name = 'Repeat'`;
      expect(Number(count?.n)).toBe(1);
    });

    it("reports a changed file as updated, on the same document", async () => {
      await employee(orgA, "changed@example.com");
      const first = await commit(orgA, { employeeEmail: "changed@example.com", name: "Changed" });

      const second = await commit(orgA, { employeeEmail: "changed@example.com", name: "Changed", fileUrl: "https://example.com/v2.pdf" });

      expect(second).toMatchObject({ id: first?.id, outcome: "updated" });
      const [stored] = await sql`select file_url from documents where id = ${first?.id ?? 0}`;
      expect(stored?.file_url).toBe("https://example.com/v2.pdf");
    });

    it("refuses to change a document someone classified for the Knowledge Base, leaves it exactly as it was, and still calls an exact repeat unchanged", async () => {
      await employee(orgA, "classified@example.com");
      const first = await commit(orgA, { employeeEmail: "classified@example.com", name: "Classified", type: "POLICY", fileUrl: "https://example.com/v1.pdf" });
      await sql`update documents set classification = 'INTERNAL' where id = ${first?.id ?? 0}`;
      const [before] = await sql`select file_url, type::text as type, updated_at from documents where id = ${first?.id ?? 0}`;

      await expect(commit(orgA, { employeeEmail: "classified@example.com", name: "Classified", type: "POLICY", fileUrl: "https://example.com/v2.pdf" })).rejects.toThrow(
        /classified for the Knowledge Base/,
      );
      const repeat = await commit(orgA, { employeeEmail: "classified@example.com", name: "Classified", type: "POLICY", fileUrl: "https://example.com/v1.pdf" });

      const [after] = await sql`select file_url, type::text as type, classification::text as classification, updated_at from documents where id = ${first?.id ?? 0}`;
      expect(after).toMatchObject({ file_url: before?.file_url, type: before?.type, classification: "INTERNAL" });
      expect(new Date(after?.updated_at).getTime()).toBe(new Date(before?.updated_at).getTime());
      expect(repeat).toMatchObject({ id: first?.id, outcome: "unchanged" });
    });

    it.each([
      ["a double space", "Code  of   Conduct", "Code of Conduct"],
      ["a tab", "Code\tof Conduct", "Code of Conduct"],
      ["a non-breaking space", "Code of Conduct", "Code of Conduct"],
      ["case and outer space", "  CODE OF CONDUCT ", "Code of Conduct"],
    ])("treats a name differing only by %s as the same document, in either direction", async (_label, stored, incoming) => {
      const email = `space-${randomUUID().slice(0, 6)}@example.com`;
      const userId = await employee(orgA, email);
      const first = await commit(orgA, { employeeEmail: email, name: stored, category: "Policies" });

      const same = await commit(orgA, { employeeEmail: email, name: incoming, category: "Policies" });
      const back = await commit(orgA, { employeeEmail: email, name: stored, category: "Policies" });

      expect(same?.id).toBe(first?.id);
      expect(back?.id).toBe(first?.id);
      const [count] = await sql`select count(*)::int as n from documents where org_id = ${orgA} and user_id = ${userId}`;
      expect(Number(count?.n)).toBe(1);
    });

    it("keeps two documents that differ by category or by person apart", async () => {
      const email = `apart-${randomUUID().slice(0, 6)}@example.com`;
      const other = `apart2-${randomUUID().slice(0, 6)}@example.com`;
      await employee(orgA, email);
      await employee(orgA, other);

      const a = await commit(orgA, { employeeEmail: email, name: "Same Name", category: "One" });
      const b = await commit(orgA, { employeeEmail: email, name: "Same Name", category: "Two" });
      const c = await commit(orgA, { employeeEmail: other, name: "Same Name", category: "One" });

      expect(new Set([a?.id, b?.id, c?.id]).size).toBe(3);
    });

    it("does not revive a removed document: the sheet creates a new one and the removed one stays removed", async () => {
      const email = `revive-${randomUUID().slice(0, 6)}@example.com`;
      await employee(orgA, email);
      const first = await commit(orgA, { employeeEmail: email, name: "Revive Me" });
      await sql`update documents set is_active = false where id = ${first?.id ?? 0}`;

      const second = await commit(orgA, { employeeEmail: email, name: "Revive Me" });

      expect(second?.outcome).toBe("created");
      expect(second?.id).not.toBe(first?.id);
      const [old] = await sql`select is_active from documents where id = ${first?.id ?? 0}`;
      expect(old?.is_active).toBe(false);
    });
  });

  describe("the expiry date", () => {
    it("keeps a stored expiry when the sheet's cell is blank, and replaces it when the sheet gives one", async () => {
      const email = `expiry-${randomUUID().slice(0, 6)}@example.com`;
      await employee(orgA, email);
      const first = await commit(orgA, { employeeEmail: email, name: "Expiring", expiryDate: "2027-01-31" });

      const blank = await commit(orgA, { employeeEmail: email, name: "Expiring", expiryDate: "" });
      const [kept] = await sql`select expiry_date::text as expiry from documents where id = ${first?.id ?? 0}`;
      expect(blank?.outcome).toBe("unchanged");
      expect(kept?.expiry).toBe("2027-01-31");

      const replaced = await commit(orgA, { employeeEmail: email, name: "Expiring", expiryDate: "2028-02-29" });
      const [now] = await sql`select expiry_date::text as expiry from documents where id = ${first?.id ?? 0}`;
      expect(replaced?.outcome).toBe("updated");
      expect(now?.expiry).toBe("2028-02-29");
    });

    it("stores no expiry for a new document whose cell is blank", async () => {
      const email = `noexpiry-${randomUUID().slice(0, 6)}@example.com`;
      await employee(orgA, email);

      const created = await commit(orgA, { employeeEmail: email, name: "No Expiry" });

      const [stored] = await sql`select expiry_date from documents where id = ${created?.id ?? 0}`;
      expect(stored?.expiry_date).toBeNull();
    });
  });

  describe("the name key", () => {
    it("is one SQL definition applied to both sides, so the stored column and the incoming value agree on every whitespace", async () => {
      const inputs = ["a b", "a  b", "a\tb", "a\nb", "a\u00a0b", " A B ", "A\r\n\tB", "\u00a0a \u00a0 b\u00a0"];
      const keys: unknown[] = [];
      for (const input of inputs) {
        const [result] = await db.execute<{ k: string }>(drizzleSql`select ${nameKey(input)} as k`);
        keys.push(result?.k);
      }

      expect(new Set(keys)).toEqual(new Set(["a b"]));
    });

    it("keeps different names different", async () => {
      const [one] = await db.execute<{ k: string }>(drizzleSql`select ${nameKey("Code of Conduct")} as k`);
      const [two] = await db.execute<{ k: string }>(drizzleSql`select ${nameKey("Code of Conducts")} as k`);

      expect(one?.k).not.toBe(two?.k);
    });
  });
});
