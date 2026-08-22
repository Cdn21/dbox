/**
 * D'où viennent les sources d'une app.
 *
 * Un dépôt git cloné sur la machine, et rien de plus : pas de cache, pas de
 * miroir, pas de format intermédiaire. `git clone` puis `git pull`, exactement
 * ce qu'on taperait — et si DBox disparaît, le dossier reste un dépôt normal.
 */

import { run, type RunResult } from "./docker.ts";
import { nameFromDirectory } from "./init.ts";
import { gitSshCommand } from "./sshkey.ts";

/** `undefined` : on laisse git faire, avec `~/.ssh` tel qu'il est monté. */
function sshEnv(sshKeyFile: string | undefined): { env?: Record<string, string> } {
  return sshKeyFile === undefined ? {} : { env: { GIT_SSH_COMMAND: gitSshCommand(sshKeyFile) } };
}

/**
 * Déduit le nom de l'app de l'URL du dépôt.
 *
 * `git@github.com:Cdn21/budgetApp.git` → `budgetapp`. Le nom passe par le même
 * rabotage que celui d'un dossier : c'est un nom de machine sur le tailnet, pas
 * un nom de dépôt.
 */
export function nameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  // Une URL SSH courte (`git@hôte:chemin`) n'a pas de « / » après l'hôte.
  const afterColon = trimmed.includes("://") ? trimmed : trimmed.split(":").pop() ?? trimmed;
  const last = afterColon.split("/").pop() ?? "";
  return nameFromDirectory(last);
}

export function clone(url: string, directory: string, sshKeyFile?: string): Promise<RunResult> {
  return run("git", ["clone", "--", url, directory], sshEnv(sshKeyFile));
}

export function pull(directory: string, sshKeyFile?: string): Promise<RunResult> {
  // `--ff-only` : on refuse de fusionner. Un dépôt de déploiement qui diverge
  // est une anomalie à regarder, pas à résoudre automatiquement.
  return run("git", ["-C", directory, "pull", "--ff-only"], sshEnv(sshKeyFile));
}

export async function isGitRepo(directory: string): Promise<boolean> {
  const result = await run("git", ["-C", directory, "rev-parse", "--git-dir"]).catch(() => null);
  return result !== null && result.code === 0;
}

export type UpstreamCheck =
  | { ok: true; changed: boolean }
  | { ok: false; detail: string };

/**
 * Y a-t-il du nouveau en amont ? Sans jamais fusionner : un `fetch`, puis une
 * comparaison de commits. C'est tout ce que le sondage automatique a besoin
 * de savoir avant de décider de redéployer.
 */
export async function checkUpstream(directory: string, sshKeyFile?: string): Promise<UpstreamCheck> {
  const fetched = await run("git", ["-C", directory, "fetch", "--quiet"], sshEnv(sshKeyFile));
  if (fetched.code !== 0) return { ok: false, detail: fetched.stderr || fetched.stdout };

  const upstream = await run("git", ["-C", directory, "rev-parse", "@{u}"]);
  if (upstream.code !== 0) {
    return { ok: false, detail: "aucune branche amont : git branch --set-upstream-to=origin/<branche>" };
  }

  const head = await run("git", ["-C", directory, "rev-parse", "HEAD"]);
  return { ok: true, changed: head.stdout.trim() !== upstream.stdout.trim() };
}
