/**
 * La façade de l'interface : le seul point d'entrée pour `server.ts`.
 *
 * Le découpage en modules est une affaire interne à `ui/` — le daemon importe
 * ici, et rien d'autre. Déplacer une fonction d'un module à l'autre ne le
 * concerne pas.
 */

export { ICON_SVG, MANIFEST_JSON } from "./chrome.ts";
export { escape } from "./html.ts";
export { cleCible, renderList, type Extras } from "./cartes.ts";
export { renderPage } from "./page.ts";
export { apercuFragment } from "./ajout.ts";
export {
  actionResult,
  cleAppFragment,
  envPanelFragment,
  fichiersPanelFragment,
  jobFragment,
  logsFragment,
  manifestPanelFragment,
  redeployerMaintenant,
  type JobView,
} from "./panneaux.ts";
export { diagnosticFragment, renderSettingsPage, sshKeyPanel, type HeadscaleStatus, type SshKeyStatus, type TraefikStatus } from "./reglages.ts";
