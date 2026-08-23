/**
 * Les constantes partagées entre le serveur et la page.
 *
 * Dans leur propre module pour éviter un import circulaire : la page a besoin
 * du nom de l'en-tête d'action, le serveur a besoin de la page.
 */

/** Posés par `tailscale serve` sur chaque requête proxifiée. */
export const IDENTITY_HEADERS = ["tailscale-user-login", "tailscale-user-name"];

/**
 * Exigé sur toute écriture. Un formulaire d'un site tiers ne peut pas poser
 * d'en-tête maison, et un `fetch` qui en pose déclenche un contrôle préalable
 * auquel on ne répond jamais. Sans lui, l'identité étant injectée par le proxy,
 * n'importe quelle page ouverte dans le navigateur pourrait déclencher un
 * déploiement.
 */
export const ACTION_HEADER = "x-dbox-action";
