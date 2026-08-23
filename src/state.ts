/**
 * Ce qui est déployé, écrit à côté des fichiers générés.
 *
 * Un simple JSON lisible plutôt qu'une base : c'est la seule chose que DBox
 * sait et que Docker ne sait pas — quelle version remettre en place si la
 * suivante échoue.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { State } from "./up.ts";

const FILE = "state.json";

export async function readState(directory: string): Promise<State | null> {
  try {
    const raw = await readFile(`${directory}/${FILE}`, "utf8");
    const parsed = JSON.parse(raw) as Partial<State>;
    if (typeof parsed.tag !== "string") return null;
    return {
      tag: parsed.tag,
      previousTag: typeof parsed.previousTag === "string" ? parsed.previousTag : null,
      deployedAt: typeof parsed.deployedAt === "string" ? parsed.deployedAt : "",
    };
  } catch {
    // Absent ou illisible : on se comporte comme un premier déploiement, ce qui
    // désactive seulement le retour arrière.
    return null;
  }
}

export async function writeState(directory: string, state: State): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/${FILE}`, JSON.stringify(state, null, 2) + "\n");
}
