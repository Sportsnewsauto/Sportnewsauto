import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";

const isProductionWorkersBuild =
  process.env.WORKERS_CI === "1" &&
  process.env.WORKERS_CI_BRANCH === "main";

export default defineConfig({
  plugins: [
    vinext(),
    cloudflare({
      // Workers Builds deploys the Vite plugin's resolved Worker config.
      // cloudflare.config.ts is consumed by the cf CLI, not by a plain
      // vite build, so register the Cron Trigger in this build path too.
      // The callback mutates the loaded config and keeps Cron off Previews.
      config: (userConfig) => {
        if (isProductionWorkersBuild) {
          userConfig.triggers = { crons: ["*/5 * * * *"] };
        }
      },
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
