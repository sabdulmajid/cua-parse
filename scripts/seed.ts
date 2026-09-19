import { loadConfig } from "../src/server/config.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
const c = loadConfig();
const file = path.join(c.localDir, "seed-session.json");
let session: { cookie: string; csrf: string } | undefined;
if (existsSync(file)) session = JSON.parse(readFileSync(file, "utf8"));
try {
  const response = await fetch(c.APP_BASE_URL + "/api/session", {
    headers: session ? { Cookie: session.cookie } : {},
    signal: AbortSignal.timeout(5000),
  });
  const initial = await response.json();
  session = {
    cookie:
      response.headers.get("set-cookie")?.split(";")[0] || session!.cookie,
    csrf: initial.csrfToken,
  };
  writeFileSync(file, JSON.stringify(session), { mode: 0o600 });
  const call = async (name: string, body: unknown) => {
    const r = await fetch(c.APP_BASE_URL + "/api/tools/" + name, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: session!.cookie,
        "X-CSRF-Token": session!.csrf,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error("Seed API failed");
    return r.json();
  };
  const { job } = await call("start_research", {
    product: "AcmeFlow",
    question: "What do people dislike about pricing and onboarding?",
    mode: "fixture",
    idempotencyKey: "seed-fixture-v1",
  });
  const deadline = Date.now() + c.JOB_TIMEOUT_MS + 5000;
  while (Date.now() < deadline) {
    const { job: current } = await call("get_research_status", {
      researchId: job.id,
    });
    if (["ready", "failed", "cancelled"].includes(current.state)) {
      console.log(
        JSON.stringify({
          state: current.state,
          indexed: current.indexed,
          duplicates: current.duplicates,
          mode: "synthetic",
          note: "Idempotent seed session. Start a fixture in your browser for an interactive session.",
        }),
      );
      if (current.state !== "ready") process.exitCode = 1;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
} catch {
  console.error("BLOCKED: start the app with npm start before npm run seed.");
  process.exitCode = 1;
}
