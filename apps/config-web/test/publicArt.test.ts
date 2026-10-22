import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { isPublicArtPath } from "../src/publicArt.js";
import { requireSession } from "../src/auth/requireSession.js";

const get = (): IncomingMessage =>
  ({ headers: {}, socket: { remoteAddress: "10.0.0.9" }, method: "GET" }) as unknown as IncomingMessage;

describe("public team-builder art routes", () => {
  it("matches only generated art under /sprites, /crests and /icons", () => {
    for (const ok of [
      "/sprites/manifest.json",
      "/sprites/amazon/eaglewarrior.png",
      "/sprites/stars/grak.png",
      "/crests/amazon.png",
      "/crests/manifest.json",
      "/icons/inducements/bribe.png",
    ]) expect(isPublicArtPath(ok)).toBe(true);
    for (const bad of [
      "/sprites/../team-builder.js",
      "/sprites/%2e%2e/admin.js",
      "/sprites/amazon/..",
      "/sprites/amazon/x.js",
      "/sprites/README.md",
      "/sprites//x.png",
      "/sprites/Amazon/x.png",
      "/crests/x.png/",
      "/admin.js",
      "/spritesx/a.png",
    ]) expect(isPublicArtPath(bad)).toBe(false);
  });

  it("is reachable without a session under the auth sidecar, and wired into the static allow-list", () => {
    expect(requireSession(get(), "/sprites/amazon/eaglewarrior.png", "").kind).toBe("allow");
    expect(requireSession(get(), "/icons/inducements/bribe.png", "").kind).toBe("allow");
    expect(requireSession(get(), "/sprites/../users.html", "").kind).not.toBe("allow");
    const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    expect(server).toContain("isPublicArtPath(pathname) ||");
    expect(server).toContain('".png": "image/png"');
  });

  it("ships the generated manifests and every file they reference", () => {
    const pub = new URL("../public/", import.meta.url);
    for (const [manifest, key] of [["sprites/manifest.json", "races"], ["crests/manifest.json", "crests"], ["icons/inducements/manifest.json", "icons"]] as const) {
      const doc = JSON.parse(readFileSync(new URL(manifest, pub), "utf8"));
      const values: string[] = key === "races"
        ? Object.values(doc.races as Record<string, Record<string, string>>).flatMap((roles) => Object.values(roles))
        : Object.values(doc[key] as Record<string, string>);
      expect(values.length).toBeGreaterThan(10);
      for (const path of values) {
        expect(isPublicArtPath(`/${path}`)).toBe(true);
        expect(existsSync(new URL(path, pub))).toBe(true);
      }
      expect(doc.source.commit).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});
