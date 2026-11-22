import { createSign } from "node:crypto";

type DispatchResult =
  | { dispatched: true }
  | { dispatched: false; reason: "not_configured"; missingBindings: string[] }
  | { dispatched: false; reason: "failed" };

type DispatchConfig = {
  appId?: string;
  privateKey?: string;
  repository?: string;
  ref?: string;
};

function createAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iat: now - 60,
    exp: now + 8 * 60,
    iss: appId,
  })).toString("base64url");
  const unsignedToken = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsignedToken);
  signer.end();
  return `${unsignedToken}.${signer.sign(privateKey).toString("base64url")}`;
}

/**
 * Starts the multi-tenant worker immediately through GitHub Actions.
 * Manual requests and the Cloudflare scheduled handler share this dispatcher.
 */
export async function dispatchMultiTenantWorker(config: DispatchConfig = {}): Promise<DispatchResult> {
  const appId = (config.appId ?? process.env.GITHUB_APP_ID)?.trim();
  const rawPrivateKey = (config.privateKey ?? process.env.GITHUB_APP_PRIVATE_KEY)?.trim();
  const repository = (config.repository ?? process.env.GITHUB_REPOSITORY)?.trim() || "Sportsnewsauto/Sportnewsauto";
  const ref = (config.ref ?? process.env.GITHUB_DEFAULT_BRANCH)?.trim() || "main";

  const missingBindings = [
    ...(!appId ? ["GITHUB_APP_ID"] : []),
    ...(!rawPrivateKey ? ["GITHUB_APP_PRIVATE_KEY"] : []),
  ];
  if (missingBindings.length > 0) {
    return { dispatched: false, reason: "not_configured", missingBindings };
  }

  const [owner, repo, ...extra] = repository.split("/");
  if (!owner || !repo || extra.length > 0) {
    console.error("Immediate worker dispatch is misconfigured: GITHUB_REPOSITORY must be owner/repo.");
    return { dispatched: false, reason: "failed" };
  }

  try {
    const privateKey = rawPrivateKey!.replace(/\\n/g, "\n");
    const appJwt = createAppJwt(appId!, privateKey);
    const apiBase = "https://api.github.com";
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${appJwt}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };

    const installationResponse = await fetch(
      `${apiBase}/repos/${owner}/${repo}/installation`,
      { headers, cache: "no-store" },
    );
    if (!installationResponse.ok) {
      console.error(`Immediate worker dispatch could not find the GitHub App installation (HTTP ${installationResponse.status}).`);
      return { dispatched: false, reason: "failed" };
    }

    const installation = await installationResponse.json() as { id?: number };
    if (!installation.id) {
      console.error("Immediate worker dispatch could not read the GitHub App installation ID.");
      return { dispatched: false, reason: "failed" };
    }

    const tokenResponse = await fetch(
      `${apiBase}/app/installations/${installation.id}/access_tokens`,
      {
        method: "POST",
        headers,
        cache: "no-store",
      },
    );
    if (!tokenResponse.ok) {
      console.error(`Immediate worker dispatch could not create an installation token (HTTP ${tokenResponse.status}).`);
      return { dispatched: false, reason: "failed" };
    }

    const tokenData = await tokenResponse.json() as { token?: string };
    if (!tokenData.token) {
      console.error("Immediate worker dispatch received no installation token.");
      return { dispatched: false, reason: "failed" };
    }

    const dispatchResponse = await fetch(
      `${apiBase}/repos/${owner}/${repo}/actions/workflows/multi-tenant-podcast-worker.yml/dispatches`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${tokenData.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref }),
        cache: "no-store",
      },
    );

    if (!dispatchResponse.ok) {
      console.error(`GitHub rejected the immediate worker dispatch (HTTP ${dispatchResponse.status}). Check that the App has Actions: write permission.`);
      return { dispatched: false, reason: "failed" };
    }

    return { dispatched: true };
  } catch (error) {
    console.error(
      "Immediate worker dispatch failed.",
      error instanceof Error ? error.message : "Unknown error",
    );
    return { dispatched: false, reason: "failed" };
  }
}
