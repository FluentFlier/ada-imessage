/**
 * Centralized configuration for Ada iMessage agent.
 * All env vars and defaults in one place.
 *
 * InsForge config mirrors the iOS app's constants/config.ts so the
 * iMessage channel plugs into the exact same backend.
 */

export const config = {
  // Identity
  adaName: process.env.ADA_NAME ?? "Ada",

  // Phone gating
  ownerPhone: process.env.OWNER_PHONE ?? "",

  // Group chat
  watchGroups: process.env.WATCH_GROUPS === "true",
  watchedGroupIds: (process.env.WATCHED_GROUP_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),

  // InsForge backend (same as EXPO_PUBLIC_INSFORGE_URL / EXPO_PUBLIC_INSFORGE_ANON_KEY in iOS app)
  insforge: {
    url: process.env.INSFORGE_URL ?? "",
    anonKey: process.env.INSFORGE_ANON_KEY ?? "",
    get enabled() {
      return !!this.url && !!this.anonKey;
    },
  },

  // InsForge user credentials (optional fallback if OAuth fails)
  // Primary auth is Google OAuth via browser. These are only used
  // if OAuth is unavailable (e.g. headless server).
  insforgeUser: {
    email: process.env.INSFORGE_USER_EMAIL ?? "",
    password: process.env.INSFORGE_USER_PASSWORD ?? "",
  },

  // Sync server
  syncServerPort: parseInt(process.env.SYNC_SERVER_PORT ?? "3001", 10),

  // API keys (used for local fallback when InsForge is unreachable)
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  supermemoryApiKey: process.env.SUPERMEMORY_API_KEY ?? "",
  composioApiKey: process.env.COMPOSIO_API_KEY ?? "",
  jinaApiKey: process.env.JINA_API_KEY ?? "",

  // Debug
  debug: process.env.NODE_ENV === "development",
};

/**
 * Check if a phone number matches the owner (handles +1 prefix variants).
 */
export function isOwner(sender: string): boolean {
  const owner = config.ownerPhone;
  if (!owner) return false;
  return sender === owner || sender.includes(owner.replace("+1", ""));
}

/**
 * Check if a group chat ID is in the watch list.
 */
export function isWatchedGroup(chatId: string): boolean {
  if (!config.watchGroups) return false;
  return config.watchedGroupIds.includes(chatId);
}
