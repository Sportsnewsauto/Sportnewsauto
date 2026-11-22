import handler from "vinext/server/fetch-handler";
import { dispatchMultiTenantWorker } from "../lib/server/github-actions";

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
    _env: unknown,
    ctx: PodcastiExecutionContext,
  ) {
    const scheduledAt = new Date(controller.scheduledTime).toISOString();

    // Use the same process.env-based dispatcher as the working manual button.
    // Cloudflare populates process.env for Workers using this compatibility date.
    console.log(
      `Podcasti Cloudflare cron received at ${scheduledAt} UTC (cron: ${controller.cron}).`,
    );

    const dispatchTask = (async () => {
      const result = await dispatchMultiTenantWorker();

      if (!result.dispatched) {
        console.error(
          `Podcasti Cloudflare cron could not wake the episode processor (reason: ${result.reason}).`,
        );
        throw new Error(
          `Podcasti scheduled worker dispatch failed: ${result.reason}.`,
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
