/**
 * LLM client factory — optional and provider-flexible.
 *
 * The whole app runs WITHOUT any key: embeddings (Phase 5) fall back to a
 * deterministic hashing method and narration (Phase 6) to a template. A key
 * upgrades both. Two providers are supported through the OpenAI SDK:
 *
 *   • Google Gemini — set GEMINI_API_KEY. Calls Gemini's OpenAI-compatible
 *                     endpoint with Gemini model names.
 *   • OpenAI        — set OPENAI_API_KEY. Default endpoint, OpenAI models.
 *
 * If both are set, Gemini wins. Only .env changes to switch vendors — every
 * downstream caller (embeddings.ts, story.ts) keeps using getOpenAI()/CHAT_MODEL/
 * EMBED_MODEL unchanged.
 */
import OpenAI from "openai";

// Gemini exposes an OpenAI-compatible surface at this base URL.
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

interface Provider {
  apiKey: string;
  baseURL?: string;
  chatModel: string;
  embedModel: string;
}

/** A key counts as "real" only if present, not the template placeholder, and long enough. */
function realKey(value: string | undefined, placeholder: string): string | null {
  const k = (value ?? "").trim();
  if (!k || k === placeholder || k.length < 20) return null;
  return k;
}

/** Pick the provider from env once. Gemini takes precedence over OpenAI. */
function selectProvider(): Provider | null {
  const gemini = realKey(process.env.GEMINI_API_KEY, "your-gemini-api-key-here");
  if (gemini) {
    return {
      apiKey: gemini,
      baseURL: GEMINI_BASE_URL,
      chatModel: process.env.GEMINI_CHAT_MODEL || "gemini-flash-latest",
      embedModel: process.env.GEMINI_EMBED_MODEL || "text-embedding-004",
    };
  }
  const openai = realKey(process.env.OPENAI_API_KEY, "your-openai-api-key-here");
  if (openai) {
    return {
      apiKey: openai,
      chatModel: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
      embedModel: process.env.OPENAI_EMBED_MODEL || "text-embedding-3-small",
    };
  }
  return null;
}

const PROVIDER = selectProvider();

let cached: OpenAI | null | undefined;

export function getOpenAI(): OpenAI | null {
  if (cached !== undefined) return cached;
  cached = PROVIDER ? new OpenAI({ apiKey: PROVIDER.apiKey, baseURL: PROVIDER.baseURL }) : null;
  return cached;
}

export const CHAT_MODEL = PROVIDER?.chatModel || "gpt-4o-mini";
export const EMBED_MODEL = PROVIDER?.embedModel || "text-embedding-3-small";

export function aiEnabled(): boolean {
  return getOpenAI() !== null;
}
