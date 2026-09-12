import { z } from "zod";
import { wireDate, nullableWireDate } from "../../../common/openapi/wire-types";

const associationRef = z.object({ id: z.number().int(), name: z.string().nullable() }).nullable();

const contactItemSchema = z.object({
  id: z.number().int(),
  orgId: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  title: z.string().nullable(),
  department: z.string().nullable(),
  company: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  twitterUrl: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  notes: z.string().nullable(),
  tags: z.array(z.string()),
  deletedAt: nullableWireDate(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
  dealId: z.number().int().nullable(),
  mergedIntoId: z.number().int().nullable(),
  leadId: z.number().int().nullable(),
  organizationId: z.number().int().nullable(),
  lead: associationRef,
  deal: associationRef,
});

export const contactListSchema = z.object({
  items: z.array(contactItemSchema),
  total: z.number().int().optional(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});

export const contactDetailSchema = contactItemSchema.extend({
  crmOrganization: z.object({ id: z.number().int(), name: z.string().nullable() }).nullable(),
});

export const contactSearchSchema = z.array(
  z.object({
    id: z.number().int(),
    name: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    company: z.string().nullable(),
    jobTitle: z.string().nullable(),
    image: z.string().nullable(),
  }),
);

export const bulkImportSchema = z.object({
  created: z.number().int(),
  failed: z.number().int(),
});

export const contactRoleRowSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  contactId: z.number().int(),
  entityType: z.string(),
  entityId: z.number().int(),
  roleKey: z.string(),
  isPrimary: z.boolean(),
  createdAt: wireDate(),
  updatedAt: wireDate(),
});

export const contactRoleListResponseSchema = z.array(contactRoleRowSchema);
