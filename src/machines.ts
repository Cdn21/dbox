/**
 * Les autres machines DBox connues de celle-ci — de quoi sauter d'un tableau
 * de bord à l'autre (dev, prod…) sans retaper une adresse.
 *
 * Volontairement à part de `config.toml` : cette liste se gère depuis
 * l'interface (ajouter/retirer une machine), pas à la main comme le reste de
 * la configuration. JSON plutôt que TOML pour ça — pas de parseur maison à
 * étendre pour un tableau, et rien ici n'a vocation à être lu par un humain
 * en dehors du panneau qui l'édite.
 *
 * Chaque machine tient sa propre liste, indépendamment des autres : ni
 * source de vérité partagée, ni synchronisation. Comme le reste de DBox, une
 * machine ne dépend jamais d'une autre pour fonctionner — seul le navigateur
 * qui les affiche connaît les deux.
 */

export interface MachineEntry {
  name: string;
  url: string;
}

/**
 * Seules les URL http(s) sont acceptées — à l'écriture comme à la lecture.
 * Le sélecteur de machines navigue vers cette valeur (`location.href = url`) :
 * une URL `javascript:` y exécuterait du code dans la page. Vérifié à la revue
 * du 4 octobre 2026. Contrôlé aux deux bouts : l'interface pose la valeur, mais
 * le fichier JSON peut aussi avoir été écrit autrement.
 */
export function estUrlWeb(url: string): boolean {
  try {
    const protocole = new URL(url).protocol;
    return protocole === "http:" || protocole === "https:";
  } catch {
    return false;
  }
}

/** Absent, vide ou illisible : liste vide, jamais une erreur — un sélecteur
 * qui ne propose que la machine courante reste un sélecteur valide. */
export async function readMachines(
  path: string,
  read: (path: string) => Promise<string>,
): Promise<MachineEntry[]> {
  let raw: string;
  try {
    raw = await read(path);
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed.filter(
    (entry): entry is MachineEntry =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as Record<string, unknown>)["name"] === "string" &&
      typeof (entry as Record<string, unknown>)["url"] === "string" &&
      estUrlWeb((entry as Record<string, unknown>)["url"] as string),
  );
}

export async function writeMachines(
  path: string,
  entries: MachineEntry[],
  write: (path: string, content: string) => Promise<void>,
): Promise<void> {
  await write(path, `${JSON.stringify(entries, null, 2)}\n`);
}
