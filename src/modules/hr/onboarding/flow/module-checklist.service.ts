import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import { moduleSetupChecklistItems, moduleSetupChecklists } from "../../../../db/schema";
import { OnboardingAnalyticsService } from "./onboarding-analytics.service";
import { HrChecklistReconciliationService } from "./hr-checklist-reconciliation.service";
import { EntitlementsService } from "../../../access/entitlements.service";

type ChecklistWithItems = typeof moduleSetupChecklists.$inferSelect & {
  items: (typeof moduleSetupChecklistItems.$inferSelect)[];
};

interface ChecklistItemSeed {
  itemKey: string;
  title: string;
  description?: string;
  actionHref?: string;
  required: boolean;
}

// Default checklist items per module, per PRD 03 "Module Setup Checklist Examples".
const CHECKLIST_SEEDS: Record<string, ChecklistItemSeed[]> = {
  crm: [
    { itemKey: "import_contacts", title: "Import contacts/leads", actionHref: "/crm/contacts", required: false },
    { itemKey: "create_pipeline", title: "Create first pipeline", actionHref: "/crm/deals", required: true },
    { itemKey: "invite_sales_team", title: "Invite sales team", actionHref: "/users", required: false },
    { itemKey: "connect_email", title: "Connect email", actionHref: "/settings/integrations", required: false },
  ],
  hr: [
    {
      itemKey: "org_profile",
      title: "Organization profile",
      description: "Confirm your company name, country, and timezone are set.",
      actionHref: "/settings/organization",
      required: true,
    },
    {
      itemKey: "locations_departments",
      title: "Locations & departments",
      description: "Add at least one location and one department — required for employees, leave, payroll, and reporting.",
      actionHref: "/hr/org?tab=departments",
      required: true,
    },
    {
      itemKey: "roles_positions",
      title: "Job roles, levels & positions",
      description: "Create at least one role/designation and one position or headcount record.",
      actionHref: "/hr/org?tab=roles",
      required: true,
    },
    {
      itemKey: "leave_policies",
      title: "Leave policies",
      description: "Activate at least one leave policy (annual, sick, casual, etc.) with an accrual rule.",
      actionHref: "/hr/leave-policies",
      required: true,
    },
    {
      itemKey: "holiday_calendar",
      title: "Holiday calendar",
      description: "Add your organization's holidays so they appear in the calendar and affect leave calculations.",
      actionHref: "/hr/holidays",
      required: true,
    },
    {
      itemKey: "attendance_schedule",
      title: "Attendance & work schedule",
      description: "Configure working hours and at least one shift.",
      actionHref: "/hr/shifts",
      required: true,
    },
    {
      itemKey: "onboarding_template",
      title: "Employee onboarding template",
      description: "Create an onboarding template covering personal details, documents, and manager assignment.",
      actionHref: "/hr/onboarding?tab=plans",
      required: true,
    },
    {
      itemKey: "document_types",
      title: "Document types & compliance",
      description: "Define the document types employees must submit before onboarding is considered complete.",
      actionHref: "/hr/document-types",
      required: true,
    },
    {
      itemKey: "approval_workflows",
      title: "Approval workflows",
      description: "Set up who approves leave, expenses, attendance regularization, requisitions, and payroll.",
      actionHref: "/hr/settings/workflows",
      required: true,
    },
    {
      itemKey: "payroll_setup",
      title: "Payroll setup",
      description: "Configure salary components and an active payroll policy/calendar.",
      actionHref: "/payroll/settings",
      required: true,
    },
    {
      itemKey: "recruitment_setup",
      title: "Recruitment setup",
      description: "Configure interview stages, scorecards, or offer templates. Skip if you're not hiring right now.",
      actionHref: "/hr/recruitment/settings",
      required: false,
    },
    {
      itemKey: "first_employees",
      title: "Add or invite your first employees",
      description: "Onboard a single employee or bulk-import your team.",
      actionHref: "/hr/onboarding?tab=wizard",
      required: true,
    },
  ],
  inventory: [
    { itemKey: "create_warehouse", title: "Create warehouse", actionHref: "/inventory/warehouses", required: true },
    { itemKey: "import_products", title: "Import products", actionHref: "/inventory/products", required: false },
    { itemKey: "set_opening_stock", title: "Set opening stock", actionHref: "/inventory/stock", required: false },
    { itemKey: "configure_reorder_rules", title: "Configure reorder rules", actionHref: "/inventory/products", required: false },
  ],
  accounting: [
    { itemKey: "set_fiscal_year", title: "Set fiscal year", actionHref: "/accounting", required: true },
    { itemKey: "configure_taxes", title: "Configure taxes", actionHref: "/accounting", required: true },
    { itemKey: "add_payment_provider", title: "Add bank/payment provider", actionHref: "/accounting/settings/payment-providers", required: false },
    { itemKey: "create_first_invoice", title: "Create first invoice", actionHref: "/billing/invoices/new", required: false },
  ],
  build: [
    { itemKey: "create_first_project", title: "Create first project", actionHref: "/build", required: true },
    { itemKey: "invite_team", title: "Invite project team", actionHref: "/users", required: false },
  ],
  support: [
    { itemKey: "configure_sla", title: "Configure SLA policy", actionHref: "/support/routing", required: false },
    { itemKey: "create_first_ticket_view", title: "Create first ticket view", actionHref: "/support", required: false },
  ],
  kb: [
    { itemKey: "create_team_space", title: "Create team space", actionHref: "/knowledge", required: true },
    { itemKey: "add_first_sop", title: "Add first SOP", actionHref: "/knowledge", required: false },
    { itemKey: "invite_collaborators", title: "Invite collaborators", actionHref: "/users", required: false },
  ],
  chat: [
    { itemKey: "create_first_channel", title: "Create first channel", actionHref: "/chat", required: false },
  ],
};

