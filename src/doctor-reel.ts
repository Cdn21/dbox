/**
 * Les effets réels du diagnostic (`doctor.ts`), partagés par la CLI et le
 * daemon. Tous en lecture seule, tous bornés dans le temps : un diagnostic qui
 * reste bloqué sur un réseau absent ne dirait rien de plus qu'un délai.
 */

import { constants } from "node:fs";
import { access, readFile, stat, statfs } from "node:fs/promises";
import { lookup, Resolver } from "node:dns/promises";
import { run } from "./docker.ts";
import type { DoctorDeps } from "./doctor.ts";
import { listDescriptors } from "./registry.ts";

type Effets = Pick<
  DoctorDeps,
  "docker" | "readFile" | "permissions" | "ecrivable" | "espaceLibre" | "magicDns" | "cibles" | "probe" | "resoudre" | "now"
>;

export function effetsReels(root: string): Effets {
  return {
    docker: async () => {
      const r = await run("docker", ["version", "--format", "{{.Server.Version}}"]).catch((e: Error) => ({
        code: -1,
        stdout: "",
        stderr: e.message,
      }));
      return r.code === 0
        ? { ok: true, detail: r.stdout.trim() === "" ? "Docker" : `Docker ${r.stdout.trim()}` }
        : { ok: false, detail: (r.stderr || r.stdout).trim().split("\n").pop() || "docker ne répond pas" };
    },
    readFile: (path) => readFile(path, "utf8"),
    permissions: async (path) => {
      const info = await stat(path).catch(() => null);
      return info === null ? null : info.mode & 0o777;
    },
    ecrivable: (dir) =>
      access(dir, constants.W_OK).then(
        () => true,
        () => false,
      ),
    espaceLibre: async (dir) => {
      const s = await statfs(dir).catch(() => null);
      return s === null ? null : s.bavail * s.bsize;
    },
    // Une réponse quelconque — même « ce nom n'existe pas » — prouve que
    // 100.100.100.100 est joignable, donc que la machine est sur le tailnet.
    // Seuls un délai dépassé ou un refus disent le contraire.
    magicDns: async (tailnet) => {
      const resolveur = new Resolver({ timeout: 1500, tries: 1 });
      resolveur.setServers(["100.100.100.100"]);
      try {
        await resolveur.resolve4(tailnet);
        return true;
      } catch (error) {
        const code = (error as { code?: string }).code;
        return code !== "ETIMEOUT" && code !== "ECONNREFUSED" && code !== "ECANCELLED";
      }
    },
    cibles: async () =>
      (await listDescriptors(root)).map((d) => ({ label: `${d.app} · ${d.target}`, url: d.url })),
    // Toute réponse HTTP prouve que le TLS a abouti ; seul le silence compte.
    probe: async (url) => {
      try {
        const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
        return r.status;
      } catch {
        return null;
      }
    },
    resoudre: (hote) =>
      lookup(hote).then(
        () => true,
        () => false,
      ),
    now: Date.now,
  };
}
