/**
 * htmx et Alpine, vendorisés — jamais chargés depuis un CDN, cohérent avec
 * « la page tient dans une seule requête, sans ressource externe » : le
 * daemon sert ces fichiers lui-même, comme `icon.svg`. Voir `vendor/README.md`
 * pour les versions et la marche à suivre pour les mettre à jour.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const HTMX_JS = readFileSync(join(HERE, "vendor/htmx.min.js"), "utf8");
export const ALPINE_JS = readFileSync(join(HERE, "vendor/alpine.min.js"), "utf8");
