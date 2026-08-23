/**
 * Format du rapport écrit par `tagcheck.ts` (dans le conteneur
 * `authkey-rotator`), lu par le daemon (`server.ts`) pour l'afficher sur
 * `/settings` — même principe que `orphans-report.ts` : un fichier partagé
 * par le montage `$DBOX_HOME` que les deux conteneurs voient déjà.
 */

export interface TagReport {
  checkedAt: string;
  tag: string;
  present: boolean;
  /** Ligne prête à coller dans tagOwners, calquée sur un tag déjà présent
   * dans la policy — absente si `present` est vrai. */
  suggestedLine: string | null;
}

export function serializeTagReport(report: TagReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}

/** Absent, illisible, ou mal formé : `null` — un renseignement, jamais une
 * raison de casser le tableau de bord, même règle que `authkey.ts`. */
export async function readTagReport(
  path: string,
  readFile: (path: string) => Promise<string>,
): Promise<TagReport | null> {
  try {
    const parsed = JSON.parse(await readFile(path)) as Partial<TagReport>;
    if (
      typeof parsed.checkedAt !== "string" ||
      typeof parsed.tag !== "string" ||
      typeof parsed.present !== "boolean"
    ) {
      return null;
    }
    return { checkedAt: parsed.checkedAt, tag: parsed.tag, present: parsed.present, suggestedLine: parsed.suggestedLine ?? null };
  } catch {
    return null;
  }
}
