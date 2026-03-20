# Ada for iMessage

> An additional input channel for [Ada](https://tryada.app), bringing your AI secretary into iMessage conversations.

## What is Ada?

Ada is an AI secretary that lives in the iOS share sheet. When you're reading an article, browsing a restaurant, or looking at a flight, you hit Share and Ada handles it: saves it to memory, sets a reminder, adds it to your calendar, or drafts a follow-up. Ada doesn't wait to be asked. She acts.

Ada's primary surface is iOS. This repo extends Ada's reach into iMessage.

## What is this?

This is **Ada's iMessage channel**, not a standalone chatbot. Think of it this way:

- **Ada on iOS** captures intent from apps via the share sheet
- **Ada on iMessage** captures intent from conversations via text messages

Same secretary. Same memory. Same action pipeline. Different input surface.

Concretely, this lets Ada:

- **Ingest content from conversations.** Forward a link from a group chat, text Ada a thought, share a screenshot. It all flows into Ada's memory.
- **Join group chats.** Add Ada to a group and @mention her. She'll save links, answer questions, and take actions without anyone needing the iOS app.
- **Auto-detect forwarded content.** Messages that start with "Fwd:", contain a URL with context, or include attachments are automatically saved to memory.
- **Sync with the iOS app.** A lightweight HTTP server lets the Ada iOS app pull iMessage-saved content into Ada's feed.
- **Route heavy processing to InsForge.** Large documents, batch classification, and embedding generation go through the user's InsForge backend.

## Architecture

Ada uses a two-layer architecture (identical to the Ada iOS app):

```
iMessage in (DM or group chat)
    |
    v
Forwarded content?  ----yes----> Auto-save to memory (tagged: imessage-forward)
    |no
    v
Layer 1: GPT-4o-mini classifies intent
    -> save | recall | act | chat | status
    |
    v
Layer 2: Claude Sonnet generates secretary response
    ^                    ^                ^
    |                    |                |
Supermemory (RAG)    Composio          InsForge
persistent memory    actions           heavy compute
                     (calendar,        (document processing,
                      reminders,        batch classification,
                      tasks)            embeddings)
    |
    v
Jina Reader: URL extraction and summarization
```

### Group Chat Mode

When Ada is in a group chat, she follows different rules:

- Only responds when @mentioned by name
- Keeps responses to 1-2 sentences
- Saves all content she's tagged in to memory (tagged with the group name)
- Does the most obvious thing rather than asking for clarification

### Sync Server

A lightweight HTTP server (Bun.serve) runs alongside the iMessage watcher so the iOS app can pull iMessage-saved content:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Status check (agent name, InsForge status, group watch status) |
| `/saved?since=ISO_DATE` | GET | Recent saves from Supermemory, optionally filtered by date |
| `/sync` | POST | Trigger a manual memory sync |

Default port: 3001 (configurable via `SYNC_SERVER_PORT`).

## Demo

```
You:  https://paulgraham.com/founder.html - read this later
Ada:  Saved. "Founder Mode" by Paul Graham, bookmarked with your note.

You:  remind me to follow up with Riya on Friday
Ada:  Reminder set for Friday. Following up with Riya.

You:  what was that Paul Graham essay I saved?
Ada:  "Founder Mode" - you saved it 3 days ago. Here's the gist: ...

[In a group chat]
Friend: @Ada save this https://arxiv.org/abs/2401.00001
Ada:  Saved.

[Forwarded content - auto-detected]
You:  Fwd: Check out this apartment https://zillow.com/...
Ada:  Saved that forwarded link.
```

## Project Structure

```
ada-imessage/
  index.ts          Entry point. Starts iMessage watcher + sync server.
  agent.ts          Orchestrator. Classify -> memory -> act -> respond.
                    Handles DMs, group chats, and forwarded content.
  classifier.ts     Layer 1: GPT-4o-mini intent classification.
  llm.ts            Layer 2: Claude Sonnet response generation.
                    Separate system prompts for DM vs group chat.
  memory.ts         Supermemory integration. Save + search with source tagging.
  actions.ts        Composio action execution (calendar, reminders, tasks).
  config.ts         Centralized configuration. All env vars and defaults.
  insforge.ts       InsForge backend. Heavy compute with graceful fallback.
  sync-server.ts    HTTP server for iOS app sync.
  .env.example      All environment variables with descriptions.
```

## Setup

### Prerequisites

- macOS (iMessage requirement)
- [Bun](https://bun.sh) >= 1.0.0
- Full Disk Access granted to your terminal (System Settings > Privacy & Security > Full Disk Access)

### Install

```bash
git clone https://github.com/AnirudhManjworked/ada-imessage
cd ada-imessage
bun install
```

### Configure

```bash
cp .env.example .env
```

Fill in your `.env`. At minimum you need:

```env
ANTHROPIC_API_KEY=       # Claude Sonnet
OPENAI_API_KEY=          # GPT-4o-mini
SUPERMEMORY_API_KEY=     # Persistent memory
OWNER_PHONE=+1234567890 # Your phone number
```

Optional for full functionality:

```env
COMPOSIO_API_KEY=        # Calendar, reminders, tasks
JINA_API_KEY=            # URL extraction
INSFORGE_BASE_URL=       # Heavy compute backend
INSFORGE_API_KEY=        # InsForge auth
WATCH_GROUPS=true        # Enable group chat monitoring
WATCHED_GROUP_IDS=id1,id2 # Group chats to watch
```

### Run

```bash
# Start Ada (iMessage watcher + sync server)
bun run start

# Development mode (auto-reload + debug logging)
bun run dev

# Sync server only (no iMessage watcher)
bun run sync-server
```

Ada will send you an iMessage when she's online.

## Stack

All choices match the Ada iOS app exactly:

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Transport | @photon-ai/imessage-kit | iMessage read/write on macOS |
| Classification | GPT-4o-mini | Layer 1: intent classification |
| Response | Claude Sonnet (Anthropic API) | Layer 2: secretary responses |
| Memory | Supermemory API | RAG and personalization |
| URL Extraction | Jina Reader | Fetch and summarize web content |
| Actions | Composio | Calendar, reminders, tasks |
| Heavy Compute | InsForge | Document processing, embeddings |
| Runtime | Bun + TypeScript | Fast, native TypeScript execution |

## Built By

[Anirudh Manjesh](https://linkedin.com/in/amanjesh) - Founder of Ada, CS @ ASU Barrett Honors College

[tryada.app](https://tryada.app) - Join the waitlist

## License

MIT
