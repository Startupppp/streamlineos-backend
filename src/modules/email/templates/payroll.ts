import { getEmailTemplate, escapeHtml } from "./base";
import { renderKeyValueRows, renderCallout } from "./components";
import {
  EMAIL_TEMPLATE_VERSION,
  resolveLocaleValue,
  type LocalizedValues,
} from "./email-locale";

const PAYSLIP_TEMPLATE_VERSION = EMAIL_TEMPLATE_VERSION;
export const PAYSLIP_TEMPLATE_LOCALES = ["en", "fr", "es", "de"] as const;

/**
 * SEC-007. `netSalary` was rendered into the body and retained in `email_outbox.html`.
 * The figure is in the attached PDF, which is where it belongs — the email announces
 * that the payslip exists. The field is removed rather than left unused, so no caller
 * can reintroduce it without changing this type.
 */
export interface PayslipEmailParams {
  employeeName: string;
  month: string;
  orgName: string;
  locale?: string;
}

const SUBJECT_MAP: LocalizedValues<(month: string) => string> = {
  en: (m) => `Your payslip for ${m}`,
  fr: (m) => `Votre bulletin de salaire pour ${m}`,
  es: (m) => `Su nómina de ${m}`,
  de: (m) => `Ihre Gehaltsabrechnung für ${m}`,
};

const TITLE_MAP: LocalizedValues<(month: string) => string> = {
  en: (m) => `Your payslip for ${m}`,
  fr: (m) => `Votre bulletin de salaire pour ${m}`,
  es: (m) => `Su nómina de ${m}`,
  de: (m) => `Ihre Gehaltsabrechnung für ${m}`,
};

const GREETING_MAP: LocalizedValues<(firstName: string, month: string) => string> = {
  en: (n, m) => `Hi ${n}, your payslip for ${m} is attached to this email as a PDF.`,
  fr: (n, m) => `Bonjour ${n}, votre bulletin de salaire pour ${m} est joint à cet e-mail en PDF.`,
  es: (n, m) => `Hola ${n}, su nómina de ${m} está adjunta a este correo electrónico como PDF.`,
  de: (n, m) => `Hallo ${n}, Ihre Gehaltsabrechnung für ${m} ist diesem E-Mail als PDF beigefügt.`,
};

const PERIOD_LABEL_MAP: LocalizedValues<string> = {
  en: "Period",
  fr: "Période",
  es: "Período",
  de: "Zeitraum",
};

const CALLOUT_MAP: LocalizedValues<string> = {
  en: "The PDF contains your full salary breakdown including earnings, deductions, and bank transfer details. Contact HR if you have any questions.",
  fr: "Le PDF contient le détail complet de votre salaire, y compris les revenus, les déductions et les informations de virement bancaire. Contactez les RH si vous avez des questions.",
  es: "El PDF contiene el desglose completo de su salario, incluidos ingresos, deducciones y datos de transferencia bancaria. Contacte con RRHH si tiene alguna pregunta.",
  de: "Das PDF enthält Ihre vollständige Gehaltsaufschlüsselung mit Einnahmen, Abzügen und Banküberweisung. Wenden Sie sich bei Fragen an die Personalabteilung.",
};

const PREHEADER_MAP: LocalizedValues<(month: string, org: string) => string> = {
  en: (m, o) => `Your ${m} payslip from ${o} is attached.`,
  fr: (m, o) => `Votre bulletin de salaire ${m} de ${o} est joint.`,
  es: (m, o) => `Su nómina de ${m} de ${o} está adjunta.`,
  de: (m, o) => `Ihre Gehaltsabrechnung ${m} von ${o} ist beigefügt.`,
};

export function getPayslipEmailTemplate(params: PayslipEmailParams): { subject: string; html: string } {
  const { employeeName, month, orgName, locale = "en" } = params;

  const subjectFn = resolveLocaleValue(locale, SUBJECT_MAP);
  const titleFn = resolveLocaleValue(locale, TITLE_MAP);
  const greetingFn = resolveLocaleValue(locale, GREETING_MAP);
  const periodLabel = resolveLocaleValue(locale, PERIOD_LABEL_MAP);
  const calloutText = resolveLocaleValue(locale, CALLOUT_MAP);
  const preheaderFn = resolveLocaleValue(locale, PREHEADER_MAP);

  const subject = subjectFn(month);
  const firstName = escapeHtml(employeeName.split(" ")[0] ?? employeeName);
  const safeMonth = escapeHtml(month);
  const safeOrg = escapeHtml(orgName);

  const content = `
<h1 class="email-title">${escapeHtml(titleFn(month))}</h1>
<p class="email-text">${escapeHtml(greetingFn(firstName, month))}</p>
${renderKeyValueRows([{ label: periodLabel, value: month }])}
${renderCallout(calloutText, "info")}
`;

  return {
    subject,
    html: getEmailTemplate({
      title: subject,
      preheader: preheaderFn(safeMonth, safeOrg),
      content,
    }),
  };
}
