/**
 * InsForge integration for Ada iMessage agent.
 *
 * This mirrors the iOS app's services/insforge.ts + insforge-queries.ts
 * but for a server-side (Bun) context instead of React Native.
 *
 * The iMessage agent authenticates as the user and creates items in the
 * same database the iOS app reads from. When the agent saves something
 * from iMessage, it shows up in the iOS app via realtime.
 *
 * Flow: iMessage in -> create Item -> trigger classify edge function
 *       -> item appears in iOS app with category, actions, etc.
 */

import { createClient } from "@insforge/sdk";
import { config } from "./config.ts";

// Simple in-memory token storage for server-side use (no SecureStore needed)
const tokenStore: Record<string, string> = {};
const memoryStorage = {
  getItem(key: string) {
    return tokenStore[key] ?? null;
  },
  async setItem(key: string, value: string) {
    tokenStore[key] = value;
  },
  async removeItem(key: string) {
    delete tokenStore[key];
  },
};

// ─── Client ─────────────────────────────────────────────────────────

let client: ReturnType<typeof createClient> | null = null;
let authenticatedUserId: string | null = null;

function getClient() {
  if (!config.insforge.enabled) return null;

  if (!client) {
    client = createClient({
      baseUrl: config.insforge.url,
      anonKey: config.insforge.anonKey,
      storage: memoryStorage,
      autoRefreshToken: true,
      persistSession: true,
    });
  }
  return client;
}

/**
 * Authenticate the iMessage agent as the Ada user.
 * Must be called once at startup. Caches the session.
 */
export async function authenticate(): Promise<string | null> {
  const c = getClient();
  if (!c) {
    console.warn("[insforge] Not configured, running in standalone mode");
    return null;
  }

  const { email, password } = config.insforgeUser;
  if (!email || !password) {
    console.warn("[insforge] No user credentials, running in standalone mode");
    return null;
  }

  try {
    // Check if we already have a session
    const { data: existing } = await c.auth.getCurrentUser();
    if (existing?.user?.id) {
      authenticatedUserId = existing.user.id;
      console.log(`[insforge] Resumed session for ${existing.user.email}`);
      return authenticatedUserId;
    }

    // Sign in
    const { data, error } = await c.auth.signInWithPassword({ email, password });
    if (error) {
      console.error("[insforge] Auth failed:", error.message);
      return null;
    }

    authenticatedUserId = data?.user?.id ?? null;
    console.log(`[insforge] Authenticated as ${email}`);
    return authenticatedUserId;
  } catch (err) {
    console.error("[insforge] Auth error:", err);
    return null;
  }
}

/**
 * Get the authenticated user's ID. Returns null if not authenticated.
 */
export function getUserId(): string | null {
  return authenticatedUserId;
}

// ─── Items (mirrors insforge-queries.ts) ─────────────────────────────

export type ContentType = "link" | "text" | "image" | "screenshot";

interface SaveItemParams {
  type: ContentType;
  content: string;
  sourceApp?: string;
}

/**
 * Create an Item in InsForge's database.
 * This is the same as the iOS share handler's saveItem().
 * The item will appear in the iOS app immediately via realtime.
 */
export async function saveItem(params: SaveItemParams): Promise<string | null> {
  const c = getClient();
  if (!c || !authenticatedUserId) return null;

  try {
    const { data, error } = await c.database
      .from("items")
      .insert({
        user_id: authenticatedUserId,
        type: params.type,
        raw_content: params.content,
        status: "pending",
        source_app: params.sourceApp ?? "imessage",
      })
      .select();

    if (error || !data || data.length === 0) {
      console.error("[insforge] Failed to save item:", error);
      return null;
    }

    const itemId = (data[0] as { id: string }).id;
    console.log(`[insforge] Item created: ${itemId}`);
    return itemId;
  } catch (err) {
    console.error("[insforge] saveItem error:", err);
    return null;
  }
}

/**
 * Trigger the classify edge function on an item.
 * This runs Ada's full classification pipeline server-side:
 * Jina extraction -> GPT-4o-mini classification -> action creation -> realtime notify
 */
export async function triggerClassify(
  itemId: string,
  itemData?: { type: string; raw_content: string }
): Promise<boolean> {
  const c = getClient();
  if (!c || !authenticatedUserId) return false;

  try {
    const { error } = await c.functions.invoke("classify", {
      body: {
        item_id: itemId,
        ...(itemData ?? {}),
        user_id: authenticatedUserId,
      },
    });

    if (error) {
      console.error("[insforge] Classify trigger failed:", error);
      return false;
    }

    console.log(`[insforge] Classify triggered for ${itemId}`);
    return true;
  } catch (err) {
    console.error("[insforge] triggerClassify error:", err);
    return false;
  }
}

/**
 * Use Ada's chat edge function for conversational responses.
 * This gives the iMessage agent the same 8 chat tools as the iOS app.
 */
export async function chat(message: string): Promise<string | null> {
  const c = getClient();
  if (!c || !authenticatedUserId) return null;

  try {
    const { data, error } = await c.functions.invoke("chat", {
      body: {
        message,
        user_id: authenticatedUserId,
      },
    });

    if (error) {
      console.error("[insforge] Chat function failed:", error);
      return null;
    }

    const result = data as { reply?: string; response?: string } | null;
    return result?.reply ?? result?.response ?? null;
  } catch (err) {
    console.error("[insforge] chat error:", err);
    return null;
  }
}

/**
 * Semantic search via InsForge's search edge function.
 */
export async function searchItems(
  query: string
): Promise<string[]> {
  const c = getClient();
  if (!c || !authenticatedUserId) return [];

  try {
    const { data, error } = await c.functions.invoke("search", {
      body: { query },
    });

    if (error) return [];
    const result = data as { item_ids?: string[] } | null;
    return result?.item_ids ?? [];
  } catch {
    return [];
  }
}

/**
 * Get recent items from the database.
 */
export async function getRecentItems(
  limit = 10
): Promise<Array<Record<string, unknown>>> {
  const c = getClient();
  if (!c || !authenticatedUserId) return [];

  try {
    const { data, error } = await c.database
      .from("items")
      .select("*")
      .eq("user_id", authenticatedUserId)
      .order("created_at", { ascending: false })
      .range(0, limit - 1);

    if (error) return [];
    return (data ?? []) as Array<Record<string, unknown>>;
  } catch {
    return [];
  }
}

/**
 * Check if InsForge is reachable and authenticated.
 */
export function isConnected(): boolean {
  return !!client && !!authenticatedUserId;
}
