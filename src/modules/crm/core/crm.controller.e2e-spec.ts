import { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createE2eApp } from "test/helpers/e2e-app";

describe("CRM auth (e2e)", () => {
  let app: INestApplication;
  beforeAll(async () => {
    app = await createE2eApp();
  });
  afterAll(async () => app.close());

  type Method = "get" | "post" | "patch" | "delete";
  const routes: ReadonlyArray<[Method, string]> = [
    ["get", "/crm/organizations"],
    ["post", "/crm/organizations"],
    ["get", "/crm/organizations/1"],
    ["patch", "/crm/organizations/1"],
    ["delete", "/crm/organizations/1"],
    ["get", "/crm/organizations/1/hierarchy"],
    ["get", "/crm/organizations/1/related-leads"],
    ["get", "/crm/organizations/1/roll-up"],
    ["get", "/crm/organizations/1/timeline"],
    ["get", "/crm/people-slugs"],
    ["get", "/crm/consent/contacts/1"],
    ["post", "/crm/consent/contacts/1"],
    ["get", "/crm/consent/missing"],
    ["get", "/crm/people/some-slug"],
    ["get", "/crm/sla/policies"],
    ["post", "/crm/sla/policies"],
    ["patch", "/crm/sla/policies/1"],
    ["delete", "/crm/sla/policies/1"],
    ["get", "/crm/sla/breached"],
    ["get", "/crm/sla/report"],
    ["get", "/crm/territories"],
    ["post", "/crm/territories"],
    ["patch", "/crm/territories/1"],
    ["delete", "/crm/territories/1"],
    ["get", "/crm/web-forms"],
    ["post", "/crm/web-forms"],
    ["patch", "/crm/web-forms/1"],
    ["delete", "/crm/web-forms/1"],
    ["get", "/crm/assignment-rules"],
    ["post", "/crm/assignment-rules"],
    ["patch", "/crm/assignment-rules/reorder"],
    ["patch", "/crm/assignment-rules/1"],
    ["delete", "/crm/assignment-rules/1"],
    ["get", "/crm/scoring-rules"],
    ["post", "/crm/scoring-rules"],
    ["patch", "/crm/scoring-rules/1"],
    ["delete", "/crm/scoring-rules/1"],
    ["get", "/crm/email-templates"],
    ["post", "/crm/email-templates"],
    ["patch", "/crm/email-templates/1"],
    ["delete", "/crm/email-templates/1"],
    ["get", "/crm/sales-dashboard"],
    ["get", "/crm/support-dashboard"],
    ["get", "/crm/customer-executive"],
  ];

  function callRoute(method: Method, path: string): request.Test {
    const agent = request(app.getHttpServer());
    switch (method) {
      case "get":
        return agent.get(path);
      case "post":
        return agent.post(path);
      case "patch":
        return agent.patch(path);
      case "delete":
        return agent.delete(path);
    }
  }

  it.each(routes)("401 on %s %s without a token", async (method, path) => {
    const res = await callRoute(method, path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: "UNAUTHORIZED", message: "Unauthorized" });
  });
});
