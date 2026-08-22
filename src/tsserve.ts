/**
 * Configuration `tailscale serve` du sidecar : il termine le TLS sur 443 et
 * proxifie vers l'amont.
 *
 * `${TS_CERT_DOMAIN}` est conservé **littéralement** : c'est le conteneur
 * Tailscale qui l'interpole, une fois qu'il connaît son propre nom complet.
 * L'interpoler ici casserait tout, silencieusement.
 */

export const CERT_DOMAIN = "${TS_CERT_DOMAIN}";

/** Un port du bloc `TCP` : soit terminé en HTTPS (443, proxifié via `Web`),
 * soit un forward TCP brut (`TCPForward`) — jamais les deux à la fois. */
export interface TcpPortHandler {
  HTTPS?: boolean;
  TCPForward?: string;
}

export interface ServeConfig {
  TCP: Record<string, TcpPortHandler>;
  Web: Record<string, { Handlers: Record<string, { Proxy: string }> }>;
}

/**
 * `sshUpstream` (`hôte:port`) : quand une cible déclare `ssh_port`, le
 * sidecar forward aussi le 22 en TCP brut — jamais de TLS dessus, ce n'est
 * pas du HTTP. `null` : le sidecar ne parle toujours que HTTPS, comme avant.
 */
export function serveConfigFor(upstream: string, sshUpstream: string | null = null): ServeConfig {
  const TCP: Record<string, TcpPortHandler> = { "443": { HTTPS: true } };
  if (sshUpstream !== null) {
    TCP["22"] = { TCPForward: sshUpstream };
  }
  return {
    TCP,
    Web: {
      [`${CERT_DOMAIN}:443`]: {
        Handlers: { "/": { Proxy: upstream } },
      },
    },
  };
}
