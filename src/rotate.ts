/**
 * Rotation automatique de la clé d'auth semée dans les nouvelles apps
 * (`tag:dbox`) — le pendant de `poller.ts` pour une tâche différente, même
 * forme : une fonction pure sondée à intervalle, testable sans minuteur.
 *
 * Volontairement séparé du daemon : cette tâche est la seule à connaître le
 * token d'accès API Tailscale, un secret aux droits bien plus larges que
 * tout ce que le daemon manipule ailleurs (il agit avec les droits du compte
 * qui l'a créé, pas un accès limité aux clés). Elle tourne dans son propre
 * conteneur (`deploy/docker-compose.yml`), sans le socket Docker, sans route
 * depuis le sidecar Tailscale — compromettre le daemon ne donne jamais accès
 * à ce token.
 */

import { expiryPath, readAuthkeyNotice } from "./authkey.ts";
import type { NewAuthKey } from "./tailscale.ts";
import type { NewPreAuthKey } from "./headscale.ts";

/** En dessous de ce seuil, une rotation est déclenchée — largement avant
 * l'échéance, pour qu'un souci passager (API indisponible, token expiré)
 * laisse le temps d'un vrai avertissement humain avant que ça ne casse
 * l'inscription de nouvelles apps. */
export const ROTATE_WITHIN_DAYS = 14;

/** À côté de `.expires`, même convention — l'identifiant de la clé en place,
 * pour pouvoir révoquer *celle-là précisément* à la prochaine rotation. */
export function idPath(authkeyFile: string): string {
  return `${authkeyFile}.id`;
}

export interface RotateDeps {
  authkeyFile: string;
  tailnet: string;
  tag: string | null;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string, mode: number) => Promise<void>;
  readToken: () => Promise<string>;
  createKey: (tailnet: string, token: string, tag: string | null) => Promise<NewAuthKey>;
  revokeKey: (tailnet: string, token: string, keyId: string) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
}

/**
 * Ne régénère que si nécessaire — jamais à chaque passage, pour ne pas
 * accumuler des clés inutilisées dans la console à chaque redémarrage.
 * Absence d'échéance connue (premier passage, fichier jamais posé) traitée
 * comme « à régénérer » : c'est justement le rôle de cette tâche que d'en
 * établir une.
 *
 * La nouvelle clé est en place et fonctionnelle avant toute tentative de
 * révoquer l'ancienne — jamais l'inverse. Et un échec de révocation n'est
 * qu'un oubli de ménage, pas un échec de la rotation : la nouvelle clé
 * marche déjà, ça n'empêche rien.
 */
export async function rotateOnce(deps: RotateDeps): Promise<void> {
  const notice = await readAuthkeyNotice(deps.authkeyFile, deps.readFile, deps.now());
  if (notice !== null && notice.daysLeft > ROTATE_WITHIN_DAYS) {
    deps.log(`clé encore valide ${notice.daysLeft} j — rien à faire`);
    return;
  }

  const token = (await deps.readToken()).trim();
  if (token === "") {
    deps.log("token d'accès API Tailscale absent ou vide — rotation impossible");
    return;
  }

  const previousId = (await deps.readFile(idPath(deps.authkeyFile)).catch(() => "")).trim();

  const created = await deps.createKey(deps.tailnet, token, deps.tag);
  await deps.writeFile(deps.authkeyFile, `${created.key}\n`, 0o600);
  await deps.writeFile(expiryPath(deps.authkeyFile), `${created.expiresOn}\n`, 0o644);
  await deps.writeFile(idPath(deps.authkeyFile), `${created.id}\n`, 0o644);
  deps.log(`nouvelle clé posée, expire le ${created.expiresOn}`);

  if (previousId === "") return; // rien à révoquer, première rotation

  try {
    await deps.revokeKey(deps.tailnet, token, previousId);
    deps.log(`ancienne clé (${previousId}) révoquée`);
  } catch (error) {
    deps.log(`ancienne clé (${previousId}) non révoquée : ${(error as Error).message}`);
  }
}

/** Démarre la rotation périodique ; l'arrêter rend le process testable sans
 * laisser de minuteur actif — même contrat que `startPolling`. */
export function startRotating(intervalMs: number, deps: RotateDeps): () => void {
  const timer = setInterval(() => {
    rotateOnce(deps).catch((error: Error) => deps.log(`rotation : ${error.message}`));
  }, intervalMs);
  return () => clearInterval(timer);
}

/**
 * Rotation de la clé préauth Headscale — même forme que `rotateOnce`, mais
 * contre l'API Headscale, et l'expiration de l'ancienne se fait **par sa
 * valeur** (Headscale n'expose pas d'id exploitable). D'où la lecture de
 * l'ancienne clé avant de l'écraser — pas de fichier `.id` (qui, en 0644,
 * laisserait fuiter une clé).
 */
export interface HeadscaleRotateDeps {
  authkeyFile: string;
  loginServer: string;
  user: string;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, content: string, mode: number) => Promise<void>;
  readToken: () => Promise<string>;
  createKey: (loginServer: string, token: string, user: string) => Promise<NewPreAuthKey>;
  expireKey: (loginServer: string, token: string, user: string, key: string) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
}

export async function rotateHeadscaleOnce(deps: HeadscaleRotateDeps): Promise<void> {
  const notice = await readAuthkeyNotice(deps.authkeyFile, deps.readFile, deps.now());
  if (notice !== null && notice.daysLeft > ROTATE_WITHIN_DAYS) {
    deps.log(`clé Headscale encore valide ${notice.daysLeft} j — rien à faire`);
    return;
  }

  const token = (await deps.readToken()).trim();
  if (token === "") {
    deps.log("token d'API Headscale absent ou vide — rotation impossible");
    return;
  }

  // L'ancienne clé, lue avant l'écrasement : c'est elle qu'on expirera.
  const oldKey = (await deps.readFile(deps.authkeyFile).catch(() => "")).trim();

  const created = await deps.createKey(deps.loginServer, token, deps.user);
  await deps.writeFile(deps.authkeyFile, `${created.key}\n`, 0o600);
  await deps.writeFile(expiryPath(deps.authkeyFile), `${created.expiresOn}\n`, 0o644);
  deps.log(`nouvelle clé Headscale posée, expire le ${created.expiresOn}`);

  if (oldKey === "") return; // rien à expirer, première rotation

  try {
    await deps.expireKey(deps.loginServer, token, deps.user, oldKey);
    deps.log("ancienne clé Headscale expirée");
  } catch (error) {
    deps.log(`ancienne clé Headscale non expirée : ${(error as Error).message}`);
  }
}

export function startRotatingHeadscale(intervalMs: number, deps: HeadscaleRotateDeps): () => void {
  const timer = setInterval(() => {
    rotateHeadscaleOnce(deps).catch((error: Error) => deps.log(`rotation Headscale : ${error.message}`));
  }, intervalMs);
  return () => clearInterval(timer);
}
