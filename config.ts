/**
 * Centralized configuration for Ada iMessage agent.
 * All env vars and defaults in one place.
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

  // InsForge backend
  insforge: {
    baseUrl: process.env.INSFORGE_BASE_URL ?? "",
    apiKey: process.env.INSFORGE_API_KEY ?? "",
    get enabled() {
      return !!this.baseUrl && !!this.apiKey;
    },
    timeout: 30_000,
  },

  // Sync server
  syncServerPort: parseInt(process.env.SYNC_SERVER_PORT ?? "3001", 10),

  // API keys
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
