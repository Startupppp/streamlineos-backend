import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  users,
  organizations,
  organizationMembers,
  roles,
  permissions,
} from "../db/schema/common/auth";
import {
  roleAssignments,
  rolePermissionGrants,
  accessVersions,
} from "../db/schema/common/access";
import { orgUnits } from "../db/schema/common/organization";
import { subscriptions } from "../db/schema/common/subscriptions";
import { hrPeople, hrEmployments, hrReportingLines } from "../db/schema/hr/core-people";
import { organizationPeople } from "../db/schema/directory/organization-people";
import { leaveTypes, leaveRequests } from "../db/schema/hr/leaves";
import { leavePolicies } from "../db/schema/hr/leave-policies";
import { attendance, holidays, helpdeskTickets } from "../db/schema/hr/attendance";
import { shiftTemplates, employeeShiftAssignments } from "../db/schema/hr/shifts";
import { jobPostings } from "../db/schema/hr/hiring-core";
import { candidates, candidateApplications } from "../db/schema/hr/hiring-candidates";
import { assets } from "../db/schema/hr/assets";
import { documents } from "../db/schema/hr/documents";
import { reviewCycles } from "../db/schema/hr/performance";
import {
  hrWorkflowDefinitions,
  hrWorkflowSteps,
  hrWorkflowInstances,
  hrWorkflowStepActions,
} from "../db/schema/hr/workflow-engine";
import { PERMISSIONS, ROLE_DEFAULT_PERMISSIONS } from "../modules/rbac/permissions";
import { buildPermissionCatalogRows } from "../modules/rbac/permission-catalog-rows";
import { modulesCatalog } from "../db/schema/common/modules";
import { DEFAULT_REGION } from "../common/region/region-registry";

type Db = PostgresJsDatabase<typeof schema>;

const ORG_ID = "e1000001-0000-4000-8000-000000000001";
const ADMIN_ID = "e1000001-0000-4000-8000-000000000002";
const ORG_SLUG = "enterprise-demo-workspace";
const ADMIN_EMAIL = "admin@enterprise-demo.streamlineos.in";

const PEOPLE = [
  { id: "e1000001-0000-4000-8000-000000000003", email: "priya.mgr@enterprise-demo.in", first: "Priya", last: "Sharma", emp: "EMP-MGR-01", worker: "FULL_TIME" as const, status: "ACTIVE" as const, designation: "Engineering Manager", dept: "Engineering", isManager: true },
  { id: "e1000001-0000-4000-8000-000000000004", email: "rahul.mgr@enterprise-demo.in", first: "Rahul", last: "Mehta", role: "HR", emp: "EMP-MGR-02", worker: "FULL_TIME" as const, status: "ACTIVE" as const, designation: "HR Manager", dept: "People Operations", isManager: true },
  { id: "e1000001-0000-4000-8000-000000000005", email: "anita@enterprise-demo.in", first: "Anita", last: "Kapoor", emp: "EMP-001", worker: "FULL_TIME" as const, status: "ACTIVE" as const, designation: "Software Engineer", dept: "Engineering", manager: "priya.mgr@enterprise-demo.in" },
  { id: "e1000001-0000-4000-8000-000000000006", email: "vikram@enterprise-demo.in", first: "Vikram", last: "Singh", emp: "EMP-002", worker: "FULL_TIME" as const, status: "ACTIVE" as const, designation: "Software Engineer", dept: "Engineering", manager: "priya.mgr@enterprise-demo.in" },
  { id: "e1000001-0000-4000-8000-000000000007", email: "neha@enterprise-demo.in", first: "Neha", last: "Gupta", emp: "EMP-003", worker: "FULL_TIME" as const, status: "ACTIVE" as const, designation: "Product Analyst", dept: "Engineering", manager: "priya.mgr@enterprise-demo.in" },
  { id: "e1000001-0000-4000-8000-000000000008", email: "alex.contractor@enterprise-demo.in", first: "Alex", last: "Turner", emp: "CTR-001", worker: "CONTRACTOR" as const, status: "ACTIVE" as const, designation: "DevOps Consultant", dept: "Engineering", manager: "priya.mgr@enterprise-demo.in" },
  { id: "e1000001-0000-4000-8000-000000000009", email: "meera.intern@enterprise-demo.in", first: "Meera", last: "Patel", emp: "INT-001", worker: "INTERN" as const, status: "ACTIVE" as const, designation: "Engineering Intern", dept: "Engineering", manager: "priya.mgr@enterprise-demo.in" },
  { id: "e1000001-0000-4000-8000-00000000000a", email: "sanjay.exited@enterprise-demo.in", first: "Sanjay", last: "Reddy", emp: "EMP-004", worker: "FULL_TIME" as const, status: "EXITED" as const, designation: "Former Analyst", dept: "Engineering", inactive: true },
] as const;

