import OpenAI from "openai";
import { config } from "./config.ts";

const openai = new OpenAI({ apiKey: config.openaiApiKey });

export type Intent =
  | "save"       // Save content to memory (links, notes, ideas)
  | "recall"     // Retrieve something from memory
  | "act"        // Do something (calendar, email, reminder)
  | "chat"       // General conversation / question
  | "status";    // Ask what Ada has saved / what's pending

export interface ClassifiedMessage {
  intent: Intent;
  confidence: number;
  url?: string;
  entities: {
    dates?: string[];
    people?: string[];
    topics?: string[];
    actions?: string[];
  };
  summary: string;
}

export async function classify(text: string): Promise<ClassifiedMessage> {
  const urlMatch = text.match(/https?:\/\/[^\s]+/);
  const url = urlMatch?.[0];

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are Ada's intent classifier. Analyze messages sent to Ada, an AI secretary.

Classify into one intent:
- "save": user is sharing content to be remembered (links, notes, ideas, "save this", "remember this", "add to my list")
- "recall": user wants to retrieve something ("what was that...", "find me...", "do I have...", "what did I save...")  
- "act": user wants an action taken (set reminder, create calendar event, draft email, add task)
- "chat": general question or conversation
- "status": asking what Ada has stored or what's pending ("what have I saved", "show me my...")

Extract entities when present:
- dates: any time references
- people: any person names
- topics: key subject matter
- actions: verbs describing what to do

Return JSON:
{
  "intent": "save|recall|act|chat|status",
  "confidence": 0.0-1.0,
  "entities": { "dates": [], "people": [], "topics": [], "actions": [] },
  "summary": "one sentence describing what the user wants"
}`,
      },
      {
        role: "user",
        content: text,
      },
    ],
  });

  const raw = JSON.parse(response.choices[0].message.content ?? "{}");

  return {
    intent: raw.intent ?? "chat",
    confidence: raw.confidence ?? 0.5,
    url,
    entities: raw.entities ?? {},
    summary: raw.summary ?? text,
  };
}
