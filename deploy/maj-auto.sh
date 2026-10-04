#!/usr/bin/env bash
# Met à jour le daemon DBox de CETTE machine quand la branche `production` avance.
#
# `production` n'avance que lorsque la CI Forgejo a validé un commit de `main`
# (voir .forgejo/workflows/ci.yml) : ce script ne déploie donc jamais un commit
# non testé. Il tire, il n'est jamais poussé — aucune clé vers la machine n'entre
# dans la CI.
#
#   Automatique : cron, toutes les 5 minutes (voir doc/REFERENCE.md, « Déploiement continu »)
#   Manuel      : ~/dbox/tool/deploy/maj-auto.sh
#   Forcer      : DBOX_MAJ_FORCER=1 ~/dbox/tool/deploy/maj-auto.sh
#                 (reconstruit même si la version en place est déjà la bonne,
#                 ou revient sciemment à une version plus ancienne)
#
# Ce dossier doit être un clone dédié au déploiement — pas un dossier de travail :
# `git reset --hard` y efface toute modification d'un fichier suivi. `deploy/.env`
# et `deploy/ts.env` ne sont pas suivis, donc jamais touchés.
#
# Comme deploy-to.sh, il ne redémarre que le daemon et le rotator : le sidecar
# Tailscale n'est pas recréé (le recréer couperait le tableau de bord du tailnet
# sans rien apporter), et les apps déployées par DBox vivent dans leurs propres
# projets Compose.
#
# Silencieux quand il n'y a rien à faire : le journal ne contient que de vrais
# événements.

set -euo pipefail

# Tout le corps est dans une fonction appelée à la toute fin : bash lit un script
# au fur et à mesure de son exécution, et ce script se remplace lui-même au
# `git reset --hard`. Sans ça, la suite serait lue dans la nouvelle version du
# fichier, à un décalage d'octets qui n'a plus de sens.
principal() {
  local depot branche etat echec cible construit version
  depot=$(cd "$(dirname "$0")/.." && pwd)
  branche=${DBOX_MAJ_BRANCHE:-production}
  # L'état vit dans .git : jamais suivi, et il ne salit pas l'arbre — un arbre
  # sale ferait étiqueter la version « -sale » sur /settings.
  etat="$depot/.git/dbox-deploye"
  echec="$depot/.git/dbox-echec"

  cd "$depot"

  # GIT_SSH_COMMAND l'emporte sur le `core.sshCommand` du clone. Une crontab qui
  # le pose pour une autre app (vécu sur serve) ferait donc passer git par la
  # mauvaise clé, et chaque fetch échouerait. Le clone sait quelle clé utiliser.
  unset GIT_SSH_COMMAND

  # Un seul passage à la fois : cron et un lancement manuel ne se marchent
  # jamais dessus (une construction peut durer plus que l'intervalle du cron).
  exec 9>"$depot/.git/dbox-maj.lock"
  flock -n 9 || return 0

  git fetch --quiet origin "$branche" main
  cible=$(git rev-parse "origin/$branche")
  construit=$(cat "$etat" 2>/dev/null || true)

  if [ "${DBOX_MAJ_FORCER:-}" != 1 ]; then
    [ "$construit" = "$cible" ] && return 0
    # Un commit qui a déjà échoué ici n'est pas retenté toutes les 5 minutes :
    # on attend le suivant, qui le corrigera.
    [ "$(cat "$echec" 2>/dev/null || true)" = "$cible" ] && return 0
  fi

  # Le jeton de la CI peut pousser `production`, et la CI tourne sur toutes les
  # branches : une branche qui réécrirait le workflow pourrait donc y pousser
  # n'importe quoi. `main`, elle, est protégée — seul un humain la pousse. Un
  # commit qu'elle ne contient pas n'est pas déployé, quel que soit le chemin
  # par lequel il est arrivé dans `production`.
  #   DBOX_MAJ_HORS_MAIN=1 lève ce refus, pour tester le déploiement depuis une
  #   branche jetable (DBOX_MAJ_BRANCHE=...) — jamais dans la crontab.
  if [ "${DBOX_MAJ_HORS_MAIN:-}" != 1 ] && ! git merge-base --is-ancestor "$cible" origin/main; then
    echo "$cible" >"$echec"
    journal "refus : $cible (origin/$branche) n'est pas dans main — rien n'est déployé"
    return 1
  fi

  # Ni en arrière : le jeton de la CI est présent dans TOUTES les étapes du job
  # (GITHUB_TOKEN/FORGEJO_TOKEN dans l'environnement, vérifié le 4 octobre 2026),
  # donc du code lancé par `npm ci` ou les tests peut ramener `production` sur un
  # ancien commit de main — qui passe le contrôle précédent. Redéployer une
  # version plus ancienne reste possible, mais délibérément : DBOX_MAJ_FORCER=1.
  if [ -n "$construit" ] && [ "${DBOX_MAJ_FORCER:-}" != 1 ] &&
    ! git merge-base --is-ancestor "$construit" "$cible" 2>/dev/null; then
    echo "$cible" >"$echec"
    journal "refus : $cible ne descend pas de la version en place ($construit) — retour en arrière ? DBOX_MAJ_FORCER=1 pour le vouloir"
    return 1
  fi

  # Pas d'apostrophe dans la valeur par défaut d'une expansion entre guillemets
  # doubles : bash y ouvrirait une chaîne qu'il ne referme jamais.
  local avant=${construit:-aucune version enregistrée}
  journal "déploiement $avant → $cible"

  if ! deployer "$cible"; then
    echo "$cible" >"$echec"
    if [ -n "$construit" ]; then
      journal "échec : retour à $construit"
      if deployer "$construit"; then
        journal "revenu à $construit — le daemon tourne, la nouvelle version est à corriger"
      else
        journal "le retour a échoué aussi : intervention manuelle nécessaire"
      fi
    else
      journal "échec, et aucune version précédente enregistrée vers laquelle revenir"
    fi
    return 1
  fi

  echo "$cible" >"$etat"
  rm -f "$echec"
  version=$(docker exec dbox-daemon-daemon-1 sh -c 'echo "$DBOX_VERSION"' 2>/dev/null || echo "?")
  journal "déployé : daemon $version, en bonne santé"
}

