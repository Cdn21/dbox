import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAuthKey, listDevices, listTagOwners, revokeAuthKey } from "../src/tailscale.ts";

function ok(payload: unknown): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => "",
    json: async () => payload,
  })) as unknown as typeof fetch;
}

describe("création d'une clé d'auth via l'API Tailscale", () => {
  it("poste les bonnes capacités et renvoie la clé et sa date d'expiration", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => "",
        json: async () => ({ id: "knew111CNTRL", key: "tskey-auth-xxx", expires: "2026-11-13T12:00:00Z" }),
      };
    }) as unknown as typeof fetch;

    const result = await createAuthKey("tail4bb652.ts.net", "tskey-api-yyy", "tag:dbox", fetchImpl);

    assert.equal(result.id, "knew111CNTRL");
    assert.equal(result.key, "tskey-auth-xxx");
    assert.equal(result.expiresOn, "2026-11-13");
    assert.match(capturedUrl, /\/tailnet\/tail4bb652\.ts\.net\/keys$/);
    assert.equal(capturedInit?.method, "POST");
    assert.equal((capturedInit?.headers as Record<string, string>)["authorization"], "Bearer tskey-api-yyy");

    const body = JSON.parse(capturedInit?.body as string);
    assert.deepEqual(body.capabilities.devices.create.tags, ["tag:dbox"]);
    assert.equal(body.capabilities.devices.create.reusable, true);
    assert.equal(body.capabilities.devices.create.ephemeral, false);
  });

  it("n'annonce aucun tag quand tag est null, comme un tailnet non taggé ailleurs dans DBox", async () => {
    let sentTags: unknown = "jamais lu";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      sentTags = JSON.parse(init?.body as string).capabilities.devices.create.tags;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => "",
        json: async () => ({ id: "k1", key: "k", expires: "2026-01-01T00:00:00Z" }),
      };
    }) as unknown as typeof fetch;

    await createAuthKey("tail4bb652.ts.net", "token", null, fetchImpl);
    assert.deepEqual(sentTags, []);
  });

  it("lève une erreur claire quand l'API refuse, avec le détail renvoyé", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: async () => "token invalide ou expiré",
      json: async () => ({}),
    })) as unknown as typeof fetch;

    await assert.rejects(
      createAuthKey("tail4bb652.ts.net", "bad", "tag:dbox", fetchImpl),
      /403.*token invalide ou expiré/,
    );
  });

  it("lève une erreur claire quand la réponse n'a ni clé ni expiration", async () => {
    await assert.rejects(
      createAuthKey("tail4bb652.ts.net", "token", "tag:dbox", ok({})),
      /inattendue/,
    );
  });
});

describe("liste des appareils via l'API Tailscale", () => {
  it("interroge le bon tailnet avec le bon en-tête, et renvoie une liste normalisée", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init?.headers as Record<string, string>;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => "",
        json: async () => ({
          devices: [{ id: "1", hostname: "budget", tags: ["tag:dbox"], lastSeen: "2026-08-16T09:00:00Z" }],
        }),
      };
    }) as unknown as typeof fetch;

    const devices = await listDevices("tail4bb652.ts.net", "tskey-api-abc", fetchImpl);

    assert.match(capturedUrl, /\/tailnet\/tail4bb652\.ts\.net\/devices$/);
    assert.equal(capturedHeaders?.["authorization"], "Bearer tskey-api-abc");
    assert.deepEqual(devices, [
      { id: "1", hostname: "budget", tags: ["tag:dbox"], lastSeen: "2026-08-16T09:00:00Z" },
    ]);
  });

  it("normalise les champs absents plutôt que de planter", async () => {
    const devices = await listDevices("tail4bb652.ts.net", "token", ok({ devices: [{}] }));
    assert.deepEqual(devices, [{ id: "", hostname: "", tags: [], lastSeen: "" }]);
  });

  it("lève une erreur claire quand l'API refuse", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "API token invalid",
    })) as unknown as typeof fetch;

    await assert.rejects(listDevices("tail4bb652.ts.net", "bad", fetchImpl), /401.*API token invalid/);
  });

  it("lève une erreur claire quand la réponse n'a pas de liste « devices »", async () => {
    await assert.rejects(listDevices("tail4bb652.ts.net", "token", ok({})), /inattendue/);
  });
});

describe("révocation d'une clé via l'API Tailscale", () => {
  it("appelle DELETE sur l'identifiant de la clé, jamais sa valeur", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedHeaders: Record<string, string> | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "";
      capturedHeaders = init?.headers as Record<string, string>;
      return { ok: true, status: 200, statusText: "OK", text: async () => "" };
    }) as unknown as typeof fetch;

    await revokeAuthKey("tail4bb652.ts.net", "tskey-api-abc", "kold999CNTRL", fetchImpl);

    assert.equal(capturedMethod, "DELETE");
    assert.match(capturedUrl, /\/tailnet\/tail4bb652\.ts\.net\/keys\/kold999CNTRL$/);
    assert.equal(capturedHeaders?.["authorization"], "Bearer tskey-api-abc");
  });

  it("lève une erreur claire quand l'API refuse", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => "key not found",
    })) as unknown as typeof fetch;

    await assert.rejects(
      revokeAuthKey("tail4bb652.ts.net", "token", "kabsent", fetchImpl),
      /404.*key not found/,
    );
  });
});

describe("lecture des propriétaires de tags via l'API Tailscale", () => {
  it("demande du JSON strict, jamais le HuJSON brut", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: async () => "",
        json: async () => ({ tagOwners: { "tag:dbox": ["autogroup:admin"] } }),
      };
    }) as unknown as typeof fetch;

    const owners = await listTagOwners("tail4bb652.ts.net", "tskey-api-abc", fetchImpl);

    assert.equal(capturedHeaders?.["accept"], "application/json");
    assert.equal(capturedHeaders?.["authorization"], "Bearer tskey-api-abc");
    assert.deepEqual(owners, { "tag:dbox": ["autogroup:admin"] });
  });

  it("renvoie un objet vide si la policy ne déclare aucun tag", async () => {
    const owners = await listTagOwners("tail4bb652.ts.net", "token", ok({}));
    assert.deepEqual(owners, {});
  });

  it("lève une erreur claire quand l'API refuse", async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      text: async () => "insufficient scope",
    })) as unknown as typeof fetch;

    await assert.rejects(listTagOwners("tail4bb652.ts.net", "bad", fetchImpl), /403.*insufficient scope/);
  });
});
