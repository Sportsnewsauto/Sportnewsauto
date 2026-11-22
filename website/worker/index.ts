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

  /**
   * Return the dispatch promise directly. Cloudflare awaits the scheduled()
   * handler, so waitUntil() is not needed for this single task.
   */
  async scheduled(
    controller: PodcastiScheduledController,
    env: PodcastiWorkerEnv,
  ): Promise<void> {
    // Cloudflare's runtime API documents milliseconds. Some persisted event
    // records expose scheduledTime in seconds, so accept either representation.
    const scheduledTime = Number(controller.scheduledTime);
    const scheduledAt = new Date(
      scheduledTime < 1_000_000_000_000 ? scheduledTime * 1000 : scheduledTime,
    ).toISOString();

    console.log(
      `Podcasti Cloudflare cron received at ${scheduledAt} UTC (cron: ${controller.cron}).`,
    );

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
      const message =
        `Podcasti Cloudflare cron could not wake the episode processor (reason: ${result.reason}).${missingBindings}`;
      console.error(message);
      throw new Error(message);
    }

    console.log(
      `Podcasti Cloudflare cron successfully dispatched the episode processor for ${scheduledAt} UTC (cron: ${controller.cron}).`,
    );
  },
};
