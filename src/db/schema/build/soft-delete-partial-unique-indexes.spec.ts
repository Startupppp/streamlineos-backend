import { getTableConfig } from "drizzle-orm/pg-core";
import { projectTeams } from "./teams";
import { tickets } from "./ticket-core";
import { projectRisks, projectDecisions } from "./governance";
import { changeRequests } from "./change-requests";
import { projectForms } from "./forms";
import { feedbucketWidgets } from "./feedback";
import type { Index } from "drizzle-orm/pg-core";

function findIndex(indexes: Index[], name: string): Index | undefined {
  return indexes.find((idx) => idx.config.name === name);
}

describe("ticket-63 soft-delete partial unique indexes", () => {
  it("walks enough indexes across all seven tables to avoid a vacuous pass", () => {
    const total =
      getTableConfig(projectTeams).indexes.length +
      getTableConfig(tickets).indexes.length +
      getTableConfig(projectRisks).indexes.length +
      getTableConfig(projectDecisions).indexes.length +
      getTableConfig(changeRequests).indexes.length +
      getTableConfig(projectForms).indexes.length +
      getTableConfig(feedbucketWidgets).indexes.length;
    expect(total).toBeGreaterThan(7);
  });

  it("uniq_project_teams_org_key is unique and has a WHERE predicate restricting it to undeleted rows", () => {
    const idx = findIndex(getTableConfig(projectTeams).indexes, "uniq_project_teams_org_key");
    expect(idx).toBeDefined();
    expect(idx?.config.unique).toBe(true);
    expect(idx?.config.where).toBeDefined();
  });

  it("uniq_tickets_project_number is unique and has a WHERE predicate restricting it to undeleted rows", () => {
    const idx = findIndex(getTableConfig(tickets).indexes, "uniq_tickets_project_number");
    expect(idx).toBeDefined();
    expect(idx?.config.unique).toBe(true);
    expect(idx?.config.where).toBeDefined();
  });

  it("uq_project_risks_project_number is unique and has a WHERE predicate restricting it to undeleted rows", () => {
    const idx = findIndex(getTableConfig(projectRisks).indexes, "uq_project_risks_project_number");
    expect(idx).toBeDefined();
    expect(idx?.config.unique).toBe(true);
    expect(idx?.config.where).toBeDefined();
  });

  it("uq_project_decisions_project_number is unique and has a WHERE predicate restricting it to undeleted rows", () => {
    const idx = findIndex(getTableConfig(projectDecisions).indexes, "uq_project_decisions_project_number");
    expect(idx).toBeDefined();
    expect(idx?.config.unique).toBe(true);
    expect(idx?.config.where).toBeDefined();
  });

  it("uq_change_requests_project_number is unique and has a WHERE predicate restricting it to undeleted rows", () => {
    const idx = findIndex(getTableConfig(changeRequests).indexes, "uq_change_requests_project_number");
    expect(idx).toBeDefined();
    expect(idx?.config.unique).toBe(true);
    expect(idx?.config.where).toBeDefined();
  });

  it("uq_project_forms_project_number is unique and has a WHERE predicate restricting it to undeleted rows", () => {
    const idx = findIndex(getTableConfig(projectForms).indexes, "uq_project_forms_project_number");
    expect(idx).toBeDefined();
    expect(idx?.config.unique).toBe(true);
    expect(idx?.config.where).toBeDefined();
  });

  it("uniq_feedbucket_widgets_public_key is unique and has a WHERE predicate restricting it to undeleted rows", () => {
    const idx = findIndex(getTableConfig(feedbucketWidgets).indexes, "uniq_feedbucket_widgets_public_key");
    expect(idx).toBeDefined();
    expect(idx?.config.unique).toBe(true);
    expect(idx?.config.where).toBeDefined();
  });
});
