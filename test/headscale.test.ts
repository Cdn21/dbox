import assert from "node:assert/strict";
import net from "node:net";
import { describe, it } from "node:test";
import { backendFor, composeFor, DEFAULT_CONTEXT, type Context } from "../src/compose.ts";
import { headscaleProbe } from "../src/docker.ts";
import { pinnedHttpProbe } from "../src/health.ts";
import { parseManifest, serializeManifest } from "../src/manifest.ts";
import { planFor } from "../src/plan.ts";
import { caddyfileFor } from "../src/tsserve.ts";

const TS: Context = {
  ...DEFAULT_CONTEXT,
  tailnet: "tail1234.ts.net",
  uid: 1000,
  gid: 1000,
  sourcePath: "/srv/app",
};
// Une machine en mode Headscale : backend par défaut + réglages posés.
const HS: Context = {
  ...TS,
  tailnet: "tailnet.appvc.fr",
  backend: "headscale",
  headscale: { loginServer: "https://headscale.appvc.fr", certDir: "/certs/dir" },
};

const deployed = (extra = "") =>
  parseManifest(`name = "app"\n[targets.prod]\nmode = "deployed"\nport = 8080\n${extra}`);
const services = (ctx: Context, m = deployed(), t = "prod") =>
  composeFor(m, t, ctx)["services"] as Record<string, any>;

describe("backend dans le manifeste", () => {
  it("accepte tailscale et headscale, refuse le reste", () => {
    assert.equal(parseManifest(`name="a"\n[targets.prod]\nmode="deployed"\nport=80\nbackend="headscale"`).targets.prod!.backend, "headscale");
    assert.equal(parseManifest(`name="a"\n[targets.prod]\nmode="deployed"\nport=80`).targets.prod!.backend, null);
    assert.throws(() => parseManifest(`name="a"\n[targets.prod]\nmode="deployed"\nport=80\nbackend="nomad"`), /backend/);
  });

  it("fait l'aller-retour par la sérialisation", () => {
    const m = parseManifest(`name = "app"\n\n[targets.prod]\nmode = "deployed"\nport = 8080\nbackend = "headscale"\n`);
    assert.match(serializeManifest(m), /backend = "headscale"/);
  });
});

describe("backendFor : résolution et refus", () => {
  it("prend le défaut machine, redéfinissable par cible", () => {
    assert.equal(backendFor(deployed().targets.prod!, TS, "prod"), "tailscale");
    assert.equal(backendFor(deployed('backend = "headscale"').targets.prod!, HS, "prod"), "headscale");
    // La cible prime sur le défaut machine, dans les deux sens.
    assert.equal(backendFor(deployed('backend = "tailscale"').targets.prod!, HS, "prod"), "tailscale");
  });

  it("refuse headscale sans réglages machine, avant toute écriture", () => {
    assert.throws(() => backendFor(deployed('backend = "headscale"').targets.prod!, TS, "prod"), /aucun réglage headscale/);
  });

  it("refuse ssh_port avec headscale (pas de TCPForward côté Caddy)", () => {
    const m = deployed('backend = "headscale"\nssh_port = 22');
    assert.throws(() => backendFor(m.targets.prod!, HS, "prod"), /ssh_port/);
  });
});

describe("le Compose généré en backend headscale", () => {
  const svc = services(HS);

  it("sidecar non-userspace, --login-server, caps et tun, sans serve.json", () => {
    const ts = svc["tailscale"];
    assert.equal(ts["environment"]["TS_USERSPACE"], "false");
    assert.equal(ts["environment"]["TS_SERVE_CONFIG"], undefined);
    assert.match(ts["environment"]["TS_EXTRA_ARGS"], /--login-server=https:\/\/headscale\.appvc\.fr/);
    assert.deepEqual(ts["cap_add"], ["NET_ADMIN", "NET_RAW"]);
    assert.deepEqual(ts["devices"], ["/dev/net/tun"]);
    assert.deepEqual(ts["volumes"], ["ts-state:/var/lib/tailscale"]); // pas de serve.json
  });

  it("ajoute un Caddy qui partage le netns et monte le certificat", () => {
    const caddy = svc["caddy"];
    assert.ok(caddy, "le service caddy doit exister");
    assert.equal(caddy["network_mode"], "service:tailscale");
    assert.deepEqual(caddy["volumes"], ["./Caddyfile:/etc/caddy/Caddyfile:ro", "/certs/dir:/certs:ro"]);
    assert.equal(caddy["networks"], undefined); // network_mode et networks s'excluent
  });

  it("garde l'invariant du mode privé : aucun ports: nulle part", () => {
    for (const s of Object.values(svc)) assert.equal((s as any)["ports"], undefined);
  });

  it("en tailscale, rien de tout ça : userspace + serve.json, pas de caddy", () => {
    const s = services(TS);
    assert.equal(s["tailscale"]["environment"]["TS_USERSPACE"], "true");
    assert.ok(s["tailscale"]["volumes"].includes("./serve.json:/config/serve.json:ro"));
    assert.equal(s["caddy"], undefined);
  });
});

