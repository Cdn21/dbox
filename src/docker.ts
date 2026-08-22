/**
 * Le strict nécessaire pour parler à Docker : on appelle la CLI, on ne
 * réimplémente rien. Si DBox disparaît, ces commandes restent tapables à la main.
 */

import { spawn } from "node:child_process";

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
}

export function run(file: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const env = options.env === undefined ? undefined : { ...process.env, ...options.env };
    const child = spawn(file, args, { cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

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
      reject(
        error.code === "ENOENT"
          ? new Error(`« ${file} » est introuvable — Docker est-il installé sur cette machine ?`)
          : error,
      );
    });
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** Un appel `docker compose` cadré sur le dossier généré d'une cible. */
export type Compose = (directory: string, args: string[]) => Promise<RunResult>;

export function composeRunner(onLine?: (line: string) => void): Compose {
  return (directory, args) =>
    run("docker", ["compose", "--project-directory", directory, ...args], { cwd: directory, onLine });
}
