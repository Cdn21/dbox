# Image du daemon DBox.
#
# Node 24 exécute le TypeScript nativement : rien à compiler, on copie les
# sources telles quelles. Et comme le projet n'a aucune dépendance, il n'y a ni
# npm install, ni node_modules, ni lockfile à faire dériver.
FROM node:24-bookworm-slim

# DBox n'appelle pas l'API Docker : il appelle la CLI, exactement comme on le
# ferait à la main. Il lui faut donc le binaire et le greffon Compose — repris
# de l'image officielle plutôt qu'installés par apt, pour rester épinglés.
COPY --from=docker:28-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:28-cli /usr/local/libexec/docker/cli-plugins/ /usr/local/libexec/docker/cli-plugins/

# git : « ajouter une app » clone un dépôt. La clé SSH d'accès à GitHub arrive
# par le montage de l'hôte (même ~/.ssh que la CLI), pas embarquée dans l'image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    # Le daemon clone dans des dossiers dont le propriétaire (l'UID de l'hôte
    # monté) ne coïncide pas forcément avec celui vu depuis l'image : git
    # refuse ça par défaut depuis CVE-2022-24765. `--system` (/etc/gitconfig)
    # plutôt que `--global` : ce dernier suivrait $HOME, qui change selon
    # l'utilisateur runtime du conteneur (voir docker-compose.yml).
    && git config --system --add safe.directory '*'

WORKDIR /app
COPY src/ ./src/
COPY package.json ./

# Le daemon tourne en root : il doit pouvoir écrire les fichiers générés et
# parler au socket Docker, dont le groupe varie d'un hôte à l'autre. C'est
# assumé — cette image vaut de toute façon root sur la machine, c'est pourquoi
# elle porte son propre tag Tailscale et sa propre ACL.
ENV NODE_ENV=production

EXPOSE 8099

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8099/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "src/cli.ts"]
CMD ["serve"]
