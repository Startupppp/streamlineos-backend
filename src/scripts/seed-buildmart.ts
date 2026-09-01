/**
 * Buildmart — realistic development seed for the materials pack.
 *
 * ## What this creates
 *
 * One organisation running the `materials` pack, four Hyderabad dark stores with
 * real zones and delivery promises, a construction and interiors catalogue with
 * brands and grades, five suppliers, stock across every bucket the dashboard
 * reports on (available, reserved, damaged, quarantined, in transit), open
 * purchase orders, a transfer in the van, three live construction projects with
 * material requirements — and, for all of it, a **ledger**.
 *
 * ## Why the ledger is written rather than just the balances
 *
 * `inv_stock_levels` is a cache of `inv_stock_transactions`. A seed that wrote
 * only balances would produce a system whose movement history is empty, whose
 * audit trail answers no questions, and whose reconciliation report says
 * everything is wrong. Every balance below has the movements that produced it,
 * with `quantity_before`/`quantity_after` arithmetic that satisfies
 * `chk_inv_stock_transactions_arithmetic` — which is also what makes it
 * impossible for this file to write a balance the history cannot explain.
 *
 * ## Safety
 *
 * Refuses to run unless `NODE_ENV` is `development` or `test`, and refuses any
 * database whose URL looks like production. It is idempotent on the org id: a
 * second run reports what already existed and writes nothing new.
 */
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { and, eq, sql } from "drizzle-orm";
// The whole schema object is passed to `drizzle(client, { schema })` to register
// relational queries. Nothing here reads a legacy identity table.
// eslint-disable-next-line no-restricted-imports -- see above
import * as schema from "../db/schema";
import { users, organizations, organizationMembers } from "../db/schema/common/auth";
import { subscriptions } from "../db/schema/common/subscriptions";
import { orgModules } from "../db/schema/common/access";
import {
  invSettings,
  invUom,
  invCategories,
  invProducts,
  invProductVariants,
  invWarehouses,
  invLocations,
  invVendors,
  invStockLevels,
  invStockTransactions,
  invStockReservations,
  invStockTransfers,
  invStockTransferLines,
  invPurchaseOrders,
  invPoLines,
  invProjects,
  invProjectRequirements,
  invAuditEvents,
} from "../db/schema";
import { DEFAULT_REGION } from "../common/region/region-registry";
import { organizationPlacement } from "../db/schema";
import { DEFAULT_DATABASE_SHARD, DEFAULT_SEARCH_CLUSTER, LEGACY_CELL_ID } from "../common/region/placement";
import { newWriteFenceToken, FENCE_LEASE_MS } from "../common/region/placement-lookup";

type Db = PostgresJsDatabase<typeof schema>;

const ORG_ID = "b0000001-0000-4000-8000-000000000001";
const OWNER_ID = "b0000001-0000-4000-8000-000000000002";
const ORG_SLUG = "buildmart-materials";

interface StaffSeed {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  title: string;
}

const STAFF: StaffSeed[] = [
  { id: "b0000001-0000-4000-8000-000000000003", email: "rekha.inventory@buildmart.local", firstName: "Rekha", lastName: "Iyer", title: "Inventory Manager" },
  { id: "b0000001-0000-4000-8000-000000000004", email: "arif.kompally@buildmart.local", firstName: "Arif", lastName: "Sheikh", title: "Dark Store Operator — Kompally" },
  { id: "b0000001-0000-4000-8000-000000000005", email: "sneha.procurement@buildmart.local", firstName: "Sneha", lastName: "Reddy", title: "Procurement Manager" },
  { id: "b0000001-0000-4000-8000-000000000006", email: "vikram.dispatch@buildmart.local", firstName: "Vikram", lastName: "Rao", title: "Dispatch Manager" },
];

interface StoreSeed {
  code: string;
  name: string;
  zone: string;
  zoneLabel: string;
  address: string;
  promiseMinutes: number;
  radiusKm: string;
  lat: string;
  lng: string;
}

/**
 * Four dark stores, one per Hyderabad zone. The promises differ because the
 * geography does: Gachibowli's catchment is dense and short, Shamshabad's runs
 * out to the ORR and the airport corridor.
 */
const STORES: StoreSeed[] = [
  { code: "HYD-N-KMP", name: "Kompally Dark Store", zone: "HYD_NORTH", zoneLabel: "Hyderabad North", address: "Plot 44, Bowrampet Road, Kompally", promiseMinutes: 90, radiusKm: "12.00", lat: "17.540000", lng: "78.480000" },
  { code: "HYD-S-ATP", name: "Attapur Dark Store", zone: "HYD_SOUTH", zoneLabel: "Hyderabad South", address: "Survey 118, Rajendranagar Road, Attapur", promiseMinutes: 120, radiusKm: "16.00", lat: "17.360000", lng: "78.420000" },
  { code: "HYD-E-UPL", name: "Uppal Dark Store", zone: "HYD_EAST", zoneLabel: "Hyderabad East", address: "Shed 7, Ramanthapur Industrial Lane, Uppal", promiseMinutes: 90, radiusKm: "14.00", lat: "17.400000", lng: "78.560000" },
  { code: "HYD-W-GCB", name: "Gachibowli Dark Store", zone: "HYD_WEST", zoneLabel: "Hyderabad West", address: "Unit 3, Kollur Road, Gachibowli", promiseMinutes: 60, radiusKm: "10.00", lat: "17.440000", lng: "78.350000" },
];

interface UomSeed { name: string; abbreviation: string; category: string; isBase: boolean }

const UOMS: UomSeed[] = [
  { name: "Piece", abbreviation: "pc", category: "Count", isBase: true },
  { name: "Box", abbreviation: "box", category: "Count", isBase: false },
  { name: "Bag", abbreviation: "bag", category: "Count", isBase: false },
  { name: "Bundle", abbreviation: "bdl", category: "Count", isBase: false },
  { name: "Kilogram", abbreviation: "kg", category: "Weight", isBase: false },
  { name: "Tonne", abbreviation: "t", category: "Weight", isBase: false },
  { name: "Metre", abbreviation: "m", category: "Length", isBase: false },
  { name: "Foot", abbreviation: "ft", category: "Length", isBase: false },
  { name: "Square Foot", abbreviation: "sqft", category: "Area", isBase: false },
  { name: "Litre", abbreviation: "L", category: "Volume", isBase: false },
];

const CATEGORIES: { name: string; parent: string | null; description: string }[] = [
  { name: "Construction Materials", parent: null, description: "Structural and civil-works materials" },
  { name: "Interior Materials", parent: null, description: "Finishes, fittings and interior fit-out" },
  { name: "Cement & Aggregates", parent: "Construction Materials", description: "OPC, PPC, sand, aggregate" },
  { name: "Steel & Rebar", parent: "Construction Materials", description: "TMT bars, binding wire, structural steel" },
  { name: "Bricks & Blocks", parent: "Construction Materials", description: "AAC blocks, red brick, fly-ash brick" },
  { name: "Waterproofing & Chemicals", parent: "Construction Materials", description: "Membranes, admixtures, adhesives" },
  { name: "Tiles & Stone", parent: "Interior Materials", description: "Vitrified, ceramic, granite, marble" },
  { name: "Paints & Coatings", parent: "Interior Materials", description: "Emulsion, primer, enamel, putty" },
  { name: "Sanitaryware & Plumbing", parent: "Interior Materials", description: "CP fittings, pipes, closets" },
  { name: "Electrical & Lighting", parent: "Interior Materials", description: "Wire, switchgear, luminaires" },
  { name: "Wood, Panels & Ceiling", parent: "Interior Materials", description: "Plywood, laminate, false ceiling" },
];

interface VendorSeed {
  code: string; name: string; city: string; leadTimeDays: number; email: string; phone: string; gstin: string;
}

const VENDORS: VendorSeed[] = [
  { code: "SUP-UTC", name: "UltraTech Cement — Telangana Depot", city: "Hyderabad", leadTimeDays: 3, email: "orders@utc-depot.local", phone: "+91 40 4000 1101", gstin: "36AABCU1234M1Z5" },
  { code: "SUP-TIS", name: "Tiscon Steel Distributors", city: "Hyderabad", leadTimeDays: 5, email: "sales@tiscon-dist.local", phone: "+91 40 4000 1102", gstin: "36AACCT5678N1Z2" },
  { code: "SUP-KAJ", name: "Kajaria Ceramics — South Hub", city: "Hyderabad", leadTimeDays: 7, email: "south@kajaria-hub.local", phone: "+91 40 4000 1103", gstin: "36AAACK9012P1Z8" },
  { code: "SUP-APL", name: "Asian Paints Regional Warehouse", city: "Hyderabad", leadTimeDays: 4, email: "hyd@apl-rw.local", phone: "+91 40 4000 1104", gstin: "36AAACA3456Q1Z4" },
  { code: "SUP-JAQ", name: "Jaquar & Astral Fittings Agency", city: "Secunderabad", leadTimeDays: 10, email: "orders@jaquar-agency.local", phone: "+91 40 4000 1105", gstin: "36AABCJ7890R1Z1" },
];

