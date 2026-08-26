export * from "./common";
export * from "./calendar";
export * from "./build";
export * from "./timesheets";
export * from "./hr";
export * from "./crm";
export * from "./chat";
export * from "./blog";
export * from "./accounting";
export * from "./support";
export * from "./kb";
export * from "./mail";
export * from "./automation";
export * from "./inventory";
export * from "./billing";
export * from "./ai";
export * from "./surveys";
export * from "./e-sign";
export * from "./directory";
export * from "./party";
export * from "./portal-access";
export * from "./payroll";

// MUST be last: cross-module relations reference tables from common/, hr/ and build/.
// Declaring them inside common/ created a circular import (common -> build/hr while common
// was still initializing), which left 25 build/ relations with an undefined table and made
// drizzle(client, { schema }) throw at startup.
export * from "./custom-field-engine";
export * from "./cross-module-relations";