# deployer <commit> : extrait, construit, redémarre, attend la santé.
#
# Chaque étape est vérifiée EXPLICITEMENT (`|| return 1`), sans compter sur
# `set -e` : bash l'ignore dans une fonction appelée depuis un `if !`, et c'est
# ainsi qu'on l'appelle. Vécu : une construction en échec laissait passer le
# `up -d`, qui redémarrait l'ANCIENNE image — et le déploiement se disait réussi.
deployer() {
  local commit=$1 version etat_sante en_service err="$depot/.git/dbox-maj.err"
  git reset --hard --quiet "$commit" || return 1
  version=$(git rev-parse --short=12 HEAD) || return 1
  [ -n "$(git status --porcelain)" ] && version="$version-sale"

  # Construire d'abord, et s'arrêter là si ça échoue : rien n'a encore été
  # redémarré, la version en place continue de tourner.
  if ! (cd deploy && DBOX_VERSION="$version" docker compose build --quiet daemon) >/dev/null 2>"$err"; then
    journal "construction en échec :"
    sed 's/^/    /' "$err" | tail -15
    return 1
  fi
  if ! (cd deploy && DBOX_VERSION="$version" docker compose up -d daemon authkey-rotator) >/dev/null 2>"$err"; then
    journal "démarrage en échec :"
    sed 's/^/    /' "$err" | tail -15
    return 1
  fi

  # Docker rend la main dès que le conteneur démarre, pas quand il est sain :
  # sans cette attente, un daemon qui plante au bout de deux secondes passerait
  # pour un déploiement réussi.
  etat_sante=inconnu
  for _ in $(seq 1 45); do
    etat_sante=$(docker inspect --format '{{.State.Health.Status}}' dbox-daemon-daemon-1 2>/dev/null || echo inconnu)
    case "$etat_sante" in
      healthy | unhealthy) break ;;
    esac
    sleep 2
  done
  if [ "$etat_sante" != healthy ]; then
    journal "daemon pas en bonne santé (état : $etat_sante) — derniers journaux :"
    docker logs --tail 10 dbox-daemon-daemon-1 2>&1 | sed 's/^/    /'
    return 1
  fi

  # Dernier garde-fou : la version en service doit être celle qu'on vient de
  # construire. Un daemon sain qui tourne autre chose n'est pas un succès.
  en_service=$(docker exec dbox-daemon-daemon-1 sh -c 'echo "$DBOX_VERSION"' 2>/dev/null || true)
  if [ "$en_service" != "$version" ]; then
    journal "le daemon tourne « ${en_service:-?} » au lieu de « $version »"
    return 1
  fi
}

journal() {
  printf '%s  %s\n' "$(date -Is)" "$*"
}

principal "$@"
exit $?
