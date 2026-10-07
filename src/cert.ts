/**
 * L'expiration du certificat wildcard d'un backend Headscale, en avertissement.
 *
 * C'est la pièce fragile et propre à Headscale : le certificat `*.<tailnet>` est
 * renouvelé **hors de DBox** (lego/DNS-01, un script à toi), et s'il expire,
 * **toutes** les cibles Headscale cassent leur TLS d'un coup, en silence. On le
 * surveille donc, comme la clé préauth — mais ici on lit la vraie date dans le
 * certificat (`notAfter`), il n'y a pas de fichier `.expires` à tenir à jour.
 *
 * Contrainte : le certificat est en général `0600 root`, et le daemon tourne en
 * 1000:1000 — il ne peut pas le lire. On passe donc par un conteneur root qui
 * monte le dossier en lecture seule (même image et même idée que la sonde de
 * santé headscale), via la commande cachée `__certexpiry`. Absent ou illisible,
 * pas de bannière : un renseignement, jamais une raison de casser le tableau de bord.
 */

import { X509Certificate } from "node:crypto";
import { daysUntil } from "./authkey.ts";
import { run, type RunResult } from "./docker.ts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface CertNotice {
  expiresOn: string;
  daysLeft: number;
}

/**
 * La date d'expiration (`notAfter`, en ISO `YYYY-MM-DD`) d'un certificat PEM,
 * `null` si le PEM est illisible. Pur — c'est ce que `__certexpiry` exécute
 * dans le conteneur root, et ce que les tests vérifient.
 */
export function certExpiryFromPem(pem: string): string | null {
  try {
    const cert = new X509Certificate(pem);
    const date = new Date(cert.validTo);
    if (Number.isNaN(date.getTime())) return null;
    return date.toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

/** Chemin du certificat dans le dossier fourni : `<tailnet>.crt`, la convention
 * que `caddyfileFor` attend aussi (le cert suit le domaine, pas le nom). */
export function certPath(tailnet: string): string {
  return `${tailnet}.crt`;
}

/**
 * Lit la date d'expiration du certificat wildcard via un conteneur root qui
 * monte le dossier en lecture seule — le daemon (1000:1000) ne peut pas lire un
 * `0600 root`. `exec` injectable pour le test.
 */
export async function readCertExpiry(
  certDir: string,
  tailnet: string,
  image: string,
  exec: (file: string, args: string[]) => Promise<RunResult> = (file, args) => run(file, args, { timeoutMs: 20_000 }),
): Promise<string | null> {
  const res = await exec("docker", [
    "run",
    "--rm",
    "-v",
    `${certDir}:/certs:ro`,
    image,
    "__certexpiry",
    `/certs/${certPath(tailnet)}`,
  ]);
  const out = res.stdout.trim();
  return ISO_DATE.test(out) ? out : null;
}

export function certNotice(expiresOn: string, now: number): CertNotice {
  return { expiresOn, daysLeft: daysUntil(expiresOn, now) };
}