@Injectable()
export class ModuleChecklistService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly analytics: OnboardingAnalyticsService,
    private readonly hrReconciliation: HrChecklistReconciliationService,
    private readonly entitlements: EntitlementsService,
  ) {}

  private async resolveVisibleModuleKeys(orgId: string): Promise<string[]> {
    const statuses = await this.entitlements.listModules(orgId).catch(() => []);
    return statuses.filter((m) => m.enabled).map((m) => m.moduleKey);
  }

  /** Idempotently creates a checklist + seeded items for each module key. Safe to call repeatedly. */
  async ensureChecklistsForModules(orgId: string, moduleKeys: readonly string[]) {
    for (const moduleKey of moduleKeys) {
      const seeds = CHECKLIST_SEEDS[moduleKey];
      if (!seeds) continue;

      const existing = await this.db.query.moduleSetupChecklists.findFirst({
        where: and(eq(moduleSetupChecklists.orgId, orgId), eq(moduleSetupChecklists.moduleKey, moduleKey)),
      });
      if (existing) continue;

      await this.db.transaction(async (tx) => {
        const [checklist] = await tx
          .insert(moduleSetupChecklists)
          .values({ orgId, moduleKey, status: "not_started", progress: 0 })
          .returning();

        for (const [index, seed] of seeds.entries()) {
          await tx.insert(moduleSetupChecklistItems).values({
            orgId,
            checklistId: checklist.id,
            itemKey: seed.itemKey,
            title: seed.title,
            description: seed.description,
            actionHref: seed.actionHref,
            required: seed.required,
            sortOrder: index,
          });
        }
      });
    }
  }

  /**
   * Existing checklist item rows were snapshotted from CHECKLIST_SEEDS at creation time —
   * ensureChecklistsForModules only inserts missing rows, it never touches rows that already
   * exist. If a seed's title/description/actionHref/required/sortOrder is edited later (e.g. a
   * fixed route), orgs provisioned before that edit keep serving the stale value forever unless
   * something reconciles it. Runs for every module with a seed, not just HR.
   */
  private async syncItemMetadataFromSeed(moduleKey: string, items: (typeof moduleSetupChecklistItems.$inferSelect)[]) {
    const seeds = CHECKLIST_SEEDS[moduleKey];
    if (!seeds) return;
    const seedByKey = new Map(seeds.map((s, index) => [s.itemKey, { ...s, sortOrder: index }]));

    for (const item of items) {
      const seed = seedByKey.get(item.itemKey);
      if (!seed) continue;
      const stale =
        item.title !== seed.title ||
        item.description !== (seed.description ?? null) ||
        item.actionHref !== (seed.actionHref ?? null) ||
        item.required !== seed.required ||
        item.sortOrder !== seed.sortOrder;
      if (!stale) continue;

      await this.db
        .update(moduleSetupChecklistItems)
        .set({
          title: seed.title,
          description: seed.description ?? null,
          actionHref: seed.actionHref ?? null,
          required: seed.required,
          sortOrder: seed.sortOrder,
        })
        .where(eq(moduleSetupChecklistItems.id, item.id));
    }
  }

  /**
   * `includeHr` is resolved by the controller from the caller's HR permissions — the HR entry is
   * silently omitted (not an error) for callers without them, since this is a bulk multi-module
   * listing. Ensures a checklist row exists for every currently-visible module first, so orgs
   * that predate this feature (never routed through org-setup's seeding) self-heal on first read
   * instead of silently returning nothing.
   */
  async listChecklists(orgId: string, includeHr: boolean) {
    const visibleModuleKeys = await this.resolveVisibleModuleKeys(orgId);
    await this.ensureChecklistsForModules(orgId, visibleModuleKeys);
    const checklists = await this.db.query.moduleSetupChecklists.findMany({
      where: eq(moduleSetupChecklists.orgId, orgId),
      with: { items: true },
      limit: 30,
    });
    const visible = checklists.filter(
      (c) => visibleModuleKeys.includes(c.moduleKey) && (c.moduleKey !== "hr" || includeHr),
    );
    await Promise.all(visible.map((c) => this.syncItemMetadataFromSeed(c.moduleKey, c.items)));
    return Promise.all(visible.map((c) => (c.moduleKey === "hr" ? this.reconcileAndReload(orgId, c) : this.reload(c))));
  }

  async getChecklist(orgId: string, moduleKey: string) {
    const visibleModuleKeys = await this.resolveVisibleModuleKeys(orgId);
    if (!visibleModuleKeys.includes(moduleKey)) {
      throw new NotFoundException(`Module setup checklist not found: ${moduleKey}`);
    }
    await this.ensureChecklistsForModules(orgId, [moduleKey]);
    const checklist = await this.db.query.moduleSetupChecklists.findFirst({
      where: and(eq(moduleSetupChecklists.orgId, orgId), eq(moduleSetupChecklists.moduleKey, moduleKey)),
      with: { items: true },
    });
    if (!checklist) throw new NotFoundException(`Module setup checklist not found: ${moduleKey}`);
    await this.syncItemMetadataFromSeed(moduleKey, checklist.items);
    if (moduleKey === "hr") return this.reconcileAndReload(orgId, checklist);
    return this.reload(checklist);
  }

  /** Re-reads a checklist + items — used after syncItemMetadataFromSeed may have updated rows in place. */
  private async reload(checklist: ChecklistWithItems): Promise<ChecklistWithItems> {
    const reloaded = await this.db.query.moduleSetupChecklists.findFirst({
      where: eq(moduleSetupChecklists.id, checklist.id),
      with: { items: true },
    });
    return reloaded ?? checklist;
  }

  /**
   * HR is the only module whose checklist completion is derived from real HR data rather than
   * manual complete-clicks (task requirement). Re-derives todo/done for every non-skipped item
   * on every read, then always reloads — callers must see a state consistent with live data,
   * including any metadata sync (syncItemMetadataFromSeed) that ran on this same `checklist`
   * object before reconciliation, which `changed` here doesn't account for.
   */
  private async reconcileAndReload(orgId: string, checklist: ChecklistWithItems): Promise<ChecklistWithItems> {
    await this.hrReconciliation.reconcile(orgId, checklist.items);
    await this.recomputeProgress(checklist.id);
    return this.reload(checklist);
  }

  private async recomputeProgress(checklistId: number) {
    const items = await this.db.query.moduleSetupChecklistItems.findMany({
      where: eq(moduleSetupChecklistItems.checklistId, checklistId),
      limit: 100,
    });
    const total = items.length;
    const done = items.filter((i) => i.status === "done" || i.status === "skipped").length;
    const progress = total === 0 ? 0 : Math.round((done / total) * 100);
    const requiredIncomplete = items.some((i) => i.required && i.status !== "done" && i.status !== "skipped");
    const status = progress === 100 ? "completed" : progress > 0 ? "in_progress" : "not_started";

    await this.db
      .update(moduleSetupChecklists)
      .set({
        progress,
        status,
        ...(status === "completed" ? { completedAt: new Date() } : {}),
      })
      .where(eq(moduleSetupChecklists.id, checklistId));

    return { progress, status, requiredIncomplete };
  }

  async completeItem(orgId: string, moduleKey: string, itemKey: string, userId: string) {
    const checklist = await this.getChecklist(orgId, moduleKey);
    const item = checklist.items.find((i) => i.itemKey === itemKey);
    if (!item) throw new NotFoundException(`Checklist item not found: ${itemKey}`);

    await this.db
      .update(moduleSetupChecklistItems)
      .set({ status: "done", completedAt: new Date() })
      .where(eq(moduleSetupChecklistItems.id, item.id));

    await this.analytics.track(orgId, userId, "module_checklist_item_completed", { moduleKey, stepKey: itemKey });
    return this.recomputeProgress(checklist.id);
  }

  async skipItem(orgId: string, moduleKey: string, itemKey: string, userId: string, reason?: string) {
    const checklist = await this.getChecklist(orgId, moduleKey);
    const item = checklist.items.find((i) => i.itemKey === itemKey);
    if (!item) throw new NotFoundException(`Checklist item not found: ${itemKey}`);
    if (item.required) {
      throw new BadRequestException(`Checklist item is required and cannot be skipped: ${itemKey}`);
    }

    await this.db
      .update(moduleSetupChecklistItems)
      .set({ status: "skipped", skippedAt: new Date() })
      .where(eq(moduleSetupChecklistItems.id, item.id));

    await this.analytics.track(orgId, userId, "module_checklist_item_skipped", { moduleKey, stepKey: itemKey, metadata: { reason } });
    return this.recomputeProgress(checklist.id);
  }

  /**
   * Dismissal means "stop showing me this proactively" (Skip / Remind later / Finish setup
   * later), not "attest everything is done" — real completion is independently tracked via
   * status/progress, so this intentionally does not require required items to be complete.
   */
  async dismissChecklist(orgId: string, moduleKey: string, userId: string) {
    const checklist = await this.getChecklist(orgId, moduleKey);

    const [updated] = await this.db
      .update(moduleSetupChecklists)
      .set({ dismissedAt: new Date() })
      .where(eq(moduleSetupChecklists.id, checklist.id))
      .returning();

    await this.analytics.track(orgId, userId, "module_checklist_dismissed", { moduleKey });
    return updated;
  }

  /**
   * Reopens a dismissed checklist and gives the user a fresh look at anything they previously
   * skipped. Items already "done" are left as-is — real-data-backed completion is never lost —
   * and will self-correct on the next read if the underlying record is later removed.
   */
  async restartChecklist(orgId: string, moduleKey: string, userId: string) {
    const checklist = await this.getChecklist(orgId, moduleKey);

    await this.db
      .update(moduleSetupChecklists)
      .set({ dismissedAt: null })
      .where(eq(moduleSetupChecklists.id, checklist.id));

    const skippedItemIds = checklist.items.filter((i) => i.status === "skipped").map((i) => i.id);
    if (skippedItemIds.length > 0) {
      await this.db
        .update(moduleSetupChecklistItems)
        .set({ status: "todo", skippedAt: null })
        .where(inArray(moduleSetupChecklistItems.id, skippedItemIds));
    }

    await this.analytics.track(orgId, userId, "module_checklist_restarted", { moduleKey });
    return this.recomputeProgress(checklist.id);
  }
}
