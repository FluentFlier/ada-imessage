/**
 * InsForge backend integration.
 * Routes heavy compute tasks (document processing, embedding generation,
 * batch classification) to the user's InsForge endpoint.
 * Falls back gracefully to direct API calls if InsForge is unreachable.
 */

import { config } from "./config.ts";

interface InsForgeResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

async function insforgeRequest<T>(
  path: string,
  body: Record<string, unknown>
): Promise<InsForgeResponse<T>> {
  if (!config.insforge.enabled) {
    return { success: false, error: "InsForge not configured" };
  }

  try {
    const res = await fetch(`${config.insforge.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.insforge.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.insforge.timeout),
    });

    if (!res.ok) {
      return { success: false, error: `InsForge returned ${res.status}` };
    }

    const data = (await res.json()) as T;
    return { success: true, data };
  } catch (err) {
    console.error("[insforge] Request failed:", err);
    return { success: false, error: String(err) };
  }
}

/**
 * Process a document (large text, HTML, PDF content, etc.) via InsForge.
 * Falls back to truncated raw content if InsForge is unreachable.
 */
export async function processDocument(
  content: string,
  type: "text" | "html" | "pdf" | "markdown" = "text"
): Promise<{ summary: string; content: string }> {
  const result = await insforgeRequest<{ summary: string; content: string }>(
    "/process-document",
    { content, type }
  );

  if (result.success && result.data) {
    return result.data;
  }

  // Fallback: truncate and return as-is
  console.log("[insforge] Falling back to local processing for document");
  return {
    summary: content.slice(0, 200),
    content: content.slice(0, 2000),
  };
}

/**
 * Generate embeddings via InsForge.
 * Returns null on failure so the caller can use Supermemory's built-in embeddings.
 */
export async function generateEmbedding(
  text: string
): Promise<number[] | null> {
  const result = await insforgeRequest<{ embedding: number[] }>(
    "/embed",
    { text }
  );

  if (result.success && result.data) {
    return result.data.embedding;
  }

  console.log("[insforge] Embedding fallback: using Supermemory built-in");
  return null;
}

/**
 * Batch classify multiple messages via InsForge.
 * Returns null on failure so the caller can classify individually.
 */
export async function batchClassify(
  messages: string[]
): Promise<Array<{ intent: string; summary: string }> | null> {
  const result = await insforgeRequest<{
    classifications: Array<{ intent: string; summary: string }>;
  }>("/batch-classify", { messages });

  if (result.success && result.data) {
    return result.data.classifications;
  }

  console.log("[insforge] Batch classify fallback: classify individually");
  return null;
}

/**
 * Check if the InsForge backend is reachable.
 */
export async function isInsForgeHealthy(): Promise<boolean> {
  if (!config.insforge.enabled) return false;

  try {
    const res = await fetch(`${config.insforge.baseUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
