/**
 * Ada's core agent loop.
 * Orchestrates: classify -> memory -> act -> respond
 *
 * Dual pipeline:
 * 1. LOCAL (fast path): GPT-4o-mini classifier + Claude Sonnet response
 *    -> instant iMessage reply
 * 2. INSFORGE (sync path): Create Item in database + trigger classify edge function
 *    -> item appears in iOS app with full classification, actions, etc.
 *
 * Both run in parallel so the user gets an instant reply AND the iOS app stays in sync.
 */

import { config } from "./config.ts";
import { classify } from "./classifier.ts";
import { saveToMemory, saveUrl, searchMemory, buildMemoryContent } from "./memory.ts";
import { executeAction, inferActionType } from "./actions.ts";
import { generateResponse } from "./llm.ts";
import {
  saveItem,
  triggerClassify,
  chat as insforgeChat,
  isConnected,
  type ContentType,
} from "./insforge.ts";
import type { Message } from "@photon-ai/imessage-kit";

export interface AgentResponse {
  text: string;
  handled: boolean;
}

export interface GroupContext {
  chatId: string;
  chatName?: string;
}

/**
 * Detect if a message looks like forwarded content.
 */
function isForwardedContent(text: string, hasAttachments?: boolean): boolean {
  const lower = text.toLowerCase();
  if (lower.startsWith("fwd:") || lower.startsWith("fw:")) return true;
  const urlMatch = text.match(/https?:\/\/[^\s]+/);
  if (urlMatch) {
    const textWithoutUrl = text.replace(urlMatch[0], "").trim();
    if (textWithoutUrl.length > 20) return true;
  }
  if (hasAttachments) return true;
  return false;
}

/**
 * Strip the @Ada mention from a group chat message.
 */
function stripMention(text: string): string {
  const pattern = new RegExp(`@?${config.adaName}\\s*`, "i");
  return text.replace(pattern, "").trim();
}

/**
 * Detect content type for InsForge item creation.
 */
function detectContentType(text: string): ContentType {
  if (/https?:\/\/[^\s]+/.test(text)) return "link";
  return "text";
}

/**
 * Sync a message to InsForge (fire-and-forget).
 * Creates an Item in the database and triggers classification.
 * The item then appears in the iOS app via realtime.
 */
async function syncToInsForge(
  text: string,
  sourceApp = "imessage"
): Promise<void> {
  if (!isConnected()) return;

  try {
    const type = detectContentType(text);
    const content = type === "link"
      ? text.match(/https?:\/\/[^\s]+/)?.[0] ?? text
      : text;

    const itemId = await saveItem({ type, content, sourceApp });
    if (itemId) {
      // Trigger classify in the background - don't await
      triggerClassify(itemId, { type, raw_content: content }).catch(() => {});
    }
  } catch (err) {
    console.error("[sync] InsForge sync failed (non-fatal):", err);
  }
}

/**
 * Handle a direct message to Ada (1:1 conversation with the owner).
 */
export async function handleMessage(msg: Message): Promise<AgentResponse> {
  const text = msg.text ?? "";

  if (!text.trim()) {
    return {
      text: "Got an empty message. Send me something to save, recall, or do.",
      handled: true,
    };
  }

  console.log(`[ada] Incoming: "${text.slice(0, 80)}..."`);

  // Check for forwarded content and auto-save
  const hasAttachments = !!(msg as Record<string, unknown>).attachments;
  if (isForwardedContent(text, hasAttachments)) {
    console.log("[ada] Detected forwarded content, auto-saving");
    return handleForwardedContent(text);
  }

  // Run local classification + InsForge sync in parallel
  const [classified] = await Promise.all([
    classify(text),
    syncToInsForge(text),
  ]);

  console.log(
    `[ada] Intent: ${classified.intent} (${classified.confidence.toFixed(2)})`
  );

  let actionResult: { success: boolean; message: string } | undefined;

  // Route based on intent
  switch (classified.intent) {
    case "save": {
      if (classified.url) {
        const content = await saveUrl(
          classified.url,
          text.replace(classified.url, "").trim() || undefined
        );
        await saveToMemory({
          content: content || text,
          metadata: { url: classified.url, intent: "save", type: "link" },
        });
      } else {
        await saveToMemory({
          content: text,
          metadata: {
            intent: "save",
            type: "note",
            topics: classified.entities.topics?.join(", ") ?? "",
          },
        });
      }
      break;
    }

    case "act": {
      const actionType = inferActionType(classified.entities, text);
      actionResult = await executeAction({
        type: actionType,
        title: classified.summary,
        description: text,
        date: classified.entities.dates?.[0],
        recipient: classified.entities.people?.[0],
      });
      await saveToMemory({
        content: `Action taken: ${actionResult.message}\nOriginal request: ${text}`,
        metadata: { intent: "act", type: actionType },
      });
      break;
    }

    case "status": {
      const results = await searchMemory("recent saved content notes links");
      if (results.length === 0) {
        return {
          text: "Nothing saved yet. Share me a link or a thought and I'll hold onto it.",
          handled: true,
        };
      }
      break;
    }

    case "recall":
    case "chat":
    default:
      break;
  }

  // Search memory for context
  const memoryContext =
    classified.intent !== "save"
      ? await searchMemory(classified.summary || text)
      : [];

  // Generate Ada's response
  const reply = await generateResponse(
    text,
    classified,
    memoryContext,
    actionResult,
    false
  );

  console.log(`[ada] Reply: "${reply.slice(0, 80)}"`);
  return { text: reply, handled: true };
}

