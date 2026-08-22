/**
 * Le registre des apps.
 *
 * Il n'y a pas de base de données : **le système de fichiers est le registre**.
 * Une cible existe parce que son dossier existe, avec son `dbox.json` (qui elle
 * est) et son `state.json` (ce qui tourne). Rien à synchroniser, rien qui puisse
 * mentir — et si DBox disparaît, l'inventaire reste lisible avec `ls` et `cat`.
 *
 * Les fonctions pures (analyse, résumé) sont séparées de la lecture du disque
 * et de l'appel à Docker, pour rester testables sans ni l'un ni l'autre.
 */

import { readdir, readFile } from "node:fs/promises";
import type { Descriptor } from "./plan.ts";
import type { State } from "./up.ts";

export type Status = "en marche" | "partielle" | "arrêtée" | "redémarre" | "jamais démarrée";

export interface Container {
  name: string;
  state: string;
}

export interface Entry {
  descriptor: Descriptor;
  state: State | null;
  status: Status;
  containers: Container[];
  directory: string;
}

/** Le format demandé à `docker ps`, séparé pour que le test parle du même. */
export const PS_FORMAT = '{{.Label "com.docker.compose.project"}}|{{.Names}}|{{.State}}';

export const PS_ARGS = ["ps", "--all", "--format", PS_FORMAT];

export function parseContainers(output: string): Map<string, Container[]> {
  const byProject = new Map<string, Container[]>();

  for (const line of output.split("\n")) {
    const [project, name, state] = line.trim().split("|");
    if (project === undefined || project === "" || name === undefined || state === undefined) continue;
    const list = byProject.get(project) ?? [];
    list.push({ name, state });
    byProject.set(project, list);
  }

  return byProject;
}

export function statusOf(containers: Container[]): Status {
  if (containers.length === 0) return "jamais démarrée";
  // Un conteneur qui redémarre en boucle mérite d'être signalé comme tel :
  // c'est le symptôme du sidecar qui n'arrive pas à rejoindre le tailnet.
  if (containers.some((c) => c.state === "restarting")) return "redémarre";

  const running = containers.filter((c) => c.state === "running").length;
  if (running === containers.length) return "en marche";
  if (running === 0) return "arrêtée";
  return "partielle";
}

/**
 * Balaie `<root>/<app>/<cible>/`. Un dossier sans `dbox.json` est ignoré en
 * silence : ce n'est pas une cible DBox, ce n'est pas une erreur.
 */
export async function scan(root: string, listContainers: () => Promise<string>): Promise<Entry[]> {
  const byProject = parseContainers(await listContainers());
  const entries: Entry[] = [];

  for (const app of await subdirectories(root)) {
    for (const target of await subdirectories(`${root}/${app}`)) {
      const directory = `${root}/${app}/${target}`;
      const descriptor = await readJson<Descriptor>(`${directory}/dbox.json`);
      if (descriptor === null) continue;

      const containers = byProject.get(descriptor.project) ?? [];
      entries.push({
        descriptor,
        state: await readJson<State>(`${directory}/state.json`),
        status: statusOf(containers),
        containers,
        directory,
      });
    }
  }

  entries.sort((a, b) =>
    `${a.descriptor.app}/${a.descriptor.target}`.localeCompare(`${b.descriptor.app}/${b.descriptor.target}`),
  );
  return entries;
}

async function subdirectories(path: string): Promise<string[]> {
  try {
    const found = await readdir(path, { withFileTypes: true });
    return found.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** « il y a 12 min », en version courte pour une colonne de tableau. */
export function since(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";

  const minutes = Math.floor((now - then) / 60_000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `${minutes} min`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;

  const days = Math.floor(hours / 24);
  return `${days} j`;
}
