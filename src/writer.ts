/**
 * Matérialisation d'un plan sur le disque.
 *
 * Un fichier marqué `preserveIfExists` n'est écrit qu'une fois : son contenu
 * généré est une amorce que l'utilisateur remplit. Réécrire `ts.env` à chaque
 * déploiement effacerait la clé d'authentification, et `.env` les secrets.
 */

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PlannedFile } from "./plan.ts";

export interface WriteOutcome {
  path: string;
  /** `false` quand le fichier existait déjà et devait être préservé. */
  written: boolean;
}

export async function writeFiles(files: PlannedFile[]): Promise<WriteOutcome[]> {
  const outcomes: WriteOutcome[] = [];

  for (const file of files) {
    if (file.preserveIfExists === true && (await exists(file.path))) {
      outcomes.push({ path: file.path, written: false });
      continue;
    }
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content, { mode: file.mode ?? 0o644 });
    outcomes.push({ path: file.path, written: true });
  }

  return outcomes;
}

/**
 * Sème la clé d'auth dans un `ts.env` qui vient d'être créé.
 *
 * Elle est posée **après** l'écriture, jamais dans le plan : `dbox plan`
 * affiche le contenu des fichiers, et une clé n'a rien à faire dans une sortie
 * de terminal. Un `ts.env` préexistant n'est pas touché — c'est la règle qui
 * protège les clés déjà en place.
 */
export async function seedAuthKey(
  outcomes: WriteOutcome[],
  keyFile: string | undefined,
): Promise<string | null> {
  if (keyFile === undefined) return null;

  const created = outcomes.find((outcome) => outcome.written && outcome.path.endsWith("/ts.env"));
  if (created === undefined) return null;

  let key: string;
  try {
    key = (await readFile(keyFile, "utf8")).trim();
  } catch {
    return null;
  }
  if (key === "") return null;

  await writeFile(created.path, `TS_AUTHKEY=${key}\n`, { mode: 0o600 });
  return created.path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
