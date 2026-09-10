if (process.env.TENANT_A_ORG_ID || process.env.TENANT_B_ORG_ID)
  throw new Error(
    "AR-02: tenant-relationship-integrity.spec.ts only runs unit design checks; legacy tenant IDs cannot count as SQL proof. " +
    "For guarded real-database verification configure TENANT_FK_PROBE_* and run pnpm test:db-specs --runTestsByPath src/db/tenant-relationship-integrity.db.spec.ts. " +
    "RBAC-001 remains incomplete until that probe passes against an approved disposable database.",
  );

describe("AR-02 cross-tenant FK integrity", () => {
  describe("composite FK design invariants (unit-provable)", () => {
    it("single-column FK accepts a cross-tenant id (demonstrates the attack vector)", () => {
      const singleColFkCheck = (parentOrgId: string, childOrgId: string, parentId: number, childParentId: number): boolean => {
        return childParentId === parentId;
      };

      const parentExists = singleColFkCheck("org-A", "org-B", 42, 42);
      expect(parentExists).toBe(true);
    });

    it("composite FK rejects a cross-tenant child (key invariant)", () => {
      const compositeFkCheck = (parentOrgId: string, parentId: number, childOrgId: string, childParentId: number): boolean => {
        return childOrgId === parentOrgId && childParentId === parentId;
      };

      const validSameOrg = compositeFkCheck("org-A", 42, "org-A", 42);
      const invalidCrossTenant = compositeFkCheck("org-A", 42, "org-B", 42);

      expect(validSameOrg).toBe(true);
      expect(invalidCrossTenant).toBe(false);
    });

    it("SET NULL column-list nulls only the child column when parent is deleted", () => {
      type TicketRow = { orgId: string; id: number; epicId: number | null };

      function simulateSetNullColumnList(rows: TicketRow[], deletedId: number): TicketRow[] {
        return rows.map((r) =>
          r.epicId === deletedId ? { ...r, epicId: null } : r,
        );
      }

      const rows: TicketRow[] = [
        { orgId: "org-A", id: 1, epicId: null },
        { orgId: "org-A", id: 2, epicId: 1 },
        { orgId: "org-A", id: 3, epicId: 1 },
      ];

      const after = simulateSetNullColumnList(rows, 1);
      expect(after[0]).toMatchObject({ orgId: "org-A", id: 1, epicId: null });
      expect(after[1]).toMatchObject({ orgId: "org-A", id: 2, epicId: null });
      expect(after[2]).toMatchObject({ orgId: "org-A", id: 3, epicId: null });
    });

    it("records the expected relationship names, without claiming schema or SQL coverage", () => {
      const requiredCompositeRelationships: Array<{ child: string; parent: string; constraint: string }> = [
        { child: "build.tickets", parent: "build.tickets", constraint: "fk_tickets_org_epic" },
        { child: "build.tickets", parent: "build.tickets", constraint: "fk_tickets_org_parent" },
        { child: "build.tickets", parent: "build.tickets", constraint: "fk_tickets_org_recurrence_parent" },
        { child: "build.okr_goals", parent: "build.okr_goals", constraint: "fk_okr_goals_org_parent" },
        { child: "build.pages", parent: "build.pages", constraint: "fk_pages_org_parent" },
        { child: "build_events.ticket_comments", parent: "build_events.ticket_comments", constraint: "fk_ticket_comments_org_parent" },
        { child: "ledger_accounts", parent: "ledger_accounts", constraint: "fk_ledger_accounts_org_parent" },
        { child: "journal_entries", parent: "journal_entries", constraint: "fk_je_org_reversed" },
        { child: "documents", parent: "documents", constraint: "fk_documents_org_parent" },
        { child: "goals", parent: "goals", constraint: "fk_goals_org_parent" },
        { child: "kb_article_comments", parent: "kb_article_comments", constraint: "fk_kb_article_comments_org_parent" },
        { child: "billing_invoice_snapshots", parent: "subscriptions", constraint: "fk_billing_inv_snap_org_sub" },
        { child: "billing_invoice_line_snapshots", parent: "billing_invoice_snapshots", constraint: "fk_billing_inv_lines_org_snap" },
        { child: "billing_invoice_line_snapshots", parent: "billing_proration_lines", constraint: "fk_billing_inv_lines_org_proration" },
        { child: "billing_invoice_line_snapshots", parent: "billing_usage_rollups", constraint: "fk_billing_inv_lines_org_rollup" },
        { child: "billing_credit_notes", parent: "billing_invoice_snapshots", constraint: "fk_billing_credit_notes_org_snap" },
        { child: "billing_credit_note_lines", parent: "billing_credit_notes", constraint: "fk_billing_credit_note_lines_org_note" },
        { child: "subscription_items", parent: "subscriptions", constraint: "fk_sub_items_org_sub" },
        { child: "billing_proration_lines", parent: "subscriptions", constraint: "fk_billing_proration_org_sub" },
        { child: "subscription_payments", parent: "subscriptions", constraint: "fk_sub_payments_org_sub" },
      ];

      expect(requiredCompositeRelationships).toHaveLength(20);
      for (const r of requiredCompositeRelationships)
        expect(r.constraint).toMatch(/^fk_/);
    });
  });

});
