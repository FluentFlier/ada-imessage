/**
 * Ada's Layer 2 - Claude Sonnet powers the secretary response.
 * Takes classified intent + memory context and generates Ada's reply.
 * Supports both DM and group chat modes.
 */

import { config } from "./config.ts";
import type { ClassifiedMessage } from "./classifier.ts";
import type { SearchResult } from "./memory.ts";

const DM_SYSTEM_PROMPT = `You are ${config.adaName}, an AI secretary living in iMessage. You are not an assistant - you are a secretary. The distinction matters: you don't wait to be asked, you handle things.

Your personality:
- Concise and action-oriented. No fluff.
- Warm but efficient. You respect the user's time.
- You confirm actions taken, not actions planned.
- You speak in the first person as a trusted secretary would.
- You never use em dashes.
- iMessage context: keep responses short. 1-4 sentences max unless recalling detailed content.

Your capabilities:
- Save anything shared to persistent memory
- Recall saved content when asked
- Take actions: set reminders, create calendar events, add tasks
- Extract and summarize URLs
- Remember context across conversations via your memory layer

Format:
- No markdown, no bullet lists. Plain text, iMessage-native.
- When saving: confirm what you saved in one line.
- When recalling: surface the most relevant item(s) directly.
- When acting: confirm the action taken.`;

const GROUP_SYSTEM_PROMPT = `You are ${config.adaName}, an AI secretary participating in a group chat on iMessage. You were explicitly mentioned or asked to help. You are not an assistant - you are a secretary.

Rules for group chats:
- Be extremely concise. 1-2 sentences max.
- Only address what you were asked. Do not volunteer extra info.
- Do not greet or acknowledge being tagged. Just answer or act.
- You never use em dashes.
- No markdown, no bullet lists. Plain text only.
- If someone shares a link or content with your name, save it and confirm briefly.
- If the request is ambiguous, do the most obvious thing rather than asking for clarification.`;

/**
 * Call Claude Sonnet via Anthropic API for Ada's response.
 * @param isGroupChat - If true, uses the concise group chat system prompt.
 */
export async function generateResponse(
  userMessage: string,
  classified: ClassifiedMessage,
  memoryContext: SearchResult[],
  actionResult?: { success: boolean; message: string },
  isGroupChat = false
): Promise<string> {
  // Build context block
  const memoryBlock =
    memoryContext.length > 0
      ? `\n\nRelevant memory:\n${memoryContext
          .slice(0, 3)
          .map((r, i) => `[${i + 1}] ${r.content.slice(0, 300)}`)
          .join("\n\n")}`
      : "";

  const actionBlock = actionResult
    ? `\n\nAction already taken: ${actionResult.message}`
    : "";

  const contextMessage = `Intent: ${classified.intent} (confidence: ${classified.confidence})
Summary: ${classified.summary}${memoryBlock}${actionBlock}

User message: ${userMessage}

Reply as ${config.adaName}:`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": config.anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: isGroupChat ? 150 : 300,
      system: isGroupChat ? GROUP_SYSTEM_PROMPT : DM_SYSTEM_PROMPT,
      messages: [{ role: "user", content: contextMessage }],
    }),
  });

  if (!res.ok) {
    console.error("[llm] Anthropic API error:", res.status);
    return fallback(classified.intent, actionResult?.message);
  }

  const data = (await res.json()) as {
    content: Array<{ type: string; text: string }>;
  };
  return (
    data.content.find((b) => b.type === "text")?.text ??
    fallback(classified.intent)
  );
}

function fallback(intent: string, actionMessage?: string): string {
  if (actionMessage) return actionMessage;
  if (intent === "save") return "Got it, saved.";
  if (intent === "recall") return "Let me check my memory for that.";
  if (intent === "act") return "On it.";
  return "I'm here. What do you need?";
}
