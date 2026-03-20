/**
 * Lightweight sync server so Ada's iOS app can pull iMessage-saved content.
 * Runs on Bun.serve.
 *
 * Endpoints:
 *   GET  /health        - Status check (InsForge connection, group watch)
 *   GET  /saved?since=  - Recent saves from Supermemory (ISO date filter)
 *   GET  /items?limit=  - Recent items from InsForge database
 *   POST /sync          - Trigger a manual memory sync
 */

import { config } from "./config.ts";
import { searchMemory } from "./memory.ts";
import { isConnected, getRecentItems } from "./insforge.ts";

export function startSyncServer() {
  const port = config.syncServerPort;

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      const corsHeaders = {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      };

      if (req.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            ...corsHeaders,
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        });
      }

      // GET /health
      if (url.pathname === "/health" && req.method === "GET") {
        return Response.json(
          {
            status: "ok",
            agent: config.adaName,
            source: "imessage",
            insforge: isConnected() ? "connected" : "standalone",
            groupWatch: config.watchGroups,
            watchedGroups: config.watchedGroupIds.length,
          },
          { headers: corsHeaders }
        );
      }

      // GET /saved?since=ISO_DATE - search Supermemory
      if (url.pathname === "/saved" && req.method === "GET") {
        const since = url.searchParams.get("since");
        const query = since
          ? `content saved from imessage after ${since}`
          : "recent imessage saves";
        const results = await searchMemory(query);
        return Response.json(
          { results, query, since },
          { headers: corsHeaders }
        );
      }

      // GET /items?limit=N - get recent items from InsForge database
      if (url.pathname === "/items" && req.method === "GET") {
        const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
        const items = await getRecentItems(limit);
        return Response.json(
          { items, count: items.length },
          { headers: corsHeaders }
        );
      }

      // POST /sync
      if (url.pathname === "/sync" && req.method === "POST") {
        const results = await searchMemory("all recent imessage saves");
        return Response.json(
          { synced: true, count: results.length, results },
          { headers: corsHeaders }
        );
      }

      return Response.json(
        { error: "Not found" },
        { status: 404, headers: corsHeaders }
      );
    },
  });

  console.log(`[sync] Server running on http://localhost:${port}`);
  return server;
}
