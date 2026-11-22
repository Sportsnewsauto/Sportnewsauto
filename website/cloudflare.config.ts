import { bindings, defineConfig, defineWorker, triggers } from "cf/config";

export default defineConfig(({ isPreview }) => ({
  worker: defineWorker({
    name: "sportnewsauto",
    entrypoint: "./worker/index.ts",
    compatibilityDate: "2026-11-22",
    // Worker Previews do not support Cron Trigger declarations. Keep the
    // five-minute schedule on production builds only.
    ...(isPreview
      ? {}
      : { triggers: [triggers.scheduled({ schedule: "*/5 * * * *" })] }),
    assets: {
      htmlHandling: "none",
      notFoundHandling: "none",
      runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
    },
    env: {
      ASSETS: bindings.assets(),
    },
  }),
}));