describe("le plan émet le bon fichier de terminaison TLS", () => {
  const fichier = (ctx: Context, suffix: string) => {
    const p = planFor(deployed(ctx === HS ? 'backend = "headscale"' : ""), "prod", ctx);
    return p.files.find((f) => f.path.endsWith(suffix));
  };

  it("serve.json en tailscale, Caddyfile en headscale — jamais les deux", () => {
    assert.ok(fichier(TS, "serve.json"));
    assert.equal(fichier(TS, "Caddyfile"), undefined);
    assert.ok(fichier(HS, "Caddyfile"));
    assert.equal(fichier(HS, "serve.json"), undefined);
  });

  it("le backend résolu est consigné dans le plan et le descripteur", () => {
    assert.equal(planFor(deployed('backend = "headscale"'), "prod", HS).backend, "headscale");
    const dboxJson = planFor(deployed(), "prod", TS).files.find((f) => f.path.endsWith("dbox.json"))!;
    assert.match(dboxJson.content, /"backend": "tailscale"/);
  });

  it("le Caddyfile cible le domaine wildcard, pas le nom d'hôte", () => {
    const c = caddyfileFor("app", "tailnet.appvc.fr", "http://app:8080");
    assert.match(c, /app\.tailnet\.appvc\.fr \{/);
    assert.match(c, /tls \/certs\/tailnet\.appvc\.fr\.crt \/certs\/tailnet\.appvc\.fr\.key/);
    assert.match(c, /reverse_proxy http:\/\/app:8080/);
  });
});

describe("API Headscale (clé préauth)", () => {
  const ok = (payload: unknown) =>
    (async () => ({ ok: true, status: 200, statusText: "OK", text: async () => "", json: async () => payload })) as unknown as typeof fetch;

  it("crée une clé réutilisable pour le bon user, et lit key + expiration", async () => {
    let seen: { url: string; body: any } | null = null;
    const { createPreAuthKey } = await import("../src/headscale.ts");
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen = { url, body: JSON.parse(String(init!.body)) };
      return { ok: true, status: 200, statusText: "OK", text: async () => "", json: async () => ({ preAuthKey: { key: "hskey-auth-xyz", expiration: "2026-11-13T12:00:00Z" } }) };
    }) as unknown as typeof fetch;
    const r = await createPreAuthKey("https://headscale.exemple/", "hskey-api-1", "test", fetchImpl, () => Date.parse("2026-08-15T12:00:00Z"));
    assert.deepEqual(r, { key: "hskey-auth-xyz", expiresOn: "2026-11-13" });
    assert.equal(seen!.url, "https://headscale.exemple/api/v1/preauthkey"); // pas de double barre
    assert.equal(seen!.body.user, "test");
    assert.equal(seen!.body.reusable, true);
    assert.match(seen!.body.expiration, /^2026-11-13T/); // +90 j
  });

  it("remonte un refus de l'API plutôt que de produire une clé fantôme", async () => {
    const { createPreAuthKey } = await import("../src/headscale.ts");
    const fetchImpl = (async () => ({ ok: false, status: 401, statusText: "Unauthorized", text: async () => "no" })) as unknown as typeof fetch;
    await assert.rejects(() => createPreAuthKey("https://h", "bad", "test", fetchImpl), /401/);
  });

  it("expire une clé par sa valeur, sous le user", async () => {
    let body: any = null;
    const { expirePreAuthKey } = await import("../src/headscale.ts");
    const fetchImpl = (async (_u: string, init?: RequestInit) => { body = JSON.parse(String(init!.body)); return { ok: true, status: 200, statusText: "OK", text: async () => "" }; }) as unknown as typeof fetch;
    await expirePreAuthKey("https://h", "tok", "test", "hskey-auth-old", fetchImpl);
    assert.deepEqual(body, { user: "test", key: "hskey-auth-old" });
  });
});

