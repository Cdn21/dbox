# DBox

**Self-host your own code on your private network. DBox handles the networking.**

Every app you deploy gets its own name and HTTPS certificate on your
[Tailscale](https://tailscale.com) network — `https://my-app.your-tailnet.ts.net` —
with no open port, no DNS record, no certificate and no reverse proxy to manage.
Reachable from your laptop and your phone, invisible from the internet.

```
dbox up ~/code/my-app      # build, start, health-check → https://my-app.your-tailnet.ts.net
```

> **Status.** DBox is a personal tool, published as is. It runs daily on two
> machines, has more than 550 tests and 17 invariants guarded by them — but it has one
> maintainer, runs on **Linux only**, works with **Tailscale only** (Headscale is
> planned), and its command line and docs **speak French**. This README is the
> English entry point; the full documentation is in [`doc/`](doc/README.md).

## Why DBox

Plenty of tools deploy your code (Coolify, Dokploy, Kamal…), and some expose
containers on Tailscale (tsdproxy, ScaleTail). DBox is the one that does both,
private by design:

- **No port is ever published.** Not a setting you could forget: the generated
  Compose file never contains `ports:`, and a test guarantees it. Each app is
  reachable only through its own Tailscale sidecar.
- **It builds and deploys your code** from a `Dockerfile`, checks the health of
  the *final* URL (app, sidecar, tailnet, certificate), and rolls back to the
  previous image if that check fails.
- **Same manifest from dev to prod.** A `dev` target can run your dev server
  with hot reload — on your machine or in a container — behind real HTTPS, so
  you can open your work in progress on your phone.
- **Disposable.** No database, no custom runtime: DBox writes plain, readable
  `docker-compose.yml` files. Remove DBox tomorrow and everything keeps running.

## Quickstart

### What you need

- A **Linux machine** with **Docker**, usable without `sudo`
  ([install Docker](https://docs.docker.com/engine/install/)).
- A **Tailscale account** (the free plan is enough), and **Tailscale installed
  and logged in on that machine** — DBox checks each app through its final URL,
  so the machine must be on the tailnet itself.

### 1. Prepare your tailnet (once)

In the [Tailscale admin console](https://login.tailscale.com/admin):

1. **DNS** → enable **MagicDNS** and **HTTPS Certificates**. Without them, apps
   get no certificate.
2. **Access controls** → declare the tags DBox uses, owned by admins:

   ```json
   "tagOwners": {
     "tag:dbox":       ["autogroup:admin"],
     "tag:dbox-admin": ["autogroup:admin"]
   }
   ```

   `tag:dbox` is carried by every app, `tag:dbox-admin` by the optional
   dashboard. Tagged nodes don't expire after 90 days, and your grants decide
   who can reach them.
3. **Settings → Keys → Generate auth key**: *Reusable* on, *Ephemeral* off, tag
   `tag:dbox`. Keep the value for step 2.

### 2. Install

```bash
git clone <repository-url> dbox && cd dbox
./install.sh      # checks Docker, builds the image, puts `dbox` in ~/.local/bin
dbox setup        # writes ~/.config/dbox/config.toml for this machine
```

The `dbox` command runs inside a container: Docker is the only thing you need
on the host. To use the published image instead of building it, pick a
[release](https://github.com/Cdn21/dbox/releases):
`DBOX_IMAGE=ghcr.io/cdn21/dbox:1.4.0 ./install.sh` (amd64 and arm64). `dbox setup` asks five questions, in French:

| prompt | meaning | default |
| --- | --- | --- |
| *Domaine du tailnet* | your tailnet domain, e.g. `tail1234.ts.net` | — (required) |
| *Cible que gère cette machine* | which target this machine deploys | `prod` |
| *Racine des fichiers générés* | where generated files live | `~/dbox/apps` |
| *Tag ACL des nœuds créés* | tag carried by app nodes | `tag:dbox` |
| *Fichier de la clé Tailscale* | where the auth key will be read from | `~/dbox/authkey` |

`setup` never asks for the key itself — a secret should not go through a tool
that could log it. Put it there yourself:

```bash
mkdir -p ~/dbox && echo 'tskey-auth-…' > ~/dbox/authkey && chmod 600 ~/dbox/authkey
```

The file must contain the key and nothing else. Then check everything at once:

```bash
dbox doctor       # Docker, auth key, tailnet, HTTPS, ACL tag, disk — changes nothing
```

### 3. Deploy your first app

Any folder with a `Dockerfile`:

```bash
dbox up ~/code/my-app
```

Without a `dbox.toml`, DBox writes one from the folder and the `Dockerfile`
(name, port from `EXPOSE`, volume from `VOLUME`), then builds, starts and checks
the app. It's done when the last line reads:

```
en ligne · https://my-app.your-tailnet.ts.net
```

Your code is in a git repository? `dbox add git@github.com:you/my-app.git`
clones, writes the manifest if needed, and deploys.

### 4. The dashboard (optional)

A web page listing your apps — redeploy, stop, edit environment variables, read
logs — reachable at `https://dbox.your-tailnet.ts.net`, from your phone too.

It gets full access to Docker on the machine (which means root), so it is a
separate, deliberate step:

```bash
cd deploy
cp ts.env.exemple ts.env && chmod 600 ts.env   # then put an auth key tagged tag:dbox-admin in TS_AUTHKEY
cat > .env <<EOF
DBOX_TAILNET=your-tailnet.ts.net
DBOX_HOME=$HOME/dbox
DBOX_DOCKER_GID=$(getent group docker | cut -d: -f3)
EOF
docker compose up -d daemon tailscale
```

The daemon runs as UID 1000; set `DBOX_UID`/`DBOX_GID` in `.env` if yours
differ. By default any identity your tailnet lets reach the node has full
access; set `DBOX_ALLOWED_USERS` (comma-separated Tailscale logins) in `.env`
to restrict the dashboard to yourself — recommended, as a second barrier behind
the tailnet ACL. With a published image, add `DBOX_IMAGE=ghcr.io/cdn21/dbox:1.4.0` to
`.env` and `docker pull` it first: DBox never pulls an image implicitly. Every other setting is documented at the top of
`deploy/docker-compose.yml`.

## The manifest

```toml
name = "budget"

[targets.dev]
mode = "workspace"        # your dev server, running on this machine
command = "npm run dev"
port = 5178               # → https://budget-dev.your-tailnet.ts.net

[targets.prod]
mode = "deployed"         # an image built from your Dockerfile
port = 8080
health = "/healthz"       # → https://budget.your-tailnet.ts.net
```

Three modes: `deployed` (built image), `devcontainer` (your command in a
container, sources mounted, hot reload) and `workspace` (your command directly
on the host). Companion services, per-target ACL tags, public exposure through
an existing Traefik, and auto-deploy by polling (never a webhook) are described
in [`doc/REFERENCE.md`](doc/REFERENCE.md).

## When something goes wrong

Start with `dbox doctor` (or **Settings → Diagnostic** in the dashboard): it
checks every prerequisite below and says how to fix what fails.

- **The app never becomes reachable, or "invalid key".** Check that
  `~/dbox/authkey` contains only the key, and that `tag:dbox` exists in
  `tagOwners`.
- **No certificate / the first start takes longer than 180 s.** Check that
  HTTPS Certificates are enabled in the DNS settings of your tailnet; the first
  certificate can take a moment. Logs: `docker logs dbox-<app>-<target>-tailscale-1`.
- **The health check fails although the app runs.** The machine running DBox
  must be on the tailnet itself (`tailscale status`).
- **`docker: permission denied`.** Add your user to the `docker` group and log
  in again.
- **The guessed port is wrong.** Edit the generated `dbox.toml`: it is a plain
  text file, a starting point.

## Documentation

What changed between versions: [`doc/CHANGELOG.md`](doc/CHANGELOG.md).

In French, in [`doc/`](doc/README.md): a guide with use cases
([`GUIDE.md`](doc/GUIDE.md)), the full reference ([`REFERENCE.md`](doc/REFERENCE.md)),
the architecture and its UML diagrams ([`ARCHITECTURE.md`](doc/ARCHITECTURE.md),
[`UML.md`](doc/UML.md)).

## License

[Apache 2.0](LICENSE).
