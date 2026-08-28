#!/usr/bin/env bash
#
# Run the engine unit tests with ZERO installed dependencies.
#
# Why this exists: the whole engine is pure arithmetic, so it should be provable on
# a clean machine — no npm install, no database, no API key. This script copies the
# server sources to a temp directory, points relative imports at real .ts files
# (Node's ESM resolver wants extensions), stubs the two packages the pure paths
# import at runtime (mongoose, openai — neither is called by any test), and runs the
# suites under Node's built-in type stripping.
#
# Requires Node >= 22.6. For the normal path (with dependencies installed) use:
#   cd server && npm test
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cp -r "$ROOT/server/src" "$WORK/src"
cp "$ROOT/server/package.json" "$ROOT/server/tsconfig.json" "$WORK/"
# contract.test.ts reads the client's own type file to prove the two halves agree.
mkdir -p "$WORK/client/src"
cp "$ROOT/client/src/types.ts" "$WORK/client/src/types.ts"
mkdir -p "$WORK/node_modules/mongoose" "$WORK/node_modules/openai"

cat > "$WORK/node_modules/mongoose/package.json" <<'JSON'
{ "name": "mongoose", "version": "0.0.0-stub", "main": "index.js" }
JSON
cat > "$WORK/node_modules/mongoose/index.js" <<'JS'
class Schema {
  constructor(def, opts) { this.def = def; this.opts = opts; }
  index() { return this; }
}
Schema.Types = { Mixed: "Mixed", ObjectId: "ObjectId" };
const empty = { lean: async () => null, sort: () => empty, limit: () => empty };
function model() {
  return {
    find: () => ({ lean: async () => [], sort: () => ({ lean: async () => [] }) }),
    findOne: () => empty,
    findOneAndUpdate: async () => null,
    aggregate: async () => [],
    distinct: async () => [],
    countDocuments: async () => 0,
    insertMany: async () => [],
    deleteMany: async () => ({ deletedCount: 0 }),
    bulkWrite: async () => ({}),
  };
}
module.exports = { Schema, model, connect: async () => {}, connection: { readyState: 0 } };
module.exports.InferSchemaType = undefined;
module.exports.Types = Schema.Types;
module.exports.Document = class {};
module.exports.default = module.exports;
JS
cat > "$WORK/node_modules/openai/package.json" <<'JSON'
{ "name": "openai", "version": "0.0.0-stub", "main": "index.js" }
JSON
cat > "$WORK/node_modules/openai/index.js" <<'JS'
class OpenAI {
  constructor(opts) {
    this.opts = opts;
    this.chat = { completions: { create: async () => ({ choices: [] }) } };
    this.embeddings = { create: async () => ({ data: [] }) };
  }
}
module.exports = OpenAI;
module.exports.default = OpenAI;
JS

cat > "$WORK/fiximports.mjs" <<'MJS'
import fs from "node:fs";
import path from "node:path";
const root = path.join(process.argv[2], "src");
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (p.endsWith(".ts")) files.push(p);
  }
})(root);
for (const f of files) {
  const dir = path.dirname(f);
  const src = fs.readFileSync(f, "utf8");
  const out = src.replace(/(from\s+")(\.[^"]*)(")/g, (m, a, spec, c) => {
    if (/\.(ts|js|json)$/.test(spec)) return m;
    const abs = path.resolve(dir, spec);
    if (fs.existsSync(abs + ".ts")) return `${a}${spec}.ts${c}`;
    if (fs.existsSync(path.join(abs, "index.ts"))) return `${a}${spec}/index.ts${c}`;
    return m;
  });
  if (out !== src) fs.writeFileSync(f, out);
}
MJS

node "$WORK/fiximports.mjs" "$WORK"
cd "$WORK"
node --experimental-strip-types --test \
  src/engine/engine.test.ts \
  src/engine/insight.test.ts \
  src/engine/outlook.test.ts \
  src/engine/contract.test.ts \
  src/ingest/ingest.test.ts
