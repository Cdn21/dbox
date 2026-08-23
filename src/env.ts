/**
 * Les variables d'environnement d'une cible — le fichier `.env` injecté au
 * lancement.
 *
 * Format volontairement pauvre : `CLÉ=valeur`, une par ligne. Pas
 * d'interpolation, pas de guillemets à interpréter, pas de multi-lignes. Docker
 * Compose lit ce fichier tel quel, et tout ce qu'on ajouterait ici serait une
 * divergence entre ce que l'interface montre et ce que le conteneur reçoit.
 *
 * Conséquence assumée : les commentaires ne survivent pas à une édition depuis
 * l'interface. C'est un fichier de réglages, pas un document.
 */

export interface EnvEntry {
  key: string;
  value: string;
}

/** Ce que le shell et Docker acceptent comme nom de variable. */
export const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseEnv(source: string): EnvEntry[] {
  const entries: EnvEntry[] = [];

  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    const equals = line.indexOf("=");
    if (equals === -1) continue;

    const key = line.slice(0, equals).trim();
    if (!KEY.test(key)) continue;

    entries.push({ key, value: line.slice(equals + 1) });
  }

  return entries;
}

export function serializeEnv(entries: EnvEntry[]): string {
  return entries.map((entry) => `${entry.key}=${entry.value}`).join("\n") + "\n";
}

/**
 * Refuse ce qui casserait le fichier ou tromperait sur son contenu : un nom
 * invalide, un doublon (Docker garderait le dernier en silence), un saut de
 * ligne dans une valeur (qui deviendrait une variable fantôme).
 */
export function validateEntries(entries: EnvEntry[]): string | null {
  const seen = new Set<string>();

  for (const entry of entries) {
    if (!KEY.test(entry.key)) {
      return `« ${entry.key} » n'est pas un nom de variable valide (lettres, chiffres, souligné, ne commence pas par un chiffre)`;
    }
    if (seen.has(entry.key)) {
      return `« ${entry.key} » est défini deux fois`;
    }
    if (/[\r\n]/.test(entry.value)) {
      return `la valeur de « ${entry.key} » contient un saut de ligne`;
    }
    seen.add(entry.key);
  }

  return null;
}
