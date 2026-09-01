import type { Permission } from "./types";

export const INVENTORY_PERMISSIONS: Permission[] = [
  {
    name: "inventory:products:read",
    resource: "inventory:products",
    action: "read",
    description: "View products",
    scopable: true,
  },
  {
    name: "inventory:products:create",
    resource: "inventory:products",
    action: "create",
    description: "Create products",
  },
  {
    name: "inventory:products:update",
    resource: "inventory:products",
    action: "update",
    description: "Update products",
  },
  {
    name: "inventory:products:delete",
    resource: "inventory:products",
    action: "delete",
    description: "Delete products",
  },
  {
    name: "inventory:stock:read",
    resource: "inventory:stock",
    action: "read",
    description: "View stock levels",
    scopable: true,
  },
  {
    name: "inventory:stock:adjust",
    resource: "inventory:stock",
    action: "adjust",
    description: "Adjust stock levels",
  },
  {
    name: "inventory:stock:transfer",
    resource: "inventory:stock",
    action: "transfer",
    description: "Transfer stock between warehouses",
  },
  {
    name: "inventory:warehouses:scope-all",
    resource: "inventory:warehouses",
    action: "scope-all",
    description: "See and transact in every warehouse, bypassing warehouse assignment",
  },
  {
    name: "inventory:adjustments:approve",
    resource: "inventory:adjustments",
    action: "approve",
    description: "Approve a stock adjustment raised by someone else",
  },
  {
    name: "inventory:adjustments:post",
    resource: "inventory:adjustments",
    action: "post",
    description: "Post an approved stock adjustment to the ledger",
  },
  {
    name: "inventory:warehouses:read",
    resource: "inventory:warehouses",
    action: "read",
    description: "View warehouses",
  },
  {
    name: "inventory:warehouses:manage",
    resource: "inventory:warehouses",
    action: "manage",
    description: "Manage warehouses",
  },
  {
    name: "inventory:vendors:read",
    resource: "inventory:vendors",
    action: "read",
    description: "View vendors",
  },
  {
    name: "inventory:vendors:manage",
    resource: "inventory:vendors",
    action: "manage",
    description: "Manage vendors",
  },
  {
    name: "inventory:purchase-orders:read",
    resource: "inventory:purchase-orders",
    action: "read",
    description: "View purchase orders",
    scopable: true,
  },
  {
    name: "inventory:purchase-orders:create",
    resource: "inventory:purchase-orders",
    action: "create",
    description: "Create purchase orders",
  },
  {
    name: "inventory:purchase-orders:approve",
    resource: "inventory:purchase-orders",
    action: "approve",
    description: "Approve purchase orders",
  },
  {
    name: "inventory:purchase-orders:receive",
    resource: "inventory:purchase-orders",
    action: "receive",
    description: "Receive purchase orders",
  },
  {
    name: "inventory:sales-orders:read",
    resource: "inventory:sales-orders",
    action: "read",
    description: "View sales orders",
    scopable: true,
  },
  {
    name: "inventory:sales-orders:create",
    resource: "inventory:sales-orders",
    action: "create",
    description: "Create sales orders",
  },
  {
    name: "inventory:sales-orders:confirm",
    resource: "inventory:sales-orders",
    action: "confirm",
    description: "Confirm sales orders",
  },
  {
    name: "inventory:sales-orders:ship",
    resource: "inventory:sales-orders",
    action: "ship",
    description: "Ship sales orders",
  },
  {
    name: "inventory:sales-orders:invoice",
    resource: "inventory:sales-orders",
    action: "invoice",
    description: "Invoice sales orders",
  },
  {
    /**
     * B5. Swapping a SKU at the shelf rewrites what the customer is owed, so it
     * is not the same authority as walking a wave. `inventory:sales-orders:ship`
     * says "you may pick and dispatch what was ordered"; this says "you may
     * change what was ordered", which is why it is a key of its own rather than
     * one more thing every picker holds.
     */
    name: "inventory:picking:substitute",
    resource: "inventory:picking",
    action: "substitute",
    description:
      "Swap a different SKU in at the shelf, rewriting the sales-order line and its reservation",
  },
  {
    /** B5. The supervisor half: owning, reassigning and resolving exceptions. */
    name: "inventory:picking:review",
    resource: "inventory:picking",
    action: "review",
    description: "Own and resolve pick exceptions raised by pickers",
  },
  {
    name: "inventory:reports:read",
    resource: "inventory:reports",
    action: "read",
    description: "View inventory reports",
  },
  {
    name: "inventory:stock:reserve",
    resource: "inventory:stock",
    action: "reserve",
    description: "Reserve stock against sales orders or transfers",
  },
  {
    name: "inventory:stock:reconcile",
    resource: "inventory:stock",
    action: "reconcile",
    description: "Reconcile stock ledger discrepancies",
  },
  {
    name: "inventory:purchase-orders:update",
    resource: "inventory:purchase-orders",
    action: "update",
    description: "Update purchase orders",
  },
  {
    name: "inventory:vendor-returns:manage",
    resource: "inventory:vendor-returns",
    action: "manage",
    description: "Manage vendor returns",
  },
  {
    name: "inventory:sales-orders:update",
    resource: "inventory:sales-orders",
    action: "update",
    description: "Update sales orders",
  },
  {
    name: "inventory:customer-returns:manage",
    resource: "inventory:customer-returns",
    action: "manage",
    description: "Manage customer returns",
  },
  {
    name: "inventory:valuation:read",
    resource: "inventory:valuation",
    action: "read",
    description: "View inventory valuation and costing reports",
  },
  {
    // Distinct from `purchase-orders:receive`, which every receiving clerk holds:
    // applying a landed-cost voucher restates what inventory is worth and posts
    // to the general ledger. Signing for a pallet and revaluing the balance sheet
    // are different authorities.
    name: "inventory:landed-cost:manage",
    resource: "inventory:landed-cost",
    action: "manage",
    description:
      "Raise landed-cost vouchers and apply freight, duty and handling into inventory cost layers",
  },
  {
    name: "inventory:settings:manage",
    resource: "inventory:settings",
    action: "manage",
    description: "Manage inventory settings and configuration",
  },
  {
    name: "inventory:import",
    resource: "inventory:import",
    action: "import",
    description: "Import inventory data",
  },
  {
    name: "inventory:export",
    resource: "inventory:export",
    action: "export",
    description: "Export inventory data",
  },
  {
    name: "inventory:audit:read",
    resource: "inventory:audit",
    action: "read",
    description: "Read the inventory audit trail — who changed which record, and when",
  },
  {
    name: "inventory:audit:export",
    resource: "inventory:audit",
    action: "export",
    description: "Take an immutable, checksummed audit export of the inventory ledger and audit trail",
  },
  {
    name: "inventory:webhooks:manage",
    resource: "inventory:webhooks",
    action: "manage",
    description: "Manage inventory webhooks",
  },
  {
    name: "inventory:quality:read",
    resource: "inventory:quality",
    action: "read",
    description: "View quality inspections and holds",
  },
  {
    name: "inventory:quality:inspect",
    resource: "inventory:quality",
    action: "inspect",
    description: "Perform quality inspections",
  },
  {
    name: "inventory:quality:release",
    resource: "inventory:quality",
    action: "release",
    description: "Release quality holds",
  },
  {
    name: "inventory:quality:recall",
    resource: "inventory:quality",
    action: "recall",
    description: "Manage product recalls",
  },
  {
    name: "inventory:quality:plans:manage",
    resource: "inventory:quality:plans",
    action: "manage",
    description:
      "Author and version the inspection plans that decide which arrivals must be inspected before they become available",
  },
  {
    name: "inventory:packages:manage",
    resource: "inventory:packages",
    action: "manage",
    description: "Manage shipment packages",
  },
  {
    name: "inventory:shipments:manage",
    resource: "inventory:shipments",
    action: "manage",
    description: "Manage outbound shipments",
  },
  {
    name: "inventory:loads:manage",
    resource: "inventory:loads",
    action: "manage",
    description: "Manage loads and containers",
  },
  {
    name: "inventory:channels:manage",
    resource: "inventory:channels",
    action: "manage",
    description: "Manage sales channel stock publications",
  },
  {
    name: "inventory:3pl:manage",
    resource: "inventory:3pl",
    action: "manage",
    description: "Manage 3PL warehouse connections",
  },
  {
    name: "inventory:replenishment:manage",
    resource: "inventory:replenishment",
    action: "manage",
    description: "Manage reorder rules and replenishment",
  },
  {
    name: "inventory:replenishment:read",
    resource: "inventory:replenishment",
    action: "read",
    description: "View replenishment proposals, transfer recommendations and forecast drift",
    scopable: true,
  },
  {
    name: "inventory:allocation:override",
    resource: "inventory:allocation",
    action: "override",
    description: "Override FEFO or a near-expiry block when allocating a lot, with a recorded reason",
  },
  {
    name: "inventory:transit:abandon",
    resource: "inventory:transit",
    action: "abandon",
    description: "Abandon or return-to-source stock stranded in transit by a short receipt",
  },
  {
    name: "inventory:labels:print",
    resource: "inventory:labels",
    action: "print",
    description: "Print barcode labels, goods-receipt notes and pick lists",
  },
  {
    name: "inventory:dock:manage",
    resource: "inventory:dock",
    action: "manage",
    description: "Book and manage dock appointments: which vehicle is at which door, and when",
  },
  {
    name: "inventory:kits:assemble",
    resource: "inventory:kits",
    action: "assemble",
    description:
      "Assemble and disassemble kits: consume components and create the kit SKU, moving valuation with them",
  },
  {
    name: "inventory:labor:read",
    resource: "inventory:labor",
    action: "read",
    description:
      "Read the warehouse labour board: units per hour and performance against standard, by named person",
    scopable: true,
  },
  {
    name: "inventory:ai:read",
    resource: "inventory:ai",
    action: "read",
    description:
      "Read AI-assisted inventory surfaces: the operations brief, the digest, insight explanations and supplier-delay signals",
  },
  {
    name: "inventory:ai:propose",
    resource: "inventory:ai",
    action: "propose",
    description: "Propose AI-generated reorder draft POs and confirm them",
  },
  {
    name: "inventory:projects:read",
    resource: "inventory:projects",
    action: "read",
    description:
      "View construction projects and the material each site still needs, including what is at risk of missing its date",
    scopable: true,
  },
  {
    name: "inventory:projects:manage",
    resource: "inventory:projects",
    action: "manage",
    description:
      "Create and edit construction projects and their material requirements. Reserving stock against a line is a separate key (inventory:stock:reserve)",
  },
  {
    name: "inventory:ai:manage",
    resource: "inventory:ai",
    action: "manage",
    description: "Dismiss or update AI-generated inventory insights",
  },
];
