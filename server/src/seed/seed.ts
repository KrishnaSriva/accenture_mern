/**
 * Seed loader — wipes and re-inserts the generated JSON into MongoDB.
 *
 *   npm run seed
 *
 * Reads kpi-storytelling/data/generated/*.json (produced by scripts/generate_data.py).
 * Idempotent: each collection is emptied then re-inserted, so you can re-run freely.
 * document_embeddings and analysis_results are left empty (filled in later phases).
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { connectDB, disconnectDB } from "../config/db";
import {
  Region,
  Kpi,
  Product,
  User,
  Account,
  Renewal,
  Sale,
  KpiValue,
  Inventory,
  Document,
  DocumentEmbedding,
  AnalysisResult,
  Company,
} from "../models";

const DATA_DIR = path.resolve(__dirname, "../../../data/generated");
const DEMO = "DEMO";

function readJSON(name: string): any[] {
  const file = path.join(DATA_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `Missing ${file}. Run:  python scripts/generate_data.py  first.`
    );
  }
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

// (jsonName -> Mongoose model)
const LOAD: Array<[string, any]> = [
  ["regions", Region],
  ["kpis", Kpi],
  ["products", Product],
  ["users", User],
  ["accounts", Account],
  ["renewals", Renewal],
  ["sales", Sale],
  ["kpi_values", KpiValue],
  ["inventory", Inventory],
  ["documents", Document],
];

async function main() {
  await connectDB();

  const counts: Record<string, number> = {};
  for (const [name, Model] of LOAD) {
    const rows = readJSON(name).map((r) => ({ company: DEMO, ...r }));
    await Model.deleteMany({ company: DEMO });
    if (rows.length) await Model.insertMany(rows, { ordered: false });
    counts[name] = rows.length;
    console.log(`  seeded ${name.padEnd(12)} ${rows.length}`);
  }

  // register DEMO as a first-class company so the connect UI can list it
  await Company.deleteMany({ ticker: DEMO });
  await Company.create({
    ticker: DEMO,
    name: "Amazon-modeled demo (synthetic)",
    sources: ["synthetic"],
    counts: {
      kpiValues: counts["kpi_values"] ?? 0,
      regions: counts["regions"] ?? 0,
      documents: counts["documents"] ?? 0,
    },
  });

  // runtime collections start empty (only DEMO's are cleared here)
  await DocumentEmbedding.deleteMany({});
  await AnalysisResult.deleteMany({ company: DEMO });
  console.log("  cleared document_embeddings + analysis_results (runtime)");

  await disconnectDB();
  console.log("Seed complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
