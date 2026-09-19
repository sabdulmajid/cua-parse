/** Local-only pre-push check. Never prints matching text or configured values. */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

const MAX_BYTES = 64 * 1024 * 1024;
const patterns = [
  [
    "private-key",
    /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----|-----BEGIN (?:PGP) PRIVATE KEY BLOCK-----/g,
  ],
  [
    "openai-or-anthropic-key",
    /\bsk-(?:(?:proj|svcacct|ant-api\d+)-)?[A-Za-z0-9_-]{20,}/g,
  ],
  ["stripe-secret", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ["elevenlabs-key", /\bsk_[a-fA-F0-9]{32,}/g],
  [
    "github-token",
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g,
  ],
  ["gitlab-token", /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ["slack-token", /\b(?:xox[baprs]-[A-Za-z0-9-]{20,}|xapp-[A-Za-z0-9-]{20,})/g],
  ["google-api-key", /\bAIza[A-Za-z0-9_-]{35}/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36,}/g],
  [
    "jwt-token",
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g,
  ],
] as const;
const secretName = /(?:api[_-]?key|token|secret|password|credential)/i;
const placeholder =
  /^(?:\$\{?[^\s]+\}?|(?:your|example|placeholder|replace|change[-_]?me|test|mock|dummy|fake)(?:[-_ ].*)?|x+|<[^>]+>)$/i;

export interface Finding {
  location: string;
  rule: string;
  line?: number;
}

function opaque(value: string): boolean {
  if (placeholder.test(value) || value.length < 20) return false;
  return (
    /^[a-f\d]{32,}$/i.test(value) ||
    (value.length >= 28 &&
      /[A-Z]/.test(value) &&
      /[a-z]/.test(value) &&
      /\d/.test(value))
  );
}

function elasticEncoded(value: string): boolean {
  if (!/^[A-Za-z\d+/_-]{24,}={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  return (
    /^[A-Za-z\d_-]{8,}:[A-Za-z\d_-]{16,}$/.test(decoded) &&
    Buffer.from(decoded).toString("base64url") ===
      value.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")
  );
}

function redactLocation(location: string, values: string[]): string {
  let safe = location;
  for (const value of values) safe = safe.split(value).join("[REDACTED]");
  for (const [, expression] of patterns)
    safe = safe.replace(new RegExp(expression), "[REDACTED]");
  return JSON.stringify(safe);
}

/** ASCII secret patterns are checked in every file type, including binary blobs. */
export function scanText(
  text: string,
  location: string,
  values: string[] = [],
): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const add = (rule: string, offset: number) => {
    const line = text.slice(0, offset).split("\n").length;
    const key = `${rule}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ location: redactLocation(location, values), rule, line });
  };
  for (const [rule, expression] of patterns)
    for (const match of text.matchAll(new RegExp(expression)))
      add(rule, match.index!);
  for (const value of values) {
    let offset = text.indexOf(value);
    while (offset !== -1) {
      add("configured-secret-value", offset);
      offset = text.indexOf(value, offset + value.length);
    }
  }
  // Quoted source/config assignments and raw dotenv assignments. Never flag
  // arbitrary base64 strings, dependency hashes, or unquoted code identifiers.
  const assignments = [
    /["']?([A-Za-z_][A-Za-z\d_-]*)["']?\s*[:=]\s*["']([^"'\r\n]+)["']/g,
    /^[ \t]*(?:export[ \t]+)?([A-Z_][A-Z\d_]*)[ \t]*=[ \t]*([^\s#"']+)/gm,
  ];
  for (const expression of assignments) {
    for (const match of text.matchAll(expression)) {
      const [, name, value] = match;
      if (!secretName.test(name) || placeholder.test(value)) continue;
      if (elasticEncoded(value)) add("encoded-api-key", match.index!);
      else if (opaque(value)) add("credential-assignment", match.index!);
      if (/^(?:VITE_|NEXT_PUBLIC_)/.test(name) && value)
        add("public-client-secret-setting", match.index!);
    }
  }
  for (const match of text.matchAll(
    /\b(?:ApiKey|Bearer)\s+([A-Za-z\d+/_=.-]{20,})/g,
  ))
    if (elasticEncoded(match[1]) || opaque(match[1]))
      add("authorization-token", match.index!);
  return findings;
}

function artifactRule(file: string): string | null {
  if (/(?:^|\/)\.env(?:\.[^/]*)?$/.test(file) && !file.endsWith(".env.example"))
    return "local-environment-file";
  if (
    /(?:^|\/)(?:\.local|browser-sessions|recordings|playwright-report|test-results)\//.test(
      file,
    ) ||
    /\.(?:db(?:-(?:wal|shm))?|sqlite\w*(?:-(?:wal|shm))?)$/i.test(file)
  )
    return "local-runtime-artifact";
  return null;
}

function git(cwd: string, args: string[], input?: string): Buffer {
  return execFileSync("git", args, {
    cwd,
    input,
    maxBuffer: MAX_BYTES,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

export function scanRepository(options: {
  cwd: string;
  history?: boolean;
  stagedOnly?: boolean;
  secretsFile?: string;
}) {
  const root = git(options.cwd, ["rev-parse", "--show-toplevel"])
    .toString("utf8")
    .trim();
  const values = options.secretsFile
    ? [
        ...new Set(
          Object.entries(parse(readFileSync(options.secretsFile)))
            .filter(
              ([name, value]) =>
                secretName.test(name) &&
                value.length >= 8 &&
                !placeholder.test(value),
            )
            .map(([, value]) => value),
        ),
      ]
    : [];
  const findings: Finding[] = [];
  let files = 0;
  let indexBlobs = 0;
  let historyBlobs = 0;
  const inspect = (data: Buffer, file: string, location: string) => {
    const rule = artifactRule(file);
    if (rule)
      findings.push({ location: redactLocation(location, values), rule });
    if (data.length > MAX_BYTES) {
      findings.push({
        location: redactLocation(location, values),
        rule: "file-exceeds-scan-limit",
      });
      return;
    }
    findings.push(...scanText(data.toString("utf8"), location, values));
  };
  if (!options.stagedOnly) {
    const candidates = git(root, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ])
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    for (const file of new Set(candidates)) {
      const target = path.join(root, file);
      let stat;
      try {
        stat = lstatSync(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; // Staged deletion is still checked in history.
        throw error;
      }
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      if (stat.size > MAX_BYTES) {
        findings.push({
          location: redactLocation(`worktree:${file}`, values),
          rule: "file-exceeds-scan-limit",
        });
        continue;
      }
      inspect(
        stat.isSymbolicLink()
          ? Buffer.from(readlinkSync(target))
          : readFileSync(target),
        file,
        `worktree:${file}`,
      );
      files++;
    }
  }
  const checkedBlobs = new Set<string>();
  const staged = git(root, ["ls-files", "--stage", "-z"])
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  for (const entry of staged) {
    const match = /^(\d+) ([a-f\d]+) (\d)\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error("invalid_git_index");
    const [, mode, oid, stage, file] = match;
    if (mode === "160000") {
      findings.push({
        location: redactLocation(`index:${file}`, values),
        rule: "submodule-not-scanned",
      });
      continue;
    }
    inspect(
      git(root, ["cat-file", "blob", oid]),
      file,
      `index:${file} (stage ${stage})`,
    );
    checkedBlobs.add(oid);
    indexBlobs++;
  }
  if (options.history) {
    const objects = git(root, ["rev-list", "--objects", "--all", "--reflog"])
      .toString("utf8")
      .trim();
    const paths = new Map<string, string>();
    for (const line of objects ? objects.split("\n") : []) {
      const space = line.indexOf(" ");
      paths.set(
        space < 0 ? line : line.slice(0, space),
        space < 0 ? "(unnamed object)" : line.slice(space + 1),
      );
    }
    if (paths.size) {
      const metadata = git(
        root,
        ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
        [...paths.keys()].join("\n") + "\n",
      ).toString("utf8");
      for (const line of metadata.trim().split("\n")) {
        const [oid, type, size] = line.split(" ");
        if (type !== "blob" || checkedBlobs.has(oid)) continue;
        const file = paths.get(oid)!;
        const location = `history:${oid.slice(0, 12)}:${file}`;
        if (Number(size) > MAX_BYTES)
          findings.push({
            location: redactLocation(location, values),
            rule: "file-exceeds-scan-limit",
          });
        else inspect(git(root, ["cat-file", "blob", oid]), file, location);
        historyBlobs++;
      }
    }
  }
  return {
    findings,
    files,
    indexBlobs,
    historyBlobs,
    historyRequested: !!options.history,
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "Usage: npm run secret-scan -- [--history] [--staged] [--secrets-file /private/path/.env]\nDefault: scan tracked and non-ignored untracked files plus every index blob.\n--history also scans blobs reachable from all local refs and reflogs.\n--staged scans only the index (plus history if requested). Configured secret values stay in memory.\nThe scan is local and makes no network requests. A pass is not proof that every possible secret or private artifact is absent.",
    );
    return;
  }
  let secretsFile: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--secrets-file") {
      secretsFile = args[++i];
      if (!secretsFile || secretsFile.startsWith("--"))
        throw new Error("missing_secrets_file");
    } else if (!["--history", "--staged"].includes(args[i]))
      throw new Error("unknown_option");
  }
  const result = scanRepository({
    cwd: process.cwd(),
    history: args.includes("--history"),
    stagedOnly: args.includes("--staged"),
    secretsFile,
  });
  for (const finding of result.findings)
    console.log(
      `FAIL ${finding.location}${finding.line ? `:${finding.line}` : ""} [${finding.rule}]`,
    );
  console.log(
    `${result.findings.length ? "FAIL" : "PASS"}: ${result.files} working files, ${result.indexBlobs} index blobs, ${result.historyBlobs} additional history blobs; ${result.historyRequested ? "history included" : "history not requested"}.`,
  );
  if (result.findings.length) process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch {
    console.error(
      "FAIL: secret scan could not complete. Check Git access, file permissions, size limits, and command options. No secret values were printed.",
    );
    process.exitCode = 2;
  }
}
