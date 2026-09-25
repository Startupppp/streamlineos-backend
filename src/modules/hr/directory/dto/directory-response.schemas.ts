import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../../common/openapi/wire-types";
import { successSchema } from "../../../../common/openapi/response-envelopes";
import { EMPLOYEE_ADMISSION_STATUSES } from "../employee-admission-status";
import { INVITE_DELIVERY_STATUSES } from "../employee-invite-delivery";

export { successSchema };

export const accessRequestRowSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  employeeId: z.string(),
  systemName: z.string(),
  accessLevel: z.string(),
  status: z.string(),
  grantedBy: z.string().nullable(),
  revokedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const assetRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  type: z.string(),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  serialNumber: z.string().nullable(),
  assignedTo: z.string().nullable(),
  assignedToMembershipId: z.number().int().nullable(),
  status: z.string(),
  purchaseDate: z.string().nullable(),
  purchaseCost: z.string().nullable(),
  location: z.string().nullable(),
  notes: z.string().nullable(),
  expectedReturnDate: z.string().nullable(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const assetCountsSchema = z.object({
  total: z.number().int(),
  available: z.number().int(),
  assigned: z.number().int(),
  maintenance: z.number().int(),
  retired: z.number().int(),
});

export const assetListPageSchema = z.object({
  data: z.array(assetRowSchema),
  counts: assetCountsSchema,
  pagination: z.object({
    limit: z.number().int(),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
  }),
});

export const assetReturnRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  assetId: z.number().int().nullable(),
  assetName: z.string(),
  assetType: z.string().nullable(),
  serialNumber: z.string().nullable(),
  status: z.string(),
  returnedAt: nullableWireDate(),
  condition: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: wireDate(),
  employeeName: z.string().nullable(),
});

export const deviceRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  deviceType: z.string(),
  deviceName: z.string(),
  serialNumber: z.string().nullable(),
  brand: z.string().nullable(),
  model: z.string().nullable(),
  assignedDate: z.string().nullable(),
  returnDate: z.string().nullable(),
  status: z.string(),
  notes: z.string().nullable(),
  createdAt: wireDate(),
  user: z.object({
    id: z.string(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    email: z.string().nullable(),
  }),
});

export const bgvUserSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
  image: z.string().nullable(),
  designation: z.string().nullable(),
  employeeId: z.string().nullable(),
});

export const bgvRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  type: z.string(),
  status: z.string(),
  provider: z.string().nullable(),
  referenceNumber: z.string().nullable(),
  result: z.string().nullable(),
  notes: z.string().nullable(),
  completedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  user: bgvUserSchema.nullable(),
});

const directoryMemberSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
  image: z.string().nullable(),
  designation: z.string().nullable(),
  role: z.string(),
  phone: z.string().nullable(),
  reportingTo: z.string().nullable(),
  employeeId: z.string().nullable(),
  department: z.object({ id: z.string(), name: z.string() }).nullable(),
});

export const directoryListSchema = z.array(directoryMemberSchema);

export const celebrationsResponseSchema = z.object({
  todayBirthdays: z.array(z.object({
    id: z.string(),
    name: z.string().nullable(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    image: z.string().nullable(),
    dateOfBirth: z.string().nullable(),
    joiningDate: z.string().nullable(),
  })),
  upcomingBirthdays: z.array(z.object({
    id: z.string(),
    name: z.string().nullable(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    image: z.string().nullable(),
    dateOfBirth: z.string().nullable(),
    joiningDate: z.string().nullable(),
  })),
  todayAnniversaries: z.array(z.object({
    id: z.string(),
    name: z.string().nullable(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    image: z.string().nullable(),
    dateOfBirth: z.string().nullable(),
    joiningDate: z.string().nullable(),
    years: z.number().int(),
  })),
});

const orgChartNodeSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  role: z.string().nullable(),
  designation: z.string().nullable(),
  image: z.string().nullable(),
  departmentId: z.string().nullable(),
  departmentName: z.string().nullable(),
  hasDirectReports: z.boolean(),
  /**
   * V-026. Additive. A root of this page is anyone with no VISIBLE manager, so
   * the page mixes the founder with every hire nobody has assigned a manager
   * to. Splitting those on `hasDirectReports` produced a tree with several
   * apparent CEOs; the owner is the only one of them the organisation actually
   * has.
   */
  isOwner: z.boolean(),
});

export const orgChartPageSchema = z.object({
  data: z.array(orgChartNodeSchema),
  pageInfo: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

export const headcountGroupSchema = z.array(z.object({
  groupId: z.union([z.string(), z.number().int()]).nullable(),
  groupName: z.string().nullable(),
  headcount: z.number().int(),
}));

const teamMemberSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  image: z.string().nullable(),
  email: z.string().nullable(),
  role: z.string(),
  designation: z.string().nullable(),
});

export const teamDetailSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  managerId: z.string().nullable(),
  managerName: z.string().nullable(),
  membersTruncated: z.boolean(),
  members: z.array(teamMemberSchema),
});

