// A static server that serves one typed site the way Spot does (docs/site-types.md, "Serving on a typed
// site's origin"): the package's index.html at /, its other files under /_type/ with the strong ETag
// "<version>-<sha256>" and `private, no-cache`, and every other path from the site's own data with
// `no-store`. /api/probe records a hit and answers 204, so payload decks can report a request.
//
//   node checks/serve.mjs <site-dir> [--package slides] [--port 8765]

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};
const NOT_SERVED = new Set(["type.json", "SKILL.md"]);

// The site-host request check from the path contract; null means 400.
function requestPath(rawUrl) {
  const raw = rawUrl.split("?")[0];
  if (/%2f|%5c/i.test(raw)) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!decoded.startsWith("/") || decoded.includes("\\") || /[\u0000-\u001f\u007f]/.test(decoded)) return null;
  const segments = decoded.slice(1).split("/");
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment === "." || segment === "..") return null;
    if (segment === "" && i !== segments.length - 1) return null;
  }
  return decoded;
}

async function readFileIfPresent(file) {
  try {
    if (!(await stat(file)).isFile()) return null;
    return await readFile(file);
  } catch {
    return null;
  }
}

function etagMatches(header, etag) {
  if (!header) return false;
  return header.split(",").some((tag) => {
    const value = tag.trim();
    return value === "*" || value.replace(/^W\//, "") === etag;
  });
}

export async function serveSite({ packageDir, dataDir, host = "127.0.0.1", port = 0, log = () => {} }) {
  const manifest = JSON.parse(await readFile(path.join(packageDir, "type.json"), "utf8"));
  const version = String(manifest.version).replace(/\+.*$/, "");
  const hashes = new Map();
  const probes = [];

  const send = (req, res, status, headers, body) => {
    res.writeHead(status, headers);
    res.end(req.method === "HEAD" ? undefined : body);
    log({ method: req.method, path: req.url, status });
  };

  const serveTypeFile = async (req, res, rel) => {
    const bytes = await readFileIfPresent(path.join(packageDir, rel));
    if (!bytes) return send(req, res, 404, { "Content-Type": "text/plain" }, "404 page not found\n");
    if (!hashes.has(rel)) hashes.set(rel, createHash("sha256").update(bytes).digest("hex"));
    const etag = `"${version}-${hashes.get(rel)}"`;
    const headers = { ETag: etag, "Cache-Control": "private, no-cache" };
    if (etagMatches(req.headers["if-none-match"], etag)) return send(req, res, 304, headers);
    headers["Content-Type"] = CONTENT_TYPES[path.extname(rel).toLowerCase()] || "application/octet-stream";
    return send(req, res, 200, headers, bytes);
  };

  const server = createServer(async (req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") return send(req, res, 405, { Allow: "GET, HEAD" }, "");
      const decoded = requestPath(req.url);
      if (decoded === null) return send(req, res, 400, { "Content-Type": "text/plain" }, "bad path\n");
      if (decoded === "/" || decoded === "/index.html") return await serveTypeFile(req, res, "index.html");
      if (decoded === "/_type" || decoded.startsWith("/_type/")) {
        const rel = decoded.slice("/_type/".length);
        if (!rel || rel.endsWith("/") || NOT_SERVED.has(rel)) return send(req, res, 404, { "Content-Type": "text/plain" }, "404 page not found\n");
        return await serveTypeFile(req, res, rel);
      }
      if (decoded === "/api/probe") {
        probes.push(req.url);
        return send(req, res, 204, { "Cache-Control": "no-store" });
      }
      if (decoded.startsWith("/api/")) return send(req, res, 404, { "Content-Type": "text/plain" }, "404 page not found\n");
      const rel = decoded.slice(1) + (decoded.endsWith("/") ? "index.html" : "");
      const bytes = await readFileIfPresent(path.join(dataDir, rel));
      if (!bytes) return send(req, res, 404, { "Content-Type": "text/plain", "Cache-Control": "no-store" }, "404 page not found\n");
      return send(req, res, 200, {
        "Content-Type": CONTENT_TYPES[path.extname(rel).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store",
      }, bytes);
    } catch (error) {
      send(req, res, 500, { "Content-Type": "text/plain" }, `${error?.message || error}\n`);
    }
  });
  await new Promise((resolve) => server.listen(port, host, resolve));
  return {
    url: `http://${host}:${server.address().port}`,
    version,
    probes,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const at = args.indexOf(name);
    return at >= 0 ? args.splice(at, 2)[1] : fallback;
  };
  const packageDir = path.resolve(option("--package", path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "slides")));
  const port = Number(option("--port", "8765"));
  const dataDir = args[0];
  if (!dataDir) {
    console.error("usage: node checks/serve.mjs <site-dir> [--package slides] [--port 8765]");
    process.exit(2);
  }
  const site = await serveSite({ packageDir, dataDir: path.resolve(dataDir), port, log: ({ method, path: url, status }) => console.log(status, method, url) });
  console.log(`${path.basename(packageDir)} ${site.version} serving ${path.resolve(dataDir)} at ${site.url}/ (check mode: ${site.url}/?check=1)`);
}
