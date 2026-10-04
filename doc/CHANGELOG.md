# Changelog

All notable changes to DBox. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/): a manifest (`dbox.toml`) or a
`deploy/` setup that works with one version keeps working with every later
version of the same major.

## [1.3.0] — 2026-10-04

### Added

- **Owner allowlist.** `--allowed-users` (env `DBOX_ALLOWED_USERS`, a
  comma-separated list of Tailscale logins) restricts the dashboard to those
  identities; everyone else gets `403`, reads included. Empty (the default)
  keeps the previous behaviour, where any tailnet identity is accepted and the
  tailnet ACL is the only boundary. Set it so that a guest or compromised device
  on your tailnet cannot read an app's environment or control your apps.

### Security

- A black-box recon confirmed that, without the allowlist above, any tailnet
  device could read every app's environment values in clear through
  `GET /api/apps/<app>/<target>/env` and stop or deploy apps. The allowlist is
  the defence-in-depth answer; the tailnet ACL remains the first barrier.
- Added `Strict-Transport-Security`, `Referrer-Policy: no-referrer`, and
  `object-src 'none'; base-uri 'self'` to the content security policy on every
  response.

## [1.2.0] — 2026-10-04

### Added

- **`dbox doctor`** checks this machine's prerequisites and says how to fix
  what fails: Docker, the auth key (present, nothing else in the file, `600`,
  not expired), being on the tailnet, apps answering over HTTPS (and whether
  tailnet names resolve at all), the ACL tag in `tagOwners`, the root folder,
  free disk space. It changes nothing. The dashboard runs the same checks from
  **Settings → Diagnostic**, without ever reading the Tailscale API token.

### Security

- The image now starts DBox through an absolute path. The `dbox` launcher runs
  in the current folder, and the relative entrypoint of earlier images made it
  run the **project's own** `src/cli.ts` when there was one — with access to
  the Docker socket. **Every image up to 1.1.0 is affected: rerun
  `install.sh`.**
- The launcher never pulls an image implicitly (`--pull never`).
- The dashboard daemon now shares its Tailscale sidecar's network namespace and
  binds to `127.0.0.1`: it is reachable only through the sidecar, and thus only
  through the tailnet's ACL. Before, a process on the host could reach the
  container directly and forge the identity header the proxy is meant to add.
- The Tailscale API token is now hidden from the daemon (an empty `tmpfs` over
  `secrets/`), so it is read only by the isolated `authkey-rotator`. Before, the
  daemon mounted the whole data directory and could read the token — which holds
  full account rights. **On upgrade, move the token to
  `$DBOX_HOME/secrets/tailscale-api-token`.**
- Every HTTP response sends `X-Frame-Options: DENY`,
  `Content-Security-Policy: frame-ancestors 'none'` and `X-Content-Type-Options:
  nosniff` (anti-clickjacking).
- A "known machine" URL must be `http(s)`: a `javascript:` URL could otherwise
  run code when selected in the machine switcher.

### Fixed

- `dbox up` run through the launcher always failed its health check after
  180 s: the container could not resolve tailnet names. The launcher now runs
  on a named Docker network, whose DNS reaches the host's resolver. Rerun
  `install.sh` to get it.

## [1.1.0] — 2026-10-04

### Added

- **Public targets.** `public_domain` exposes a target on the internet *as well
  as* the tailnet, through a Traefik already running on the machine. DBox only
  sets labels on its own containers and never publishes a port.
- **Companion services.** A target can declare a database or a cache next to it
  (`[targets.<name>.services.<service>]`, `image` and `data` only). Companions
  are never exposed, and each gets its own named volume.
- **Pre-build checks.** Before building, DBox reads a few project files and warns
  about what will certainly fail: Vite without `allowedHosts`, a dev server that
  only listens on localhost, a JVM project in a Node devcontainer. Warnings never
  block a deployment.
- **Dashboard.**
  - Cards show whether a target is public, its companions, which container is
    failing, and link the deployed commit to its forge. They also say when the
    source has commits that are not deployed yet.
  - The Manifest panel edits data path, image, ACL tag and companions.
  - Stopping or restarting a `deployed` target asks for confirmation.
  - Reloading the page during a redeploy keeps following it, and the card's
    actions stay disabled meanwhile.
  - Logs can be filtered and show 200 or 1000 lines.
  - The add form previews the `dbox.toml` it will write, and can create
    non-Node devcontainers.
  - The home page reminds about stale Tailscale nodes and a missing ACL tag.
  - Usable on a phone: tested at 360–414 px, touch targets of 44 px.
- **`/settings` shows the daemon's version.**
- **`dbox --version`.**
- **Continuous deployment of the daemon**, by pull: CI tests every push, advances
  a `production` branch from `main`, and each machine pulls it with
  `deploy/maj-auto.sh` (cron), with health check and automatic rollback.
  `deploy-to.sh` remains for one-off pushes to a machine that is not a git clone.
- **English README** with a quickstart.

### Security

- Images built by DBox are never pulled from a registry (`pull_policy: never`),
  and rollback no longer builds (`--no-build`). The `dbox` namespace on Docker
  Hub belongs to a third party: a missing local image could otherwise have been
  pulled from there.
- The daemon's local image is renamed `dbox-daemon:local`, out of that
  namespace.
- `deploy/maj-auto.sh` refuses a `production` commit that is not contained in
  `main`, or that would roll back the running version (unless forced).
- A registry entry whose `dbox.json` does not match its own folder is ignored
  instead of displayed.
- Pre-build checks only read regular files of bounded size: a named pipe could
  block a deployment forever.
- Starting, stopping, restarting or saving the environment of a target is
  refused while it is being redeployed.

### Fixed

- The daemon runs with `init: true`: no more zombie processes accumulating.
- The add form could add a local folder instead of cloning the URL after
  switching the source back to git.
- On a phone, the Variables panel and the settings header overflowed the screen.

## [1.0.0] — 2026-08-22

First public version: `dbox.toml`, the three modes (`deployed`, `devcontainer`,
`workspace`), one Tailscale sidecar per target, health check on the final URL
with rollback, the dashboard, `dbox add` from git, SSH deploy keys, Tailscale
auth key rotation, stale node and ACL tag reports.

[1.3.0]: https://github.com/Cdn21/dbox/releases/tag/v1.3.0
[1.2.0]: https://github.com/Cdn21/dbox/releases/tag/v1.2.0
[1.1.0]: https://github.com/Cdn21/dbox/releases/tag/v1.1.0
[1.0.0]: https://github.com/Cdn21/dbox/releases/tag/v1.0.0
