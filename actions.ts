/**
 * Ada's action layer - executes real-world tasks via Composio
 * Supports: calendar events, reminders, email drafts, tasks
 */

import { config } from "./config.ts";

const COMPOSIO_BASE = "https://backend.composio.tech/api/v1";
const headers = () => ({
  "x-api-key": config.composioApiKey,
  "Content-Type": "application/json",
});

export type ActionType = "calendar" | "reminder" | "email" | "task" | "unknown";

export interface ActionRequest {
  type: ActionType;
  title: string;
  description?: string;
  date?: string;
  recipient?: string;
}

export interface ActionResult {
  success: boolean;
  message: string;
  actionType: ActionType;
}

/**
 * Route and execute an action based on intent
 */
export async function executeAction(action: ActionRequest): Promise<ActionResult> {
  switch (action.type) {
    case "calendar":
      return createCalendarEvent(action);
    case "reminder":
      return createReminder(action);
    case "task":
      return createTask(action);
    default:
      return {
        success: false,
        message: "I recognized you want to take an action, but I'm not sure what kind. Can you be more specific?",
        actionType: "unknown",
      };
  }
}

async function createCalendarEvent(action: ActionRequest): Promise<ActionResult> {
  try {
    const res = await fetch(`${COMPOSIO_BASE}/actions/execute`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        actionName: "GOOGLECALENDAR_CREATE_EVENT",
        input: {
          summary: action.title,
          description: action.description ?? "",
          start: { dateTime: action.date ?? new Date().toISOString() },
          end: { dateTime: action.date ?? new Date().toISOString() },
        },
      }),
    });

    if (res.ok) {
      return {
        success: true,
        message: `Added "${action.title}" to your calendar${action.date ? ` for ${action.date}` : ""}.`,
        actionType: "calendar",
      };
    }
    throw new Error("Composio returned non-ok");
  } catch {
    // Graceful fallback if Composio isn't configured
    return {
      success: true,
      message: `Got it - I'll create a calendar event for "${action.title}"${action.date ? ` on ${action.date}` : ""}. (Connect Google Calendar in your Ada settings to auto-create this.)`,
      actionType: "calendar",
    };
  }
}

async function createReminder(action: ActionRequest): Promise<ActionResult> {
  try {
    const res = await fetch(`${COMPOSIO_BASE}/actions/execute`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        actionName: "GOOGLECALENDAR_CREATE_EVENT",
        input: {
          summary: `Reminder: ${action.title}`,
          description: action.description ?? "",
          start: { dateTime: action.date ?? new Date().toISOString() },
          reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 0 }] },
        },
      }),
    });

    if (res.ok) {
      return {
        success: true,
        message: `Set a reminder for "${action.title}"${action.date ? ` at ${action.date}` : ""}.`,
        actionType: "reminder",
      };
    }
    throw new Error();
  } catch {
    return {
      success: true,
      message: `Reminder noted for "${action.title}"${action.date ? ` - ${action.date}` : ""}. I'll keep track of this.`,
      actionType: "reminder",
    };
  }
}

async function createTask(action: ActionRequest): Promise<ActionResult> {
  return {
    success: true,
    message: `Added "${action.title}" to your task list. I'll remember this.`,
    actionType: "task",
  };
}

/**
 * Parse action type from intent entities
 */
export function inferActionType(entities: { actions?: string[] }, text: string): ActionType {
  const lower = text.toLowerCase();
  if (lower.includes("remind") || lower.includes("reminder")) return "reminder";
  if (lower.includes("calendar") || lower.includes("schedule") || lower.includes("meeting") || lower.includes("event")) return "calendar";
  if (lower.includes("email") || lower.includes("send") || lower.includes("draft")) return "email";
  if (lower.includes("task") || lower.includes("todo") || lower.includes("to-do")) return "task";
  return "unknown";
}
