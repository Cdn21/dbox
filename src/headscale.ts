/**
 * Appel brut à l'API HTTP de Headscale : créer une clé préauth, en expirer une.
 *
 * Le pendant de `tailscale.ts` pour un backend auto-hébergé. Utilisé **seulement**
 * par le rotateur (`rotate.ts`, conteneur `authkey-rotator`), jamais par le
 * daemon : le token d'API Headscale a les droits de l'instance entière, comme
 * le token Tailscale — il vit dans `secrets/`, masqué au daemon.
 *
 * Headscale n'a pas de notion de « tag » dans sa clé préauth comme Tailscale :
 * une clé appartient à un **user**. C'est ce qui remplace le tag ici.
 */

/** Durée de validité d'une clé fraîchement créée — large, comme pour Tailscale. */
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export interface NewPreAuthKey {
  key: string;
  /** Date ISO (YYYY-MM-DD), tronquée depuis l'horodatage RFC3339 de l'API. */
  expiresOn: string;
}

/** `https://headscale.exemple/` → `https://headscale.exemple` (sans / final),
 * pour composer `${base}/api/v1/...` sans double barre. */
function base(loginServer: string): string {
  return loginServer.replace(/\/+$/, "");
}

/**
 * `user` est l'**ID numérique** du user Headscale (ex. "1"), jamais son nom :
 * l'API attend un uint64 (un nom donne « invalid value for uint64 field user »).
 * Envoyé tel quel — la proto-JSON de Headscale accepte l'entier en chaîne.
 */
export async function createPreAuthKey(
  loginServer: string,
  token: string,
  user: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<NewPreAuthKey> {
  const expiration = new Date(now() + NINETY_DAYS_MS).toISOString();
  const response = await fetchImpl(`${base(loginServer)}/api/v1/preauthkey`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ user, reusable: true, ephemeral: false, expiration }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `l'API Headscale a refusé la création de la clé (${response.status}) : ${detail || response.statusText}`,
    );
  }

  // Headscale enveloppe la réponse : { preAuthKey: { key, expiration, ... } }.
  const parsed = (await response.json()) as { preAuthKey?: { key?: string; expiration?: string } };
  const pak = parsed.preAuthKey;
  if (pak === undefined || typeof pak.key !== "string" || typeof pak.expiration !== "string") {
    throw new Error("réponse de l'API Headscale inattendue : « preAuthKey.key » ou « expiration » manquant");
  }
  return { key: pak.key, expiresOn: pak.expiration.slice(0, 10) };
}

/**
 * Expire une clé préauth — l'équivalent de `revokeAuthKey`. Headscale n'a pas
 * d'identifiant opaque exploitable ici : on expire **par sa valeur** (`key`),
 * sous le même `user`. C'est pourquoi la rotation lit l'ancienne clé avant de
 * l'écraser, plutôt que de mémoriser un id (voir `rotateHeadscaleOnce`).
 */
export async function expirePreAuthKey(
  loginServer: string,
  token: string,
  user: string,
  key: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(`${base(loginServer)}/api/v1/preauthkey/expire`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ user, key }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `l'API Headscale a refusé l'expiration de la clé (${response.status}) : ${detail || response.statusText}`,
    );
  }
}