export const employeeListItemSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string().nullable(),
  role: z.string(),
  designation: z.string().nullable(),
  employeeId: z.string().nullable(),
  department: z.object({ id: z.string(), name: z.string() }).nullable(),
  image: z.string().nullable(),
  isActive: z.boolean(),
  /**
   * PROVISIONAL (product default E-4): derived at read time, never stored —
   * the invitee accepted (came through the magic link) rather than merely
   * having an account row. Without it a never-accepted invitee badges as
   * "Active" beside a counter saying "Pending invite: 1".
   */
  hasAccepted: z.boolean(),
  joiningDate: z.string().nullable(),
  reportingTo: z.string().nullable(),
});

export const employeeListPageSchema = z.object({
  data: z.array(employeeListItemSchema),
  pageInfo: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

export const inviteDeliverySchema = z.object({
  sent: z.boolean(),
  reason: z.string().nullable(),
});

export type InviteDelivery = z.infer<typeof inviteDeliverySchema>;

/**
 * HRMS-E2E-018. What is known about the last invite email for an employee.
 *
 * The enum is `INVITE_DELIVERY_STATUSES` and deliberately has no `delivered` and no
 * `bounced` member: neither is observable per message, because the provider bounce
 * webhook is keyed on the address and carries no message id to join back to an
 * outbox row. `deliveryConfirmed` is pinned to `false` in the contract so no future
 * caller can quietly start asserting arrival without changing this schema first.
 */
export const inviteDeliveryStatusSchema = z.object({
  status: z.enum(INVITE_DELIVERY_STATUSES),
  queuedAt: nullableWireDate(),
  sentAt: nullableWireDate(),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  deliveryConfirmed: z.literal(false),
});

export type InviteDeliveryStatusResponse = z.infer<
  typeof inviteDeliveryStatusSchema
>;

/**
 * A join link handed to an administrator to pass on directly.
 *
 * The token lives in `inviteUrl` and nowhere else — not in a log, not in the
 * audit row, not in a second field — so the response is the only copy and the
 * caller is expected to hand it over rather than keep it.
 */
export const inviteLinkSchema = z.object({
  inviteUrl: z.string().url(),
  expiresAt: z.string(),
  email: z.string().email(),
});

export type InviteLink = z.infer<typeof inviteLinkSchema>;

export const employeeCountsSchema = z.object({
  active: z.number().int(),
  /**
   * Invited, account created, never accepted. Split out of `active` because an
   * account flag is set the moment an administrator creates the person, so a
   * hire who has never signed in was being counted as headcount.
   */
  pending: z.number().int(),
  inactive: z.number().int(),
});

export const onboardResponseSchema = z.object({
  success: z.boolean(),
  userId: z.string(),
  invite: inviteDeliverySchema,
});

export const resendInviteResponseSchema = z.object({
  success: z.boolean(),
  invite: inviteDeliverySchema,
});

export const bulkOnboardResultSchema = z.object({
  total: z.number().int(),
  created: z.number().int(),
  failed: z.number().int(),
  results: z.array(z.record(z.string(), z.unknown())),
});

export const checkEmailSchema = z.object({
  exists: z.boolean(),
  status: z.enum(EMPLOYEE_ADMISSION_STATUSES),
  memberStatus: z.enum(["SUSPENDED", "LEFT"]).nullable(),
});

export const employeeStatsSchema = z.object({
  leaves: z.object({
    total: z.number().int(),
    approved: z.number().int(),
    pending: z.number().int(),
    rejected: z.number().int(),
    byType: z.record(z.string(), z.number().int()),
  }),
  attendance: z.object({
    daysPresent: z.number().int(),
    daysAbsent: z.number().int(),
    daysLate: z.number().int(),
    totalHours: z.string(),
    avgHoursPerDay: z.string(),
  }).nullable(),
});

const anniversaryFeedItemSchema = z.object({
  userId: z.string().nullable(),
  name: z.string().nullable(),
  image: z.string().nullable(),
  type: z.string(),
  daysAway: z.number().int(),
  dateStr: z.string(),
  yearsCount: z.number().int().optional(),
});

export const anniversaryFeedSchema = z.array(anniversaryFeedItemSchema);

export const availabilityItemSchema = z.object({
  userId: z.string(),
  status: z.string(),
  leaveType: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

export const availabilityListSchema = z.array(availabilityItemSchema);

const expertResultSchema = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  image: z.string().nullable(),
  designation: z.string().nullable(),
  department: z.string().nullable(),
  role: z.string(),
  skills: z.array(z.object({ name: z.string(), level: z.number().int() })),
  matchedSkill: z.string(),
  matchedLevel: z.number().int(),
});

export const findExpertResponseSchema = z.array(expertResultSchema);

export const skillsMatrixSchema = z.object({
  employees: z.array(z.object({
    userId: z.string(),
    name: z.string().nullable(),
    image: z.string().nullable(),
    skills: z.record(z.string(), z.number().int()),
  })),
  skills: z.array(z.string()),
  pageInfo: z.object({
    limit: z.number().int(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
  }),
});

export const employeeProjectsSchema = z.array(z.object({
  id: z.string(),
  name: z.string(),
  key: z.string(),
  status: z.string(),
  role: z.string(),
}));

export const employeeTicketsSchema = z.object({
  data: z.array(z.object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    priority: z.string(),
    projectId: z.string(),
    ticketNumber: z.string(),
  })),
});

const reportsToMeItemSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  image: z.string().nullable(),
  email: z.string().nullable(),
  designation: z.string().nullable(),
});

