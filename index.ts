/**
 * Ada iMessage Agent
 * Entry point - starts watching for messages and routes them through Ada's agent.
 * Supports direct messages (owner only) and group chats (watched groups).
 *
 * Run: bun run start
 */

import { IMessageSDK } from "@photon-ai/imessage-kit";
import { config, isOwner, isWatchedGroup } from "./config.ts";
import { handleMessage, handleGroupMessage } from "./agent.ts";
import { startSyncServer } from "./sync-server.ts";

if (!config.ownerPhone) {
  console.error("OWNER_PHONE is required. Set it in your .env file.");
  process.exit(1);
}

const sdk = new IMessageSDK({
  debug: config.debug,
  watcher: {
    pollInterval: 2000,
    unreadOnly: false,
    excludeOwnMessages: true,
  },
});

console.log(`\n${config.adaName} is live on iMessage.`);
console.log(`Listening for messages from ${config.ownerPhone}`);
if (config.watchGroups) {
  console.log(
    `Watching ${config.watchedGroupIds.length} group chat(s): ${config.watchedGroupIds.join(", ")}`
  );
}
console.log();

// Start sync server for iOS app communication
startSyncServer();

// Startup ping to owner
await sdk.send(
  config.ownerPhone,
  `${config.adaName} is online. Text me anything to save, recall, or do.`
);

await sdk.startWatching({
  onDirectMessage: async (msg) => {
    // Never respond to Ada's own messages
    if (msg.isFromMe) return;

    // Only respond to the owner's messages
    if (!isOwner(msg.sender)) {
      console.log(`[ada] Ignoring DM from ${msg.sender}`);
      return;
    }

    // Skip empty or reaction messages
    if (!msg.text || msg.isReaction) return;

    try {
      const response = await handleMessage(msg);
      if (response.handled) {
        await sdk.send(config.ownerPhone, response.text);
      }
    } catch (err) {
      console.error("[ada] Error handling message:", err);
      await sdk.send(
        config.ownerPhone,
        "Something went wrong on my end. Try again in a moment."
      );
    }
  },

  onGroupMessage: async (msg) => {
    // Never respond to Ada's own messages
    if (msg.isFromMe) return;

    // Only process watched group chats
    if (!msg.chatId || !isWatchedGroup(msg.chatId)) return;

    // Skip empty or reaction messages
    if (!msg.text || msg.isReaction) return;

    // Only respond if Ada is @mentioned by name
    const mentionPattern = new RegExp(`@?${config.adaName}\\b`, "i");
    if (!mentionPattern.test(msg.text)) return;

    try {
      const response = await handleGroupMessage(msg, {
        chatId: msg.chatId,
        chatName: msg.chatName,
      });
      if (response.handled) {
        await sdk.sendToGroup(msg.chatId, response.text);
      }
    } catch (err) {
      console.error("[ada] Error handling group message:", err);
      await sdk.sendToGroup(
        msg.chatId,
        "Something went wrong. Try again in a moment."
      );
    }
  },

  onError: (err) => {
    console.error("[ada] Watcher error:", err);
  },
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\nShutting down Ada...");
  sdk.stopWatching();
  await sdk.close();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  sdk.stopWatching();
  await sdk.close();
  process.exit(0);
});
