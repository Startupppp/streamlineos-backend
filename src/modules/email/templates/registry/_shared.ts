import { appUrl } from "../../app-url";
import { getBrandName } from "../../branding";

export { appUrl as BASE_URL };
export const BRAND = getBrandName();

export interface TemplateEntry {
  category: string;
  name: string;
  subject: string;
  generateHtml: () => string;
}
