/**
 * Le strict nécessaire pour parler à Docker : on appelle la CLI, on ne
 * réimplémente rien. Si DBox disparaît, ces commandes restent tapables à la main.
 */

import { spawn } from "node:child_process";
import type { Probe } from "./health.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  /** Reçoit chaque ligne des deux flux, pour un journal en direct. */
  onLine?: (line: string) => void;
  /** Fusionné à l'environnement du daemon — jamais un remplacement complet. */
  env?: Record<string, string>;
  /** Tue le processus après ce délai et résout en échec. Pour une commande qui
   * doit finir en temps borné (la sonde headscale) : un conteneur bloqué ne
   * doit pas faire pendre `up()` indéfiniment. */
  timeoutMs?: number;
}

export function run(file: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const env = options.env === undefined ? undefined : { ...process.env, ...options.env };
    const child = spawn(file, args, { cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    const minuterie =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            stderr += `\n(délai de ${options.timeoutMs} ms dépassé, processus tué)`;
            child.kill("SIGKILL");
          }, options.timeoutMs);
    const finir = (result: RunResult) => {
      if (minuterie !== undefined) clearTimeout(minuterie);
      resolve(result);
    };

    const collect = (stream: NodeJS.ReadableStream, append: (chunk: string) => void) => {
      let pending = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        append(chunk);
        if (options.onLine === undefined) return;
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) options.onLine(line);
      });
      stream.on("end", () => {
        if (pending !== "" && options.onLine !== undefined) options.onLine(pending);
      });
    };

    collect(child.stdout, (chunk) => (stdout += chunk));
    collect(child.stderr, (chunk) => (stderr += chunk));

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (minuterie !== undefined) clearTimeout(minuterie);
      reject(
        error.code === "ENOENT"
          ? new Error(`« ${file} » est introuvable — Docker est-il installé sur cette machine ?`)
          : error,
      );
    });
    child.on("close", (code) => finir({ code: code ?? -1, stdout, stderr }));
  });
}

/** Un appel `docker compose` cadré sur le dossier généré d'une cible. */
export type Compose = (directory: string, args: string[]) => Promise<RunResult>;

export function composeRunner(onLine?: (line: string) => void): Compose {
  return (directory, args) =>
    run("docker", ["compose", "--project-directory", directory, ...args], { cwd: directory, onLine });
}

/**
 * La sonde de santé d'une cible Headscale.
 *
 * Le daemon ne peut pas joindre le nœud Headscale par le réseau : son propre
 * sidecar est sur **Tailscale**, et les deux partagent le préfixe 100.64.0.0/10
 * — une IP overlay Headscale n'a donc aucune route depuis le daemon. On sonde
 * donc **depuis l'intérieur du netns du sidecar de la cible** : `docker run
 * --network container:<sidecar>` partage sa pile réseau, où Caddy écoute sur
 * `:443`. La sonde interroge `127.0.0.1` avec le nom en SNI (voir le
 * sous-commande `__probe`, qui réutilise `pinnedHttpProbe`) — ça valide toute
 * la chaîne app + Caddy + certificat, prouvé en vrai contre le témoin.
 *
 * `image` est l'image du daemon lui-même (son entrypoint est `node
 * .../cli.ts`), posée par `--probe-image` : elle embarque le code et Node, rien
 * à télécharger. Un échec de `docker run` (sidecar pas encore là, Caddy muet)
 * rend « injoignable » et la boucle d'attente réessaie, comme pour le certificat.
 * `exec` injectable pour le test.
 */
export function headscaleProbe(
  project: string,
  image: string,
  // Délai de garde plus long que celui de `__probe` lui-même (10 s) : on le
  // laisse d'abord se terminer proprement ; ce plafond ne sert que si le
  // conteneur-sonde lui-même se bloque. Sans lui, un conteneur figé pendrait `up()`.
  exec: (file: string, args: string[]) => Promise<RunResult> = (file, args) => run(file, args, { timeoutMs: 20_000 }),
): Probe {
  return async (url) => {
    const res = await exec("docker", [
      "run",
      "--rm",
      "--network",
      `container:${project}-tailscale-1`,
      image,
      "__probe",
      url,
    ]);
    const out = res.stdout.trim();
    return /^\d+$/.test(out) ? Number(out) : null;
  };
}
