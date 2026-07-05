import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { moduleSetupChecklistItems, moduleSetupChecklists } from "../../db/schema";
import { OnboardingAnalyticsService } from "./onboarding-analytics.service";

interface ChecklistItemSeed {
  itemKey: string;
  title: string;
  description?: string;
  actionHref?: string;
  required: boolean;
}

// Default checklist items per module, per PRD 03 "Module Setup Checklist Examples".
const CHECKLIST_SEEDS: Record<string, ChecklistItemSeed[]> = {
  CRM: [
    { itemKey: "import_contacts", title: "Import contacts/leads", actionHref: "/crm/contacts", required: false },
    { itemKey: "create_pipeline", title: "Create first pipeline", actionHref: "/crm/deals", required: true },
    { itemKey: "invite_sales_team", title: "Invite sales team", actionHref: "/settings/members", required: false },
    { itemKey: "connect_email", title: "Connect email", actionHref: "/settings/integrations", required: false },
  ],
  HR: [
    { itemKey: "add_departments", title: "Add departments", actionHref: "/hr/departments", required: true },
    { itemKey: "invite_employees", title: "Invite employees", actionHref: "/settings/members", required: false },
    { itemKey: "configure_leave_policy", title: "Configure leave policy", actionHref: "/hr/leave-policies", required: false },
    { itemKey: "create_onboarding_plan", title: "Create onboarding plan", actionHref: "/hr/onboarding", required: false },
  ],
  INVENTORY: [
    { itemKey: "create_warehouse", title: "Create warehouse", actionHref: "/inventory/warehouses", required: true },
    { itemKey: "import_products", title: "Import products", actionHref: "/inventory/products", required: false },
    { itemKey: "set_opening_stock", title: "Set opening stock", actionHref: "/inventory/stock", required: false },
    { itemKey: "configure_reorder_rules", title: "Configure reorder rules", actionHref: "/inventory/settings", required: false },
  ],
  FINANCE: [
    { itemKey: "set_fiscal_year", title: "Set fiscal year", actionHref: "/settings/accounting", required: true },
    { itemKey: "configure_taxes", title: "Configure taxes", actionHref: "/settings/taxes", required: true },
    { itemKey: "add_payment_provider", title: "Add bank/payment provider", actionHref: "/settings/payments", required: false },
    { itemKey: "create_first_invoice", title: "Create first invoice", actionHref: "/invoices/new", required: false },
  ],
  PROJECTS: [
    { itemKey: "create_first_project", title: "Create first project", actionHref: "/projects", required: true },
    { itemKey: "invite_team", title: "Invite project team", actionHref: "/settings/members", required: false },
  ],
  HELPDESK: [
    { itemKey: "configure_sla", title: "Configure SLA policy", actionHref: "/support/settings", required: false },
    { itemKey: "create_first_ticket_view", title: "Create first ticket view", actionHref: "/support", required: false },
  ],
  KNOWLEDGE: [
    { itemKey: "create_team_space", title: "Create team space", actionHref: "/knowledge", required: true },
    { itemKey: "add_first_sop", title: "Add first SOP", actionHref: "/knowledge", required: false },
    { itemKey: "invite_collaborators", title: "Invite collaborators", actionHref: "/settings/members", required: false },
  ],
  CHAT: [
    { itemKey: "create_first_channel", title: "Create first channel", actionHref: "/chat", required: false },
  ],
  PAYMENTS: [
    { itemKey: "choose_provider", title: "Choose payment provider", actionHref: "/settings/payments", required: true },
    { itemKey: "add_test_credentials", title: "Add test credentials", actionHref: "/settings/payments", required: true },
    { itemKey: "verify_webhook", title: "Verify webhook", actionHref: "/settings/payments", required: true },
    { itemKey: "run_test_payment", title: "Run test payment", actionHref: "/settings/payments", required: true },
    { itemKey: "activate_live", title: "Activate live payments", actionHref: "/settings/payments", required: false },
  ],
};

@Injectable()
export class ModuleChecklistService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly analytics: OnboardingAnalyticsService,
  ) {}

  /** Idempotently creates a checklist + seeded items for each module key. Safe to call repeatedly. */
  async ensureChecklistsForModules(orgId: string, moduleKeys: string[]) {
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

  async listChecklists(orgId: string, visibleModuleKeys: string[]) {
    const checklists = await this.db.query.moduleSetupChecklists.findMany({
      where: eq(moduleSetupChecklists.orgId, orgId),
      with: { items: true },
    });
    return checklists.filter((c) => visibleModuleKeys.includes(c.moduleKey));
  }

  async getChecklist(orgId: string, moduleKey: string, visibleModuleKeys: string[]) {
    if (!visibleModuleKeys.includes(moduleKey)) {
      throw new NotFoundException(`Module setup checklist not found: ${moduleKey}`);
    }
    const checklist = await this.db.query.moduleSetupChecklists.findFirst({
      where: and(eq(moduleSetupChecklists.orgId, orgId), eq(moduleSetupChecklists.moduleKey, moduleKey)),
      with: { items: true },
    });
    if (!checklist) throw new NotFoundException(`Module setup checklist not found: ${moduleKey}`);
    return checklist;
  }

  private async recomputeProgress(checklistId: number, orgId: string) {
    const items = await this.db.query.moduleSetupChecklistItems.findMany({
      where: eq(moduleSetupChecklistItems.checklistId, checklistId),
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

  async completeItem(orgId: string, moduleKey: string, itemKey: string, userId: string, visibleModuleKeys: string[]) {
    const checklist = await this.getChecklist(orgId, moduleKey, visibleModuleKeys);
    const item = checklist.items.find((i) => i.itemKey === itemKey);
    if (!item) throw new NotFoundException(`Checklist item not found: ${itemKey}`);

    await this.db
      .update(moduleSetupChecklistItems)
      .set({ status: "done", completedAt: new Date() })
      .where(eq(moduleSetupChecklistItems.id, item.id));

    await this.analytics.track(orgId, userId, "module_checklist_item_completed", { moduleKey, stepKey: itemKey });
    return this.recomputeProgress(checklist.id, orgId);
  }

  async skipItem(orgId: string, moduleKey: string, itemKey: string, userId: string, visibleModuleKeys: string[], reason?: string) {
    const checklist = await this.getChecklist(orgId, moduleKey, visibleModuleKeys);
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
    return this.recomputeProgress(checklist.id, orgId);
  }

  async dismissChecklist(orgId: string, moduleKey: string, userId: string, visibleModuleKeys: string[]) {
    const checklist = await this.getChecklist(orgId, moduleKey, visibleModuleKeys);
    const hasRequiredIncomplete = checklist.items.some(
      (i) => i.required && i.status !== "done" && i.status !== "skipped",
    );
    if (hasRequiredIncomplete) {
      throw new BadRequestException("Checklist has required items still incomplete and cannot be dismissed");
    }

    const [updated] = await this.db
      .update(moduleSetupChecklists)
      .set({ dismissedAt: new Date() })
      .where(eq(moduleSetupChecklists.id, checklist.id))
      .returning();

    await this.analytics.track(orgId, userId, "module_checklist_dismissed", { moduleKey });
    return updated;
  }
}
