/**
 * All Mongoose models for the KPI Storytelling Engine.
 *
 * Field names deliberately match the snake_case keys in data/generated/*.json so
 * the seed loader can insert rows verbatim. Schemas are intentionally permissive
 * (strict: false where the shape varies, e.g. documents) to stay hackathon-simple.
 *
 * Collections seeded from JSON:
 *   regions, kpis, products, users, accounts, renewals, sales, kpi_values,
 *   inventory, documents
 * Collections populated at runtime (later phases):
 *   document_embeddings (Phase 5), analysis_results (Phase 6)
 *
 * Multi-tenant: every collection the engine reads carries a `company` tag. The
 * synthetic Amazon-modeled seed data is company "DEMO"; a real company connected
 * via /api/connect (Phase 9) gets its own ticker (e.g. "AMZN"). All engine queries
 * filter by company, so tenants never collide.
 */
import { Schema, model, InferSchemaType } from "mongoose";

// `false as const` (not plain `false`) because mongoose types versionKey as
// `string | false`, and a widened `boolean` fails to assign — the source of 13
// otherwise-harmless tsc errors that were masking real ones.
const opts = { versionKey: false as const };
const company = { type: String, index: true, default: "DEMO" };

/* ------------------------------------------------------------------ reference */
const regionSchema = new Schema(
  { company, code: { type: String, index: true }, name: String },
  opts
);
regionSchema.index({ company: 1, code: 1 });

const kpiSchema = new Schema(
  {
    company,
    key: { type: String, index: true },
    name: String,
    unit: String,
    higher_is_better: Boolean,
  },
  opts
);
kpiSchema.index({ company: 1, key: 1 });

const productSchema = new Schema(
  {
    sku: { type: String, index: true },
    name: String,
    category: { type: String, index: true },
    subscription: Boolean,
    price: Number,
  },
  opts
);

const userSchema = new Schema(
  { name: String, email: { type: String, index: true }, role: String },
  opts
);

/* --------------------------------------------------------------- subscriptions */
const accountSchema = new Schema(
  {
    account_id: { type: String, index: true },
    name: String,
    region: { type: String, index: true },
    segment: String,
    plan_sku: String,
    seats: Number,
    mrr: Number,
  },
  opts
);

const renewalSchema = new Schema(
  {
    company,
    renewal_id: String,
    account_id: { type: String, index: true },
    account_name: String,
    region: { type: String, index: true },
    segment: String,
    plan_sku: String,
    period: { type: String, index: true },
    date: String,
    arr: Number,
    status: { type: String, index: true }, // renewed | churned
    churn_reason: { type: String, default: null },
  },
  opts
);
renewalSchema.index({ company: 1, region: 1, period: 1, status: 1 });

/* --------------------------------------------------------------------- structured */
const saleSchema = new Schema(
  {
    company,
    order_id: String,
    period: { type: String, index: true },
    date: String,
    region: { type: String, index: true },
    sku: String,
    product: String,
    category: { type: String, index: true },
    segment: { type: String, index: true },
    orders: Number,
    quantity: Number,
    unit_price: Number,
    discount: Number,
    revenue: Number,
    cost: Number,
    profit: Number,
    recurring: Boolean,
  },
  opts
);
saleSchema.index({ company: 1, region: 1, period: 1 });

const kpiValueSchema = new Schema(
  {
    company,
    kpi_key: { type: String, index: true },
    region: { type: String, index: true },
    period: { type: String, index: true },
    period_type: { type: String, default: "month" },
    value: Number,
  },
  opts
);
kpiValueSchema.index({ company: 1, kpi_key: 1, region: 1, period: 1 });

const inventorySchema = new Schema(
  {
    inventory_id: String,
    period: { type: String, index: true },
    region: { type: String, index: true },
    sku: String,
    product: String,
    units_on_hand: Number,
    stockout_events: Number,
  },
  opts
);

