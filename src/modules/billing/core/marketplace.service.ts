import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import {
  appInstallations,
  marketplaceApps,
} from "../../../db/schema";

@Injectable()
export class MarketplaceService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listApps(orgId: string) {
    const [apps, installs] = await Promise.all([
      this.db
        .select({
          id: marketplaceApps.id,
          slug: marketplaceApps.slug,
          name: marketplaceApps.name,
          description: marketplaceApps.description,
          category: marketplaceApps.category,
          iconUrl: marketplaceApps.iconUrl,
          screenshotUrls: marketplaceApps.screenshotUrls,
          features: marketplaceApps.features,
          pricingType: marketplaceApps.pricingType,
          monthlyPrice: marketplaceApps.monthlyPrice,
          annualPrice: marketplaceApps.annualPrice,
          trialDays: marketplaceApps.trialDays,
          isActive: marketplaceApps.isActive,
          sortOrder: marketplaceApps.sortOrder,
          requiredPlan: marketplaceApps.requiredPlan,
          createdAt: marketplaceApps.createdAt,
          updatedAt: marketplaceApps.updatedAt,
        })
        .from(marketplaceApps)
        .where(eq(marketplaceApps.isActive, true))
        .orderBy(marketplaceApps.sortOrder)
        .limit(100),
      this.db
        .select({
          id: appInstallations.id,
          orgId: appInstallations.orgId,
          appId: appInstallations.appId,
          installedBy: appInstallations.installedBy,
          status: appInstallations.status,
          trialEndsAt: appInstallations.trialEndsAt,
          installedAt: appInstallations.installedAt,
          cancelledAt: appInstallations.cancelledAt,
        })
        .from(appInstallations)
        .where(eq(appInstallations.orgId, orgId))
        .limit(100),
    ]);
    const installMap = new Map(installs.map((i) => [i.appId, i]));
    return apps.map((app) => ({
      ...app,
      installation: installMap.get(app.id) ?? null,
    }));
  }

  async installApp(orgId: string, userId: string, appId: number) {
    const [app] = await this.db
      .select({ id: marketplaceApps.id })
      .from(marketplaceApps)
      .where(
        and(eq(marketplaceApps.id, appId), eq(marketplaceApps.isActive, true)),
      )
      .limit(1);
    if (!app) throw new NotFoundException("App not found");

    const [existing] = await this.db
      .select({ id: appInstallations.id, status: appInstallations.status })
      .from(appInstallations)
      .where(
        and(
          eq(appInstallations.orgId, orgId),
          eq(appInstallations.appId, appId),
        ),
      )
      .limit(1);

    if (existing?.status === "ACTIVE") {
      throw new BadRequestException("App is already installed");
    }

    if (existing) {
      const [updated] = await this.db
        .update(appInstallations)
        .set({ status: "ACTIVE", cancelledAt: null })
        .where(eq(appInstallations.id, existing.id))
        .returning();
      return updated;
    }

    const [installation] = await this.db
      .insert(appInstallations)
      .values({ orgId, appId, installedBy: userId, status: "ACTIVE" })
      .returning();
    return installation;
  }

  async uninstallApp(orgId: string, appId: number) {
    const [existing] = await this.db
      .select({ id: appInstallations.id })
      .from(appInstallations)
      .where(
        and(
          eq(appInstallations.orgId, orgId),
          eq(appInstallations.appId, appId),
          eq(appInstallations.status, "ACTIVE"),
        ),
      )
      .limit(1);
    if (!existing) throw new NotFoundException("App is not installed");

    const [updated] = await this.db
      .update(appInstallations)
      .set({ status: "CANCELLED", cancelledAt: new Date() })
      .where(eq(appInstallations.id, existing.id))
      .returning();
    return updated;
  }

  async startAppTrial(orgId: string, userId: string, appId: number) {
    const [app] = await this.db
      .select({ id: marketplaceApps.id, trialDays: marketplaceApps.trialDays })
      .from(marketplaceApps)
      .where(
        and(eq(marketplaceApps.id, appId), eq(marketplaceApps.isActive, true)),
      )
      .limit(1);
    if (!app) throw new NotFoundException("App not found");
    if (!app.trialDays)
      throw new BadRequestException("This app does not offer a trial");

    const [existing] = await this.db
      .select({ id: appInstallations.id })
      .from(appInstallations)
      .where(
        and(
          eq(appInstallations.orgId, orgId),
          eq(appInstallations.appId, appId),
        ),
      )
      .limit(1);
    if (existing)
      throw new BadRequestException("App already installed or trial already used");

    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + app.trialDays);

    const [installation] = await this.db
      .insert(appInstallations)
      .values({
        orgId,
        appId,
        installedBy: userId,
        status: "TRIALING",
        trialEndsAt,
      })
      .returning();
    return installation;
  }
}