function normalizeDatabaseUrl(url: string): string {
  if (!/\.neon\.tech/i.test(url)) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("channel_binding");
    return parsed.toString();
  } catch {
    return url.replace(/[&?]channel_binding=[^&]*/g, "").replace(/\?&/, "?");
  }
}

async function seedRbac(db: Db, orgId: string, memberUserId: string, memberRole: string): Promise<void> {
  if (PERMISSIONS.length > 0) {
    const catalogModules = new Set(
      (await db.select({ moduleKey: modulesCatalog.moduleKey }).from(modulesCatalog))
        .map((row) => row.moduleKey),
    );
    await db
      .insert(permissions)
      .values(buildPermissionCatalogRows(catalogModules))
      .onConflictDoUpdate({
        target: permissions.name,
        set: {
          resource: sql.raw("excluded.resource"),
          action: sql.raw("excluded.action"),
          description: sql.raw("excluded.description"),
          moduleKey: sql.raw("excluded.module_key"),
          administeringModuleKey: sql.raw("excluded.administering_module_key"),
          isDelegable: sql.raw("excluded.is_delegable"),
        },
      });
  }

  const catalogRows = await db.select({ name: permissions.name }).from(permissions);
  const catalog = new Set(catalogRows.map((r) => r.name));

  for (const slug of Object.keys(ROLE_DEFAULT_PERMISSIONS)) {
    await db.insert(roles).values({
      name: slug === "OWNER" ? "Owner" : slug.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      slug,
      orgId,
      isSystem: true,
    }).onConflictDoNothing({ target: [roles.slug, roles.orgId] });
  }

  const orgRoles = await db.select({ id: roles.id, slug: roles.slug, isSystem: roles.isSystem }).from(roles).where(eq(roles.orgId, orgId));
  for (const role of orgRoles) {
    const keys = [...new Set(role.isSystem ? (ROLE_DEFAULT_PERMISSIONS[role.slug] ?? []) : [])].filter((k) => catalog.has(k));
    if (!keys.length) continue;
    await db.insert(rolePermissionGrants).values(
      keys.map((permissionKey) => ({ orgId, roleId: role.id, permissionKey, scope: "all" as const })),
    ).onConflictDoNothing();
  }

  const ownerRole = orgRoles.find((r) => r.slug === memberRole);
  if (ownerRole) {
    const [memberRow] = await db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, memberUserId)))
      .limit(1);
    if (memberRow !== undefined) {
      await db
        .insert(roleAssignments)
        .values({ orgId, organizationMembershipId: memberRow.id, roleId: ownerRole.id })
        .onConflictDoNothing();
    }
  }
  await db.insert(accessVersions).values({ orgId, permissionsVersion: 1 }).onConflictDoNothing({ target: accessVersions.orgId });
}

