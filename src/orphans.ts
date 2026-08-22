/**
 * Repère les nœuds Tailscale tagués `tag:dbox` qui semblent abandonnés —
 * restes d'un `dbox rm` d'avant cette fonctionnalité, ou d'une machine
 * décommissionnée. Rapport seul, dans les journaux : une suppression de
 * nœud mérite d'avoir fait ses preuves en lecture seule avant qu'on lui
 * donne le droit d'agir. Même conteneur isolé que `rotate.ts`, même raison.
 *
 * Le signal est l'ancienneté de `lastSeen`, pas une comparaison avec le
 * registre local — DBox tourne sur plusieurs machines, chacune ne gère que
 * ses propres cibles (`serve` fait `prod`, pc-cde fait `dev`), et les
 * daemons ne s'appellent jamais entre eux. Comparer au registre d'**une
 * seule** machine signalerait à tort les cibles bien vivantes des autres.
 * `lastSeen` n'a pas ce problème : un sidecar toujours démarré se
 * reconnecte en continu, sur n'importe quelle machine.
 */

import { serializeOrphansReport, type OrphansReport } from "./orphans-report.ts";
import type { Device } from "./tailscale.ts";

export interface OrphanDeps {
  tailnet: string;
  tag: string | null;
  /** Au-delà de cette ancienneté sans nouvelle connexion, un nœud est
   * signalé — assez large pour ne pas s'affoler d'un simple redémarrage. */
  staleAfterMs: number;
  /** Où écrire le rapport que `/settings` affiche — voir `orphans-report.ts`. */
  reportFile: string;
  readToken: () => Promise<string>;
  writeFile: (path: string, content: string, mode: number) => Promise<void>;
  listDevices: (tailnet: string, token: string) => Promise<Device[]>;
  now: () => number;
  log: (line: string) => void;
}

export const STALE_AFTER_DAYS = 14;

/**
 * N'écrit le rapport que sur un passage complet (jusqu'à l'appel API) —
 * jamais sur « pas de tag configuré » ou « token absent », qui ne sont pas
 * des vérifications réussies mais des configurations manquantes. Le
 * tableau de bord ne montre alors rien, même règle que l'absence du fichier.
 */
export async function checkOrphansOnce(deps: OrphanDeps): Promise<void> {
  if (deps.tag === null) {
    deps.log("orphelins : aucun tag configuré — rien à surveiller");
    return;
  }

  const token = (await deps.readToken()).trim();
  if (token === "") {
    deps.log("orphelins : token d'accès API Tailscale absent ou vide — vérification impossible");
    return;
  }

  const devices = await deps.listDevices(deps.tailnet, token);
  const tagged = devices.filter((device) => device.tags.includes(deps.tag!));

  const stale = tagged.filter((device) => {
    const lastSeenMs = Date.parse(device.lastSeen);
    return !Number.isNaN(lastSeenMs) && deps.now() - lastSeenMs > deps.staleAfterMs;
  });

  const report: OrphansReport = {
    checkedAt: new Date(deps.now()).toISOString(),
    tag: deps.tag,
    stale: stale.map((device) => ({ hostname: device.hostname, id: device.id, lastSeen: device.lastSeen })),
  };
  await deps.writeFile(deps.reportFile, serializeOrphansReport(report), 0o644);

  if (stale.length === 0) {
    deps.log(`orphelins : aucun (${tagged.length} nœud(s) ${deps.tag} connu(s) du tailnet)`);
    return;
  }
  for (const device of stale) {
    deps.log(
      `orphelins : ${device.hostname} (${device.id}) — vu pour la dernière fois ${device.lastSeen}, ` +
        `probablement abandonné (à vérifier avant de le retirer soi-même)`,
    );
  }
}

/** Même contrat que `startRotating`/`startPolling` : l'arrêter rend le
 * process testable sans laisser de minuteur actif. */
export function startCheckingOrphans(intervalMs: number, deps: OrphanDeps): () => void {
  const timer = setInterval(() => {
    checkOrphansOnce(deps).catch((error: Error) => deps.log(`orphelins : ${error.message}`));
  }, intervalMs);
  return () => clearInterval(timer);
}
