import handler from "vinext/server/fetch-handler";
import { dispatchMultiTenantWorker } from "../lib/server/github-actions";

type PodcastiWorkerEnv = {
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_DEFAULT_BRANCH?: string;
};

type PodcastiScheduledController = {
  cron: string;
  scheduledTime: number;
};

type PodcastiExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

/**
 * Keep Vinext as the HTTP handler and add Cloudflare's native Cron Trigger
 * as the recurring wake-up for the existing multi-tenant podcast processor.
 */
export default {
  fetch(
    request: Parameters<typeof handler.fetch>[0],
    env: Parameters<typeof handler.fetch>[1],
    ctx: Parameters<typeof handler.fetch>[2],
  ) {
    return handler.fetch(request, env, ctx);
  },

  scheduled(
    controller: PodcastiScheduledController,
    env: PodcastiWorkerEnv,
    ctx: PodcastiExecutionContext,
  ) {
    const scheduledAt = new Date(controller.scheduledTime).toISOString();

    console.log(
      `Podcasti Cloudflare cron received at ${scheduledAt} UTC (cron: ${controller.cron}).`,
    );

    const dispatchTask = (async () => {
      // Cron handlers receive Worker secrets and variables through their
      // second (env) argument. Pass those bindings explicitly rather than
      // relying on process.env being populated for this event.
      const result = await dispatchMultiTenantWorker({
        appId: env.GITHUB_APP_ID,
        privateKey: env.GITHUB_APP_PRIVATE_KEY,
        repository: env.GITHUB_REPOSITORY,
        ref: env.GITHUB_DEFAULT_BRANCH,
      });

      if (!result.dispatched) {
        const missingBindings = result.reason === "not_configured"
          ? ` Missing Worker secrets: ${result.missingBindings.join(", ")}.`
          : "";
        console.error(
          `Podcasti Cloudflare cron could not wake the episode processor (reason: ${result.reason}).${missingBindings}`,
        );
        throw new Error(
          `Podcasti scheduled worker dispatch failed: ${result.reason}.${missingBindings}`,
        );
      }

      console.log(
        `Podcasti Cloudflare cron successfully dispatched the episode processor for ${scheduledAt} UTC (cron: ${controller.cron}).`,
      );
    })();

    // Keep the scheduled invocation alive until the GitHub API dispatch finishes.
    ctx.waitUntil(dispatchTask);
  },
};