type MaterialFamily = (typeof schema.invProducts.$inferInsert)["materialFamily"];

interface ProductSeed {
  sku: string;
  name: string;
  category: string;
  brand: string;
  grade: string | null;
  finish: string | null;
  colour: string | null;
  dimension: string | null;
  family: NonNullable<MaterialFamily>;
  uom: string;
  packSize: string | null;
  barcode: string;
  supplierCode: string;
  vendor: string;
  costPrice: string;
  sellingPrice: string;
  reorderPoint: string;
  reorderQuantity: string;
  leadTimeDays: number;
  /** Public-domain / permissively licensed imagery is not bundled — see the seed docs. */
  imageUrl: string | null;
  variants: { sku: string; name: string; attrs: Record<string, string>; weightGrams?: number; lengthMm?: number; widthMm?: number; heightMm?: number }[];
}

/**
 * The catalogue. Every name, brand and grade is one a Hyderabad materials yard
 * would recognise; nothing here is "Product 1".
 */
const PRODUCTS: ProductSeed[] = [
  {
    sku: "CEM-UTC-OPC53-50", name: "UltraTech OPC 53 Grade Cement", category: "Cement & Aggregates",
    brand: "UltraTech", grade: "OPC 53", finish: null, colour: null, dimension: "50 kg bag",
    family: "CEMENT_AGGREGATE", uom: "Bag", packSize: "1", barcode: "8901234500011",
    supplierCode: "UTC-OPC53-50KG", vendor: "SUP-UTC",
    costPrice: "372.0000", sellingPrice: "425.0000", reorderPoint: "400", reorderQuantity: "1000",
    leadTimeDays: 3, imageUrl: null,
    variants: [{ sku: "CEM-UTC-OPC53-50-STD", name: "50 kg bag", attrs: { pack: "50 kg" }, weightGrams: 50000 }],
  },
  {
    sku: "CEM-ACC-PPC-50", name: "ACC Suraksha PPC Cement", category: "Cement & Aggregates",
    brand: "ACC", grade: "PPC", finish: null, colour: null, dimension: "50 kg bag",
    family: "CEMENT_AGGREGATE", uom: "Bag", packSize: "1", barcode: "8901234500028",
    supplierCode: "ACC-PPC-50KG", vendor: "SUP-UTC",
    costPrice: "348.0000", sellingPrice: "398.0000", reorderPoint: "300", reorderQuantity: "800",
    leadTimeDays: 3, imageUrl: null,
    variants: [{ sku: "CEM-ACC-PPC-50-STD", name: "50 kg bag", attrs: { pack: "50 kg" }, weightGrams: 50000 }],
  },
  {
    sku: "AGG-MSAND-CUM", name: "Manufactured Sand (M-Sand) Zone II", category: "Cement & Aggregates",
    brand: "Buildmart Aggregates", grade: "Zone II", finish: null, colour: "Grey", dimension: "0-4.75 mm",
    family: "CEMENT_AGGREGATE", uom: "Tonne", packSize: null, barcode: "8901234500035",
    supplierCode: "MSAND-Z2", vendor: "SUP-UTC",
    costPrice: "1250.0000", sellingPrice: "1580.0000", reorderPoint: "20", reorderQuantity: "60",
    leadTimeDays: 2, imageUrl: null,
    variants: [{ sku: "AGG-MSAND-CUM-STD", name: "Bulk tonne", attrs: { zone: "II" } }],
  },
  {
    sku: "STL-TATA-FE500D-12", name: "Tata Tiscon TMT Bar Fe500D 12 mm", category: "Steel & Rebar",
    brand: "Tata Tiscon", grade: "Fe500D", finish: "Ribbed", colour: null, dimension: "12 mm x 12 m",
    family: "STEEL_REBAR", uom: "Bundle", packSize: "5", barcode: "8901234500042",
    supplierCode: "TT-FE500D-12", vendor: "SUP-TIS",
    costPrice: "5620.0000", sellingPrice: "6250.0000", reorderPoint: "25", reorderQuantity: "60",
    leadTimeDays: 5, imageUrl: null,
    variants: [
      { sku: "STL-TATA-FE500D-12-B5", name: "Bundle of 5 (12 m)", attrs: { diameter: "12 mm", length: "12 m" }, weightGrams: 53300, lengthMm: 12000 },
    ],
  },
  {
    sku: "STL-JSW-FE550D-16", name: "JSW Neosteel TMT Bar Fe550D 16 mm", category: "Steel & Rebar",
    brand: "JSW Neosteel", grade: "Fe550D", finish: "Ribbed", colour: null, dimension: "16 mm x 12 m",
    family: "STEEL_REBAR", uom: "Bundle", packSize: "3", barcode: "8901234500059",
    supplierCode: "JSW-FE550D-16", vendor: "SUP-TIS",
    costPrice: "5980.0000", sellingPrice: "6640.0000", reorderPoint: "20", reorderQuantity: "45",
    leadTimeDays: 6, imageUrl: null,
    variants: [
      { sku: "STL-JSW-FE550D-16-B3", name: "Bundle of 3 (12 m)", attrs: { diameter: "16 mm", length: "12 m" }, weightGrams: 56800, lengthMm: 12000 },
    ],
  },
  {
    sku: "BLK-AAC-600200", name: "Autoclaved Aerated Concrete Block", category: "Bricks & Blocks",
    brand: "Magicrete", grade: "Grade 1", finish: "Smooth", colour: "Light Grey", dimension: "600 x 200 x 150 mm",
    family: "BRICK_BLOCK", uom: "Piece", packSize: null, barcode: "8901234500066",
    supplierCode: "MGC-AAC-600200150", vendor: "SUP-UTC",
    costPrice: "62.0000", sellingPrice: "78.0000", reorderPoint: "800", reorderQuantity: "2000",
    leadTimeDays: 4, imageUrl: null,
    variants: [
      { sku: "BLK-AAC-600200-150", name: "150 mm thickness", attrs: { thickness: "150 mm" }, lengthMm: 600, widthMm: 200, heightMm: 150, weightGrams: 15300 },
      { sku: "BLK-AAC-600200-200", name: "200 mm thickness", attrs: { thickness: "200 mm" }, lengthMm: 600, widthMm: 200, heightMm: 200, weightGrams: 20400 },
    ],
  },
  {
    sku: "WPF-DRFIXIT-LW20", name: "Dr. Fixit LW+ Integral Waterproofing Compound", category: "Waterproofing & Chemicals",
    brand: "Dr. Fixit", grade: "LW+", finish: null, colour: null, dimension: "20 L can",
    family: "ADHESIVE_CHEMICAL", uom: "Litre", packSize: "20", barcode: "8901234500073",
    supplierCode: "DF-LWP-20L", vendor: "SUP-APL",
    costPrice: "2180.0000", sellingPrice: "2560.0000", reorderPoint: "40", reorderQuantity: "120",
    leadTimeDays: 5, imageUrl: null,
    variants: [{ sku: "WPF-DRFIXIT-LW20-STD", name: "20 L can", attrs: { pack: "20 L" }, weightGrams: 21000 }],
  },
  {
    sku: "TIL-KAJ-VIT-600", name: "Kajaria Vitrified Floor Tile 600x600", category: "Tiles & Stone",
    brand: "Kajaria", grade: "Premium", finish: "Glossy", colour: "Statuario White", dimension: "600 x 600 mm",
    family: "TILE_STONE", uom: "Box", packSize: "4", barcode: "8901234500080",
    supplierCode: "KAJ-VIT-600-STW", vendor: "SUP-KAJ",
    costPrice: "830.0000", sellingPrice: "1040.0000", reorderPoint: "120", reorderQuantity: "300",
    leadTimeDays: 7, imageUrl: null,
    variants: [
      { sku: "TIL-KAJ-VIT-600-GLS-STW", name: "Glossy — Statuario White", attrs: { finish: "Glossy", colour: "Statuario White" }, lengthMm: 600, widthMm: 600, weightGrams: 46000 },
      { sku: "TIL-KAJ-VIT-600-MAT-GRY", name: "Matt — Concrete Grey", attrs: { finish: "Matt", colour: "Concrete Grey" }, lengthMm: 600, widthMm: 600, weightGrams: 46000 },
    ],
  },
  {
    sku: "TIL-SOM-CER-300", name: "Somany Ceramic Wall Tile 300x600", category: "Tiles & Stone",
    brand: "Somany", grade: "Standard", finish: "Matt", colour: "Ivory", dimension: "300 x 600 mm",
    family: "TILE_STONE", uom: "Box", packSize: "6", barcode: "8901234500097",
    supplierCode: "SOM-CER-300600-IVY", vendor: "SUP-KAJ",
    costPrice: "520.0000", sellingPrice: "665.0000", reorderPoint: "90", reorderQuantity: "240",
    leadTimeDays: 7, imageUrl: null,
    variants: [{ sku: "TIL-SOM-CER-300-IVY", name: "Ivory Matt", attrs: { colour: "Ivory" }, lengthMm: 600, widthMm: 300, weightGrams: 32000 }],
  },
  {
    sku: "GRN-BLKGAL-SLAB", name: "Black Galaxy Granite Slab", category: "Tiles & Stone",
    brand: "Buildmart Stone", grade: "First Quality", finish: "Polished", colour: "Black", dimension: "18 mm thickness",
    family: "TILE_STONE", uom: "Square Foot", packSize: null, barcode: "8901234500103",
    supplierCode: "BMS-BLKGAL-18", vendor: "SUP-KAJ",
    costPrice: "185.0000", sellingPrice: "245.0000", reorderPoint: "400", reorderQuantity: "1200",
    leadTimeDays: 12, imageUrl: null,
    variants: [{ sku: "GRN-BLKGAL-SLAB-18", name: "18 mm polished", attrs: { thickness: "18 mm" } }],
  },
  {
    sku: "PNT-AP-APEX-20", name: "Asian Paints Apex Exterior Emulsion", category: "Paints & Coatings",
    brand: "Asian Paints", grade: "Apex", finish: "Sheen", colour: "Base — White", dimension: "20 L pail",
    family: "PAINT_COATING", uom: "Litre", packSize: "20", barcode: "8901234500110",
    supplierCode: "AP-APEX-20L-W", vendor: "SUP-APL",
    costPrice: "5240.0000", sellingPrice: "6150.0000", reorderPoint: "30", reorderQuantity: "80",
    leadTimeDays: 4, imageUrl: null,
    variants: [{ sku: "PNT-AP-APEX-20-WHT", name: "White base 20 L", attrs: { base: "White" }, weightGrams: 26000 }],
  },
  {
    sku: "PNT-BRG-SILK-10", name: "Berger Silk Luxury Interior Emulsion", category: "Paints & Coatings",
    brand: "Berger", grade: "Silk Luxury", finish: "Silk", colour: "Base — Pastel", dimension: "10 L pail",
    family: "PAINT_COATING", uom: "Litre", packSize: "10", barcode: "8901234500127",
    supplierCode: "BRG-SILK-10L-P", vendor: "SUP-APL",
    costPrice: "3180.0000", sellingPrice: "3750.0000", reorderPoint: "25", reorderQuantity: "60",
    leadTimeDays: 5, imageUrl: null,
    variants: [{ sku: "PNT-BRG-SILK-10-PST", name: "Pastel base 10 L", attrs: { base: "Pastel" }, weightGrams: 13000 }],
  },
  {
    sku: "SAN-JAQ-CP-BASIN", name: "Jaquar Continental Basin Mixer", category: "Sanitaryware & Plumbing",
    brand: "Jaquar", grade: "Continental", finish: "Chrome", colour: "Chrome", dimension: "Single lever",
    family: "SANITARYWARE", uom: "Piece", packSize: "1", barcode: "8901234500134",
    supplierCode: "JAQ-CON-BSM-CP", vendor: "SUP-JAQ",
    costPrice: "4180.0000", sellingPrice: "5290.0000", reorderPoint: "20", reorderQuantity: "50",
    leadTimeDays: 10, imageUrl: null,
    variants: [{ sku: "SAN-JAQ-CP-BASIN-CHR", name: "Chrome", attrs: { finish: "Chrome" }, weightGrams: 1800 }],
  },
  {
    sku: "PLB-ASTRAL-CPVC-25", name: "Astral CPVC Pipe SDR 11", category: "Sanitaryware & Plumbing",
    brand: "Astral", grade: "SDR 11", finish: null, colour: "Cream", dimension: "25 mm x 3 m",
    family: "PLUMBING", uom: "Piece", packSize: "1", barcode: "8901234500141",
    supplierCode: "AST-CPVC-25-SDR11", vendor: "SUP-JAQ",
    costPrice: "412.0000", sellingPrice: "530.0000", reorderPoint: "150", reorderQuantity: "400",
    leadTimeDays: 8, imageUrl: null,
    variants: [{ sku: "PLB-ASTRAL-CPVC-25-3M", name: "25 mm x 3 m", attrs: { diameter: "25 mm" }, lengthMm: 3000, weightGrams: 900 }],
  },
  {
    sku: "ELE-HAV-FR-2R5", name: "Havells LifeLine FR PVC Wire 2.5 sq mm", category: "Electrical & Lighting",
    brand: "Havells", grade: "FR", finish: null, colour: "Red", dimension: "2.5 sq mm x 90 m",
    family: "ELECTRICAL", uom: "Piece", packSize: "1", barcode: "8901234500158",
    supplierCode: "HAV-FR-2R5-90M-RED", vendor: "SUP-JAQ",
    costPrice: "1890.0000", sellingPrice: "2340.0000", reorderPoint: "60", reorderQuantity: "150",
    leadTimeDays: 6, imageUrl: null,
    variants: [
      { sku: "ELE-HAV-FR-2R5-RED", name: "Red 90 m coil", attrs: { colour: "Red" }, lengthMm: 90000, weightGrams: 2400 },
      { sku: "ELE-HAV-FR-2R5-BLK", name: "Black 90 m coil", attrs: { colour: "Black" }, lengthMm: 90000, weightGrams: 2400 },
    ],
  },
  {
    sku: "LIT-PHI-LED-18W", name: "Philips Astra LED Panel 18 W", category: "Electrical & Lighting",
    brand: "Philips", grade: "Astra", finish: "Matt", colour: "Cool Daylight", dimension: "225 mm round",
    family: "LIGHTING", uom: "Piece", packSize: "1", barcode: "8901234500165",
    supplierCode: "PHI-ASTRA-18W-CDL", vendor: "SUP-JAQ",
    costPrice: "520.0000", sellingPrice: "690.0000", reorderPoint: "100", reorderQuantity: "250",
    leadTimeDays: 6, imageUrl: null,
    variants: [{ sku: "LIT-PHI-LED-18W-CDL", name: "Cool daylight", attrs: { temperature: "6500K" }, weightGrams: 340 }],
  },
  {
    sku: "WD-CEN-PLY-18", name: "Century Sainik 710 BWP Plywood", category: "Wood, Panels & Ceiling",
    brand: "Century Ply", grade: "BWP 710", finish: "Sanded", colour: "Natural", dimension: "8 ft x 4 ft x 18 mm",
    family: "WOOD_PANEL", uom: "Piece", packSize: "1", barcode: "8901234500172",
    supplierCode: "CEN-SNK710-18", vendor: "SUP-KAJ",
    costPrice: "2740.0000", sellingPrice: "3380.0000", reorderPoint: "40", reorderQuantity: "100",
    leadTimeDays: 9, imageUrl: null,
    variants: [{ sku: "WD-CEN-PLY-18-8X4", name: "8 ft x 4 ft", attrs: { thickness: "18 mm" }, lengthMm: 2440, widthMm: 1220, heightMm: 18, weightGrams: 32000 }],
  },
  {
    sku: "FC-ARM-GYP-600", name: "Armstrong Gypsum Ceiling Tile", category: "Wood, Panels & Ceiling",
    brand: "Armstrong", grade: "Standard", finish: "Laminated", colour: "White", dimension: "595 x 595 x 8 mm",
    family: "FALSE_CEILING", uom: "Box", packSize: "12", barcode: "8901234500189",
    supplierCode: "ARM-GYP-595-LAM", vendor: "SUP-KAJ",
    costPrice: "1180.0000", sellingPrice: "1490.0000", reorderPoint: "50", reorderQuantity: "120",
    leadTimeDays: 11, imageUrl: null,
    variants: [{ sku: "FC-ARM-GYP-600-WHT", name: "White laminated", attrs: { colour: "White" }, lengthMm: 595, widthMm: 595, heightMm: 8, weightGrams: 42000 }],
  },
  {
    sku: "HW-PID-FEV-5", name: "Pidilite Fevicol Marine Adhesive", category: "Waterproofing & Chemicals",
    brand: "Pidilite", grade: "Marine", finish: null, colour: null, dimension: "5 kg pack",
    family: "HARDWARE_FASTENER", uom: "Kilogram", packSize: "5", barcode: "8901234500196",
    supplierCode: "PID-FEV-MAR-5KG", vendor: "SUP-APL",
    costPrice: "1240.0000", sellingPrice: "1560.0000", reorderPoint: "35", reorderQuantity: "90",
    leadTimeDays: 5, imageUrl: null,
    variants: [{ sku: "HW-PID-FEV-5-STD", name: "5 kg pack", attrs: { pack: "5 kg" }, weightGrams: 5000 }],
  },
  {
    sku: "GLS-SG-CLR-8", name: "Saint-Gobain Clear Float Glass 8 mm", category: "Interior Materials",
    brand: "Saint-Gobain", grade: "Clear Float", finish: "Polished", colour: "Clear", dimension: "8 mm",
    family: "GLASS_MIRROR", uom: "Square Foot", packSize: null, barcode: "8901234500202",
    supplierCode: "SG-CLR-FLT-8", vendor: "SUP-KAJ",
    costPrice: "118.0000", sellingPrice: "158.0000", reorderPoint: "300", reorderQuantity: "800",
    leadTimeDays: 9, imageUrl: null,
    variants: [{ sku: "GLS-SG-CLR-8-STD", name: "8 mm clear", attrs: { thickness: "8 mm" } }],
  },
];

