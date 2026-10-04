/**
 * Ce que la carte peut dire de la version déployée, au-delà de son SHA brut :
 * où la lire sur la forge, et si la source a avancé depuis.
 *
 * **Jamais de `git fetch` ici.** La liste se rafraîchit toutes les 15 s ; un
 * fetch par cible à ce rythme ferait du tableau de bord un client réseau
 * permanent de chaque forge, et le sondage `auto_deploy` fait déjà ce travail
 * pour les cibles qui le demandent. On ne compare donc qu'au `HEAD` local de la
 * source — ce qui répond à la question utile pour un dossier de travail
 * (« j'ai commité, ai-je redéployé ? ») sans prétendre savoir ce qu'il y a en
 * amont.
 */

import type { RunResult } from "./docker.ts";

export interface VersionInfo {
  /** Le commit déployé sur la forge, quand l'adresse du dépôt s'y prête. */
  commitUrl: string | null;
  /** Commits présents dans la source et absents de la version déployée. */
  nonDeployes: number | null;
}

export const AUCUNE: VersionInfo = { commitUrl: null, nonDeployes: null };

/** Le SHA porté par un tag d'image (`tag.ts`) : `<sha>` ou `<sha>-sale`. Un tag
 * horodaté (`t2026…`, source sans git) n'en porte pas. */
export function shaOf(tag: string): string | null {
  const m = /^([0-9a-f]{7,40})(-sale)?$/.exec(tag);
  return m === null ? null : m[1]!;
}

/**
 * L'adresse web d'un dépôt, depuis son `remote.origin.url`. Couvre les trois
 * formes courantes (https, `git@hôte:chemin`, `ssh://…`) ; le reste vaut `null`
 * plutôt qu'un lien deviné qui mènerait nulle part.
 *
 * **Les identifiants sont retirés** : une URL https peut porter un jeton
 * (`https://moi:jeton@forge/…`), et cette adresse finit dans une page.
 */
export function webUrlOf(remote: string): string | null {
  const nettoie = (hote: string, chemin: string): string | null => {
    const propre = chemin.replace(/^\/+/, "").replace(/\.git\/?$/, "").replace(/\/+$/, "");
    if (hote === "" || propre === "" || !/^[A-Za-z0-9.-]+$/.test(hote)) return null;
    return `https://${hote}/${propre}`;
  };

  const r = remote.trim();
  let m = /^https?:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(r);
  if (m !== null) return nettoie(m[1]!, m[2]!);
  m = /^ssh:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(r);
  if (m !== null) return nettoie(m[1]!, m[2]!);
  m = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(r);
  if (m !== null) return nettoie(m[1]!, m[2]!);
  return null;
}

type Git = (args: string[]) => Promise<RunResult>;

export async function versionInfo(source: string, tag: string, git: Git): Promise<VersionInfo> {
  const sha = shaOf(tag);
  if (sha === null) return AUCUNE;

  const [remote, compte] = await Promise.all([
    git(["-C", source, "config", "--get", "remote.origin.url"]).catch(() => null),
    git(["-C", source, "rev-list", "--count", `${sha}..HEAD`]).catch(() => null),
  ]);
  const web = remote !== null && remote.code === 0 ? webUrlOf(remote.stdout) : null;
  const n = compte !== null && compte.code === 0 ? Number.parseInt(compte.stdout.trim(), 10) : Number.NaN;

  return {
    commitUrl: web === null ? null : `${web}/commit/${sha}`,
    nonDeployes: Number.isFinite(n) ? n : null,
  };
}

/**
 * Le même calcul, gardé une minute : la liste est rendue toutes les 15 s, par
 * chaque onglet ouvert, et rien de tout ça ne change à ce rythme.
 */
export function avecCache(
  calcule: (source: string, tag: string) => Promise<VersionInfo>,
  now: () => number = Date.now,
  ttlMs = 60_000,
): (source: string, tag: string) => Promise<VersionInfo> {
  const memo = new Map<string, { at: number; info: VersionInfo }>();
  return async (source, tag) => {
    const cle = `${source}\0${tag}`;
    const deja = memo.get(cle);
    if (deja !== undefined && now() - deja.at < ttlMs) return deja.info;
    const info = await calcule(source, tag);
    memo.set(cle, { at: now(), info });
    return info;
  };
}
