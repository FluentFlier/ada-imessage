# Ada for iMessage

> Text Ada anything. She saves it, remembers it, and follows through.

Ada is an AI secretary that lives in the iOS share sheet ([tryada.app](https://tryada.app)). When you're reading an article, browsing a restaurant, or looking at a flight, you hit Share and Ada handles it: saves it to memory, sets a reminder, adds it to your calendar, or drafts a follow-up.

This repo extends Ada into iMessage. Same secretary, same memory, same backend. Different input surface.

**One sentence:** Ada on iOS captures intent from apps. Ada on iMessage captures intent from conversations.

---

## How It Works

The iMessage agent connects to the same InsForge backend as the Ada iOS app. When you text Ada a link or a thought:

1. **Instant reply** via local classification (GPT-4o-mini) + response (Claude Sonnet)
2. **Background sync** creates an Item in InsForge's database and triggers the full classification pipeline
3. **iOS app updates** in real-time via InsForge's realtime layer

Everything you text to Ada shows up in your iOS app. Everything you save in the iOS app is searchable from iMessage.

```
iMessage in (DM or group chat)
    |
    +---> Local fast path: classify + respond (instant)
    |
    +---> InsForge sync: create Item + trigger classify (background)
              |
              +---> Item appears in iOS app via realtime
              +---> Full classification (category, actions, extracted data)
              +---> Supermemory stores with containerTag = userId
```

### What Ada Does in iMessage

- **Save anything.** Text a link, a thought, a screenshot. Ada saves it to memory and creates an Item in your feed.
- **Recall anything.** "What was that restaurant from last week?" Ada searches your memory.
- **Take actions.** "Remind me to call the dentist Friday." Ada creates a reminder.
- **Join group chats.** @mention Ada in a group and she'll save links, answer questions, and act. 1-2 sentence responses only.
- **Auto-detect forwards.** Messages starting with "Fwd:" or containing a URL with context are auto-saved without being asked.

### Architecture

Ada uses the same two-layer architecture as the iOS app:

| Layer | Technology | Role |
|-------|-----------|------|
| Layer 1 | GPT-4o-mini | Intent classification (save, recall, act, chat, status) |
| Layer 2 | Claude Sonnet | Secretary response generation |
| Memory | Supermemory (containerTag = userId) | Per-user RAG across iOS + iMessage |
| Actions | Composio | Calendar, reminders, tasks |
| URLs | Jina Reader | Extract and summarize web content |
| Backend | InsForge (@insforge/sdk) | Database, auth, edge functions, realtime |
| Transport | @photon-ai/imessage-kit | iMessage read/write on macOS |

### InsForge Integration

The iMessage agent authenticates as your Ada user and writes to the same tables the iOS app reads:

- **`items` table**: Every message creates an Item (same as the share extension's `saveItem()`)
- **`classify` edge function**: Triggered on each item (same pipeline: Jina + GPT-4o-mini + action creation)
- **Supermemory**: Uses `containerTag = userId` so memory is shared between iOS and iMessage
- **Realtime**: Items appear in the iOS app immediately via InsForge's realtime subscriptions

If InsForge is unreachable, the agent falls back to standalone mode (local classify + direct Supermemory).

### Sync Server

A lightweight HTTP server runs alongside the watcher so the iOS app can query iMessage-specific data:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Agent status, InsForge connection, group watch config |
| `/saved?since=ISO_DATE` | GET | Search Supermemory for recent iMessage saves |
| `/items?limit=N` | GET | Recent items from InsForge database |
| `/sync` | POST | Trigger manual memory sync |

---

## Demo

```
You:  https://paulgraham.com/founder.html - read this later
Ada:  Saved. "Founder Mode" by Paul Graham, bookmarked with your note.
      [Item created in iOS app with category: learning, suggested actions: summarize, create_note]

You:  remind me to follow up with Riya on Friday
Ada:  Reminder set for Friday. Following up with Riya.
      [Action created: set_reminder in iOS app]

You:  what was that Paul Graham essay I saved?
Ada:  "Founder Mode" - you saved it 3 days ago. Here's the gist: ...
      [Searched Supermemory with containerTag = your userId]

[In a group chat]
Friend: @Ada save this https://arxiv.org/abs/2401.00001
Ada:  Saved.
      [Item created with source_app: imessage-group:GroupName]

[Forwarded content]
You:  Fwd: Check out this apartment https://zillow.com/...
Ada:  Saved that forwarded link.
      [Auto-detected forward, saved with source: imessage-forward]
```

---

## Setup

### Prerequisites

- macOS (iMessage requirement)
- [Bun](https://bun.sh) >= 1.0.0
- Full Disk Access granted to your terminal (System Settings > Privacy & Security > Full Disk Access)
- An Ada account with InsForge credentials (from the iOS app)

### Install

```bash
git clone https://github.com/FluentFlier/ada-imessage
cd ada-imessage
bun install
```

### Configure

```bash
cp .env.example .env
```

**Required** (minimum to run):

```env
OWNER_PHONE=+1234567890     # Your phone number
ANTHROPIC_API_KEY=...        # Claude Sonnet
OPENAI_API_KEY=...           # GPT-4o-mini
SUPERMEMORY_API_KEY=...      # Same key as iOS app
```

**For iOS app sync** (items appear in your Ada feed):

```env
INSFORGE_URL=...             # Same as EXPO_PUBLIC_INSFORGE_URL
INSFORGE_ANON_KEY=...        # Same as EXPO_PUBLIC_INSFORGE_ANON_KEY
INSFORGE_USER_EMAIL=...      # Your Ada account email
INSFORGE_USER_PASSWORD=...   # Your Ada account password
```

### Run

```bash
bun run start                # Start Ada (iMessage watcher + sync server)
bun run dev                  # Development mode (auto-reload + debug logging)
bun run sync-server          # Sync server only
```

Ada will text you when she's online.

---

## Project Structure

```
ada-imessage/
  index.ts          Entry point. Auth + iMessage watcher + sync server.
  agent.ts          Orchestrator. Dual pipeline: local fast path + InsForge sync.
  classifier.ts     Layer 1: GPT-4o-mini intent classification.
  llm.ts            Layer 2: Claude Sonnet response generation (DM + group modes).
  memory.ts         Supermemory with containerTag = userId (per-user, shared with iOS).
  actions.ts        Composio action execution (calendar, reminders, tasks).
  config.ts         Centralized config. InsForge URL/key mirrors iOS app constants.
  insforge.ts       @insforge/sdk client. Auth, item CRUD, classify trigger, search.
  sync-server.ts    HTTP server for iOS app sync + InsForge item queries.
```

---

## Built By

[Anirudh Manjesh](https://linkedin.com/in/amanjesh) - Founder of Ada, CS @ ASU Barrett Honors College

[tryada.app](https://tryada.app)

## License

MIT
