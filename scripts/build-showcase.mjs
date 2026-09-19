import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const required = [
  "index.html",
  "styles.css",
  "app.js",
  "render.js",
  "data/demo.json",
  "assets/walkthrough.mp4",
  "assets/poster.webp",
  "assets/captions.vtt",
];
const allowed = new Set([
  ".html",
  ".css",
  ".js",
  ".json",
  ".svg",
  ".webp",
  ".png",
  ".jpg",
  ".mp4",
  ".gif",
  ".vtt",
  ".txt",
]);

/** Build only the reviewed public assets. Never copy the application or its runtime files. */
export function buildShowcase(projectRoot = process.cwd()) {
  const source = path.join(projectRoot, "showcase");
  const output = path.join(projectRoot, ".site");
  if (lstatSync(source).isSymbolicLink())
    throw new Error("The showcase directory must not be a link.");
  for (const name of required) {
    if (!existsSync(path.join(source, name)))
      throw new Error(`Missing public demo asset: ${name}`);
  }
  let totalBytes = 0;
  const files = [];
  function inspect(directory, prefix = "") {
    for (const name of readdirSync(directory)) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (name.startsWith("."))
        throw new Error(`Hidden public asset is not allowed: ${relative}`);
      const stat = lstatSync(path.join(directory, name));
      if (stat.isSymbolicLink())
        throw new Error(`Linked public asset is not allowed: ${relative}`);
      if (stat.isDirectory()) {
        inspect(path.join(directory, name), relative);
        continue;
      }
      if (!stat.isFile() || !allowed.has(path.extname(name)))
        throw new Error(`Unsupported public asset: ${relative}`);
      if (stat.size > 25 * 1024 * 1024)
        throw new Error(`Public asset exceeds 25 MB: ${relative}`);
      totalBytes += stat.size;
      files.push(relative);
    }
  }
  inspect(source);
  if (totalBytes > 60 * 1024 * 1024)
    throw new Error(
      "Public demo exceeds 60 MB. Compress the recording before publication.",
    );
  const data = JSON.parse(
    readFileSync(path.join(source, "data/demo.json"), "utf8"),
  );
  if (
    data.schemaVersion !== 1 ||
    data.synthetic !== true ||
    data.product !== "AcmeFlow" ||
    data.provenance?.publicSourceUrls !== false
  )
    throw new Error("The public demo must identify its synthetic evidence.");
  for (const key of ["overview", "pricing", "excluded", "challenge"]) {
    const state = data.states?.[key];
    if (
      !Array.isArray(state?.evidence) ||
      !Array.isArray(state?.opposingEvidence)
    )
      throw new Error("A public evidence state is missing.");
    for (const record of [...state.evidence, ...state.opposingEvidence]) {
      if (
        record.provenance !== "synthetic" ||
        record.source !== "fixture" ||
        record.url !== null ||
        typeof record.id !== "string" ||
        !record.id.startsWith("fixture:")
      )
        throw new Error("A non-fixture source cannot be published.");
    }
  }
  const forbiddenKeys = new Set([
    "sessionId",
    "researchId",
    "requestId",
    "csrfToken",
    "embedding",
    "apiKey",
  ]);
  function checkPrivateFields(value) {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKeys.has(key))
        throw new Error("Runtime or credential fields cannot be published.");
      checkPrivateFields(child);
    }
  }
  checkPrivateFields(data);
  if (existsSync(output) && lstatSync(output).isSymbolicLink())
    throw new Error("The output directory must not be a link.");
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  cpSync(source, output, { recursive: true });
  writeFileSync(path.join(output, ".nojekyll"), "");
  return { files: files.sort(), bytes: totalBytes, output };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = buildShowcase();
    console.log(
      `Built ${result.files.length} public assets (${(result.bytes / 1024 / 1024).toFixed(1)} MB) into .site.`,
    );
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Public demo build failed.",
    );
    process.exitCode = 1;
  }
}