/**
 * Opening stock, per (variant SKU, store code). The buckets are deliberately
 * uneven: the dashboard's whole job is exceptions, so the seed has to contain
 * stockouts, low stock, damage, quarantine and over-reservation — otherwise the
 * board renders empty and nobody can tell working from broken.
 */
interface StockSeed {
  variantSku: string; store: string; onHand: string;
  blocked?: string; qualityHold?: string; bin: string;
}

const STOCK: StockSeed[] = [
  // Cement — healthy in the north, low in the west, out in the east.
  { variantSku: "CEM-UTC-OPC53-50-STD", store: "HYD-N-KMP", onHand: "1240", bin: "A-01-01" },
  { variantSku: "CEM-UTC-OPC53-50-STD", store: "HYD-W-GCB", onHand: "260", bin: "A-01-01" },
  { variantSku: "CEM-UTC-OPC53-50-STD", store: "HYD-S-ATP", onHand: "880", bin: "A-01-02" },
  { variantSku: "CEM-UTC-OPC53-50-STD", store: "HYD-E-UPL", onHand: "0", bin: "A-01-01" },
  { variantSku: "CEM-ACC-PPC-50-STD", store: "HYD-N-KMP", onHand: "640", bin: "A-01-03" },
  { variantSku: "CEM-ACC-PPC-50-STD", store: "HYD-S-ATP", onHand: "180", blocked: "40", bin: "A-01-04" },
  { variantSku: "AGG-MSAND-CUM-STD", store: "HYD-N-KMP", onHand: "78", bin: "YARD-01" },
  { variantSku: "AGG-MSAND-CUM-STD", store: "HYD-S-ATP", onHand: "14", bin: "YARD-01" },

  // Steel — the east store is short and the west has damage from a wet unload.
  { variantSku: "STL-TATA-FE500D-12-B5", store: "HYD-N-KMP", onHand: "84", bin: "B-02-01" },
  { variantSku: "STL-TATA-FE500D-12-B5", store: "HYD-E-UPL", onHand: "18", bin: "B-02-01" },
  { variantSku: "STL-TATA-FE500D-12-B5", store: "HYD-W-GCB", onHand: "46", blocked: "6", bin: "B-02-02" },
  { variantSku: "STL-JSW-FE550D-16-B3", store: "HYD-N-KMP", onHand: "52", bin: "B-02-03" },
  { variantSku: "STL-JSW-FE550D-16-B3", store: "HYD-S-ATP", onHand: "0", bin: "B-02-03" },

  // Blocks.
  { variantSku: "BLK-AAC-600200-150", store: "HYD-N-KMP", onHand: "3400", bin: "C-03-01" },
  { variantSku: "BLK-AAC-600200-150", store: "HYD-E-UPL", onHand: "1250", bin: "C-03-01" },
  { variantSku: "BLK-AAC-600200-200", store: "HYD-N-KMP", onHand: "620", bin: "C-03-02" },
  { variantSku: "BLK-AAC-600200-200", store: "HYD-W-GCB", onHand: "410", bin: "C-03-02" },

  // Waterproofing — a quarantined batch after a leaking-can complaint.
  { variantSku: "WPF-DRFIXIT-LW20-STD", store: "HYD-S-ATP", onHand: "96", qualityHold: "24", bin: "D-04-01" },
  { variantSku: "WPF-DRFIXIT-LW20-STD", store: "HYD-W-GCB", onHand: "31", bin: "D-04-01" },

  // Tiles — the flagship interiors line, stocked everywhere.
  { variantSku: "TIL-KAJ-VIT-600-GLS-STW", store: "HYD-W-GCB", onHand: "486", bin: "E-05-01" },
  { variantSku: "TIL-KAJ-VIT-600-GLS-STW", store: "HYD-N-KMP", onHand: "212", bin: "E-05-01" },
  { variantSku: "TIL-KAJ-VIT-600-GLS-STW", store: "HYD-S-ATP", onHand: "94", bin: "E-05-02" },
  { variantSku: "TIL-KAJ-VIT-600-MAT-GRY", store: "HYD-W-GCB", onHand: "308", bin: "E-05-03" },
  { variantSku: "TIL-KAJ-VIT-600-MAT-GRY", store: "HYD-E-UPL", onHand: "62", blocked: "14", bin: "E-05-03" },
  { variantSku: "TIL-SOM-CER-300-IVY", store: "HYD-W-GCB", onHand: "176", bin: "E-05-04" },
  { variantSku: "TIL-SOM-CER-300-IVY", store: "HYD-S-ATP", onHand: "58", bin: "E-05-04" },
  { variantSku: "GRN-BLKGAL-SLAB-18", store: "HYD-S-ATP", onHand: "1420", bin: "F-06-01" },
  { variantSku: "GRN-BLKGAL-SLAB-18", store: "HYD-W-GCB", onHand: "260", bin: "F-06-01" },

  // Paint.
  { variantSku: "PNT-AP-APEX-20-WHT", store: "HYD-W-GCB", onHand: "74", bin: "G-07-01" },
  { variantSku: "PNT-AP-APEX-20-WHT", store: "HYD-N-KMP", onHand: "22", bin: "G-07-01" },
  { variantSku: "PNT-BRG-SILK-10-PST", store: "HYD-W-GCB", onHand: "18", bin: "G-07-02" },
  { variantSku: "PNT-BRG-SILK-10-PST", store: "HYD-E-UPL", onHand: "0", bin: "G-07-02" },

  // Sanitaryware and plumbing.
  { variantSku: "SAN-JAQ-CP-BASIN-CHR", store: "HYD-W-GCB", onHand: "64", bin: "H-08-01" },
  { variantSku: "SAN-JAQ-CP-BASIN-CHR", store: "HYD-N-KMP", onHand: "12", bin: "H-08-01" },
  { variantSku: "PLB-ASTRAL-CPVC-25-3M", store: "HYD-E-UPL", onHand: "540", bin: "H-08-02" },
  { variantSku: "PLB-ASTRAL-CPVC-25-3M", store: "HYD-N-KMP", onHand: "128", bin: "H-08-02" },

  // Electrical.
  { variantSku: "ELE-HAV-FR-2R5-RED", store: "HYD-E-UPL", onHand: "210", bin: "J-09-01" },
  { variantSku: "ELE-HAV-FR-2R5-BLK", store: "HYD-E-UPL", onHand: "42", bin: "J-09-02" },
  { variantSku: "ELE-HAV-FR-2R5-RED", store: "HYD-W-GCB", onHand: "88", bin: "J-09-01" },
  { variantSku: "LIT-PHI-LED-18W-CDL", store: "HYD-W-GCB", onHand: "430", bin: "J-09-03" },
  { variantSku: "LIT-PHI-LED-18W-CDL", store: "HYD-S-ATP", onHand: "86", bin: "J-09-03" },

  // Panels, ceiling, adhesive, glass.
  { variantSku: "WD-CEN-PLY-18-8X4", store: "HYD-N-KMP", onHand: "96", bin: "K-10-01" },
  { variantSku: "WD-CEN-PLY-18-8X4", store: "HYD-W-GCB", onHand: "34", bin: "K-10-01" },
  { variantSku: "FC-ARM-GYP-600-WHT", store: "HYD-W-GCB", onHand: "128", bin: "K-10-02" },
  { variantSku: "FC-ARM-GYP-600-WHT", store: "HYD-E-UPL", onHand: "36", qualityHold: "12", bin: "K-10-02" },
  { variantSku: "HW-PID-FEV-5-STD", store: "HYD-N-KMP", onHand: "82", bin: "L-11-01" },
  { variantSku: "HW-PID-FEV-5-STD", store: "HYD-S-ATP", onHand: "26", bin: "L-11-01" },
  { variantSku: "GLS-SG-CLR-8-STD", store: "HYD-S-ATP", onHand: "980", bin: "M-12-01" },
  { variantSku: "GLS-SG-CLR-8-STD", store: "HYD-W-GCB", onHand: "180", bin: "M-12-01" },
];

