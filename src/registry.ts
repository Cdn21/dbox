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
import { isLabel } from "./manifest.ts";
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
 * Un `dbox.json` écrit par une version antérieure n'a pas les champs ajoutés
 * depuis — quatre apps sur `serve` sont dans ce cas au moment où ces lignes
 * sont écrites. Sans ce complément, le type promettrait un tableau là où il
 * n'y a rien, et le premier `.map()` planterait le tableau de bord sur un
 * dossier ancien. Le fichier sur le disque n'est pas réécrit pour autant :
 * il le sera au prochain déploiement, par le plan.
 */
function complete(descriptor: Descriptor): Descriptor {
  return {
    ...descriptor,
    services: descriptor.services ?? [],
    publicDomain: descriptor.publicDomain ?? null,
    // Un dbox.json écrit avant le backend headscale n'a pas ce champ : il
    // décrit forcément une cible Tailscale, le seul backend d'alors.
    backend: descriptor.backend ?? "tailscale",
  };
}

/**
 * Un `dbox.json` est relu depuis le disque : on ne croit pas ce qu'il annonce.
 * DBox n'en écrit qu'à partir d'un manifeste validé, donc son app et sa cible
 * sont des labels DNS, et ce sont les noms des dossiers qui le contiennent.
 * Une entrée qui ne remplit pas ces deux conditions n'a pas été écrite par
 * DBox : elle est écartée, jamais affichée. Sans ce contrôle, un nom piégé
 * finissait dans la page — c'est ainsi qu'il atteignait une expression Alpine.
 */
function estFiable(descriptor: Descriptor, app: string, target: string): boolean {
  return (
    typeof descriptor.app === "string" &&
    typeof descriptor.target === "string" &&
    descriptor.app === app &&
    descriptor.target === target &&
    isLabel(app) &&
    isLabel(target)
  );
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
      const brut = await readJson<Descriptor>(`${directory}/dbox.json`);
      if (brut === null || !estFiable(brut, app, target)) continue;
      const descriptor = complete(brut);

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

/**
 * Les descripteurs de toutes les cibles déployées sous `root`, sans lire l'état
 * Docker — `up()` s'en sert pour refuser deux cibles qui revendiqueraient le
 * même `public_domain`. Un `docker ps` serait inutile ici : seul le contenu des
 * `dbox.json` compte, pas ce qui tourne à cet instant.
 */
export async function listDescriptors(root: string): Promise<Descriptor[]> {
  const found: Descriptor[] = [];

  for (const app of await subdirectories(root)) {
    for (const target of await subdirectories(`${root}/${app}`)) {
      const descriptor = await readJson<Descriptor>(`${root}/${app}/${target}/dbox.json`);
      if (descriptor !== null && estFiable(descriptor, app, target)) found.push(complete(descriptor));
    }
  }

  return found;
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
