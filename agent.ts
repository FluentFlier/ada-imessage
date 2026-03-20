/**
 * Ada's core agent loop.
 * Orchestrates: classify -> memory -> act -> respond
 * Supports both DM and group chat contexts.
 */

import { config } from "./config.ts";
import { classify } from "./classifier.ts";
import { saveToMemory, saveUrl, searchMemory } from "./memory.ts";
import { executeAction, inferActionType } from "./actions.ts";
import { generateResponse } from "./llm.ts";
import { processDocument } from "./insforge.ts";
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
 * Patterns: "Fwd:", "FW:", URL with surrounding context text,
 * or attachment indicators.
 */
function isForwardedContent(text: string, hasAttachments?: boolean): boolean {
  const lower = text.toLowerCase();
  // Explicit forward prefixes
  if (lower.startsWith("fwd:") || lower.startsWith("fw:")) return true;
  // URL with surrounding context (not just a bare link)
  const urlMatch = text.match(/https?:\/\/[^\s]+/);
  if (urlMatch) {
    const textWithoutUrl = text.replace(urlMatch[0], "").trim();
    // If there's meaningful text around the URL, likely forwarded
    if (textWithoutUrl.length > 20) return true;
  }
  // Screenshot or file attachment
  if (hasAttachments) return true;
  return false;
}

/**
 * Strip the @Ada mention from a group chat message to get the actual request.
 */
function stripMention(text: string): string {
  const pattern = new RegExp(`@?${config.adaName}\\s*`, "i");
  return text.replace(pattern, "").trim();
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

  // Layer 1: Classify intent
  const classified = await classify(text);
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
        // Large text content goes through InsForge
        if (text.length > 1000) {
          const processed = await processDocument(text);
          await saveToMemory({
            content: processed.content,
            metadata: {
              intent: "save",
              type: "note",
              summary: processed.summary,
              topics: classified.entities.topics?.join(", ") ?? "",
            },
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

  // Search memory for context (always useful except pure saves)
  const memoryContext =
    classified.intent !== "save"
      ? await searchMemory(classified.summary || text)
      : [];

  // Layer 2: Generate Ada's response
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
 * More concise responses. Saves tagged content to memory with group context.
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

  // Check for forwarded content in group
  const hasAttachments = !!(msg as Record<string, unknown>).attachments;
  if (isForwardedContent(text, hasAttachments)) {
    console.log("[ada] Forwarded content in group, auto-saving");
    const url = text.match(/https?:\/\/[^\s]+/)?.[0];
    if (url) {
      await saveUrl(url, text.replace(url, "").trim() || undefined, memoryOptions);
    } else {
      await saveToMemory({ content: text, metadata: { type: "forward" } }, memoryOptions);
    }
    return { text: "Saved.", handled: true };
  }

  // Classify and route
  const classified = await classify(text);
  console.log(
    `[ada] Group intent: ${classified.intent} (${classified.confidence.toFixed(2)})`
  );

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

  // Always save content Ada is tagged in (group context)
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
 * Saves to memory with "imessage-forward" source tag.
 */
async function handleForwardedContent(text: string): Promise<AgentResponse> {
  const url = text.match(/https?:\/\/[^\s]+/)?.[0];
  const forwardOptions = { source: "imessage-forward" };

  if (url) {
    // Strip "Fwd:" prefix for cleaner context
    const context = text
      .replace(/^(fwd|fw):\s*/i, "")
      .replace(url, "")
      .trim();
    await saveUrl(url, context || undefined, forwardOptions);
    return { text: "Saved that forwarded link.", handled: true };
  }

  // Plain forwarded text
  const cleanText = text.replace(/^(fwd|fw):\s*/i, "").trim();

  // Large forwarded content goes through InsForge
  if (cleanText.length > 1000) {
    const processed = await processDocument(cleanText);
    await saveToMemory(
      {
        content: processed.content,
        metadata: { type: "forward", summary: processed.summary },
      },
      forwardOptions
    );
  } else {
    await saveToMemory(
      { content: cleanText, metadata: { type: "forward" } },
      forwardOptions
    );
  }

  return { text: "Saved that forwarded message.", handled: true };
}
