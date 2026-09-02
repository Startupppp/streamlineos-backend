import { organizationPeople } from "../../db/schema/directory";

/**
 * The directory is universal, so its projection carries only work-contact facts;
 * onboarding identity data stays behind the HR/self-service seams.
 */
export const DIRECTORY_PERSON_COLUMNS = {
  organizationPersonId: organizationPeople.organizationPersonId,
  organizationId: organizationPeople.organizationId,
  userId: organizationPeople.userId,
  organizationMembershipId: organizationPeople.organizationMembershipId,
  firstName: organizationPeople.firstName,
  lastName: organizationPeople.lastName,
  displayName: organizationPeople.displayName,
  preferredName: organizationPeople.preferredName,
  workEmail: organizationPeople.workEmail,
  personalEmail: organizationPeople.personalEmail,
  phone: organizationPeople.phone,
  whatsappNumber: organizationPeople.whatsappNumber,
  avatarUrl: organizationPeople.avatarUrl,
  timezone: organizationPeople.timezone,
  languageCode: organizationPeople.languageCode,
  linkedinUrl: organizationPeople.linkedinUrl,
  githubUrl: organizationPeople.githubUrl,
  bio: organizationPeople.bio,
  deletedAt: organizationPeople.deletedAt,
  createdAt: organizationPeople.createdAt,
  updatedAt: organizationPeople.updatedAt,
} as const;

export const DIRECTORY_PERSON_RESTRICTED_COLUMNS = [
  "dateOfBirth",
  "gender",
  "nationality",
  "address",
  "emergencyContact",
] as const;

export type DirectoryPersonColumnName = keyof typeof DIRECTORY_PERSON_COLUMNS;

export type DirectoryPerson = Pick<
  typeof organizationPeople.$inferSelect,
  DirectoryPersonColumnName
>;

export function toDirectoryPerson(
  row: typeof organizationPeople.$inferSelect,
): DirectoryPerson {
  return {
    organizationPersonId: row.organizationPersonId,
    organizationId: row.organizationId,
    userId: row.userId,
    organizationMembershipId: row.organizationMembershipId,
    firstName: row.firstName,
    lastName: row.lastName,
    displayName: row.displayName,
    preferredName: row.preferredName,
    workEmail: row.workEmail,
    personalEmail: row.personalEmail,
    phone: row.phone,
    whatsappNumber: row.whatsappNumber,
    avatarUrl: row.avatarUrl,
    timezone: row.timezone,
    languageCode: row.languageCode,
    linkedinUrl: row.linkedinUrl,
    githubUrl: row.githubUrl,
    bio: row.bio,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
