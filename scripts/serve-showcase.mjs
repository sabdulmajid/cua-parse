import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import { URL } from "node:url";
import path from "node:path";
const directory = path.resolve(".site");
const port = Number(process.env.SHOWCASE_PORT || 3310);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid SHOWCASE_PORT.");
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".mp4": "video/mp4",
  ".vtt": "text/vtt; charset=utf-8",
};
const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(
      new URL(req.url, "http://127.0.0.1").pathname,
    );
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (pathname === "/") {
    res.writeHead(302, { Location: "/cua-parse/" }).end();
    return;
  }
  if (!pathname.startsWith("/cua-parse/")) {
    res.writeHead(404).end();
    return;
  }
  const requested = pathname.slice("/cua-parse/".length) || "index.html";
  const file = path.resolve(directory, requested);
  if (
    !file.startsWith(directory + path.sep) ||
    !existsSync(file) ||
    !statSync(file).isFile()
  ) {
    res.writeHead(404).end();
    return;
  }
  const size = statSync(file).size;
  const headers = {
    "Content-Type": types[path.extname(file)] || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Accept-Ranges": "bytes",
  };
  const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
  if (range) {
    const start = Number(range[1]),
      end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
      return;
    }
    res.writeHead(206, {
      ...headers,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": end - start + 1,
    });
    if (req.method === "HEAD") res.end();
    else createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, "Content-Length": size });
    if (req.method === "HEAD") res.end();
    else createReadStream(file).pipe(res);
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Showcase preview: http://127.0.0.1:${port}/cua-parse/`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => server.close());
