/**
 * Text embeddings + cosine similarity.
 *
 * Uses OpenAI embeddings when a key is configured; otherwise falls back to a
 * deterministic hashing (bag-of-words) embedding so semantic-ish search still
 * works fully offline. The model tag is stored alongside each vector so the
 * query is embedded with the same method at search time.
 */
import { getOpenAI, EMBED_MODEL } from "../lib/openai";

const HASH_DIMS = 256;
const HASH_MODEL = "hashing-bow-256";

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => t.length > 1);
}

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Deterministic offline embedding: hashed term frequencies, L2-normalized. */
export function hashingEmbed(text: string): number[] {
  const v = new Array(HASH_DIMS).fill(0);
  for (const tok of tokenize(text)) v[djb2(tok) % HASH_DIMS] += 1;
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

export interface Embedding {
  vector: number[];
  model: string;
  dims: number;
}

export async function embedText(text: string): Promise<Embedding> {
  const client = getOpenAI();
  if (client) {
    const r = await client.embeddings.create({ model: EMBED_MODEL, input: text });
    const vector = r.data[0].embedding as number[];
    return { vector, model: EMBED_MODEL, dims: vector.length };
  }
  const vector = hashingEmbed(text);
  return { vector, model: HASH_MODEL, dims: vector.length };
}

export async function embedBatch(texts: string[]): Promise<Embedding[]> {
  const client = getOpenAI();
  if (!client) {
    return texts.map((t) => {
      const vector = hashingEmbed(t);
      return { vector, model: HASH_MODEL, dims: vector.length };
    });
  }
  try {
    const r = await client.embeddings.create({ model: EMBED_MODEL, input: texts });
    return r.data.map((d) => {
      const vector = d.embedding as number[];
      return { vector, model: EMBED_MODEL, dims: vector.length };
    });
  } catch {
    // Some OpenAI-compatible endpoints (notably Gemini's) reject an array of
    // inputs — retry one request per text with the SAME model so the stored
    // vector dimensions stay consistent. A genuine auth/model error still
    // surfaces here (via embedText), so a bad key fails loudly at embed time.
    const out: Embedding[] = [];
    for (const t of texts) out.push(await embedText(t));
    return out;
  }
}

/** Cosine similarity. Vectors from embedText are unit-length, but normalize defensively. */
export function cosine(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}
