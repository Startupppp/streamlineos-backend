import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import {
  appInstallations,
  marketplaceApps,
} from "../../db/schema";

@Injectable()
export class MarketplaceService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listApps(orgId: number) {
    const [apps, installs] = await Promise.all([
      this.db
        .select()
        .from(marketplaceApps)
        .where(eq(marketplaceApps.isActive, true))
        .orderBy(marketplaceApps.sortOrder),
      this.db
        .select()
        .from(appInstallations)
        .where(eq(appInstallations.orgId, orgId)),
    ]);
    const installMap = new Map(installs.map((i) => [i.appId, i]));
    return apps.map((app) => ({
      ...app,
      installation: installMap.get(app.id) ?? null,
    }));
  }

  async installApp(orgId: number, userId: number, appId: number) {
    const [app] = await this.db
      .select()
      .from(marketplaceApps)
      .where(
        and(eq(marketplaceApps.id, appId), eq(marketplaceApps.isActive, true)),
      );
    if (!app) throw new NotFoundException("App not found");

    const [existing] = await this.db
      .select()
      .from(appInstallations)
      .where(
        and(
          eq(appInstallations.orgId, orgId),
          eq(appInstallations.appId, appId),
        ),
      );

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

  async uninstallApp(orgId: number, appId: number) {
    const [existing] = await this.db
      .select()
      .from(appInstallations)
      .where(
        and(
          eq(appInstallations.orgId, orgId),
          eq(appInstallations.appId, appId),
          eq(appInstallations.status, "ACTIVE"),
        ),
      );
    if (!existing) throw new NotFoundException("App is not installed");

    const [updated] = await this.db
      .update(appInstallations)
      .set({ status: "CANCELLED", cancelledAt: new Date() })
      .where(eq(appInstallations.id, existing.id))
      .returning();
    return updated;
  }

  async startAppTrial(orgId: number, userId: number, appId: number) {
    const [app] = await this.db
      .select()
      .from(marketplaceApps)
      .where(
        and(eq(marketplaceApps.id, appId), eq(marketplaceApps.isActive, true)),
      );
    if (!app) throw new NotFoundException("App not found");
    if (!app.trialDays)
      throw new BadRequestException("This app does not offer a trial");

    const [existing] = await this.db
      .select()
      .from(appInstallations)
      .where(
        and(
          eq(appInstallations.orgId, orgId),
          eq(appInstallations.appId, appId),
        ),
      );
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
