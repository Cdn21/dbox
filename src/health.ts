/**
 * Le contrôle de santé interroge **l'URL finale**, pas le conteneur.
 *
 * C'est volontaire : ce qui compte n'est pas qu'un processus tourne, mais que
 * la chaîne entière réponde — app, sidecar, nœud tailnet, certificat. Un
 * conteneur « up » derrière un sidecar muet est un déploiement raté.
 *
 * Corollaire : la machine qui exécute DBox doit être sur le tailnet.
 */

import { request as httpsRequest } from "node:https";

export type Probe = (url: string) => Promise<number | null>;

/**
 * Plafond d'une **seule** tentative de sonde. Sans lui, un serveur qui accepte
 * la connexion puis ne répond jamais (slow-loris, app bloquée dans son propre
 * netns pour une cible headscale) ferait pendre `waitUntilHealthy` pour
 * toujours — le délai global ne se vérifie qu'entre deux tentatives, jamais
 * pendant l'une d'elles. Ça contournerait le retour arrière (invariant 4).
 * Large, car une première réponse peut tarder ; mais fini.
 */
const PROBE_TIMEOUT_MS = 10_000;

export interface WaitOptions {
  probe: Probe;
  timeoutMs: number;
  intervalMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  onAttempt?: (attempt: number, status: number | null, elapsedMs: number) => void;
}

export interface WaitResult {
  ok: boolean;
  status: number | null;
  attempts: number;
  elapsedMs: number;
}

/** `null` = injoignable. Une 5xx est un échec ; le reste prouve que ça répond. */
export const httpProbe: Probe = async (url) => {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return response.status;
  } catch {
    // Un dépassement de délai lève aussi ici (TimeoutError) → injoignable.
    return null;
  }
};

/**
 * Même sonde, mais la résolution du nom est **épinglée** sur une IP donnée.
 *
 * Nécessaire pour une cible Headscale : `<nom>.<tailnet>` se résout par le DNS
 * public vers une IP publique (contrainte du certificat wildcard), pas vers
 * l'IP overlay du nœud. On connecte donc à l'IP overlay, mais avec le **nom**
 * en SNI et en `Host:` — le certificat wildcard valide pour ce nom passe, et on
 * vérifie bien la chaîne entière (sidecar + Caddy + certificat), pas juste un
 * conteneur « up ». C'est l'équivalent d'un `curl --resolve`.
 *
 * `node:https` plutôt que `fetch` : son option `lookup` remplace la résolution
 * DNS par requête, ce que l'API `fetch` n'expose pas. Aucune dépendance ajoutée.
 */
export function pinnedHttpProbe(ip: string): Probe {
  return (url) =>
    new Promise((resolve) => {
      let u: URL;
      try {
        u = new URL(url);
      } catch {
        resolve(null); // URL mal formée = injoignable, jamais une exception
        return;
      }
      let minuterie: ReturnType<typeof setTimeout>;
      const fini = (status: number | null) => {
        clearTimeout(minuterie);
        resolve(status); // idempotent : un « error » tardif ne change rien
      };
      const req = httpsRequest(
        {
          hostname: u.hostname,
          servername: u.hostname, // SNI = le nom, pour que le cert wildcard valide
          port: u.port === "" ? 443 : Number(u.port),
          path: `${u.pathname}${u.search}`,
          method: "GET",
          // `done` attend un tableau quand Node sonde les deux familles
          // (autoSelectFamily, le défaut), un couple (adresse, famille) sinon.
          lookup: ((_hostname: string, options: { all?: boolean }, done: Function) =>
            options.all ? done(null, [{ address: ip, family: 4 }]) : done(null, ip, 4)) as never,
        },
        (response) => {
          response.resume(); // libère la socket sans lire le corps
          fini(response.statusCode ?? null);
        },
      );
      // Minuterie explicite plutôt que l'option `timeout` de socket : celle-ci
      // ne se déclenche pas pendant une poignée de main TLS qui n'aboutit jamais
      // (serveur muet). Garantie de couper, quel que soit l'état de la connexion.
      minuterie = setTimeout(() => {
        req.destroy();
        fini(null);
      }, PROBE_TIMEOUT_MS);
      req.on("error", () => fini(null));
      req.end();
    });
}

export function isHealthy(status: number | null): boolean {
  return status !== null && status < 500;
}

export async function waitUntilHealthy(url: string, options: WaitOptions): Promise<WaitResult> {
  const started = options.now();
  let attempts = 0;

  for (;;) {
    attempts++;
    const status = await options.probe(url);
    const elapsedMs = options.now() - started;
    options.onAttempt?.(attempts, status, elapsedMs);

    if (isHealthy(status)) return { ok: true, status, attempts, elapsedMs };
    // Au premier démarrage, le nœud doit encore obtenir son certificat : on
    // laisse largement le temps avant de déclarer l'échec.
    if (elapsedMs + options.intervalMs >= options.timeoutMs) {
      return { ok: false, status, attempts, elapsedMs };
    }
    await options.sleep(options.intervalMs);
  }
}
