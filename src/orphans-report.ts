/**
 * Format du rapport écrit par `orphans.ts` (dans le conteneur
 * `authkey-rotator`), lu par le daemon (`server.ts`) pour l'afficher sur
 * `/settings` — jamais l'inverse : le daemon n'appelle jamais l'API
 * Tailscale lui-même, il ne lit qu'un fichier. Partagé par le même montage
 * `$DBOX_HOME` que les deux conteneurs voient déjà chacun de leur côté.
 */

export interface StaleDevice {
  hostname: string;
  id: string;
  lastSeen: string;
}

export interface OrphansReport {
  checkedAt: string;
  /** Le tag effectivement surveillé — affiché tel quel, jamais deviné, au
   * cas où `--ts-tag` ne vaudrait pas la convention `tag:dbox`. */
  tag: string;
  stale: StaleDevice[];
}

export function serializeOrphansReport(report: OrphansReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}

/** Absent, illisible, ou mal formé : `null`: un renseignement, jamais une
 * raison de casser le tableau de bord — même règle que `authkey.ts`. */
export async function readOrphansReport(
  path: string,
  readFile: (path: string) => Promise<string>,
): Promise<OrphansReport | null> {
  try {
    const parsed = JSON.parse(await readFile(path)) as Partial<OrphansReport>;
    if (typeof parsed.checkedAt !== "string" || typeof parsed.tag !== "string" || !Array.isArray(parsed.stale)) {
      return null;
    }
    return { checkedAt: parsed.checkedAt, tag: parsed.tag, stale: parsed.stale };
  } catch {
    return null;
  }
}
