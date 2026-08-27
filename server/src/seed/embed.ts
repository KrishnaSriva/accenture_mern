/**
 * Populate the document_embeddings collection.
 *
 *   npm run embed
 *
 * Uses the configured LLM provider's embeddings (Gemini or OpenAI) when a key is
 * set, otherwise the deterministic offline hashing embedding. Safe to re-run
 * (upserts by document_id). Retrieval works even if you skip this — it falls back
 * to lexical scoring — but running it enables semantic search.
 */
import "dotenv/config";
import { connectDB, disconnectDB } from "../config/db";
import { Document as Doc, DocumentEmbedding } from "../models";
import { embedBatch } from "../engine/embeddings";
import { aiEnabled, EMBED_MODEL } from "../lib/openai";

const BATCH = aiEnabled() ? 128 : 1000;

async function main() {
  await connectDB();
  const docs = (await Doc.find({}, { _id: 0, document_id: 1, text: 1 }).lean()) as unknown as Array<{
    document_id: string;
    text: string;
  }>;

  console.log(`[embed] ${docs.length} docs · method: ${aiEnabled() ? EMBED_MODEL : "hashing (offline)"}`);
  await DocumentEmbedding.deleteMany({});

  let done = 0;
  for (let i = 0; i < docs.length; i += BATCH) {
    const chunk = docs.slice(i, i + BATCH);
    const embs = await embedBatch(chunk.map((d) => d.text));
    await DocumentEmbedding.insertMany(
      chunk.map((d, j) => ({
        document_id: d.document_id,
        model: embs[j].model,
        dims: embs[j].dims,
        vector: embs[j].vector,
      })),
      { ordered: false }
    );
    done += chunk.length;
    process.stdout.write(`\r  embedded ${done}/${docs.length}`);
  }
  process.stdout.write("\n");

  await disconnectDB();
  console.log("Embeddings complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
