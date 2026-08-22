/**
 * L'expiration de la clé d'auth Tailscale, en avertissement — pas en blocage.
 *
 * DBox ne peut pas la connaître par lui-même : Tailscale ne l'encode pas dans
 * la clé, et interroger son API demanderait un jeton de plus à faire vivre —
 * exactement le genre de charge qu'on cherche à supprimer. Le compromis :
 * un fichier texte, à côté de la clé, qu'on renseigne une fois à la création.
 *
 * Absent ou illisible, la bannière ne s'affiche pas. C'est un renseignement,
 * jamais une raison de casser le tableau de bord.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface AuthkeyNotice {
  expiresOn: string;
  daysLeft: number;
}

/** Toujours à côté de la clé elle-même : pas de réglage de plus à poser. */
export function expiryPath(authkeyFile: string): string {
  return `${authkeyFile}.expires`;
}

export function daysUntil(isoDate: string, now: number): number {
  const midnightToday = new Date(now).toISOString().slice(0, 10);
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((Date.parse(isoDate) - Date.parse(midnightToday)) / msPerDay);
}

export async function readAuthkeyNotice(
  authkeyFile: string | undefined,
  readFile: (path: string) => Promise<string>,
  now: number,
): Promise<AuthkeyNotice | null> {
  if (authkeyFile === undefined) return null;

  const raw = await readFile(expiryPath(authkeyFile)).catch(() => null);
  if (raw === null) return null;

  const trimmed = raw.trim();
  if (!ISO_DATE.test(trimmed)) return null;

  return { expiresOn: trimmed, daysLeft: daysUntil(trimmed, now) };
}