/* ------------------------------------------------------------------- unstructured */
// strict:false because docs carry optional fields (rating, priority, status, author, source)
const documentSchema = new Schema(
  {
    company,
    document_id: { type: String, index: true },
    type: { type: String, index: true }, // review | support_ticket | crm_note | sales_note | news | earnings_transcript
    period: { type: String, index: true },
    date: String,
    region: { type: String, index: true },
    category: String,
    text: String,
    themes: [String],
    negative: Boolean,
  },
  { ...opts, strict: false }
);
documentSchema.index({ company: 1, region: 1, period: 1, type: 1 });

/* --------------------------------------------------------- runtime (later phases) */
const documentEmbeddingSchema = new Schema(
  {
    document_id: { type: String, index: true, unique: true },
    model: String,
    dims: Number,
    vector: [Number],
  },
  opts
);

const analysisResultSchema = new Schema(
  {
    company,
    kpi_key: { type: String, index: true },
    region: { type: String, index: true },
    period: { type: String, index: true },
    change: Schema.Types.Mixed,      // {pct, zscore, tier, direction, ...}
    contributors: Schema.Types.Mixed, // driver decomposition
    aggregate: Schema.Types.Mixed,    // margin bridge / regional mix / seasonal prior
    evidence: Schema.Types.Mixed,     // retrieved documents + themes
    confidence: Schema.Types.Mixed,   // {score, label, reasons}
    ambiguity: Schema.Types.Mixed,
    ledger: Schema.Types.Mixed,       // ranked competing hypotheses + disconfirming tests
    forecast: Schema.Types.Mixed,     // backtested baseline + empirical intervals (or refusal)
    scenario: Schema.Types.Mixed,     // gated recovery arithmetic (or the reason it was withheld)
    action_plan: Schema.Types.Mixed,  // owned, quantified, falsifiable next steps
    provenance: Schema.Types.Mixed,   // show-the-math audit trail
    story: Schema.Types.Mixed,        // structured narrative
    created_at: { type: Date, default: Date.now },
  },
  opts
);
analysisResultSchema.index({ company: 1, kpi_key: 1, region: 1, period: 1 });

/* ------------------------------------------------------------------- companies */
// One row per connected tenant. DEMO is implicit (the seeded synthetic company);
// real companies are inserted by /api/connect (Phase 9).
const companySchema = new Schema(
  {
    ticker: { type: String, index: true, unique: true },
    name: String,
    sources: [String], // e.g. ["fmp", "newsapi"]
    counts: Schema.Types.Mixed, // { kpiValues, regions, documents }
    connected_at: { type: Date, default: Date.now },
  },
  opts
);

/* ---------------------------------------------------------------------- exports */
export const Region = model("Region", regionSchema, "regions");
export const Kpi = model("Kpi", kpiSchema, "kpis");
export const Product = model("Product", productSchema, "products");
export const User = model("User", userSchema, "users");
export const Account = model("Account", accountSchema, "accounts");
export const Renewal = model("Renewal", renewalSchema, "renewals");
export const Sale = model("Sale", saleSchema, "sales");
export const KpiValue = model("KpiValue", kpiValueSchema, "kpi_values");
export const Inventory = model("Inventory", inventorySchema, "inventory");
export const Document = model("Document", documentSchema, "documents");
export const DocumentEmbedding = model(
  "DocumentEmbedding",
  documentEmbeddingSchema,
  "document_embeddings"
);
export const AnalysisResult = model(
  "AnalysisResult",
  analysisResultSchema,
  "analysis_results"
);
export const Company = model("Company", companySchema, "companies");

export type SaleDoc = InferSchemaType<typeof saleSchema>;
export type KpiValueDoc = InferSchemaType<typeof kpiValueSchema>;
export type DocumentDoc = InferSchemaType<typeof documentSchema>;
export type RenewalDoc = InferSchemaType<typeof renewalSchema>;
