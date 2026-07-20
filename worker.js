/**
 * Cloudflare Worker — backend for the e-newspaper site.
 *
 * What this does:
 *  - Stores today's PDF link in Workers KV (a small server-side database).
 *  - GET  /api/edition   -> public, anyone can read the current link.
 *  - POST /api/publish   -> protected. The password is checked here, on the
 *                           server, and is NEVER sent to or stored in the
 *                           browser. It only ever exists as a secret on
 *                           Cloudflare's servers.
 *
 * Setup (one-time, ~5 minutes, free):
 *  1. Install Wrangler:      npm install -g wrangler
 *  2. Log in:                wrangler login
 *  3. Create the KV store:   wrangler kv namespace create NEWSPAPER_KV
 *     -> copy the "id" it prints into wrangler.toml (see wrangler.toml file)
 *  4. Set the real password (never put it in code):
 *                             wrangler secret put PUBLISHER_PASSWORD
 *     -> it will prompt you to type the password, then encrypts and stores it
 *  5. Deploy:                 wrangler deploy
 *  6. Wrangler prints a URL like https://enewspaper-backend.YOURNAME.workers.dev
 *     Put that URL into index.html where it says WORKER_URL.
 *
 * To change the password later, just run step 4 again with the new one.
 */

const ALLOWED_ORIGIN = "*"; // tighten to your site's exact domain once it's live, e.g. "https://yoursite.com"

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}

// very small in-memory-per-request rate limit helper using KV as a counter,
// so repeated wrong-password guesses get slowed down
async function tooManyAttempts(env, ip) {
  const key = `attempts:${ip}`;
  const raw = await env.NEWSPAPER_KV.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= 8) return true;
  await env.NEWSPAPER_KV.put(key, String(count + 1), { expirationTtl: 300 }); // resets after 5 min
  return false;
}

async function clearAttempts(env, ip) {
  await env.NEWSPAPER_KV.delete(`attempts:${ip}`);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === "/api/edition" && request.method === "GET") {
      const stored = await env.NEWSPAPER_KV.get("current-edition", { type: "json" });
      return json(stored || { url: null, updatedAt: null, label: null });
    }

    if (url.pathname === "/api/publish" && request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";

      if (await tooManyAttempts(env, ip)) {
        return json({ error: "Too many attempts. Try again in a few minutes." }, 429);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid request." }, 400);
      }

      const { password, pdfUrl } = body || {};

      if (!password || password !== env.PUBLISHER_PASSWORD) {
        return json({ error: "Incorrect password." }, 401);
      }

      if (!pdfUrl || typeof pdfUrl !== "string") {
        return json({ error: "Missing PDF link." }, 400);
      }

      await clearAttempts(env, ip);

      const record = {
        url: pdfUrl.trim(),
        updatedAt: new Date().toISOString(),
        label: "Today's edition",
      };

      await env.NEWSPAPER_KV.put("current-edition", JSON.stringify(record));
      return json({ success: true, record });
    }

    return json({ error: "Not found." }, 404);
  },
};