/**
 * Handle a group chat message where Ada was mentioned.
 */
export async function handleGroupMessage(
  msg: Message,
  group: GroupContext
): Promise<AgentResponse> {
  const rawText = msg.text ?? "";
  if (!rawText.trim()) return { text: "", handled: false };

  const text = stripMention(rawText);
  if (!text.trim()) {
    return { text: "What do you need?", handled: true };
  }

  console.log(
    `[ada] Group "${group.chatName ?? group.chatId}": "${text.slice(0, 80)}..."`
  );

  const memoryOptions = {
    source: "imessage-group",
    groupName: group.chatName ?? group.chatId,
  };

  // Sync to InsForge + classify locally in parallel
  const [classified] = await Promise.all([
    classify(text),
    syncToInsForge(text, `imessage-group:${group.chatName ?? group.chatId}`),
  ]);

  // Check for forwarded content in group
  const hasAttachments = !!(msg as Record<string, unknown>).attachments;
  if (isForwardedContent(text, hasAttachments)) {
    const url = text.match(/https?:\/\/[^\s]+/)?.[0];
    if (url) {
      await saveUrl(url, text.replace(url, "").trim() || undefined, memoryOptions);
    } else {
      await saveToMemory({ content: text, metadata: { type: "forward" } }, memoryOptions);
    }
    return { text: "Saved.", handled: true };
  }

  let actionResult: { success: boolean; message: string } | undefined;

  switch (classified.intent) {
    case "save": {
      if (classified.url) {
        await saveUrl(
          classified.url,
          text.replace(classified.url, "").trim() || undefined,
          memoryOptions
        );
      } else {
        await saveToMemory(
          {
            content: text,
            metadata: {
              intent: "save",
              type: "note",
              topics: classified.entities.topics?.join(", ") ?? "",
            },
          },
          memoryOptions
        );
      }
      break;
    }

    case "act": {
      const actionType = inferActionType(classified.entities, text);
      actionResult = await executeAction({
        type: actionType,
        title: classified.summary,
        description: text,
        date: classified.entities.dates?.[0],
        recipient: classified.entities.people?.[0],
      });
      break;
    }

    default:
      break;
  }

  // Save all group content Ada is tagged in
  if (classified.intent !== "save") {
    await saveToMemory(
      {
        content: `Group message: ${text}`,
        metadata: { intent: classified.intent, type: "group-mention" },
      },
      memoryOptions
    );
  }

  const memoryContext =
    classified.intent !== "save"
      ? await searchMemory(classified.summary || text)
      : [];

  const reply = await generateResponse(
    text,
    classified,
    memoryContext,
    actionResult,
    true
  );

  console.log(`[ada] Group reply: "${reply.slice(0, 80)}"`);
  return { text: reply, handled: true };
}

/**
 * Handle auto-detected forwarded content.
 * Auto-saves with "imessage-forward" source tag + syncs to InsForge.
 */
async function handleForwardedContent(text: string): Promise<AgentResponse> {
  const url = text.match(/https?:\/\/[^\s]+/)?.[0];
  const forwardOptions = { source: "imessage-forward" };

  // Sync to InsForge in background
  syncToInsForge(text, "imessage-forward").catch(() => {});

  if (url) {
    const context = text
      .replace(/^(fwd|fw):\s*/i, "")
      .replace(url, "")
      .trim();
    await saveUrl(url, context || undefined, forwardOptions);
    return { text: "Saved that forwarded link.", handled: true };
  }

  const cleanText = text.replace(/^(fwd|fw):\s*/i, "").trim();
  await saveToMemory(
    { content: cleanText, metadata: { type: "forward" } },
    forwardOptions
  );

  return { text: "Saved that forwarded message.", handled: true };
}
