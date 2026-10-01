// The Worker prepends window.__SUPABASE_PUBLIC__ to <head>, so this page has no build step and no
// Supabase values of its own. The browser modules come from jsDelivr to keep the example bundler-free.
export const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Notes</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 36rem; margin: 3rem auto; padding: 0 1rem; }
      small { color: #666; }
    </style>
  </head>
  <body>
    <h1>Notes</h1>
    <p><small id="database">Connecting...</small></p>
    <ul id="notes"></ul>
    <script type="module">
      import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
      import { readPublicConfig } from "https://cdn.jsdelivr.net/npm/supabase-worker-previews@0/+esm";

      const status = document.getElementById("database");
      const config = readPublicConfig();
      if (!config) {
        status.textContent = "No Supabase config: this page was not served through the Worker.";
      } else {
        status.textContent = "Database: " + config.supabaseUrl;
        const supabase = createClient(config.supabaseUrl, config.supabaseKey);
        const { data, error } = await supabase
          .from("notes")
          .select("id, body")
          .order("created_at", { ascending: false });
        const list = document.getElementById("notes");
        for (const note of data ?? []) {
          const item = document.createElement("li");
          item.textContent = note.body;
          list.append(item);
        }
        if (error) status.textContent = "Could not read notes: " + error.message;
      }
    </script>
  </body>
</html>
`;
