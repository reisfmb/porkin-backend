import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { createApp } from "./app.js";

serve({ fetch: createApp().fetch, port: config.port }, (info) => {
  console.log(
    `porkin-backend listening on :${info.port} (provider=${config.provider}, model=${config.model})`,
  );
});
