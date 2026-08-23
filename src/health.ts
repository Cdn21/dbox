/**
 * Le contrôle de santé interroge **l'URL finale**, pas le conteneur.
 *
 * C'est volontaire : ce qui compte n'est pas qu'un processus tourne, mais que
 * la chaîne entière réponde — app, sidecar, nœud tailnet, certificat. Un
 * conteneur « up » derrière un sidecar muet est un déploiement raté.
 *
 * Corollaire : la machine qui exécute DBox doit être sur le tailnet.
 */

export type Probe = (url: string) => Promise<number | null>;

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
    const response = await fetch(url, { redirect: "manual" });
    return response.status;
  } catch {
    return null;
  }
};

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
