/**
 * Le strict nécessaire pour parler à l'API Tailscale : créer une nouvelle clé
 * d'auth réutilisable, lister les appareils du tailnet, et lire (jamais
 * écrire) les tags déclarés dans sa policy. Jamais appelé par le daemon
 * lui-même — seulement par `dbox rotate-authkey`, tenu à l'écart exprès de
 * tout ce qui répond à une requête HTTP ou touche au socket Docker. Voir
 * `rotate.ts`, `orphans.ts` et `tagcheck.ts`.
 *
 * Volontairement aucune fonction pour écrire l'ACL : contrairement à une
 * clé ou un appareil, la policy gouverne tout le tailnet d'un coup — un
 * `POST` la remplace en entier, pas de correctif ciblé possible côté API.
 * Un bug dans un cycle lire-modifier-écrire automatisé ne casserait pas
 * qu'une app, mais l'accès à toute la machine. Décision : DBox lit et
 * suggère, jamais n'écrit — voir la discussion dans `tagcheck.ts`.
 */

export interface NewAuthKey {
  id: string;
  key: string;
  /** Date ISO (YYYY-MM-DD), tronquée depuis l'horodatage complet de l'API. */
  expiresOn: string;
}

const NINETY_DAYS_SECONDS = 90 * 24 * 60 * 60;

/**
 * `tag` à `null` : la clé n'annonce aucun tag — même règle qu'un tailnet non
 * taggé ailleurs dans DBox (`ctx.tsTag`), tant que `tagOwners` n'est pas posé.
 */
export async function createAuthKey(
  tailnet: string,
  token: string,
  tag: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<NewAuthKey> {
  const body = {
    capabilities: {
      devices: {
        create: {
          reusable: true,
          ephemeral: false,
          preauthorized: true,
          tags: tag === null ? [] : [tag],
        },
      },
    },
    expirySeconds: NINETY_DAYS_SECONDS,
    description: "dbox — clé semée dans les nouvelles apps, régénérée automatiquement",
  };

  const response = await fetchImpl(`https://api.tailscale.com/api/v2/tailnet/${encodeURIComponent(tailnet)}/keys`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `l'API Tailscale a refusé la création de la clé (${response.status}) : ${detail || response.statusText}`,
    );
  }

  const parsed = (await response.json()) as { id?: string; key?: string; expires?: string };
  if (typeof parsed.id !== "string" || typeof parsed.key !== "string" || typeof parsed.expires !== "string") {
    throw new Error("réponse de l'API Tailscale inattendue : « id », « key » ou « expires » manquant");
  }

  return { id: parsed.id, key: parsed.key, expiresOn: parsed.expires.slice(0, 10) };
}

/** Révoque une clé par son identifiant (jamais sa valeur, jamais connue une
 * fois créée) — utilisé pour retirer l'ancienne clé une fois la nouvelle en
 * place, jamais avant : une révocation ratée ne doit pas laisser DBox sans
 * clé valide. */
export async function revokeAuthKey(
  tailnet: string,
  token: string,
  keyId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(
    `https://api.tailscale.com/api/v2/tailnet/${encodeURIComponent(tailnet)}/keys/${encodeURIComponent(keyId)}`,
    { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `l'API Tailscale a refusé la révocation de la clé (${response.status}) : ${detail || response.statusText}`,
    );
  }
}

export interface Device {
  id: string;
  hostname: string;
  tags: string[];
  /** ISO complet — l'API ne renvoie pas qu'une date pour celui-là. */
  lastSeen: string;
}

export async function listDevices(tailnet: string, token: string, fetchImpl: typeof fetch = fetch): Promise<Device[]> {
  const response = await fetchImpl(
    `https://api.tailscale.com/api/v2/tailnet/${encodeURIComponent(tailnet)}/devices`,
    { headers: { authorization: `Bearer ${token}` } },
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `l'API Tailscale a refusé la liste des appareils (${response.status}) : ${detail || response.statusText}`,
    );
  }

  const parsed = (await response.json()) as {
    devices?: { id?: string; hostname?: string; tags?: string[]; lastSeen?: string }[];
  };
  if (!Array.isArray(parsed.devices)) {
    throw new Error("réponse de l'API Tailscale inattendue : pas de liste « devices »");
  }

  return parsed.devices.map((d) => ({
    id: d.id ?? "",
    hostname: d.hostname ?? "",
    tags: d.tags ?? [],
    lastSeen: d.lastSeen ?? "",
  }));
}

/**
 * Les propriétaires de chaque tag déclaré dans la policy — pour vérifier
 * qu'un tag existe, jamais pour la modifier. `Accept: application/json` :
 * sans lui, l'API renvoie le fichier HuJSON tel quel (commentaires compris),
 * pas du JSON strict.
 */
export async function listTagOwners(
  tailnet: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, string[]>> {
  const response = await fetchImpl(`https://api.tailscale.com/api/v2/tailnet/${encodeURIComponent(tailnet)}/acl`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `l'API Tailscale a refusé la lecture de la policy (${response.status}) : ${detail || response.statusText}`,
    );
  }

  const parsed = (await response.json()) as { tagOwners?: Record<string, string[]> };
  return parsed.tagOwners ?? {};
}