interface ProjectSeed {
  code: string; name: string; zone: string; city: string; address: string;
  contact: string; phone: string; status: "PLANNING" | "ACTIVE" | "ON_HOLD";
  startsOn: string; endsOn: string; notes: string;
  requirements: {
    variantSku: string; store: string | null; qty: string; requiredBy: string;
    /** How much of the line to hold now. Zero leaves it unreserved and at risk. */
    reserve: string;
  }[];
}

const PROJECTS: ProjectSeed[] = [
  {
    code: "HYD-TOWER-04", name: "Aparna Sarovar Tower 4 — Structure", zone: "HYD_WEST",
    city: "Hyderabad", address: "Nallagandla, Serilingampally", contact: "Mahesh Kumar",
    phone: "+91 98490 11223", status: "ACTIVE", startsOn: "2026-06-01", endsOn: "2026-12-20",
    notes: "Slab casting on floors 9–14. Cement and steel drawn weekly.",
    requirements: [
      { variantSku: "CEM-UTC-OPC53-50-STD", store: "HYD-W-GCB", qty: "600", requiredBy: "2026-09-08", reserve: "180" },
      { variantSku: "STL-TATA-FE500D-12-B5", store: "HYD-W-GCB", qty: "40", requiredBy: "2026-09-05", reserve: "24" },
      { variantSku: "BLK-AAC-600200-200", store: "HYD-W-GCB", qty: "900", requiredBy: "2026-09-22", reserve: "0" },
    ],
  },
  {
    code: "HYD-VILLA-KOK", name: "Kokapet Villa Interiors — Phase 2", zone: "HYD_WEST",
    city: "Hyderabad", address: "Kokapet Neopolis, Gandipet", contact: "Sruthi Nair",
    phone: "+91 90000 44556", status: "ACTIVE", startsOn: "2026-07-15", endsOn: "2026-10-31",
    notes: "Fourteen villas. Tile, paint and CP fittings staged from Gachibowli.",
    requirements: [
      { variantSku: "TIL-KAJ-VIT-600-GLS-STW", store: "HYD-W-GCB", qty: "240", requiredBy: "2026-09-12", reserve: "240" },
      { variantSku: "PNT-AP-APEX-20-WHT", store: "HYD-W-GCB", qty: "36", requiredBy: "2026-09-18", reserve: "20" },
      { variantSku: "SAN-JAQ-CP-BASIN-CHR", store: "HYD-W-GCB", qty: "42", requiredBy: "2026-09-25", reserve: "0" },
      { variantSku: "LIT-PHI-LED-18W-CDL", store: "HYD-W-GCB", qty: "180", requiredBy: "2026-10-02", reserve: "60" },
    ],
  },
  {
    code: "HYD-OFFICE-UPL", name: "Uppal IT Park — Fit-out Block C", zone: "HYD_EAST",
    city: "Hyderabad", address: "Survey 42, Uppal Ring Road", contact: "Farhan Qureshi",
    phone: "+91 99590 77889", status: "PLANNING", startsOn: "2026-09-10", endsOn: "2027-02-28",
    notes: "False ceiling and electrical first fix. Stock not yet committed.",
    requirements: [
      { variantSku: "FC-ARM-GYP-600-WHT", store: "HYD-E-UPL", qty: "220", requiredBy: "2026-09-30", reserve: "0" },
      { variantSku: "ELE-HAV-FR-2R5-BLK", store: "HYD-E-UPL", qty: "120", requiredBy: "2026-10-08", reserve: "0" },
      { variantSku: "PLB-ASTRAL-CPVC-25-3M", store: "HYD-E-UPL", qty: "300", requiredBy: "2026-10-20", reserve: "150" },
    ],
  },
];

