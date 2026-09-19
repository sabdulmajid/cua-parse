import { loadConfig } from "../src/server/config.js";
import { LocalStore } from "../src/server/storage.js";
import { EvidenceStore } from "../src/server/elastic.js";
import path from "node:path";
const c = loadConfig();
const db = new LocalStore(path.join(c.localDir, "app.db"));
db.close();
const es = new EvidenceStore({
  url: c.ELASTICSEARCH_URL,
  apiKey: c.ELASTICSEARCH_API_KEY || undefined,
  index: c.ELASTICSEARCH_INDEX,
  ...(c.RETRIEVAL_MODE === "hybrid"
    ? {
        embedding: {
          apiKey: c.OPENAI_API_KEY!,
          model: c.OPENAI_EMBEDDING_MODEL,
          dimensions: c.OPENAI_EMBEDDING_DIMENSIONS,
        },
      }
    : {}),
});
try {
  await es.init();
  console.log(
    "PASS: local storage and Elasticsearch evidence mapping are ready.",
  );
} catch {
  console.error(
    "BLOCKED: Elasticsearch unavailable or mapping incompatible. Start Docker, then run docker compose up -d and retry npm run setup.",
  );
  process.exitCode = 1;
} finally {
  await es.close();
}