export const reportsToMeListSchema = z.array(reportsToMeItemSchema);

export const managerScorecardSchema = z.object({
  managerId: z.string(),
  teamSize: z.number().int(),
  avgPerformanceRating: z.number().nullable(),
  teamAttendanceRate: z.number().int().nullable(),
  pendingLeaveRequests: z.number().int(),
  directReports: z.array(z.object({
    id: z.string(),
    name: z.string().nullable(),
    image: z.string().nullable(),
    designation: z.string().nullable(),
    avgRating: z.number().nullable(),
  })),
});

const employmentDetailSchema = z.object({
  id: z.number().int(),
  personId: z.number().int(),
  employeeNumber: z.string(),
  lifecycleStatus: z.string(),
  workerType: z.string(),
  departmentId: z.string().nullable(),
  designation: z.string().nullable(),
  joiningDate: z.string().nullable(),
  probationEndDate: z.string().nullable(),
  confirmationDate: z.string().nullable(),
}).nullable();

export const employeeDetailSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  email: z.string(),
  role: z.string(),
  designation: z.string().nullable(),
  employeeId: z.string().nullable(),
  orgDepartmentId: z.string().nullable(),
  image: z.string().nullable(),
  isActive: z.boolean(),
  joiningDate: z.string().nullable(),
  reportingTo: z.string().nullable(),
  bio: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  twitterUrl: z.string().nullable(),
  githubUrl: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  skills: z.array(z.object({ name: z.string(), level: z.number().int() })),
  phone: z.string().nullable(),
  employmentStatus: z.string().nullable(),
  employment: employmentDetailSchema,
  inviteDelivery: inviteDeliveryStatusSchema,
});

const teamEventParticipantSchema = z.object({
  id: z.number().int(),
  orgId: z.string().nullable(),
  eventId: z.number().int(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  status: z.string(),
  joinedAt: wireDate(),
});

const teamEventRowSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  type: z.string(),
  date: z.string(),
  time: z.string().nullable(),
  location: z.string().nullable(),
  maxParticipants: z.number().int().nullable(),
  organizedBy: z.string().nullable(),
  createdAt: wireDate(),
  participants: z.array(teamEventParticipantSchema),
  organizer: z.object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.string().nullable(),
    image: z.string().nullable(),
    designation: z.string().nullable(),
  }).nullable(),
});

export const teamEventsListSchema = z.array(teamEventRowSchema);

export const teamEventCreateSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  type: z.string(),
  date: z.string(),
  time: z.string().nullable(),
  location: z.string().nullable(),
  maxParticipants: z.number().int().nullable(),
  organizedBy: z.string().nullable(),
  createdAt: wireDate(),
});

export const teamEventJoinSchema = z.object({
  id: z.number().int(),
  orgId: z.string().nullable(),
  eventId: z.number().int(),
  userId: z.string(),
  userMembershipId: z.number().int().nullable(),
  status: z.string(),
  joinedAt: wireDate(),
});
