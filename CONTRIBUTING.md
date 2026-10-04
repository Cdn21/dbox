# DBox — contribuer

Outil de self-host : on pose du code, DBox monte le réseau. Une cible déployée
devient `https://<nom>.mon-tailnet.ts.net` — sans port ouvert, sans DNS, sans
certificat à gérer.

**Le modèle, le manifeste et les arbitrages sont dans `doc/REFERENCE.md`**, la
structure du code et ses diagrammes dans `doc/ARCHITECTURE.md` et `doc/UML.md`.
Les lire avant de proposer un changement de conception ; ne pas les paraphraser
ici. Toute la documentation vit dans `doc/` (index : `doc/README.md`).

## Lancer les choses

⚠️ **Ne jamais synchroniser `deploy/` en entier vers une autre machine**
(`tar czf - src deploy | ssh ...`) : `.env` et `ts.env` y vivent, non suivis
par git, propres à chaque machine. Un tel envoi écrase la config de la
machine cible avec celle de la machine source — vécu en vrai le 14 août
2026 (`serve` renommé `dbox-dev` par la config de pc-cde). Ne synchroniser
que `src` seul ; `deploy/docker-compose.yml`/`Dockerfile` changent rarement
et se copient à la main si besoin.

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"   # node n'est PAS dans le PATH d'un shell non interactif
node --test test/*.test.ts                          # 563 tests, ~600 ms
npm run typecheck                                    # tsc --noEmit ; npm install d'abord si node_modules manque
node src/cli.ts plan examples/budget --tailnet mon-tailnet.ts.net
node src/cli.ts up <dossier> --target prod          # nécessite Docker + le tailnet
node src/cli.ts ls --root /home/serve/dbox/apps     # inventaire
node src/cli.ts rm <app> --root ... [--target <cible>] [--yes]  # arrête et supprime
```

## Contraintes du projet

- **Zéro dépendance à l'exécution.** Le parseur TOML et l'émetteur YAML sont
  maison et volontairement partiels. Ne pas ajouter de paquet chargé au
  runtime sans le dire explicitement. **Exception assumée, outillage seul** :
  `typescript`/`@types/node` en devDependencies, pour `npm run typecheck`
  (`tsc --noEmit`, jamais utilisé pour générer le JS exécuté — Node continue
  d'effacer les types lui-même). `node_modules` existe donc localement,
  gitignored ; `package-lock.json` est commité pour que l'outillage reste
  reproductible. Rien de tout ça ne tourne en production.
- **Node 24 exécute le TypeScript en effaçant les types, sans les générer.** Donc :
  pas de propriétés de constructeur (`constructor(readonly x: T)`), pas d'`enum`,
  pas de décorateurs, et **les imports portent l'extension `.ts`**.
- **Commentaires, messages d'erreur et noms de tests en français.** Les identifiants
  de code restent en anglais.
- Les commentaires expliquent *pourquoi*, pas *quoi*. Beaucoup encodent un piège
  précis — ne pas les supprimer en « nettoyant ».

## Carte du code

| fichier | rôle |
| --- | --- |
| `toml.ts` | parseur TOML, sous-ensemble ; refuse tout le reste avec la ligne |
| `yaml.ts` | émetteur YAML ; citation conservatrice |
| `manifest.ts` | `dbox.toml` → manifeste validé ; **les messages d'erreur sont le produit** |
| `compose.ts` | une cible → objet Compose |
| `tsserve.ts` | config `tailscale serve` du sidecar |
| `plan.ts` | manifeste → liste de fichiers (dont `dbox.json`) ; **pur** |
| `preflight.ts` | ce qui va casser, dit **avant** de construire ; **pur**, et ne refuse jamais |
| `lecture.ts` | lire un fichier du projet sans risquer de bloquer (fichier ordinaire, taille bornée) |
| `registry.ts` | inventaire : le système de fichiers **est** le registre |
| `writer.ts` | matérialise un plan ; gère `preserveIfExists` |
| `state.ts` | `state.json` : quelle version est déployée |
| `tag.ts` | SHA git court, `-sale` si l'arbre est modifié |
| `versions.ts` | lien vers le commit déployé, commits de la source non déployés ; **jamais de `fetch`** |
| `docker.ts` | appels `docker compose` |
| `health.ts` | attente active sur l'URL finale |
| `up.ts` | orchestration ; **toutes les dépendances externes sont injectées** |
| `server.ts` | daemon HTTP ; l'aiguillage est **pur**, la glu HTTP est mince |
| `actions.ts` | start / stop / logs / redéploiement / suppression — les commandes qu'on taperait |
| `jobs.ts` | tâches longues, en mémoire ; la vérité reste dans `state.json` |
| `protocol.ts` | en-têtes partagés serveur/page (évite un import circulaire) |
| `config.ts` | `~/.config/dbox/config.toml` ; la CLI garde le dernier mot |
| `env.ts` | le `.env` d'une cible : `CLÉ=valeur`, rien d'autre |
| `authkey.ts` | avertissement d'expiration ; absent ou mal formé = silence, jamais une erreur |
| `init.ts` | déduit nom, port et volume du dossier et du Dockerfile |
| `sources.ts` | clone / pull / fetch-et-compare d'un dépôt — pas de cache maison |
| `poller.ts` | sondage `auto_deploy` ; jamais de webhook, ça exposerait un port |
| `tailscale.ts` | appel brut à l'API Tailscale : créer une clé, lister les appareils |
| `rotate.ts` | régénère la clé si l'échéance approche, révoque l'ancienne ; jamais appelé par le daemon |
| `orphans.ts` | signale les nœuds `tag:dbox` inactifs depuis longtemps ; rapport seul |
| `orphans-report.ts` | format du rapport ; écrit par `orphans.ts`, lu par `server.ts` |
| `tagcheck.ts` | vérifie `--ts-tag` dans `tagOwners` ; lecture seule, jamais d'écriture de l'ACL |
| `tag-report.ts` | format du rapport ; écrit par `tagcheck.ts`, lu par `server.ts` |
| `sshkey.ts` | clé SSH dédiée aux clonages ; jamais celle de la personne |
| `machines.ts` | autres machines DBox connues (nom + URL) ; JSON, propre à chaque machine |
| `ui/` | l'interface, rendue côté serveur (htmx/Alpine, sans CDN) — **`server.ts` n'importe que `ui/index.ts`**, le découpage interne ne le regarde pas |
| `ui/html.ts` | `escape`, `domId`, `slug` — l'échappement garde l'invariant 8 |
| `ui/chrome.ts` | le décor : style, script, icônes, sélecteur de machine |
| `ui/cartes.ts` | la liste des apps, une carte par cible |
| `ui/ajout.ts` | le formulaire d'ajout (dépôt git ou dossier local) |
| `ui/panneaux.ts` | les panneaux d'une carte, et les fragments des actions |
| `ui/reglages.ts` | `/settings` — presque tout en lecture seule |
| `ui/page.ts` | la page d'accueil ; elle n'assemble que |
| `vendor.ts` | htmx et Alpine vendorisés (`src/vendor/`), servis par le daemon lui-même |
| `cli.ts` | `setup`, `init`, `plan`, `up`, `ls`, `add` et `serve` |

## Invariants — un test garde chacun, ne pas les casser

1. **Aucun `ports:` ni `expose:` dans le Compose généré**, quel que soit le mode.
   C'est *la* propriété du mode privé : l'app n'est joignable que par le sidecar.
2. **`${TS_CERT_DOMAIN}` reste littéral** dans `serve.json` — c'est le conteneur
   Tailscale qui l'interpole.
3. **`ts.env` et `.env` ne sont jamais réécrits** s'ils existent : ils contiennent
   la clé d'auth et les secrets.
4. **Un échec de construction ne touche à rien** ; un échec de santé revient à
   l'image précédente ; une cible de développement n'est jamais coupée.
5. **Le YAML cite ce qui serait mal relu** : booléens déguisés (`no`, `on`),
   nombres en chaîne (`"8080"`), et sexagésimal (`user: "1000:1000"`).
6. **Un volume de données est nommé, jamais anonyme** : un volume anonyme
   disparaît au premier `down -v`, et la base de l'app avec.
7. **Pas de champ « montages » dans le manifeste** : il donnerait à n'importe
   quelle app le moyen de réclamer le socket Docker, donc root sur l'hôte. DBox
   s'amorce par `deploy/docker-compose.yml`, écrit à la main.
8. **Tout ce qui vient du disque est échappé avant d'entrer dans la page.**
9. **Pas d'identité Tailscale, pas de réponse** (sauf `/health`) ; et toute
   écriture exige l'en-tête `x-dbox-action`, sinon un site tiers pourrait
   déclencher un déploiement avec l'identité injectée par le proxy.
10. **`dbox up` amorce le manifeste s'il manque, jamais s'il existe** — même
    invalide. `plan` n'y touche jamais, il promet de ne rien écrire.
11. **Enregistrer un réglage ne démarre jamais une cible arrêtée**, et
    régénérer un plan n'écrase pas le tag d'image déployé (sinon le prochain
    démarrage tenterait de reconstruire, voire de télécharger).
12. **Un tailnet non renseigné est un refus, pas un gabarit** : `<tailnet>` se
    retrouverait dans `dbox.json`, le contrôle de santé et la page.
13. **`auto_deploy` n'existe pas en mode `workspace`** : sans conteneur d'app,
    rien à reconstruire. Le sondeur ne fait jamais de `fetch` sur une cible
    déjà en cours de redéploiement (manuel ou automatique).
14. **Une clé SSH générée ne s'écrase jamais** — même règle que `ts.env`/`.env` :
    une clé déjà collée dans GitHub/GitLab ne doit jamais devenir invalide
    parce qu'on a cliqué le bouton deux fois.
15. **Le parseur TOML n'ignore jamais rien en silence** — une clé mal orthographiée
   doit exploser, pas disparaître.
16. **Supprimer une cible (`rm`) ne touche ni au dossier source ni aux volumes
    nommés** — `down` sans `--volumes`. Le dossier source peut servir à
    d'autres cibles de la même app ; un volume de données ne se reconstruit
    pas. Rien n'est supprimé non plus si `down` échoue, ni si un redéploiement
    de cette cible est en cours.
17. **`ssh_port` ne publie rien non plus** : le forward TCP brut passe par le
    sidecar Tailscale (`TCPForward` dans `serve.json`), jamais par un `ports:`
    Docker — même invariant 1, même mécanisme que le proxy HTTPS. Toujours sur
    le 22 externe, jamais un autre port : le seul cas d'usage est du SSH, et un
    port externe différent surprendrait n'importe quel client `git`/`ssh`
    standard.

## Conventions

- Nom de machine : la cible `prod` porte le nom nu (`budget`), les autres sont
  suffixées (`budget-dev`). Valider la **longueur composée**, pas seulement `name`.
- `name` est un label DNS : minuscules, chiffres, tirets, 63 max.
- Le contrôle de santé interroge l'URL finale, pas le conteneur → la machine qui
  exécute DBox doit être sur le tailnet.

## État, décisions, contexte machine

Volontairement absents d'ici : l'avancement du projet, les décisions propres
à cette installation, et le détail des machines qui la font tourner vivent
dans un fichier local, non suivi, jamais publié avec le reste du dépôt. Ce
fichier-ci reste générique — utile à quiconque lirait ou contribuerait au
code, indépendamment de qui l'a déployé où.
