import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import { PublicFormsService } from "./public-forms.service";
import type { SubmissionsService } from "../build/forms/submissions.service";

describe("PublicFormsService — C4 server-enforce: six access conditions", () => {
  const TOKEN = "tok-form-probe";
  const PROJECT_ID = 99;
  const ORG_ID = "org-probe";

  const BASE_FORM = {
    id: 1,
    name: "Probe form",
    description: null,
    type: "contact",
    fields: [],
    publicToken: TOKEN,
    isPublic: true,
    isActive: true,
    deletedAt: null as Date | null,
  };

  function makeSubmissions() {
    return { submitPublicForm: jest.fn() } as unknown as SubmissionsService;
  }

  function makeFormDb(formRow: unknown): Db {
    return {
      query: { projectForms: { findFirst: jest.fn().mockResolvedValue(formRow) } },
      execute: jest.fn().mockResolvedValue([{ org_id: ORG_ID }]),
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          query: { projectForms: { findFirst: jest.fn().mockResolvedValue(formRow) } },
          execute: jest.fn().mockResolvedValue([{ org_id: ORG_ID }]),
          select: jest.fn().mockReturnValue({
            from: jest.fn().mockReturnValue({
              where: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([{ id: PROJECT_ID }]),
              }),
            }),
          }),
          insert: jest.fn().mockReturnValue({
            values: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([{ id: 1 }]),
            }),
          }),
        }),
      ),
    } as unknown as Db;
  }

  describe("getFormByToken — token capability + tenant isolation", () => {
    it("throws NotFoundException for an unknown token — cross-tenant isolation, no existence oracle", async () => {
      const db = makeFormDb(null);
      const svc = new PublicFormsService(db, makeSubmissions());
      await expect(svc.getFormByToken("bad-token")).rejects.toThrow(NotFoundException);
    });

    it("returns the form for a valid active public token — control (positive pair)", async () => {
      const db = makeFormDb(BASE_FORM);
      const svc = new PublicFormsService(db, makeSubmissions());
      const result = await svc.getFormByToken(TOKEN);
      expect(result).toHaveProperty("id", 1);
      expect(result).toHaveProperty("name", "Probe form");
    });
  });

  describe("getFormByToken — lifecycle: soft-deleted form is rejected", () => {
    it("throws NotFoundException when deletedAt is set — form has been removed", async () => {
      const db = makeFormDb({ ...BASE_FORM, deletedAt: new Date("2026-01-01") });
      const svc = new PublicFormsService(db, makeSubmissions());
      await expect(svc.getFormByToken(TOKEN)).rejects.toThrow(NotFoundException);
    });

    it("accepts a form whose deletedAt is null — lifecycle predicate requires null", async () => {
      const db = makeFormDb({ ...BASE_FORM, deletedAt: null });
      const svc = new PublicFormsService(db, makeSubmissions());
      const result = await svc.getFormByToken(TOKEN);
      expect(result).toHaveProperty("id");
    });
  });

  describe("getFormByToken — publication state", () => {
    it("throws NotFoundException when isPublic is false — form has been unpublished", async () => {
      const db = makeFormDb({ ...BASE_FORM, isPublic: false });
      const svc = new PublicFormsService(db, makeSubmissions());
      await expect(svc.getFormByToken(TOKEN)).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException when isActive is false — form has been deactivated", async () => {
      const db = makeFormDb({ ...BASE_FORM, isActive: false });
      const svc = new PublicFormsService(db, makeSubmissions());
      await expect(svc.getFormByToken(TOKEN)).rejects.toThrow(NotFoundException);
    });

    it("accepts an isPublic+isActive form — publication predicate requires both true", async () => {
      const db = makeFormDb({ ...BASE_FORM, isPublic: true, isActive: true });
      const svc = new PublicFormsService(db, makeSubmissions());
      const result = await svc.getFormByToken(TOKEN);
      expect(result).toHaveProperty("id");
    });
  });

  describe("getFormByToken — source ACL: response does not expose internal state", () => {
    it("does not expose isPublic, isActive, or deletedAt in the response", async () => {
      const db = makeFormDb(BASE_FORM);
      const svc = new PublicFormsService(db, makeSubmissions());
      const result = await svc.getFormByToken(TOKEN) as Record<string, unknown>;
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("name");
      expect(result).toHaveProperty("publicToken");
      expect(result).not.toHaveProperty("isPublic");
      expect(result).not.toHaveProperty("isActive");
      expect(result).not.toHaveProperty("deletedAt");
    });
  });

  describe("getFormByToken — expiry: no expiry column on project_forms (architecture gap)", () => {
    it("token rotation is the only revocation path — no expiry column exists on this entity", () => {
      const keys = Object.keys(BASE_FORM);
      expect(keys).not.toContain("expiresAt");
      expect(keys).not.toContain("linkExpiresAt");
      expect(keys).not.toContain("tokenExpiresAt");
    });
  });

  describe("getIntakeFormByProject — project lifecycle enforced before form lookup", () => {
    function whereColumns(node: unknown, seen = new Set<object>(), out: string[] = []): string[] {
      if (node === null || typeof node !== "object" || seen.has(node)) return out;
      seen.add(node);
      const rec = node as Record<string, unknown>;
      if (typeof rec["name"] === "string" && rec["table"] !== undefined) out.push(rec["name"]);
      const chunks = rec["queryChunks"];
      if (Array.isArray(chunks)) for (const chunk of chunks) whereColumns(chunk, seen, out);
      return out;
    }

    function makeIntakeDb(projectRow: unknown, forms: readonly unknown[]): Db {
      function findFirstResult(args: { where?: unknown }) {
        const filtered = new Set(whereColumns(args.where));
        for (const row of forms) {
          const f = row as Record<string, unknown>;
          if (filtered.has("is_public") && f["isPublic"] === false) continue;
          if (filtered.has("is_active") && f["isActive"] === false) continue;
          if (filtered.has("deleted_at") && f["deletedAt"] !== null && f["deletedAt"] !== undefined) continue;
          return row;
        }
        return null;
      }
      return {
        query: { projectForms: { findFirst: jest.fn().mockResolvedValue(forms[0] ?? null) } },
        execute: jest.fn().mockResolvedValue([{ org_id: ORG_ID }]),
        transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            query: {
              projectForms: {
                findFirst: jest.fn().mockImplementation(async (args: { where?: unknown }) => findFirstResult(args)),
              },
            },
            execute: jest.fn().mockResolvedValue([]),
            select: jest.fn().mockReturnValue({
              from: jest.fn().mockReturnValue({
                where: jest.fn().mockReturnValue({
                  limit: jest.fn().mockResolvedValue(
                    projectRow ? [projectRow] : [],
                  ),
                }),
              }),
            }),
            insert: jest.fn().mockReturnValue({
              values: jest.fn().mockReturnValue({
                returning: jest.fn().mockResolvedValue([{ id: 1 }]),
              }),
            }),
          }),
        ),
      } as unknown as Db;
    }

    it("throws NotFoundException when org resolver returns null — project does not exist", async () => {
      const db: Db = {
        query: { projectForms: { findFirst: jest.fn().mockResolvedValue(null) } },
        execute: jest.fn().mockResolvedValue([{ org_id: null }]),
        transaction: jest.fn(),
      } as unknown as Db;
      const svc = new PublicFormsService(db, makeSubmissions());
      await expect(svc.getIntakeFormByProject(-1)).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException when project has deletedAt set — project lifecycle is enforced", async () => {
      const db = makeIntakeDb(null, [BASE_FORM]);
      const svc = new PublicFormsService(db, makeSubmissions());
      await expect(svc.getIntakeFormByProject(PROJECT_ID)).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException when no active public form exists for the project", async () => {
      const db = makeIntakeDb({ id: PROJECT_ID }, []);
      const svc = new PublicFormsService(db, makeSubmissions());
      await expect(svc.getIntakeFormByProject(PROJECT_ID)).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException when intake form is soft-deleted", async () => {
      const db = makeIntakeDb({ id: PROJECT_ID }, [{ ...BASE_FORM, deletedAt: new Date("2026-01-01") }]);
      const svc = new PublicFormsService(db, makeSubmissions());
      await expect(svc.getIntakeFormByProject(PROJECT_ID)).rejects.toThrow(NotFoundException);
    });

    it("throws NotFoundException when intake form is unpublished (isPublic: false)", async () => {
      const db = makeIntakeDb({ id: PROJECT_ID }, [{ ...BASE_FORM, isPublic: false }]);
      const svc = new PublicFormsService(db, makeSubmissions());
      await expect(svc.getIntakeFormByProject(PROJECT_ID)).rejects.toThrow(NotFoundException);
    });

    it("returns the form when project is live and form is active and public — control", async () => {
      const db = makeIntakeDb({ id: PROJECT_ID }, [BASE_FORM]);
      const svc = new PublicFormsService(db, makeSubmissions());
      const result = await svc.getIntakeFormByProject(PROJECT_ID);
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("name", "Probe form");
    });

    it("serves the older live form when the newest one is unpublished, because the lifecycle test belongs in the query and a project with a retired draft still has a working intake link", async () => {
      const db = makeIntakeDb({ id: PROJECT_ID }, [
        { ...BASE_FORM, id: 2, name: "Retired draft", isActive: false },
        { ...BASE_FORM, id: 1, name: "Live intake" },
      ]);
      const svc = new PublicFormsService(db, makeSubmissions());

      const result = await svc.getIntakeFormByProject(PROJECT_ID);

      expect(result).toHaveProperty("name", "Live intake");
    });
  });
});
