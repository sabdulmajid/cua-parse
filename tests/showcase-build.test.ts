import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import demo from "../showcase/data/demo.json";
const script = path.resolve("scripts/build-showcase.mjs");
const roots: string[] = [];
function project() {
  const root = mkdtempSync(path.join(tmpdir(), "cua-showcase-build-"));
  roots.push(root);
  for (const name of [
    "index.html",
    "styles.css",
    "app.js",
    "render.js",
    "data/demo.json",
    "assets/walkthrough.mp4",
    "assets/poster.webp",
    "assets/captions.vtt",
  ]) {
    const file = path.join(root, "showcase", name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      name === "data/demo.json"
        ? JSON.stringify(demo)
        : "public synthetic test asset",
    );
  }
  return root;
}
function build(root: string) {
  return execFileSync(process.execPath, [script], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
describe("public artifact boundary", () => {
  it("copies the public directory without sibling runtime files", () => {
    const root = project();
    writeFileSync(path.join(root, ".env"), "SENTINEL=private-runtime");
    mkdirSync(path.join(root, ".local"));
    writeFileSync(path.join(root, ".local", "app.db"), "private-runtime");
    expect(build(root)).toContain("public assets");
    expect(existsSync(path.join(root, ".site", ".nojekyll"))).toBe(true);
    expect(existsSync(path.join(root, ".site", ".env"))).toBe(false);
    expect(existsSync(path.join(root, ".site", ".local"))).toBe(false);
    expect(
      JSON.parse(
        readFileSync(path.join(root, ".site", "data/demo.json"), "utf8"),
      ),
    ).toEqual(demo);
  });
  it("rejects a link to a private file inside the public directory", () => {
    const root = project();
    writeFileSync(path.join(root, "private.txt"), "private");
    symlinkSync(
      path.join(root, "private.txt"),
      path.join(root, "showcase", "leak.txt"),
    );
    expect(() => build(root)).toThrow();
    expect(existsSync(path.join(root, ".site"))).toBe(false);
  });
  it("rejects hidden files and databases in the public directory", () => {
    for (const file of [".env", "app.db"]) {
      const root = project();
      writeFileSync(path.join(root, "showcase", file), "private");
      expect(() => build(root)).toThrow();
    }
  });
  it("rejects a source that is not a synthetic fixture despite a synthetic manifest", () => {
    const root = project();
    const altered = structuredClone(demo);
    altered.states.overview.evidence[0].source = "import";
    writeFileSync(
      path.join(root, "showcase/data/demo.json"),
      JSON.stringify(altered),
    );
    expect(() => build(root)).toThrow();
  });
  it("rejects runtime identities in exported data", () => {
    const root = project();
    const altered = { ...demo, sessionId: "test-session" };
    writeFileSync(
      path.join(root, "showcase/data/demo.json"),
      JSON.stringify(altered),
    );
    expect(() => build(root)).toThrow();
  });
  it("requires the recording and captions before publication", () => {
    const root = project();
    rmSync(path.join(root, "showcase/assets/captions.vtt"));
    expect(() => build(root)).toThrow();
  });
});