function assertDevelopmentOnly(url: string): void {
  const env = process.env.NODE_ENV ?? "development";
  if (env !== "development" && env !== "test") {
    throw new Error(`Refusing to seed with NODE_ENV=${env}. This writes demonstration data and is development-only.`);
  }
  if (/prod|production/i.test(url)) {
    throw new Error("Refusing to seed: DATABASE_URL looks like a production database.");
  }
}

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

const today = (offsetDays = 0): string => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
};

interface Summary {
  orgCreated: boolean; usersCreated: number; stores: number; locations: number;
  uoms: number; categories: number; vendors: number; products: number; variants: number;
  stockRows: number; ledgerRows: number; purchaseOrders: number; transfers: number;
  projects: number; requirements: number; reservations: number; auditEvents: number;
  skippedExisting: boolean;
}

async function seed(db: Db): Promise<Summary> {
  const s: Summary = {
    orgCreated: false, usersCreated: 0, stores: 0, locations: 0, uoms: 0, categories: 0,
    vendors: 0, products: 0, variants: 0, stockRows: 0, ledgerRows: 0, purchaseOrders: 0,
    transfers: 0, projects: 0, requirements: 0, reservations: 0, auditEvents: 0,
    skippedExisting: false,
  };
  const now = new Date();

  const existing = await db
    .select({ id: invProducts.id })
    .from(invProducts)
    .where(eq(invProducts.orgId, ORG_ID))
    .limit(1);
  if (existing.length > 0) {
    s.skippedExisting = true;
    return s;
  }

  // ---- organisation, owner, staff ----------------------------------------
  const [ownerSeq] = await db.execute(
    sql`SELECT nextval(pg_get_serial_sequence('organization_members', 'id')) AS id`,
  );
  const ownerMembershipId = Number(ownerSeq?.id);

  // The owner user first: the membership row below references it, and that FK is
  // not deferrable.
  const ownerRows = await db
    .insert(users)
    .values({
      id: OWNER_ID,
      email: "owner@buildmart.local",
      name: "Buildmart Owner",
      firstName: "Buildmart",
      lastName: "Owner",
      emailVerified: now,
      isActive: true,
      userStatus: "active",
      activatedAt: now,
    })
    .onConflictDoUpdate({ target: users.email, set: { isActive: true } })
    .returning({ id: users.id });
  const ownerId = ownerRows[0]?.id ?? OWNER_ID;
  s.usersCreated += ownerRows.length;

  /**
   * `organizations.owner_membership_id` and `organization_members.org_id` point
   * at each other, and `fk_organizations_owner_membership` is DEFERRABLE
   * INITIALLY DEFERRED. Neither row can be written without the other already
   * existing, so both have to land in **one** transaction — outside one, each
   * statement is its own transaction and the deferred check fires immediately
   * with a foreign-key violation on a row that is one statement away.
   */
  const orgCreated = await db.transaction(async (tx) => {
    const rows = await tx
      .insert(organizations)
      .values({
        id: ORG_ID,
        region: DEFAULT_REGION,
        ownerMembershipId,
        name: "Buildmart Materials",
        slug: ORG_SLUG,
        industry: "Construction & Building Materials",
        companySize: "51-200",
        country: "IN",
        onboardingCompletedAt: now,
        status: "ACTIVE",
      })
      .onConflictDoNothing({ target: organizations.id })
      .returning({ id: organizations.id });
    await tx
      .insert(organizationMembers)
      .values({ id: ownerMembershipId, userId: ownerId, orgId: ORG_ID, isOwner: true })
      .onConflictDoNothing();
    return rows.length > 0;
  });
  s.orgCreated = orgCreated;

  await db
    .update(users)
    .set({ lastActiveOrgId: ORG_ID })
    .where(eq(users.id, ownerId));

  /**
   * Placement. `organizations.region` is a column, not a placement — every
   * tenant transaction resolves the org through `organization_placement`, and an
   * org without a row there is unreachable: every background sweep logs
   * "has no region. It must be placed before its data can be reached" and every
   * request for it fails. The registration flow calls `placeOrganization`; this
   * writes the same row rather than importing the service graph.
   */
  await db
    .insert(organizationPlacement)
    .values({
      organizationId: ORG_ID,
      region: DEFAULT_REGION,
      cellId: LEGACY_CELL_ID,
      databaseShard: DEFAULT_DATABASE_SHARD,
      objectStorageRegion: DEFAULT_REGION,
      searchCluster: DEFAULT_SEARCH_CLUSTER,
      placementVersion: 1,
      writeFenceToken: newWriteFenceToken(),
      leaseExpiresAt: new Date(Date.now() + FENCE_LEASE_MS),
      status: "ACTIVE",
    })
    .onConflictDoNothing({ target: organizationPlacement.organizationId });

  for (const person of STAFF) {
    const rows = await db
      .insert(users)
      .values({
        id: person.id,
        email: person.email,
        name: `${person.firstName} ${person.lastName}`,
        firstName: person.firstName,
        lastName: person.lastName,
        emailVerified: now,
        isActive: true,
        userStatus: "active",
        lastActiveOrgId: ORG_ID,
        activatedAt: now,
      })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id });
    if (rows.length > 0) {
      s.usersCreated += 1;
      await db
        .insert(organizationMembers)
        .values({ userId: rows[0]!.id, orgId: ORG_ID, isOwner: false })
        .onConflictDoNothing();
    }
  }

  await db
    .insert(subscriptions)
    .values({ orgId: ORG_ID, plan: "PROFESSIONAL", status: "ACTIVE" })
    .onConflictDoNothing();

  /**
   * Inventory is plan-gated, so a subscription alone does not open it:
   * `ModuleGuard` reads `org_modules`, and with no row every inventory route
   * answers MODULE_NOT_ENABLED. The onboarding flow writes these; the seed
   * writes the ones this data set needs.
   */
  for (const moduleKey of ["inventory", "crm", "accounting"]) {
    await db
      .insert(orgModules)
      .values({ orgId: ORG_ID, moduleKey, enabled: true, enabledBy: ownerId })
      .onConflictDoNothing();
  }

  // The pack this whole seed exists to demonstrate. Without it the catalogue
  // attributes are stripped from every response and the project routes 404.
  await db
    .insert(invSettings)
    .values({
      orgId: ORG_ID,
      packWarehouse: true,
      packMaterials: true,
      packGst: true,
      allowNegativeStock: false,
      autoReserveOnConfirm: true,
      overReceiptTolerancePct: "5.00",
      requirePoApproval: true,
      poApprovalThreshold: "500000.0000",
    })
    .onConflictDoUpdate({ target: invSettings.orgId, set: { packMaterials: true, packWarehouse: true } });

  // ---- units, categories --------------------------------------------------
  const uomIds = new Map<string, number>();
  for (const u of UOMS) {
    const [row] = await db
      .insert(invUom)
      .values({
        orgId: ORG_ID, name: u.name, abbreviation: u.abbreviation,
        category: u.category, isBase: u.isBase, ratioToBase: "1",
      })
      .returning({ id: invUom.id });
    uomIds.set(u.name, row!.id);
    s.uoms += 1;
  }

  const categoryIds = new Map<string, number>();
  for (const c of CATEGORIES) {
    const [row] = await db
      .insert(invCategories)
      .values({
        orgId: ORG_ID, name: c.name, description: c.description,
        parentCategoryId: c.parent ? categoryIds.get(c.parent) ?? null : null,
      })
      .returning({ id: invCategories.id });
    categoryIds.set(c.name, row!.id);
    s.categories += 1;
  }

  // ---- dark stores and their bins ----------------------------------------
  const storeIds = new Map<string, number>();
  const binIds = new Map<string, number>();
  const receivingIds = new Map<string, number>();
  const transitIds = new Map<string, number>();
  for (const store of STORES) {
    const [wh] = await db
      .insert(invWarehouses)
      .values({
        orgId: ORG_ID, name: store.name, code: store.code,
        address: store.address, city: "Hyderabad", state: "Telangana", country: "IN",
        facilityType: "DARK_STORE", zone: store.zone, zoneLabel: store.zoneLabel,
        deliveryPromiseMinutes: store.promiseMinutes, serviceRadiusKm: store.radiusKm,
        latitude: store.lat, longitude: store.lng,
        isDefault: store.code === "HYD-N-KMP", isActive: true, createdBy: ownerId,
      })
      .returning({ id: invWarehouses.id });
    storeIds.set(store.code, wh!.id);
    s.stores += 1;

    // The five standard locations every store gets, plus the racking bins the
    // stock rows below name. `TRANSIT` is where a dispatched transfer parks: it
    // is `is_sellable = false`, which is what keeps goods in a van out of every
    // availability figure.
    const fixed = [
      { name: "Receiving Dock", code: "RECEIVING", locationType: "RECEIVING" as const, isReceivable: true, isPickable: false, isSellable: true },
      { name: "Dispatch Bay", code: "SHIPPING", locationType: "SHIPPING" as const, isReceivable: false, isPickable: true, isSellable: true },
      { name: "Quarantine", code: "QUARANTINE", locationType: "QUARANTINE" as const, isReceivable: false, isPickable: false, isSellable: false },
      { name: "Damaged / Scrap", code: "SCRAP", locationType: "SCRAP" as const, isReceivable: false, isPickable: false, isSellable: false },
      { name: "In Transit", code: "TRANSIT", locationType: "TRANSIT" as const, isReceivable: true, isPickable: false, isSellable: false },
    ];
    for (const loc of fixed) {
      const [row] = await db
        .insert(invLocations)
        .values({ orgId: ORG_ID, warehouseId: wh!.id, ...loc })
        .returning({ id: invLocations.id });
      s.locations += 1;
      if (loc.code === "RECEIVING") receivingIds.set(store.code, row!.id);
      if (loc.code === "TRANSIT") transitIds.set(store.code, row!.id);
    }

    const bins = [...new Set(STOCK.filter((r) => r.store === store.code).map((r) => r.bin))];
    for (const bin of bins) {
      const [row] = await db
        .insert(invLocations)
        .values({
          orgId: ORG_ID, warehouseId: wh!.id, name: `Bin ${bin}`, code: bin,
          locationType: "BIN", isPickable: true, isReceivable: true, isSellable: true,
        })
        .returning({ id: invLocations.id });
      binIds.set(`${store.code}:${bin}`, row!.id);
      s.locations += 1;
    }
  }

  // ---- suppliers ----------------------------------------------------------
  const vendorIds = new Map<string, number>();
  for (const v of VENDORS) {
    const [row] = await db
      .insert(invVendors)
      .values({
        orgId: ORG_ID, name: v.name, code: v.code, email: v.email, phone: v.phone,
        address: `${v.city}, Telangana`, gstin: v.gstin, leadTimeDays: v.leadTimeDays,
        paymentTermsDays: 30, currency: "INR", isActive: true, createdBy: ownerId,
      })
      .returning({ id: invVendors.id });
    vendorIds.set(v.code, row!.id);
    s.vendors += 1;
  }

  // ---- catalogue ----------------------------------------------------------
  const variantIds = new Map<string, number>();
  const variantCost = new Map<string, string>();
  for (const p of PRODUCTS) {
    const [product] = await db
      .insert(invProducts)
      .values({
        orgId: ORG_ID,
        categoryId: categoryIds.get(p.category) ?? null,
        uomId: uomIds.get(p.uom) ?? null,
        purchaseUomId: uomIds.get(p.uom) ?? null,
        salesUomId: uomIds.get(p.uom) ?? null,
        defaultVendorId: vendorIds.get(p.vendor) ?? null,
        name: p.name, sku: p.sku, barcode: p.barcode,
        description: [p.brand, p.grade, p.dimension].filter(Boolean).join(" · "),
        status: "ACTIVE", productType: "STOCKABLE", trackingMethod: "NONE",
        costingMethod: "WEIGHTED_AVERAGE",
        costPrice: p.costPrice, sellingPrice: p.sellingPrice,
        reorderPoint: p.reorderPoint, reorderEnabled: true,
        minStockLevel: p.reorderPoint, maxStockLevel: String(Number(p.reorderPoint) * 4),
        hasVariants: p.variants.length > 1,
        brand: p.brand, materialGrade: p.grade, finish: p.finish, colour: p.colour,
        dimensionLabel: p.dimension, materialFamily: p.family, packSize: p.packSize,
        supplierCode: p.supplierCode, leadTimeDays: p.leadTimeDays, reorderQuantity: p.reorderQuantity,
        hsnCode: "6810", taxTreatment: "TAXABLE", gstRate: "18.00",
        imageUrl: p.imageUrl,
        createdBy: ownerId,
      })
      .returning({ id: invProducts.id });
    s.products += 1;

    for (const v of p.variants) {
      const [row] = await db
        .insert(invProductVariants)
        .values({
          orgId: ORG_ID, productId: product!.id, name: v.name, sku: v.sku,
          barcode: `${p.barcode}${String(s.variants % 10)}`,
          costPrice: p.costPrice, sellingPrice: p.sellingPrice,
          attributeValues: v.attrs, isActive: true,
          weightGrams: v.weightGrams ?? null, lengthMm: v.lengthMm ?? null,
          widthMm: v.widthMm ?? null, heightMm: v.heightMm ?? null,
        })
        .returning({ id: invProductVariants.id });
      variantIds.set(v.sku, row!.id);
      variantCost.set(v.sku, p.costPrice);
      s.variants += 1;
    }
  }

  // ---- opening stock, with the ledger that produced it --------------------
  //
  // Every balance below is written together with the movements that explain it,
  // inside one transaction. `chk_inv_stock_transactions_arithmetic` enforces
  // `after = before + change`, so this cannot drift even by accident.
  await db.transaction(async (tx) => {
    for (const row of STOCK) {
      const variantId = variantIds.get(row.variantSku);
      const locationId = binIds.get(`${row.store}:${row.bin}`);
      if (!variantId || !locationId) continue;
      const cost = variantCost.get(row.variantSku) ?? "0";

      await tx.insert(invStockLevels).values({
        orgId: ORG_ID, productVariantId: variantId, locationId,
        onHand: row.onHand, committed: "0", onOrder: "0",
        blockedQty: row.blocked ?? "0", qualityHoldQty: row.qualityHold ?? "0",
        outgoingQty: "0", averageCost: cost, ownership: "OWNED",
      });
      s.stockRows += 1;

      if (Number(row.onHand) > 0) {
        await tx.insert(invStockTransactions).values({
          orgId: ORG_ID, productVariantId: variantId, locationId,
          transactionType: "OPENING_BALANCE", quantityBucket: "ON_HAND",
          quantityChange: row.onHand, quantityBefore: "0", quantityAfter: row.onHand,
          unitCost: cost, totalCost: String(Number(cost) * Number(row.onHand)),
          postingDate: today(-21), reason: "Opening balance at go-live",
          referenceType: "seed", referenceId: `opening:${row.store}:${row.variantSku}`,
          createdBy: ownerId, ownership: "OWNED",
        });
        s.ledgerRows += 1;
      }
      if (row.blocked && Number(row.blocked) > 0) {
        await tx.insert(invStockTransactions).values({
          orgId: ORG_ID, productVariantId: variantId, locationId,
          transactionType: "ADJUSTMENT_OUT", quantityBucket: "BLOCKED",
          quantityChange: row.blocked, quantityBefore: "0", quantityAfter: row.blocked,
          unitCost: cost, postingDate: today(-4),
          reason: "Damaged in handling — blocked pending write-off",
          referenceType: "seed", referenceId: `damage:${row.store}:${row.variantSku}`,
          createdBy: ownerId, ownership: "OWNED",
        });
        s.ledgerRows += 1;
      }
      if (row.qualityHold && Number(row.qualityHold) > 0) {
        await tx.insert(invStockTransactions).values({
          orgId: ORG_ID, productVariantId: variantId, locationId,
          transactionType: "QUARANTINE_IN", quantityBucket: "QUALITY_HOLD",
          quantityChange: row.qualityHold, quantityBefore: "0", quantityAfter: row.qualityHold,
          unitCost: cost, postingDate: today(-6),
          reason: "Batch quarantined after a customer complaint",
          referenceType: "seed", referenceId: `qa:${row.store}:${row.variantSku}`,
          createdBy: ownerId, ownership: "OWNED",
        });
        s.ledgerRows += 1;
      }
    }
  });

  // ---- open purchase orders ----------------------------------------------
  const POS: { vendor: string; store: string; number: string; status: "SENT" | "PARTIAL" | "DRAFT"; lines: { variantSku: string; qty: string; received: string }[] }[] = [
    {
      vendor: "SUP-UTC", store: "HYD-E-UPL", number: "PO-2026-0141", status: "SENT",
      lines: [
        { variantSku: "CEM-UTC-OPC53-50-STD", qty: "1000", received: "0" },
        { variantSku: "CEM-ACC-PPC-50-STD", qty: "400", received: "0" },
      ],
    },
    {
      vendor: "SUP-TIS", store: "HYD-S-ATP", number: "PO-2026-0142", status: "PARTIAL",
      lines: [{ variantSku: "STL-JSW-FE550D-16-B3", qty: "45", received: "18" }],
    },
    {
      vendor: "SUP-APL", store: "HYD-E-UPL", number: "PO-2026-0143", status: "SENT",
      lines: [{ variantSku: "PNT-BRG-SILK-10-PST", qty: "60", received: "0" }],
    },
    {
      vendor: "SUP-KAJ", store: "HYD-W-GCB", number: "PO-2026-0144", status: "DRAFT",
      lines: [{ variantSku: "TIL-KAJ-VIT-600-GLS-STW", qty: "300", received: "0" }],
    },
  ];

  for (const po of POS) {
    const subtotal = po.lines.reduce(
      (acc, l) => acc + Number(l.qty) * Number(variantCost.get(l.variantSku) ?? "0"), 0,
    );
    const tax = subtotal * 0.18;
    const [row] = await db
      .insert(invPurchaseOrders)
      .values({
        orgId: ORG_ID, vendorId: vendorIds.get(po.vendor)!, poNumber: po.number,
        status: po.status, orderDate: today(-9), expectedDeliveryDate: today(3),
        warehouseId: storeIds.get(po.store)!,
        subtotal: subtotal.toFixed(4), taxAmount: tax.toFixed(4),
        total: (subtotal + tax).toFixed(4), currency: "INR",
        notes: "Weekly replenishment against reorder report",
        sentAt: po.status === "DRAFT" ? null : new Date(Date.now() - 9 * 864e5),
        createdBy: ownerId,
      })
      .returning({ id: invPurchaseOrders.id });
    s.purchaseOrders += 1;
    for (const l of po.lines) {
      const cost = variantCost.get(l.variantSku) ?? "0";
      await db.insert(invPoLines).values({
        orgId: ORG_ID, poId: row!.id, productVariantId: variantIds.get(l.variantSku)!,
        quantity: l.qty, quantityReceived: l.received, unitCost: cost,
        taxRate: "18.00", amount: (Number(l.qty) * Number(cost)).toFixed(4),
        hsnCode: "6810", taxTreatment: "TAXABLE",
      });
    }
  }

  // ---- a transfer already in the van -------------------------------------
  //
  // Kompally is long on cement and Uppal is out of it. The goods have left, so
  // they sit at Kompally's TRANSIT location — on hand org-wide, unavailable
  // everywhere, which is exactly what `availableQtySql` is written to enforce.
  const transferVariant = variantIds.get("CEM-UTC-OPC53-50-STD")!;
  const transferQty = "300";
  const sourceBin = binIds.get("HYD-N-KMP:A-01-01")!;
  const transitLoc = transitIds.get("HYD-N-KMP")!;

  await db.transaction(async (tx) => {
    const [transfer] = await tx
      .insert(invStockTransfers)
      .values({
        orgId: ORG_ID, referenceNumber: "TRF-2026-0088",
        fromLocationId: sourceBin, toLocationId: receivingIds.get("HYD-E-UPL")!,
        fromWarehouseId: storeIds.get("HYD-N-KMP")!, toWarehouseId: storeIds.get("HYD-E-UPL")!,
        status: "IN_TRANSIT",
        notes: "Uppal is out of OPC 53. Van left Kompally at 06:40.",
        reservedAt: new Date(Date.now() - 30 * 36e5),
        dispatchedAt: new Date(Date.now() - 28 * 36e5),
        createdBy: ownerId,
      })
      .returning({ id: invStockTransfers.id });
    s.transfers += 1;

    await tx.insert(invStockTransferLines).values({
      orgId: ORG_ID, transferId: transfer!.id, productVariantId: transferVariant,
      quantity: transferQty, quantityReceived: "0",
      dispatchedUnitCost: variantCost.get("CEM-UTC-OPC53-50-STD") ?? "0",
      notes: "300 bags, 6 pallets",
    });

    // Out of the source bin…
    const sourceBefore = STOCK.find((r) => r.variantSku === "CEM-UTC-OPC53-50-STD" && r.store === "HYD-N-KMP")!.onHand;
    const sourceAfter = String(Number(sourceBefore) - Number(transferQty));
    await tx
      .update(invStockLevels)
      .set({ onHand: sourceAfter })
      .where(and(eq(invStockLevels.orgId, ORG_ID), eq(invStockLevels.productVariantId, transferVariant), eq(invStockLevels.locationId, sourceBin)));
    await tx.insert(invStockTransactions).values({
      orgId: ORG_ID, productVariantId: transferVariant, locationId: sourceBin,
      transactionType: "TRANSFER_OUT", quantityBucket: "ON_HAND",
      quantityChange: `-${transferQty}`, quantityBefore: sourceBefore, quantityAfter: sourceAfter,
      unitCost: variantCost.get("CEM-UTC-OPC53-50-STD") ?? "0",
      postingDate: today(-1), reason: "Transfer to Uppal — stockout cover",
      referenceType: "inv_stock_transfer", referenceId: String(transfer!.id),
      createdBy: ownerId, ownership: "OWNED",
    });

    // …and into transit, where nothing can pick it.
    await tx.insert(invStockLevels).values({
      orgId: ORG_ID, productVariantId: transferVariant, locationId: transitLoc,
      onHand: transferQty, committed: "0", onOrder: "0", blockedQty: "0",
      qualityHoldQty: "0", outgoingQty: "0",
      averageCost: variantCost.get("CEM-UTC-OPC53-50-STD") ?? "0", ownership: "OWNED",
    });
    await tx.insert(invStockTransactions).values({
      orgId: ORG_ID, productVariantId: transferVariant, locationId: transitLoc,
      transactionType: "TRANSFER_IN", quantityBucket: "ON_HAND",
      quantityChange: transferQty, quantityBefore: "0", quantityAfter: transferQty,
      unitCost: variantCost.get("CEM-UTC-OPC53-50-STD") ?? "0",
      postingDate: today(-1), reason: "In transit to Uppal",
      referenceType: "inv_stock_transfer", referenceId: String(transfer!.id),
      createdBy: ownerId, ownership: "OWNED",
    });
    s.stockRows += 1;
    s.ledgerRows += 2;
  });

  // ---- projects, requirements and the stock held for them ----------------
  for (const p of PROJECTS) {
    const [project] = await db
      .insert(invProjects)
      .values({
        orgId: ORG_ID, code: p.code, name: p.name, city: p.city, zone: p.zone,
        siteAddress: p.address, siteContactName: p.contact, siteContactPhone: p.phone,
        status: p.status, startsOn: p.startsOn, endsOn: p.endsOn, notes: p.notes,
        createdBy: ownerId,
      })
      .returning({ id: invProjects.id });
    s.projects += 1;

    for (const r of p.requirements) {
      const variantId = variantIds.get(r.variantSku);
      if (!variantId) continue;
      const reserving = Number(r.reserve) > 0;
      const full = reserving && Number(r.reserve) >= Number(r.qty);
      const [req] = await db
        .insert(invProjectRequirements)
        .values({
          orgId: ORG_ID, projectId: project!.id, productVariantId: variantId,
          warehouseId: r.store ? storeIds.get(r.store) ?? null : null,
          requiredQty: r.qty, fulfilledQty: "0", requiredBy: r.requiredBy,
          status: full ? "RESERVED" : reserving ? "PARTIALLY_FULFILLED" : "REQUESTED",
          notes: null, createdBy: ownerId,
        })
        .returning({ id: invProjectRequirements.id });
      s.requirements += 1;

      if (!reserving) continue;

      // A reservation is `committed` on the stock row plus the reservation row —
      // both, in one transaction, or availability and the reservation list
      // disagree and neither can be trusted.
      const locationId = r.store
        ? binIds.get(`${r.store}:${STOCK.find((x) => x.variantSku === r.variantSku && x.store === r.store)?.bin ?? ""}`)
        : undefined;
      if (!locationId) continue;

      await db.transaction(async (tx) => {
        await tx.insert(invStockReservations).values({
          orgId: ORG_ID, sourceType: "PROJECT_REQUIREMENT",
          sourceId: String(project!.id), sourceLineId: String(req!.id),
          productVariantId: variantId,
          warehouseId: r.store ? storeIds.get(r.store) ?? null : null,
          locationId, reservedQty: r.reserve, status: "ACTIVE",
          // Site holds lapse: a reservation with no expiry on a slipped site is
          // stock nobody can sell and nobody is using.
          expiresAt: new Date(`${r.requiredBy}T18:00:00Z`),
        });
        await tx
          .update(invStockLevels)
          .set({ committed: sql`${invStockLevels.committed}::numeric + ${r.reserve}::numeric` })
          .where(and(
            eq(invStockLevels.orgId, ORG_ID),
            eq(invStockLevels.productVariantId, variantId),
            eq(invStockLevels.locationId, locationId),
          ));
      });
      s.reservations += 1;
    }
  }

  // ---- audit trail --------------------------------------------------------
  const auditRows = [
    { action: "warehouse.created", resourceType: "inv_warehouse", resourceId: String(storeIds.get("HYD-W-GCB")), metadata: { zone: "HYD_WEST", promiseMinutes: 60 } },
    { action: "settings.update", resourceType: "inv_settings", resourceId: ORG_ID, metadata: { packMaterials: true } },
    { action: "purchase_order.sent", resourceType: "inv_purchase_order", resourceId: "PO-2026-0141", metadata: { vendor: "UltraTech Cement — Telangana Depot" } },
    { action: "stock.transfer.dispatched", resourceType: "inv_stock_transfer", resourceId: "TRF-2026-0088", metadata: { from: "HYD-N-KMP", to: "HYD-E-UPL", qty: "300" } },
    { action: "stock.quarantined", resourceType: "inv_stock_level", resourceId: "WPF-DRFIXIT-LW20-STD@HYD-S-ATP", metadata: { qty: "24", reason: "leaking cans reported" } },
    { action: "project.requirement.reserved", resourceType: "inv_project_requirement", resourceId: "HYD-VILLA-KOK/TIL-KAJ-VIT-600-GLS-STW", metadata: { qty: "240" } },
  ];
  for (const a of auditRows) {
    await db.insert(invAuditEvents).values({
      orgId: ORG_ID, actorUserId: ownerId, action: a.action,
      resourceType: a.resourceType, resourceId: a.resourceId, metadata: a.metadata,
    });
    s.auditEvents += 1;
  }

  return s;
}

async function main(): Promise<void> {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is required");
  assertDevelopmentOnly(raw);
  const connectionString = normalizeDatabaseUrl(raw);
  const isNeon = /\.neon\.tech/i.test(connectionString);
  const client = postgres(connectionString, {
    prepare: false, max: 5, idle_timeout: 20,
    connect_timeout: isNeon ? 60 : 30,
    ...(isNeon ? { ssl: "require" as const } : {}),
  });
  const db = drizzle(client, { schema });
  try {
    process.stdout.write("Seeding Buildmart...\n");
    const summary = await seed(db);
    if (summary.skippedExisting) {
      process.stdout.write("Buildmart data already present — nothing written.\n");
    }
    process.stdout.write(JSON.stringify({ seed: "buildmart", ...summary }, null, 2) + "\n");
  } finally {
    await client.end({ timeout: 5 });
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    process.stderr.write(`[seed-buildmart] failed: ${error instanceof Error ? error.message : String(error)}\n`);
    if (error instanceof Error && error.stack) process.stderr.write(error.stack + "\n");
    process.exit(1);
  });