describe("sonde de santé Headscale", () => {
  it("sonde depuis le netns du sidecar (docker run --network container:…), et lit le statut", async () => {
    const vus: string[][] = [];
    const probe = headscaleProbe("dbox-app-prod", "dbox-daemon:local", async (file, args) => {
      vus.push([file, ...args]);
      return { code: 0, stdout: "200\n", stderr: "" };
    });
    assert.equal(await probe("https://app.tailnet.appvc.fr/"), 200);
    assert.deepEqual(vus[0], [
      "docker",
      "run",
      "--rm",
      "--network",
      "container:dbox-app-prod-tailscale-1", // le netns du sidecar de LA cible
      "dbox-daemon:local", // l'image du daemon, pas d'IP ni de réseau public
      "__probe",
      "https://app.tailnet.appvc.fr/",
    ]);
  });

  it("une sortie non numérique (sidecar pas prêt, Caddy muet) = injoignable", async () => {
    const injoignable = headscaleProbe("dbox-app-prod", "img", async () => ({
      code: 1,
      stdout: "null",
      stderr: "No such container",
    }));
    assert.equal(await injoignable("https://x/"), null);
  });

  it("pinnedHttpProbe connecte sur l'IP épinglée quel que soit le nom (équivalent --resolve)", async () => {
    const serveur = net.createServer();
    let connexionRecue = false;
    serveur.on("connection", (socket) => {
      connexionRecue = true;
      socket.destroy(); // pas un vrai serveur TLS : le handshake avortera
    });
    await new Promise<void>((resolve) => serveur.listen(0, "127.0.0.1", resolve));
    const port = (serveur.address() as net.AddressInfo).port;

    // « nom.invalide » ne résout nulle part : seule l'IP épinglée peut connecter.
    const status = await pinnedHttpProbe("127.0.0.1")(`https://nom.invalide:${port}/`);
    serveur.close();

    assert.equal(connexionRecue, true); // la connexion a bien atteint l'IP épinglée
    assert.equal(status, null); // handshake TLS avorté → injoignable, pas une fausse réussite
  });
});

describe("rotation de la clé Headscale", () => {
  const NOW = Date.parse("2026-10-04T12:00:00Z");
  function harness(files: Record<string, string> = {}) {
    const disk = new Map(Object.entries(files));
    const logs: string[] = [];
    const expired: string[] = [];
    let createdKey = "hskey-auth-new";
    const deps = {
      authkeyFile: "/h/headscale-authkey",
      loginServer: "https://headscale.exemple",
      user: "test",
      readFile: async (p: string) => { const v = disk.get(p); if (v === undefined) throw new Error("ENOENT"); return v; },
      writeFile: async (p: string, c: string) => { disk.set(p, c); },
      readToken: async () => "hskey-api-1",
      createKey: async () => ({ key: createdKey, expiresOn: "2027-01-02" }),
      expireKey: async (_s: string, _t: string, _u: string, key: string) => { expired.push(key); },
      now: () => NOW,
      log: (l: string) => logs.push(l),
    };
    return { deps, disk, logs, expired };
  }

  it("ne régénère pas une clé encore loin de l'échéance", async () => {
    const { rotateHeadscaleOnce } = await import("../src/rotate.ts");
    const h = harness({ "/h/headscale-authkey.expires": "2027-06-01\n" });
    await rotateHeadscaleOnce(h.deps);
    assert.match(h.logs.join(), /encore valide/);
    assert.equal(h.disk.get("/h/headscale-authkey"), undefined); // pas réécrit
  });

  it("régénère, pose la clé en 600 et l'échéance, puis expire l'ancienne par sa valeur", async () => {
    const { rotateHeadscaleOnce } = await import("../src/rotate.ts");
    const h = harness({ "/h/headscale-authkey": "hskey-auth-OLD\n", "/h/headscale-authkey.expires": "2026-10-06\n" });
    await rotateHeadscaleOnce(h.deps);
    assert.equal(h.disk.get("/h/headscale-authkey"), "hskey-auth-new\n");
    assert.equal(h.disk.get("/h/headscale-authkey.expires"), "2027-01-02\n");
    assert.deepEqual(h.expired, ["hskey-auth-OLD"]); // l'ancienne valeur, pas un id
  });

  it("première rotation (aucune clé en place) : n'expire rien", async () => {
    const { rotateHeadscaleOnce } = await import("../src/rotate.ts");
    const h = harness();
    await rotateHeadscaleOnce(h.deps);
    assert.equal(h.disk.get("/h/headscale-authkey"), "hskey-auth-new\n");
    assert.deepEqual(h.expired, []);
  });

  it("token absent : ne touche à rien", async () => {
    const { rotateHeadscaleOnce } = await import("../src/rotate.ts");
    const h = harness();
    h.deps.readToken = async () => "";
    await rotateHeadscaleOnce(h.deps);
    assert.match(h.logs.join(), /token d'API Headscale absent/);
    assert.equal(h.disk.get("/h/headscale-authkey"), undefined);
  });
});
