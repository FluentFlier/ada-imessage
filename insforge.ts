/**
 * InsForge integration for Ada iMessage agent.
 *
 * This mirrors the iOS app's services/insforge.ts + insforge-queries.ts
 * but for a server-side (Bun/macOS) context instead of React Native.
 *
 * Auth strategy (in priority order):
 * 1. Cached session from previous run (persisted to ~/.ada-imessage-session)
 * 2. Google OAuth via PKCE (opens browser, catches callback on localhost)
 * 3. Email/password fallback (if INSFORGE_USER_EMAIL + PASSWORD are set)
 *
 * The iMessage agent authenticates as the user and creates items in the
 * same database the iOS app reads from. When the agent saves something
 * from iMessage, it shows up in the iOS app via realtime.
 */

import { createClient } from "@insforge/sdk";
import { config } from "./config.ts";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ─── Persistent Token Storage ───────────────────────────────────────
// Persists session to ~/.ada-imessage/session.json so the user doesn't
// have to re-authenticate on every restart.

const SESSION_DIR = join(homedir(), ".ada-imessage");
const SESSION_FILE = join(SESSION_DIR, "session.json");

function loadPersistedTokens(): Record<string, string> {
  try {
    if (existsSync(SESSION_FILE)) {
      return JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function persistTokens(tokens: Record<string, string>) {
  try {
    if (!existsSync(SESSION_DIR)) {
      mkdirSync(SESSION_DIR, { recursive: true });
    }
    writeFileSync(SESSION_FILE, JSON.stringify(tokens, null, 2));
  } catch (err) {
    console.warn("[insforge] Failed to persist session:", err);
  }
}

const tokenStore = loadPersistedTokens();

const diskStorage = {
  getItem(key: string) {
    return tokenStore[key] ?? null;
  },
  async setItem(key: string, value: string) {
    tokenStore[key] = value;
    persistTokens(tokenStore);
  },
  async removeItem(key: string) {
    delete tokenStore[key];
    persistTokens(tokenStore);
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
      storage: diskStorage,
      autoRefreshToken: true,
      persistSession: true,
    });
  }
  return client;
}

// ─── OAuth PKCE (Google) ────────────────────────────────────────────
// Same flow as the iOS app's oauthSignIn() in services/insforge.ts,
// adapted for macOS: opens the system browser, catches the callback
// on a temporary localhost HTTP server.

async function oauthSignIn(): Promise<string | null> {
  const c = getClient();
  if (!c) return null;

  const CALLBACK_PORT = 9876;
  const redirectUrl = `http://localhost:${CALLBACK_PORT}/auth/callback`;

  // Step 1: Get OAuth URL + PKCE code verifier from InsForge
  const { data, error } = await c.auth.signInWithOAuth({
    provider: "google",
    redirectTo: redirectUrl,
    skipBrowserRedirect: true,
  });

  if (error || !data?.url) {
    console.error("[insforge] OAuth init failed:", error?.message ?? "no URL");
    return null;
  }

  const codeVerifier = data.codeVerifier;

  // Step 2: Start a temporary localhost server to catch the callback
  const authCode = await new Promise<string | null>((resolve) => {
    const timeout = setTimeout(() => {
      server.stop();
      console.log("[insforge] OAuth timed out (60s). Try again.");
      resolve(null);
    }, 60_000);

    const server = Bun.serve({
      port: CALLBACK_PORT,
      fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === "/auth/callback") {
          const code = url.searchParams.get("code");
          clearTimeout(timeout);

          // Respond with a simple success page, then shut down
          setTimeout(() => server.stop(), 500);
          resolve(code);

          return new Response(
            `<html><body style="font-family:system-ui;text-align:center;padding:60px">
              <h2>Ada is connected.</h2>
              <p>You can close this tab and go back to your terminal.</p>
            </body></html>`,
            { headers: { "Content-Type": "text/html" } }
          );
        }

        return new Response("Not found", { status: 404 });
      },
    });

    // Step 3: Open the OAuth URL in the user's default browser
    console.log("[insforge] Opening browser for Google sign-in...");
    Bun.spawn(["open", data.url]);
  });

  if (!authCode) return null;

  // Step 4: Exchange the authorization code for a session
  const { data: exchangeData, error: exchangeError } =
    await c.auth.exchangeOAuthCode(authCode, codeVerifier);

  if (exchangeError || !exchangeData?.user) {
    console.error(
      "[insforge] OAuth code exchange failed:",
      exchangeError?.message ?? "no user"
    );
    return null;
  }

  authenticatedUserId = exchangeData.user.id;
  console.log(
    `[insforge] Signed in as ${exchangeData.user.email} via Google`
  );
  return authenticatedUserId;
}

// ─── Authentication ─────────────────────────────────────────────────

/**
 * Authenticate the iMessage agent.
 *
 * Strategy:
 * 1. Try to resume a cached session (persisted to disk)
 * 2. If no session, try Google OAuth (opens browser)
 * 3. If OAuth fails/unavailable, fall back to email/password
 */
export async function authenticate(): Promise<string | null> {
  const c = getClient();
  if (!c) {
    console.warn("[insforge] Not configured, running in standalone mode");
    return null;
  }

  try {
    // 1. Try to resume an existing session
    const { data: existing } = await c.auth.getCurrentUser();
    if (existing?.user?.id) {
      authenticatedUserId = existing.user.id;
      console.log(
        `[insforge] Resumed session for ${existing.user.email}`
      );
      return authenticatedUserId;
    }

    // 2. Try Google OAuth (opens browser on macOS)
    console.log("[insforge] No cached session. Starting OAuth...");
    const oauthResult = await oauthSignIn();
    if (oauthResult) return oauthResult;

    // 3. Fall back to email/password if provided
    const { email, password } = config.insforgeUser;
    if (email && password) {
      console.log("[insforge] OAuth failed. Trying email/password...");
      const { data, error } = await c.auth.signInWithPassword({
        email,
        password,
      });
      if (error) {
        console.error("[insforge] Email/password auth failed:", error.message);
        return null;
      }
      authenticatedUserId = data?.user?.id ?? null;
      console.log(`[insforge] Authenticated as ${email}`);
      return authenticatedUserId;
    }

    console.warn("[insforge] All auth methods failed. Running standalone.");
    return null;
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
export async function saveItem(
  params: SaveItemParams
): Promise<string | null> {
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
export async function searchItems(query: string): Promise<string[]> {
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
