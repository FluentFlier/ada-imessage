/**
 * Supermemory integration for Ada iMessage agent.
 *
 * Mirrors the iOS app's functions/_shared/supermemory.ts:
 * - Uses containerTag = userId for per-user memory isolation
 * - Same API endpoints (v3 for documents/profile, v4 for search)
 * - Same memory content format (buildMemoryContent)
 *
 * Falls back to non-user-scoped memory if InsForge auth is unavailable.
 */

import { config } from "./config.ts";
import { getUserId } from "./insforge.ts";

const SUPERMEMORY_API = "https://api.supermemory.ai";

const headers = () => ({
  Authorization: `Bearer ${config.supermemoryApiKey}`,
  "Content-Type": "application/json",
});

export interface MemoryEntry {
  content: string;
  metadata?: Record<string, string>;
}

export interface SearchResult {
  content: string;
  score: number;
  metadata?: Record<string, string>;
}

/**
 * Build memory content string matching the iOS app's format.
 * See functions/_shared/supermemory.ts buildMemoryContent()
 */
export function buildMemoryContent(item: {
  type: string;
  raw_content: string;
  title?: string;
  description?: string;
  category?: string;
}): string {
  const parts = [
    item.title && `Title: ${item.title}`,
    item.description && `Description: ${item.description}`,
    item.category && `Category: ${item.category}`,
    `Type: ${item.type}`,
    `Content: ${item.raw_content}`,
  ].filter(Boolean);
  return parts.join("\n");
}

/**
 * Save content to Supermemory, scoped to the authenticated user.
 * Uses v3/documents endpoint with containerTag = userId (same as iOS app).
 */
export async function saveToMemory(
  entry: MemoryEntry,
  options?: { source?: string; groupName?: string }
): Promise<boolean> {
  if (!config.supermemoryApiKey) return false;

  const userId = getUserId();

  try {
    const res = await fetch(`${SUPERMEMORY_API}/v3/documents`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        content: entry.content,
        // containerTag scopes memory to this user (matches iOS app pattern)
        ...(userId ? { containerTag: userId } : {}),
        metadata: {
          source: options?.source ?? "imessage",
          savedAt: new Date().toISOString(),
          ...(options?.groupName ? { groupName: options.groupName } : {}),
          ...entry.metadata,
        },
      }),
    });
    return res.ok;
  } catch (err) {
    console.error("[memory] save failed:", err);
    return false;
  }
}

/**
 * Search Supermemory for relevant context, scoped to the authenticated user.
 * Uses v4/search endpoint with containerTag = userId and hybrid search (same as iOS app).
 */
export async function searchMemory(query: string): Promise<SearchResult[]> {
  if (!config.supermemoryApiKey) return [];

  const userId = getUserId();

  try {
    const res = await fetch(`${SUPERMEMORY_API}/v4/search`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        q: query,
        // containerTag scopes search to this user (matches iOS app pattern)
        ...(userId ? { containerTag: userId } : {}),
        limit: 5,
        searchMode: "hybrid",
        threshold: 0.5,
      }),
    });

    if (!res.ok) return [];

    const data = (await res.json()) as {
      results?: Array<{
        memory?: string;
        chunk?: string;
        content?: string;
        similarity?: number;
        score?: number;
      }>;
    };

    return (data.results ?? []).map((r) => ({
      content: r.memory ?? r.chunk ?? r.content ?? "",
      score: r.similarity ?? r.score ?? 0,
    }));
  } catch (err) {
    console.error("[memory] search failed:", err);
    return [];
  }
}

/**
 * Fetch URL content via Jina Reader and save to memory.
 */
export async function saveUrl(
  url: string,
  context?: string,
  options?: { source?: string; groupName?: string }
): Promise<string> {
  let content = url;

  if (config.jinaApiKey) {
    try {
      const jinaRes = await fetch(`https://r.jina.ai/${url}`, {
        headers: { Authorization: `Bearer ${config.jinaApiKey}` },
      });
      if (jinaRes.ok) {
        const text = await jinaRes.text();
        content = text.slice(0, 2000);
      }
    } catch {
      // Fall back to raw URL
    }
  }

  const saved = await saveToMemory(
    {
      content: context
        ? `${context}\n\nURL: ${url}\n\n${content}`
        : `URL: ${url}\n\n${content}`,
      metadata: { url, type: "link" },
    },
    options
  );

  return saved ? content : "";
}

/**
 * Get the user's profile from Supermemory (auto-built by Supermemory).
 * Used for personalization context in responses.
 */
export async function getUserProfile(): Promise<string | null> {
  if (!config.supermemoryApiKey) return null;

  const userId = getUserId();
  if (!userId) return null;

  try {
    const res = await fetch(
      `${SUPERMEMORY_API}/v3/user-profile?containerTag=${userId}`,
      { headers: headers(), signal: AbortSignal.timeout(2000) }
    );

    if (!res.ok) return null;
    const data = (await res.json()) as { profile?: string; context?: string };
    return data?.profile ?? data?.context ?? null;
  } catch {
    return null;
  }
}
