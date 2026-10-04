# Diagrammes UML

Diagrammes de DBox, en [Mermaid](https://mermaid.js.org) : Forgejo et GitHub les
affichent directement, et ils restent du texte, relu et versionné comme le code.
Ils illustrent le [dossier d'architecture](ARCHITECTURE.md), qui y renvoie par
numéro.

Les noms de types et de fonctions sont ceux du code (`src/`). Un diagramme qui
contredit le code est faux : c'est le code qui fait foi.

| # | Diagramme | Type UML |
| --- | --- | --- |
| 1 | [Contexte](#1-contexte) | Cas d'utilisation / contexte |
| 2 | [Composants et dépendances](#2-composants-et-dépendances) | Composants |
| 3 | [Modèle du domaine](#3-modèle-du-domaine) | Classes |
| 4 | [`dbox up`](#4-séquence--dbox-up) | Séquence |
| 5 | [Redéployer depuis le tableau de bord](#5-séquence--redéployer-depuis-le-tableau-de-bord) | Séquence |
| 6 | [Gardes d'une requête HTTP](#6-séquence--gardes-dune-requête-http) | Séquence |
| 7 | [Déploiement continu du daemon](#7-séquence--déploiement-continu-du-daemon) | Séquence |
| 8 | [Cycle de vie d'une tâche](#8-états--une-tâche-job) | États |
| 9 | [État d'une cible](#9-états--une-cible) | États |
| 10 | [Un passage de `maj-auto.sh`](#10-activité--un-passage-de-maj-autosh) | Activité |
| 11 | [Le registre sur le disque](#11-le-registre-sur-le-disque) | Objets / données |
| 12 | [Déploiement physique](#12-déploiement) | Déploiement |
| 13 | [Décisions de `up()`](#13-activité--up) | Activité |

---

## 1. Contexte

Qui utilise DBox, et avec quels systèmes il parle.

```mermaid
flowchart LR
  personne(["Personne<br/>navigateur · téléphone · terminal"])

  subgraph machine["Machine hôte"]
    cli["CLI dbox"]
    daemon["Daemon DBox<br/>(dbox serve)"]
    rotator["authkey-rotator"]
    docker[("Docker Engine")]
    apps["Cibles déployées<br/>app + sidecar Tailscale"]
  end

  tailnet{{"Tailnet<br/>noms, TLS, identité"}}
  api["API Tailscale"]
  forge["Forge git"]
  traefik["Traefik préexistant<br/>(optionnel)"]
  internet(["Internet"])

  personne -- "HTTPS privé" --> tailnet
  tailnet -- "identité injectée" --> daemon
  tailnet --> apps
  personne -- "shell sur la machine" --> cli
  cli -- "socket" --> docker
  daemon -- "socket" --> docker
  docker --> apps
  daemon -- "clone · pull · fetch" --> forge
  rotator -- "clés · appareils · tagOwners" --> api
  internet -- "HTTPS public" --> traefik
  traefik -- "réseau Docker partagé" --> apps
```

## 2. Composants et dépendances

Les flèches suivent les `import` réels de `src/`. Seuls les modules du noyau
pur n'en ont aucun vers les adaptateurs.

```mermaid
flowchart TB
  subgraph entree["Points d'entrée"]
    cli[cli.ts]
    server[server.ts]
    ui["ui/index.ts<br/>page · cartes · panneaux · ajout · reglages · chrome · html"]
  end

  subgraph orch["Orchestration (effets injectés)"]
    up[up.ts]
    actions[actions.ts]
    registry[registry.ts]
    jobs[jobs.ts]
    poller[poller.ts]
    rotate[rotate.ts]
    orphans[orphans.ts]
    tagcheck[tagcheck.ts]
  end

  subgraph noyau["Noyau pur"]
    toml[toml.ts]
    manifest[manifest.ts]
    compose[compose.ts]
    tsserve[tsserve.ts]
    yaml[yaml.ts]
    plan[plan.ts]
    preflight[preflight.ts]
    init[init.ts]
    env[env.ts]
  end

  subgraph adapt["Adaptateurs"]
    docker[docker.ts]
    health[health.ts]
    writer[writer.ts]
    state[state.ts]
    tag[tag.ts]
    versions[versions.ts]
    sources[sources.ts]
    sshkey[sshkey.ts]
    lecture[lecture.ts]
    tailscale[tailscale.ts]
    fichiers["config.ts · machines.ts · authkey.ts<br/>orphans-report.ts · tag-report.ts · vendor.ts"]
  end

  cli --> up & actions & registry & server & poller & rotate & orphans & tagcheck & versions
  server --> actions & registry & jobs & ui
  ui --> registry
  actions --> up & registry & sources & sshkey & lecture & init & env & state & tag & writer
  poller --> jobs & registry & sources & up
  registry --> plan & manifest
  up --> plan & compose & preflight & docker & health & writer
  rotate --> tailscale
  orphans --> tailscale
  plan --> compose & tsserve & yaml & manifest
  compose --> manifest & yaml
  preflight --> plan
  manifest --> toml
  sources --> docker & sshkey
  writer --> plan
```

## 3. Modèle du domaine

Les types centraux. `Target` est une **union discriminée** par `mode` : chaque
variante ne porte que les champs qui ont un sens pour elle (pas de
`publicDomain` ni de compagnons en `workspace`, pas d'`autoDeploy` non plus).

```mermaid
classDiagram
  direction LR

  class Manifest {
    +name: string
    +targets: Record~string, Target~
  }

  class Target {
    <<union>>
    mode: Mode
    port: number
    health: string
    tsTag: string | null
    sshPort: number | null
  }
  class WorkspaceTarget {
    mode = "workspace"
    command: string
  }
  class DevcontainerTarget {
    mode = "devcontainer"
    command: string
    image: string
    dockerfile: string | null
    data: string | null
    autoDeploy: boolean
    publicDomain: string | null
  }
  class DeployedTarget {
    mode = "deployed"
    dockerfile: string
    data: string | null
    autoDeploy: boolean
    publicDomain: string | null
  }
  class CompanionService {
    image: string
    data: string | null
  }

  class Context {
    root: string
    tailnet: string
    uid: number
    gid: number
    tsTag: string | null
    imageTag: string
    tailscaleImage: string
    sourcePath: string
    traefik: TraefikConfig | null
  }

  class Plan {
    app: string
    target: string
    mode: Mode
    builds: boolean
    project: string
    hostname: string
    url: string
    healthUrl: string
    upstream: string
    directory: string
    publicDomain: string | null
    services: string[]
  }
  class PlannedFile {
    path: string
    content: string
    mode?: number
    preserveIfExists?: boolean
  }
  class Descriptor {
    <<dbox.json>>
    app: string
    target: string
    mode: Mode
    hostname: string
    url: string
    healthUrl: string
    project: string
    source: string
    autoDeploy: boolean
    services: string[]
    publicDomain: string | null
  }
  class State {
    <<state.json>>
    tag: string
    previousTag: string | null
    deployedAt: string
  }
  class Entry {
    descriptor: Descriptor
    state: State | null
    status: Status
    containers: Container[]
    directory: string
  }
  class Container {
    name: string
    state: string
  }

  class Jobs {
    -jobs: Map~string, Job~
    +start(label) Job
    +append(job, line)
    +finish(job, ok)
    +get(id) Job | null
    +runningFor(label) Job | null
    +list() Job[]
  }
  class Job {
    id: string
    label: string
    status: JobStatus
    lines: string[]
    startedAt: number
    endedAt: number | null
  }

  class UpResult {
    ok: boolean
    plan: Plan
    tag: string
    failure: Failure | null
    detail: string | null
    rolledBackTo: string | null
  }

  Manifest "1" *-- "1..*" Target
  Target <|-- WorkspaceTarget
  Target <|-- DevcontainerTarget
  Target <|-- DeployedTarget
  DevcontainerTarget "1" *-- "*" CompanionService : services
  DeployedTarget "1" *-- "*" CompanionService : services
  Plan "1" *-- "4..5" PlannedFile : files
  Plan ..> Descriptor : sérialisé dans dbox.json
  Manifest ..> Plan : planFor(manifest, cible, Context)
  Context ..> Plan
  Entry --> Descriptor
  Entry --> State
  Entry "1" o-- "*" Container
  Jobs "1" o-- "0..*" Job
  UpResult --> Plan
```

Les interfaces de dépendances, injectées par `cli.ts` et remplacées par des
doublures dans les tests :

```mermaid
classDiagram
  direction LR
  class UpDeps {
    <<interface>>
    compose: Compose
    probe: Probe
    writeFiles(files)
    seedAuthKey(outcomes, keyFile)
    readState(dir) / writeState(dir, state)
    listDescriptors()
    readSource(path)
    sleep(ms) / now() / log(line)
  }
  class Deps {
    <<interface — server.ts>>
    scan() Entry[]
    now()
    actions?: Actions
    authkeyNotice?() / adminAuthkeyNotice?()
    orphansReport?() / tagReport?()
    machines?() / listWorkspaces?()
  }
  class Actions {
    <<interface — server.ts>>
    compose: Compose
    jobs: Jobs
    redeploy(entry, log) UpResult
    remove(entry)
    add?(url, name, log, choice)
    addLocal?(path, log, choice)
    readFile / writeFile
    generateSshKey?() / generateAppSshKey?(app)
    saveMachines?(entries)
  }
  class up {
    <<function — up.ts>>
    up(options, deps) UpResult
  }
  class route {
    <<function — server.ts>>
    route(method, path, headers, deps, query, body) Response
  }
  up ..> UpDeps : utilise
  route ..> Deps : utilise
  Deps --> Actions
```

## 4. Séquence — `dbox up`

Le chemin nominal, puis les deux échecs qui comptent. Un échec de construction
s'arrête **avant** `up -d` : la version en place continue de tourner.

```mermaid
sequenceDiagram
  autonumber
  actor P as Personne
  participant CLI as cli.ts
  participant Up as up.ts
  participant Plan as plan.ts
  participant Pre as preflight.ts
  participant W as writer.ts
  participant D as docker compose
  participant H as health.ts
  participant S as state.json

  P->>CLI: dbox up <dossier>
  CLI->>CLI: lit dbox.toml (l'écrit s'il manque)<br/>config machine, tag = SHA git
  CLI->>Up: up(options, deps réelles)
  Up->>Plan: planFor(manifest, cible, ctx)
  Plan-->>Up: Plan (fichiers, URL, projet)
  Up->>S: readState() — version précédente
  opt public_domain
    Up->>Up: domaine déjà pris par une autre cible ?
    Note right of Up: oui → refus « domaine », rien n'est écrit
  end
  Up->>Pre: preflight(plan, cible, fichiers lus)
  Pre-->>Up: avertissements (jamais un refus)
  Up->>W: writeFiles(plan.files)<br/>.env et ts.env préservés s'ils existent
  Up->>W: seedAuthKey() si ts.env vient d'être créé
  alt mode deployed ou image de dev
    Up->>D: build
    D-->>Up: code ≠ 0 → échec « construction », fin
  end
  Up->>D: up -d --remove-orphans
  Up->>H: waitUntilHealthy(URL finale, 180 s)
  alt sain
    Up->>S: writeState(tag, previousTag, date)
    Up-->>CLI: ok · URL
  else pas sain
    Up->>D: retour à l'image previous.tag (mode deployed)
    Up-->>CLI: échec « santé », rolledBackTo
  end
  CLI-->>P: en ligne · https://<nom>.<tailnet>.ts.net
```

## 5. Séquence — redéployer depuis le tableau de bord

Un redéploiement dure des minutes : la requête rend tout de suite un fragment
qui suit une **tâche**, et htmx interroge cette tâche jusqu'à la fin.

```mermaid
sequenceDiagram
  autonumber
  actor P as Navigateur (htmx)
  participant TS as Sidecar Tailscale
  participant Srv as server.ts route()
  participant J as Jobs
  participant A as actions.ts
  participant G as git
  participant Up as up.ts

  P->>TS: POST /api/apps/budget/prod/up<br/>x-dbox-action: 1
  TS->>Srv: + Tailscale-User-Login
  Srv->>Srv: identité ? en-tête d'action ? cible connue ?
  Srv->>J: track(label) — runningFor(label) ?
  alt déjà en cours (bouton ou sondage auto_deploy)
    Srv-->>P: 200 · fragment qui suit la tâche existante
  else libre
    Srv->>J: start(label)
    Srv-->>P: 200 · fragment qui suit la nouvelle tâche
    Srv-)A: redeploy(entry, log)
    A->>G: pull --ff-only (si la source est un dépôt)
    A->>Up: up(…) — chaque ligne → Jobs.append
    Up-->>A: UpResult
    A-->>J: finish(job, ok)
  end
  loop toutes les 1,5 s (hx-trigger), tant que « en cours »
    P->>Srv: GET /api/jobs/<id>
    Srv-->>P: fragment : lignes du journal + statut
  end
```

## 6. Séquence — gardes d'une requête HTTP

L'ordre des contrôles dans `route()`. Les erreurs de protocole gardent leur code
HTTP ; une action qui échoue répond 200 avec le résultat dans le HTML.

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant R as route()

  C->>R: requête
  alt chemin = /health
    R-->>C: 200 ok (contrôle local du conteneur)
  else pas d'en-tête d'identité Tailscale
    R-->>C: 401
  else GET / HEAD
    R-->>C: page, fragment, JSON ou 404
  else méthode ≠ POST
    R-->>C: 405
  else pas d'en-tête x-dbox-action
    R-->>C: 400
  else POST valide
    R->>R: aiguillage : ajout, machines, clé SSH,<br/>env, manifeste, start/stop/restart/remove/up
    R-->>C: 200 · actionResult(ok | erreur)
  end
```

## 7. Séquence — déploiement continu du daemon

Personne ne pousse vers les machines : elles tirent.

```mermaid
sequenceDiagram
  autonumber
  actor Dev as Mainteneur
  participant F as Forge (main protégée)
  participant CI as CI (runner isolé)
  participant M as Machine — cron */5
  participant DC as docker compose (deploy/)

  Dev->>F: push main
  F->>CI: workflow ci
  CI->>CI: npm ci · typecheck · tests
  alt tout vert
    CI->>F: production ← SHA (avance rapide seulement)
  end
  M->>F: git fetch production main (clé de déploiement, lecture seule)
  M->>M: déjà déployé ou déjà en échec ? → fin, en silence
  M->>M: commit absent de main, ou antérieur<br/>à la version en place ? → refus, noté en échec
  M->>M: git reset --hard SHA
  M->>DC: build daemon
  M->>DC: up -d daemon authkey-rotator
  M->>DC: attendre healthy · version en service = SHA ?
  alt succès
    M->>M: .git/dbox-deploye ← SHA
  else échec
    M->>M: .git/dbox-echec ← SHA
    M->>DC: reconstruire et relancer la version précédente
  end
```

## 8. États — une tâche (`Job`)

```mermaid
stateDiagram-v2
  [*] --> en_cours: Jobs.start(label)
  en_cours --> en_cours: append(ligne)<br/>500 lignes au plus
  en_cours --> réussi: finish(job, true)
  en_cours --> échoué: finish(job, false)
  réussi --> [*]: élaguée au-delà des 20 dernières
  échoué --> [*]: élaguée au-delà des 20 dernières

  state "en cours" as en_cours
```

Une tâche vit en mémoire : un redémarrage du daemon l'efface. La vérité durable
— quelle version tourne — reste `state.json`.

## 9. États — une cible

Le statut affiché est **calculé** à chaque lecture (`statusOf`), à partir des
conteneurs du projet Compose ; il n'est stocké nulle part.

```mermaid
stateDiagram-v2
  state "jamais démarrée" as jamais
  state "en marche" as marche
  state "arrêtée" as arretee
  state "partielle" as partielle
  state "redémarre" as redemarre

  [*] --> jamais: dossier généré, aucun conteneur
  jamais --> marche: up · start
  marche --> arretee: stop
  arretee --> marche: start · restart · redéploiement
  marche --> partielle: un conteneur s'arrête
  partielle --> marche: restart
  marche --> redemarre: un conteneur boucle<br/>(souvent : sidecar hors du tailnet)
  redemarre --> marche: corrigé, redéployé
  marche --> [*]: rm — down sans --volumes,<br/>dossier généré supprimé
  arretee --> [*]: rm
```

| Règle (`registry.ts`) | Statut |
| --- | --- |
| aucun conteneur | jamais démarrée |
| au moins un `restarting` | redémarre |
| tous `running` | en marche |
| aucun `running` | arrêtée |
| sinon | partielle |

## 10. Activité — un passage de `maj-auto.sh`

```mermaid
flowchart TD
  debut([cron · toutes les 5 min]) --> verrou{flock libre ?}
  verrou -- non --> fin([fin, en silence])
  verrou -- oui --> fetch[git fetch production main]
  fetch --> deja{SHA déjà déployé<br/>ou déjà en échec ?}
  deja -- oui --> fin
  deja -- non --> main{SHA contenu<br/>dans main ?}
  main -- non --> refus[noter en échec · journal « refus »] --> fin
  main -- oui --> avant{descend de la version<br/>en place, ou FORCER ?}
  avant -- non --> refus
  avant -- oui --> reset[git reset --hard SHA]
  reset --> build{docker compose build}
  build -- échec --> echec
  build -- ok --> upd{up -d daemon<br/>authkey-rotator}
  upd -- échec --> echec
  upd -- ok --> sante{healthy en 90 s<br/>et version = SHA ?}
  sante -- oui --> ok[noter déployé] --> fin
  sante -- non --> echec[noter en échec]
  echec --> prec{version précédente<br/>connue ?}
  prec -- non --> alerte[journal : rien vers quoi revenir] --> fin
  prec -- oui --> retour[redéployer la précédente] --> fin
```

## 11. Le registre sur le disque

Pas de base de données : chaque dossier de cible est auto-descriptif.

```mermaid
flowchart LR
  root["&lt;root&gt;/"] --> app["budget/"]
  app --> prod["prod/"]
  app --> dev["dev/"]
  prod --> c["docker-compose.yml<br/><i>généré</i>"]
  prod --> s["serve.json<br/><i>généré</i>"]
  prod --> d["dbox.json · Descriptor<br/><i>généré à chaque plan</i>"]
  prod --> st["state.json · State<br/><i>écrit sur succès</i>"]
  prod --> e[".env · 0600<br/><i>jamais réécrit</i>"]
  prod --> t["ts.env · 0600<br/><i>jamais réécrit</i>"]
  prod --> tss["ts-state/<br/><i>nœud Tailscale</i>"]

  scan(["registry.scan()"]) -. "lit dbox.json + state.json" .-> prod
  scan -. "un seul docker ps --all" .-> ps[(Docker)]
```

## 12. Déploiement

Deux machines, chacune autonome. Les noms d'hôte (`dbox`, `dbox-dev`) viennent de
`DBOX_HOSTNAME` ; la cible gérée, de `target` dans la configuration de la machine.

```mermaid
flowchart TB
  subgraph serveur["Serveur — target = prod"]
    direction TB
    subgraph daemonS["Projet dbox-daemon"]
      dS["daemon<br/>UID 1000 · socket Docker"]
      tS["tailscale<br/>tag:dbox-admin → dbox"]
      rS["authkey-rotator<br/>réseau à part · token API"]
    end
    subgraph appP["Projet dbox-budget-prod"]
      aP["app<br/>dbox/budget:SHA"]
      tP["tailscale<br/>tag:dbox → budget"]
      cP[("db · volume nommé")]
    end
    cron1["cron · maj-auto.sh<br/>clone ~/dbox/tool"]
    tr["Traefik (optionnel)"]
  end

  subgraph poste["Poste de travail — target = dev"]
    direction TB
    subgraph daemonP["Projet dbox-daemon"]
      dP["daemon"]
      tPd["tailscale → dbox-dev"]
      rP["authkey-rotator"]
    end
    subgraph appD["Projet dbox-budget-dev"]
      aD["app (devcontainer)<br/>sources bind-montées"]
      tD["tailscale → budget-dev"]
    end
    cron2["cron · maj-auto.sh"]
  end

  tailnet{{"Tailnet"}}
  forge["Forge git<br/>main · production"]

  tS --- tailnet
  tP --- tailnet
  tPd --- tailnet
  tD --- tailnet
  tS -->|"proxy daemon:8099"| dS
  tP -->|"proxy app:port"| aP
  aP --> cP
  tD -->|"proxy app:port"| aD
  tPd --> dP
  tr -. "réseau partagé" .-> aP
  cron1 -->|"fetch"| forge
  cron2 -->|"fetch"| forge
```

## 13. Activité — `up()`

Toutes les décisions de `up.ts`, dans l'ordre où le code les prend.

```mermaid
flowchart TD
  s([up options, deps]) --> plan[planFor] --> prev[readState : version précédente]
  prev --> dom{public_domain<br/>déjà pris ?}
  dom -- oui --> fDom([échec « domaine » · rien écrit])
  dom -- non --> pre[preflight → avertissements journalisés]
  pre --> write[writeFiles · .env/ts.env préservés]
  write --> seed[seedAuthKey si ts.env neuf]
  seed --> builds{plan.builds ?}
  builds -- oui --> b{compose build}
  b -- échec --> fBuild([échec « construction » · rien redémarré])
  b -- ok --> start
  builds -- non --> start{compose up -d}
  start -- échec --> rb1[rollback] --> fStart([échec « démarrage »])
  start -- ok --> health{santé sur l'URL finale<br/>avant expiration ?}
  health -- oui --> state[writeState] --> ok([ok])
  health -- non --> rb2[rollback] --> fHealth([échec « santé »])

  rb1 -.-> rbq
  rb2 -.-> rbq
  rbq{mode deployed<br/>et version précédente ?}
  rbq -- non --> keep[laisser en marche, à inspecter]
  rbq -- oui --> back[relancer l'image previousTag<br/>données non restaurées]
```