async function seed(db: Db): Promise<Record<string, unknown>> {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const [ownerSeqRow] = await db.execute(
    sql`SELECT nextval(pg_get_serial_sequence('organization_members', 'id')) AS id`,
  );
  const ownerMembershipId = Number(ownerSeqRow?.id);

  await db.insert(organizations).values({
    id: ORG_ID,
    region: DEFAULT_REGION,
    ownerMembershipId,
    name: "Enterprise Demo Co",
    slug: ORG_SLUG,
    industry: "Technology",
    companySize: "51-200",
    country: "IN",
    onboardingCompletedAt: now,
    status: "ACTIVE",
  }).onConflictDoNothing({ target: organizations.id });

  await db.insert(users).values({
    id: ADMIN_ID,
    email: ADMIN_EMAIL,
    name: "Enterprise Admin",
    firstName: "Enterprise",
    lastName: "Admin",
    emailVerified: now,
    isActive: true,
    userStatus: "active",
    lastActiveOrgId: ORG_ID,
    activatedAt: now,
  }).onConflictDoUpdate({
    target: users.email,
    set: { isActive: true, lastActiveOrgId: ORG_ID },
  });

  await db.insert(organizationMembers).values({
    id: ownerMembershipId,
    userId: ADMIN_ID,
    orgId: ORG_ID,
    isOwner: true,
  }).onConflictDoNothing();

  const existingSub = await db.select({ id: subscriptions.id }).from(subscriptions).where(eq(subscriptions.orgId, ORG_ID)).limit(1);
  if (!existingSub.length) {
    await db.insert(subscriptions).values({ orgId: ORG_ID, plan: "ENTERPRISE", status: "ACTIVE" });
  } else {
    await db.update(subscriptions).set({ plan: "ENTERPRISE", status: "ACTIVE" }).where(eq(subscriptions.orgId, ORG_ID));
  }

  await seedRbac(db, ORG_ID, ADMIN_ID, "OWNER");

  for (const p of PEOPLE) {
    await db.insert(users).values({
      id: p.id,
      email: p.email,
      name: `${p.first} ${p.last}`,
      firstName: p.first,
      lastName: p.last,
      emailVerified: now,
      isActive: !("inactive" in p && p.inactive),
      userStatus: p.status === "EXITED" ? "inactive" : "active",
      lastActiveOrgId: ORG_ID,
      activatedAt: now,
    }).onConflictDoNothing({ target: users.email });

    await db.insert(organizationMembers).values({
      userId: p.id,
      orgId: ORG_ID,
      isOwner: false,
    }).onConflictDoNothing();
  }

  const membershipRows = await db
    .select({ userId: organizationMembers.userId, id: organizationMembers.id })
    .from(organizationMembers)
    .where(eq(organizationMembers.orgId, ORG_ID));
  const membershipByUserId = new Map<string, number>(membershipRows.map((m) => [m.userId, m.id]));

  for (const d of [
    { name: "Engineering", code: "ENG", headUserId: PEOPLE[0].id },
    { name: "People Operations", code: "HR", headUserId: PEOPLE[1].id },
  ]) {
    await db.insert(orgUnits).values({ orgId: ORG_ID, kind: "DEPARTMENT", name: d.name, code: d.code, headMembershipId: membershipByUserId.get(d.headUserId) ?? null }).onConflictDoNothing();
  }
  const deptUnitRows = await db
    .select({ id: orgUnits.id, name: orgUnits.name })
    .from(orgUnits)
    .where(and(eq(orgUnits.orgId, ORG_ID), eq(orgUnits.kind, "DEPARTMENT")));
  const deptIds = new Map<string, string>(deptUnitRows.map((r) => [r.name, r.id]));
  for (const t of [
    { name: "Platform Team", code: "PLAT", leadId: PEOPLE[0].id },
    { name: "Talent Team", code: "TA", leadId: PEOPLE[1].id },
  ]) {
    await db.insert(orgUnits).values({ orgId: ORG_ID, kind: "TEAM", name: t.name, code: t.code, headMembershipId: membershipByUserId.get(t.leadId) ?? null }).onConflictDoNothing();
  }
  for (const loc of [
    { name: "Mumbai HQ", code: "BOM", city: "Mumbai" },
    { name: "Bangalore Tech Park", code: "BLR", city: "Bangalore" },
  ]) {
    await db.insert(orgUnits).values({
      orgId: ORG_ID,
      kind: "LOCATION",
      name: loc.name,
      code: loc.code,
      metadata: { city: loc.city, country: "IN", locationType: "OFFICE" as const },
    }).onConflictDoNothing();
  }

  const locRows = await db
    .select({ id: orgUnits.id })
    .from(orgUnits)
    .where(and(eq(orgUnits.orgId, ORG_ID), eq(orgUnits.kind, "LOCATION")))
    .limit(1);
  const locId = locRows[0]?.id ?? null;
  const employmentIds = new Map<string, number>();

  for (const p of PEOPLE) {
    const [directoryPerson] = await db
      .insert(organizationPeople)
      .values({
        organizationId: ORG_ID,
        userId: p.id,
        firstName: p.first,
        lastName: p.last,
        workEmail: p.email,
      })
      .onConflictDoNothing()
      .returning({ organizationPersonId: organizationPeople.organizationPersonId });

    let organizationPersonId = directoryPerson?.organizationPersonId;
    if (!organizationPersonId) {
      const existingDirectory = await db
        .select({ organizationPersonId: organizationPeople.organizationPersonId })
        .from(organizationPeople)
        .where(
          and(
            eq(organizationPeople.organizationId, ORG_ID),
            eq(organizationPeople.workEmail, p.email),
          ),
        )
        .limit(1);
      organizationPersonId = existingDirectory[0]?.organizationPersonId;
    }
    if (!organizationPersonId) continue;

    // Look the person up rather than relying on a conflict target: this seed must run before
    // migration 1067, which is what creates the (org_id, user_id) index it would conflict on.
    const existing = await db
      .select({ id: hrPeople.id })
      .from(hrPeople)
      .where(
        and(
          eq(hrPeople.orgId, ORG_ID),
          eq(hrPeople.organizationPersonId, organizationPersonId),
        ),
      )
      .limit(1);

    let personId = existing[0]?.id;
    if (!personId) {
      const [person] = await db
        .insert(hrPeople)
        .values({ orgId: ORG_ID, userId: p.id, organizationPersonId })
        .onConflictDoNothing()
        .returning({ id: hrPeople.id });
      personId = person?.id;
    }
    if (!personId) continue;

    const [emp] = await db.insert(hrEmployments).values({
      orgId: ORG_ID,
      personId,
      employeeNumber: p.emp,
      lifecycleStatus: p.status,
      workerType: p.worker,
      departmentId: deptIds.get(p.dept) ?? null,
      locationId: locId,
      designation: p.designation,
      joiningDate: "2025-01-15",
      exitDate: p.status === "EXITED" ? "2026-05-30" : null,
      lastWorkingDay: p.status === "EXITED" ? "2026-05-30" : null,
    }).onConflictDoNothing().returning({ id: hrEmployments.id });

    if (emp) employmentIds.set(p.email, emp.id);
  }

  const priyaEmp = employmentIds.get(PEOPLE[0].email);
  if (priyaEmp) {
    for (const p of PEOPLE) {
      if ("manager" in p && p.manager === PEOPLE[0].email) {
        const reporteeId = employmentIds.get(p.email);
        if (reporteeId) {
          const existingLine = await db
            .select({ id: hrReportingLines.id })
            .from(hrReportingLines)
            .where(and(
              eq(hrReportingLines.orgId, ORG_ID),
              eq(hrReportingLines.employmentId, reporteeId),
              eq(hrReportingLines.managerEmploymentId, priyaEmp),
              eq(hrReportingLines.effectiveFrom, "2025-01-15"),
            ))
            .limit(1);
          if (!existingLine.length) {
            await db.insert(hrReportingLines).values({
              orgId: ORG_ID,
              employmentId: reporteeId,
              managerEmploymentId: priyaEmp,
              effectiveFrom: "2025-01-15",
            });
          }
        }
      }
    }
  }

  const [leaveType] = await db.insert(leaveTypes).values({
    orgId: ORG_ID,
    name: "Annual Leave",
    daysPerYear: 18,
    carryForward: true,
  }).onConflictDoNothing().returning({ id: leaveTypes.id });

  const leaveTypeId = leaveType?.id ?? (await db.select({ id: leaveTypes.id }).from(leaveTypes).where(eq(leaveTypes.orgId, ORG_ID)).limit(1))[0]?.id;
  if (leaveTypeId) {
    const existingPolicy = await db
      .select({ id: leavePolicies.id })
      .from(leavePolicies)
      .where(and(
        eq(leavePolicies.orgId, ORG_ID),
        eq(leavePolicies.leaveTypeId, leaveTypeId),
        eq(leavePolicies.name, "Standard Annual Leave"),
      ))
      .limit(1);
    if (!existingPolicy.length) {
      await db.insert(leavePolicies).values({
        orgId: ORG_ID,
        leaveTypeId,
        name: "Standard Annual Leave",
        accrualRate: "1.5",
        effectiveFrom: "2026-01-01",
      });
    }
  }

  const existingHoliday = await db
    .select({ id: holidays.id })
    .from(holidays)
    .where(and(
      eq(holidays.orgId, ORG_ID),
      eq(holidays.name, "Independence Day"),
      eq(holidays.date, "2026-08-15"),
    ))
    .limit(1);
  if (!existingHoliday.length) {
    await db.insert(holidays).values({
      orgId: ORG_ID,
      name: "Independence Day",
      date: "2026-08-15",
      isPublic: true,
    });
  }

  const [shift] = await db.insert(shiftTemplates).values({
    orgId: ORG_ID,
    name: "General Shift",
    startTime: "09:00:00",
    endTime: "18:00:00",
  }).onConflictDoNothing().returning({ id: shiftTemplates.id });

  if (shift) {
    await db.insert(employeeShiftAssignments).values({
      orgId: ORG_ID,
      userId: PEOPLE[2].id,
      shiftId: shift.id,
      effectiveFrom: "2026-01-01",
    }).onConflictDoNothing();
  }

  const checkIn = new Date(`${today}T09:15:00`);
  const checkOut = new Date(`${today}T18:05:00`);
  const existingAttendance = await db
    .select({ id: attendance.id })
    .from(attendance)
    .where(and(
      eq(attendance.orgId, ORG_ID),
      eq(attendance.userId, PEOPLE[2].id),
      eq(attendance.date, today),
    ))
    .limit(1);
  if (!existingAttendance.length) {
    await db.insert(attendance).values({
      orgId: ORG_ID,
      userId: PEOPLE[2].id,
      date: today,
      checkIn,
      checkOut,
      status: "PRESENT",
      workHours: "8.50",
    });
  }

  const existingJob = await db
    .select({ id: jobPostings.id })
    .from(jobPostings)
    .where(and(eq(jobPostings.orgId, ORG_ID), eq(jobPostings.title, "Senior Software Engineer")))
    .limit(1);
  let jobPostingId: number | undefined = existingJob[0]?.id;
  if (jobPostingId === undefined) {
    const [job] = await db.insert(jobPostings).values({
      orgId: ORG_ID,
      title: "Senior Software Engineer",
      orgDepartmentId: deptIds.get("Engineering") ?? null,
      location: "Mumbai / Remote",
      type: "FULL_TIME",
      description: "Build scalable HR and enterprise products.",
      status: "OPEN",
      postedBy: ADMIN_ID,
    }).returning({ id: jobPostings.id });
    jobPostingId = job?.id;
  }

  const existingCandidate = await db
    .select({ id: candidates.id })
    .from(candidates)
    .where(and(eq(candidates.orgId, ORG_ID), eq(candidates.email, "arjun.iyer.candidate@example.com")))
    .limit(1);
  let candidateId: number | undefined = existingCandidate[0]?.id;
  if (candidateId === undefined) {
    const [ins] = await db.insert(candidates).values({
      orgId: ORG_ID,
      firstName: "Arjun",
      lastName: "Iyer",
      email: "arjun.iyer.candidate@example.com",
      phone: "+91-9876543210",
      source: "LINKEDIN",
      status: "SCREENING",
      currentRole: "Software Engineer",
      currentCompany: "Acme Tech",
    }).returning({ id: candidates.id });
    candidateId = ins?.id;
  }

  if (jobPostingId !== undefined && candidateId !== undefined) {
    const existingApp = await db
      .select({ id: candidateApplications.id })
      .from(candidateApplications)
      .where(and(
        eq(candidateApplications.orgId, ORG_ID),
        eq(candidateApplications.candidateId, candidateId),
        eq(candidateApplications.jobPostingId, jobPostingId),
      ))
      .limit(1);
    if (!existingApp.length) {
      await db.insert(candidateApplications).values({
        orgId: ORG_ID,
        candidateId,
        jobPostingId,
        status: "APPLIED",
      });
    }
  }

  const existingDoc = await db
    .select({ id: documents.id })
    .from(documents)
    .where(and(
      eq(documents.orgId, ORG_ID),
      eq(documents.userId, PEOPLE[2].id),
      eq(documents.name, "Offer Letter - Anita Kapoor"),
    ))
    .limit(1);
  if (!existingDoc.length) {
    await db.insert(documents).values({
      orgId: ORG_ID,
      userId: PEOPLE[2].id,
      name: "Offer Letter - Anita Kapoor",
      type: "OFFER_LETTER",
      fileUrl: "https://example.com/docs/offer-anita.pdf",
      fileName: "offer-anita.pdf",
      uploadedBy: ADMIN_ID,
    });
  }

  const existingAsset = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.orgId, ORG_ID), eq(assets.serialNumber, "MBP-ENT-001")))
    .limit(1);
  if (!existingAsset.length) {
    await db.insert(assets).values({
      orgId: ORG_ID,
      name: "MacBook Pro 14",
      type: "LAPTOP",
      brand: "Apple",
      model: "M3 Pro",
      serialNumber: "MBP-ENT-001",
      assignedTo: PEOPLE[2].id,
      status: "ASSIGNED",
      purchaseDate: "2025-06-01",
      location: "Mumbai HQ",
    });
  }

  const existingTicket = await db
    .select({ id: helpdeskTickets.id })
    .from(helpdeskTickets)
    .where(and(
      eq(helpdeskTickets.orgId, ORG_ID),
      eq(helpdeskTickets.userId, PEOPLE[2].id),
      eq(helpdeskTickets.title, "Laptop fan noise issue"),
    ))
    .limit(1);
  if (!existingTicket.length) {
    await db.insert(helpdeskTickets).values({
      orgId: ORG_ID,
      userId: PEOPLE[2].id,
      title: "Laptop fan noise issue",
      description: "Fan runs loudly during video calls.",
      category: "IT",
      priority: "MEDIUM",
      status: "TODO",
      assigneeId: ADMIN_ID,
    });
  }

  const existingCycle = await db
    .select({ id: reviewCycles.id })
    .from(reviewCycles)
    .where(and(eq(reviewCycles.orgId, ORG_ID), eq(reviewCycles.name, "H1 2026 Performance Review")))
    .limit(1);
  if (!existingCycle.length) {
    await db.insert(reviewCycles).values({
      orgId: ORG_ID,
      name: "H1 2026 Performance Review",
      type: "HALF_YEARLY",
      periodStart: "2026-01-01",
      periodEnd: "2026-06-30",
      deadline: "2026-07-15",
      status: "ACTIVE",
      createdBy: ADMIN_ID,
    });
  }

  const [wfDef] = await db.insert(hrWorkflowDefinitions).values({
    orgId: ORG_ID,
    objectType: "leave_request",
    name: "Leave Approval",
    status: "active",
    isDefault: true,
  }).onConflictDoNothing().returning({ id: hrWorkflowDefinitions.id });

  if (wfDef && leaveTypeId) {
    const [step] = await db.insert(hrWorkflowSteps).values({
      orgId: ORG_ID,
      definitionId: wfDef.id,
      stepOrder: 1,
      name: "Manager Approval",
      approverType: "direct_manager",
      mode: "serial",
    }).onConflictDoNothing().returning({ id: hrWorkflowSteps.id });

    const [leaveReq] = await db.insert(leaveRequests).values({
      orgId: ORG_ID,
      userId: PEOPLE[2].id,
      leaveTypeId,
      startDate: "2026-07-20",
      endDate: "2026-07-22",
      reason: "Family event",
      status: "PENDING",
      approverId: PEOPLE[0].id,
    }).onConflictDoNothing().returning({ id: leaveRequests.id });

    if (leaveReq && step) {
      const [instance] = await db.insert(hrWorkflowInstances).values({
        orgId: ORG_ID,
        definitionId: wfDef.id,
        definitionSnapshot: { steps: [{ order: 1, name: "Manager Approval" }] },
        objectType: "leave_request",
        objectId: String(leaveReq.id),
        requestedBy: PEOPLE[2].id,
        subjectEmployeeId: PEOPLE[2].id,
        status: "in_progress",
        currentStepOrder: 1,
      }).onConflictDoNothing().returning({ id: hrWorkflowInstances.id });

      if (instance) {
        await db.insert(hrWorkflowStepActions).values({
          orgId: ORG_ID,
          instanceId: instance.id,
          stepOrder: 1,
          approverUserId: PEOPLE[0].id,
          actedByUserId: PEOPLE[0].id,
          action: "commented",
          comment: "Please confirm coverage plan before approval.",
        }).onConflictDoNothing();
      }
    }
  }

  return {
    seed: "enterprise-workspace-complete",
    orgId: ORG_ID,
    slug: ORG_SLUG,
    adminEmail: ADMIN_EMAIL,
    plan: "ENTERPRISE",
    employees: PEOPLE.length,
    departments: 2,
    teams: 2,
    managers: 2,
    locations: 2,
    loginUrl: process.env.APP_URL ?? "http://localhost:1000",
    apiUrl: `http://localhost:${process.env.PORT ?? 1500}`,
  };
}

async function main(): Promise<void> {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required");
  const client = postgres(normalizeDatabaseUrl(raw), { prepare: false, max: 5 });
  const db = drizzle(client, { schema });
  try {
    const summary = await seed(db);
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[seed-enterprise-workspace] failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
