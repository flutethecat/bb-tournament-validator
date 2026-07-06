/**
 * Config pane HTTP server — zero framework (Node built-in http), so it hosts
 * anywhere Node runs. Serves the static wizard (public/) + a small JSON API.
 *
 * Binds to 127.0.0.1 by default. To expose it, set HOST=0.0.0.0 AND ADMIN_PASSWORD
 * (Basic auth). Over a public network put it behind TLS — Basic auth is plaintext.
 */

import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TournamentPackage } from "@bb/validator";
import { PackageFiles, readCoaches, skillCatalog } from "./data";
import { PRESETS } from "./presets";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = resolve(HERE, "../public");
const PORT = Number(process.env.PORT ?? 4310);
const HOST = process.env.HOST ?? "127.0.0.1";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
const PACKAGES_DIR = resolve(process.env.PACKAGES_DIR || join(HERE, "../../../tournament-packages"));
const VALIDATED_CSV = resolve(
  process.env.VALIDATED_CSV || join(HERE, "../../discord-bot/data-store/validated-rosters.csv"),
);

const packages = new PackageFiles(PACKAGES_DIR);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
};

function authorized(req: IncomingMessage): boolean {
  if (!ADMIN_PASSWORD) return true; // open when no password set (localhost default)
  const header = req.headers.authorization ?? "";
  const m = header.match(/^Basic (.+)$/);
  if (!m) return false;
  const decoded = Buffer.from(m[1]!, "base64").toString("utf8");
  const password = decoded.slice(decoded.indexOf(":") + 1);
  return password === ADMIN_PASSWORD;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

async function serveStatic(res: ServerResponse, urlPath: string): Promise<void> {
  const rel = urlPath === "/" ? "/index.html" : urlPath;
  // prevent path traversal
  const full = normalize(join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const buf = await readFile(full);
    res.writeHead(200, { "content-type": MIME[extname(full)] ?? "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404).end("not found");
  }
}

async function handleApi(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<void> {
  const method = req.method ?? "GET";

  if (path === "/api/skills" && method === "GET") return sendJson(res, 200, skillCatalog());

  if (path === "/api/presets" && method === "GET")
    return sendJson(res, 200, PRESETS.map((p) => ({ id: p.id, label: p.label, pkg: p.pkg })));

  if (path === "/api/packages" && method === "GET") return sendJson(res, 200, packages.list());

  if (path === "/api/packages" && method === "POST") {
    const body = (await readBody(req)) as Partial<TournamentPackage>;
    if (!body || typeof body.name !== "string" || !body.name.trim())
      return sendJson(res, 400, { error: "A package name is required." });
    const { path: filePath, pkg, problems } = packages.save(body);
    return sendJson(res, 200, { ok: true, savedAs: filePath, name: pkg.name, problems });
  }

  const pkgMatch = path.match(/^\/api\/packages\/(.+)$/);
  if (pkgMatch && method === "GET") {
    const found = packages.get(decodeURIComponent(pkgMatch[1]!));
    if (!found) return sendJson(res, 404, { error: "Package not found." });
    return sendJson(res, 200, { pkg: found.pkg, problems: found.problems });
  }

  if (path === "/api/coaches" && method === "GET") {
    const pkg = query.get("package") ?? undefined;
    return sendJson(res, 200, readCoaches(VALIDATED_CSV, pkg));
  }

  sendJson(res, 404, { error: "Unknown endpoint." });
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      if (!authorized(req)) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="BB Config"' }).end("auth required");
        return;
      }
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url.pathname, url.searchParams);
      await serveStatic(res, url.pathname);
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
  })();
});

server.listen(PORT, HOST, () => {
  console.log(`Config pane on http://${HOST}:${PORT}`);
  console.log(`  packages : ${PACKAGES_DIR}`);
  console.log(`  coaches  : ${VALIDATED_CSV}`);
  console.log(`  auth     : ${ADMIN_PASSWORD ? "password required" : "OPEN (set ADMIN_PASSWORD to lock)"}`);
});
