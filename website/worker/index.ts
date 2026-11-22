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

  async scheduled(controller: PodcastiScheduledController, env: PodcastiWorkerEnv) {
    const scheduledAt = new Date(controller.scheduledTime).toISOString();
    const result = await dispatchMultiTenantWorker({
      appId: env.GITHUB_APP_ID,
      privateKey: env.GITHUB_APP_PRIVATE_KEY,
      repository: env.GITHUB_REPOSITORY,
      ref: env.GITHUB_DEFAULT_BRANCH,
    });

    if (!result.dispatched) {
      const reason = result.reason;
      console.error(`Podcasti Cloudflare cron could not wake the episode processor (reason: ${reason}).`);
      throw new Error(`Podcasti scheduled worker dispatch failed: ${reason}.`);
    }

    console.log(`Podcasti Cloudflare cron dispatched the episode processor for ${scheduledAt} UTC (cron: ${controller.cron}).`);
  },
};
