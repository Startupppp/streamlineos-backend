import { z } from "zod";
import { wireDate } from "../../../../common/openapi/wire-types";

const count = z.number().int().nonnegative();
const quota = z.object({ limit: count.nullable(), used: count }).strict();
const timestamp = z.union([wireDate(), z.iso.datetime()]);

export const billingEntitlementsResponseSchema = z.object({
  tier: z.enum(["FREE", "PAID", "ENTERPRISE"]),
  plan: z.enum(["FREE", "STARTER", "PROFESSIONAL", "ENTERPRISE"]),
  seatLimit: count.nullable(),
  lockedModules: z.array(z.string()),
  features: z.object({
    chatGroupHuddles: z.boolean(),
    chatVoiceVideo: z.boolean(),
    kbPublicSharing: z.boolean(),
    hrFull: z.boolean(),
  }).strict(),
  limits: z.object({
    members: quota,
    projects: quota,
    kbPages: quota,
    chatChannels: quota,
    crmLeads: quota,
    crmContacts: quota,
    crmDeals: quota,
    supportTickets: quota,
    automations: quota,
    signEnvelopes: quota,
    surveys: quota,
    acctInvoices: quota,
    hrCandidates: quota,
    hrJobPostings: quota,
  }).strict(),
}).strict();

export const billingSeatsResponseSchema = z.object({
  total: count.nullable(),
  used: count,
  available: count.nullable(),
  activeMembers: count,
  pendingInvitations: count,
}).strict();

export const billingSummaryResponseSchema = z.object({
  subscription: z.object({
    plan: z.string(),
    status: z.string(),
    trialEndsAt: timestamp.nullable(),
    trialDaysRemaining: count.nullable(),
    currentPeriodEnd: timestamp.nullable(),
    isActive: z.boolean(),
    isTrial: z.boolean(),
  }).strict().nullable(),
  invoiceStats: z.object({
    totalPaid: z.string(),
    totalOutstanding: z.string(),
    draft: count,
    issued: count,
    paid: count,
    failed: count,
    voided: count,
  }).strict(),
  isConfigured: z.boolean(),
}).strict();
