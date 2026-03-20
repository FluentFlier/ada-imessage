import { config } from "./config.ts";
import { processDocument } from "./insforge.ts";

const SUPERMEMORY_BASE = "https://api.supermemory.ai/v3";
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
 * Save a piece of content to Ada's memory.
 * Supports source tagging (imessage, imessage-forward, imessage-group)
 * and optional group chat name.
 */
export async function saveToMemory(
  entry: MemoryEntry,
  options?: { source?: string; groupName?: string }
): Promise<boolean> {
  try {
    const res = await fetch(`${SUPERMEMORY_BASE}/memories`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        content: entry.content,
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
 * Search Ada's memory for relevant context
 */
export async function searchMemory(query: string): Promise<SearchResult[]> {
  try {
    const res = await fetch(`${SUPERMEMORY_BASE}/search`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ q: query, limit: 5 }),
    });

    if (!res.ok) return [];
    const data = (await res.json()) as { results?: SearchResult[] };
    return data.results ?? [];
  } catch (err) {
    console.error("[memory] search failed:", err);
    return [];
  }
}

/**
 * Fetch URL content via Jina Reader and save to memory.
 * Routes large documents through InsForge for processing when available.
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

        // If content is large, route through InsForge for summarization
        if (text.length > 3000) {
          const processed = await processDocument(text, "html");
          content = processed.content;
        } else {
          content = text.slice(0, 2000);
        }
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
