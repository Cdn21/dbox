/**
 * La version que cette copie de DBox annonce (`dbox --version`).
 *
 * Deux sources, dans cet ordre :
 *   - `DBOX_VERSION`, gravée dans l'image à sa construction (`ARG DBOX_VERSION`) :
 *     le numéro de version pour une image publiée (`1.1.0`), le SHA du commit
 *     pour une machine en déploiement continu (`maj-auto.sh`) ;
 *   - à défaut, le numéro de `package.json`, suivi de « (sources) » : on lance
 *     DBox depuis un dossier de travail, et rien ne dit quel commit il contient.
 *
 * `inconnue` est la valeur par défaut de l'ARG quand l'image a été construite à
 * la main : elle ne vaut pas mieux qu'une absence.
 */

import { readFileSync } from "node:fs";

export function versionAffichee(depuisImage: string | undefined, depuisPaquet: string | null): string {
  if (depuisImage !== undefined && depuisImage !== "" && depuisImage !== "inconnue") return depuisImage;
  return depuisPaquet === null ? "inconnue" : `${depuisPaquet} (sources)`;
}

export function versionDuPaquet(): string | null {
  try {
    const paquet = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof paquet.version === "string" ? paquet.version : null;
  } catch {
    return null;
  }
}
