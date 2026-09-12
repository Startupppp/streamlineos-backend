import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { npsResponses, npsSurveys, webLeadForms } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { withPublicToken } from "../../common/tenant/with-public-token";
import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { categoryForScore } from "./public.helpers";
import type { LeadFormBody, NpsSubmitInput } from "./dto/public.schemas";
import { CrmAutomationBusService } from "../crm/automation-studio/crm-automation-bus.service";
import { PlanLimitsService } from "../billing/core/plan-limits.service";
import { createMirroredLead } from "../party/party-legacy-leads";

@Injectable()
export class CrmService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly bus: CrmAutomationBusService,
    private readonly planLimits: PlanLimitsService,
  ) {}

  async getSurvey(token: string) {
    const [survey] = await withPublicToken(this.db, token, (tx) =>
      tx
        .select({
          title: npsSurveys.title,
          question: npsSurveys.question,
          status: npsSurveys.status,
        })
        .from(npsSurveys)
        .where(eq(npsSurveys.publicToken, token)),
    );

    if (!survey || survey.status !== "active") {
      throw new NotFoundException("Survey not found");
    }

    return { survey };
  }

  async submitSurvey(token: string, input: NpsSubmitInput) {
    const [survey] = await withPublicToken(this.db, token, (tx) =>
      tx
        .select({
          id: npsSurveys.id,
          orgId: npsSurveys.orgId,
          status: npsSurveys.status,
        })
        .from(npsSurveys)
        .where(eq(npsSurveys.publicToken, token)),
    );

    if (!survey || survey.status !== "active") {
      throw new NotFoundException("Survey not found or no longer active");
    }

    const email = input.email && input.email.length > 0 ? input.email : null;

    await runInTenantTransaction(
      this.db,
      async (tx) => {
        await tx.insert(npsResponses).values({
          orgId: survey.orgId,
          surveyId: survey.id,
          score: input.score,
          category: categoryForScore(input.score),
          comment: input.comment && input.comment.length > 0 ? input.comment : null,
          respondentName: input.name && input.name.length > 0 ? input.name : null,
          respondentEmail: email,
        });
      },
      { orgId: survey.orgId },
    );

    return { success: true };
  }

  async getLeadForm(token: string) {
    const [form] = await withPublicToken(this.db, token, (tx) =>
      tx
        .select({
          name: webLeadForms.name,
          fields: webLeadForms.fields,
          submitMessage: webLeadForms.submitMessage,
          redirectUrl: webLeadForms.redirectUrl,
          isActive: webLeadForms.isActive,
        })
        .from(webLeadForms)
        .where(eq(webLeadForms.publicToken, token)),
    );

    if (!form || !form.isActive) throw new NotFoundException("Form not found");

    return { form };
  }

  async submitLeadForm(token: string, body: LeadFormBody) {
    const form = await withPublicToken(this.db, token, async (tx) => {
      const [row] = await tx.select().from(webLeadForms).where(eq(webLeadForms.publicToken, token));
      return row;
    });

    if (!form || !form.isActive) {
      throw new NotFoundException("Form not found or inactive");
    }

    /**
     * The quota check needs a tenant, and a public request does not have one.
     *
     * `fetchCount("crmLeads")` counts `business_parties` joined to
     * `lead_party_map`, both of which carry `tenant_isolation`. That policy
     * fails closed: with no `app.organization_id` on the connection it raises
     * "no tenant context" rather than returning zero rows, `assertWithinLimit`
     * catches the failure and turns it into a 503 — so every submission through
     * a public lead form was refused, on every plan, whatever the quota.
     * Nothing upstream noticed, because a 503 from a limit check reads as a
     * transient database wobble rather than a permanently closed door.
     *
     * Its own transaction rather than the write's, so the check keeps happening
     * before the required-field validation exactly as it did: a request that is
     * over quota is told so whether or not it is also malformed.
     */
    await runInTenantTransaction(
      this.db,
      () => this.planLimits.assertWithinLimit(form.orgId, "crmLeads"),
      { orgId: form.orgId },
    );

    for (const field of form.fields) {
      const val = body[field.name];
      if (field.required && (val === undefined || val === null || val === "")) {
        throw new BadRequestException(`${field.label} is required`);
      }
    }

    const strField = (key: string): string | null => {
      const val = body[key];
      return typeof val === "string" && val.length > 0 ? val : null;
    };

    const leadName =
      strField("name") ??
      strField("full_name") ??
      (strField("first_name")
        ? `${strField("first_name") ?? ""}${
            strField("last_name") ? " " + strField("last_name") : ""
          }`.trim()
        : null) ??
      "Unknown";

    const leadNotes = strField("message") ?? strField("notes");

    const insertedLead = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const lead = await createMirroredLead(
          tx,
          form.orgId,
          {
            orgId: form.orgId,
            name: leadName,
            email: strField("email"),
            phone: strField("phone"),
            company: strField("company"),
            notes: leadNotes,
            source: "website",
            customData: body,
          },
          { linkedBy: "public:web-form" },
        );

        await tx
          .update(webLeadForms)
          .set({
            totalSubmissions: sql`${webLeadForms.totalSubmissions} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(webLeadForms.id, form.id));

        return lead;
      },
      { orgId: form.orgId },
    );

    if (insertedLead !== undefined) {
      void this.bus.emit(form.orgId, "form.submitted", {
        entityType: "lead",
        entityId: String(insertedLead.id),
        data: { formId: form.id, formName: form.name },
      }).catch(() => undefined);
    }

    return {
      success: true,
      message: form.submitMessage ?? "Thank you! We'll be in touch soon.",
      redirectUrl: form.redirectUrl ?? null,
    };
  }
}
