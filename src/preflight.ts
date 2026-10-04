/**
 * Ce qui va casser, dit **avant** de construire.
 *
 * Trois échecs reviennent sans cesse au premier déploiement d'une cible de
 * développement, et tous les trois sont connaissables d'avance : un serveur
 * Vite qui refusera le nom d'hôte du sidecar, un serveur qui n'écoute que sur
 * la boucle locale, un devcontainer JVM parti sur l'image Node par défaut.
 * Aujourd'hui on les apprend après deux minutes de construction, par un
 * contrôle de santé qui échoue sans rien expliquer.
 *
 * Ce module est **pur**, comme `plan.ts` : il reçoit le contenu de fichiers
 * déjà lus et rend des avertissements. Rien n'y touche le disque, donc tout se
 * teste sans monter quoi que ce soit.
 *
 * **Ça avertit, ça ne refuse jamais.** Chaque contrôle est une heuristique :
 * un `allowedHosts` peut se composer dynamiquement, un serveur peut écouter
 * partout à cause d'une variable d'environnement. Bloquer sur une supposition
 * serait pire que le silence actuel — c'est tout l'inverse du refus d'un
 * `public_domain` en double dans `up.ts`, qui repose sur un fait vérifié.
 */

import type { Target } from "./manifest.ts";
import type { Plan } from "./plan.ts";

export interface Avertissement {
  /** Identifiant stable, pour qu'un test parle du même contrôle que le code. */
  code: string;
  message: string;
}

/**
 * Où un front vit par convention quand il n'est pas à la racine. Partagé avec
 * `suggestedCommand` (`actions.ts`) : les deux cherchent le même dossier, pour
 * la même raison, et une liste dupliquée finirait par diverger.
 */
export const SOUS_DOSSIERS_FRONT: readonly string[] = ["frontend", "front", "web", "client", "ui", "app"];

const VITE_CONFIGS: readonly string[] = ["vite.config.ts", "vite.config.js", "vite.config.mts", "vite.config.mjs"];

/** Leur seule présence suffit à reconnaître un projet JVM — on ne les lit pas. */
const MARQUEURS_JVM: readonly string[] = ["gradlew", "build.gradle.kts", "build.gradle", "pom.xml"];

/**
 * Les chemins à lire, relatifs au dossier source, avant d'appeler `preflight`.
 * Listés ici plutôt que dans `up.ts` pour que la connaissance de ce qui est
 * regardé reste avec les contrôles qui s'en servent.
 */
export const CHEMINS_SONDES: readonly string[] = [
  ...["", ...SOUS_DOSSIERS_FRONT].flatMap((dossier) =>
    VITE_CONFIGS.map((nom) => (dossier === "" ? nom : `${dossier}/${nom}`)),
  ),
  ...MARQUEURS_JVM,
];

export function preflight(plan: Plan, target: Target, fichiers: Map<string, string>): Avertissement[] {
  const avis: Avertissement[] = [];

  // Le nom que le sidecar annoncera sur le tailnet — c'est lui qui arrivera en
  // en-tête `Host`, et c'est donc lui qu'il faut autoriser.
  const hote = plan.url.replace(/^https?:\/\//, "");

  const vite = [...fichiers].find(([chemin]) => VITE_CONFIGS.some((nom) => chemin.endsWith(nom)));

  // Ces deux contrôles ne concernent que les modes qui servent un serveur de
  // développement. Le mode `deployed` sert une app déjà construite.
  if (target.mode !== "deployed" && vite !== undefined) {
    const [chemin, contenu] = vite;

    if (!contenu.includes("allowedHosts")) {
      avis.push({
        code: "vite-allowed-hosts",
        message:
          `${chemin} n'a pas d'« allowedHosts » : Vite ≥ 5.4.12 répond 403 à un Host qu'il ne connaît pas, ` +
          `et celui du sidecar sera « ${hote} ». Ajoute allowedHosts: ['${hote}'] dans server, ` +
          `sinon le contrôle de santé échouera sans autre explication`,
      });
    }

    // « allowedHosts » contient « Hosts », pas « host » : la limite de mot et
    // la casse évitent de le prendre pour un réglage d'écoute.
    const commande = target.command;
    if (!/\bhost\s*:/.test(contenu) && !commande.includes("--host")) {
      const qui =
        target.mode === "workspace"
          ? "le sidecar joint ta machine par host.docker.internal"
          : "le sidecar joint le conteneur par son nom sur le réseau interne";
      avis.push({
        code: "ecoute-locale",
        message:
          `${chemin} ne pose pas « host » et la commande n'a pas « --host » : un serveur lié à la boucle ` +
          `locale reste injoignable, ${qui} — jamais 127.0.0.1`,
      });
    }
  }

  const marqueur = MARQUEURS_JVM.find((nom) => fichiers.has(nom));
  if (target.mode === "devcontainer" && marqueur !== undefined) {
    if (target.dockerfile === null) {
      avis.push({
        code: "devcontainer-sans-jdk",
        message:
          `${marqueur} présent mais aucun « dockerfile » : l'image par défaut est une image Node, sans JDK — ` +
          `la commande ne démarrera jamais. Écris un Dockerfile de développement et pose son chemin`,
      });
    }
    if (target.data === null) {
      const cache = marqueur === "pom.xml" ? "$HOME/.m2" : "$HOME/.gradle";
      avis.push({
        code: "cache-jvm-volatil",
        message:
          `aucun « data » : le cache de dépendances (${cache}) vit dans le conteneur et disparaît à chaque ` +
          `recréation — tout se retéléchargera. Pose data sur ce chemin pour lui donner un volume nommé`,
      });
    }
  }

  return avis;
}
