import { createClient } from "@supabase/supabase-js";
import { Hono } from "hono";
import { withSupabasePreviews } from "supabase-worker-previews";
import { page } from "./page";

type Bindings = {
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/", (c) => c.html(page));

// c.env already has any SUPABASE_OVERRIDE applied, so an isolated PR reads its own database here.
app.get("/api/notes", async (c) => {
  const supabase = createClient(c.env.SUPABASE_URL, c.env.SUPABASE_PUBLISHABLE_KEY);
  const { data, error } = await supabase
    .from("notes")
    .select("id, body, created_at")
    .order("created_at", { ascending: false });
  if (error) return c.json({ error: error.message }, 500);
  return c.json(data);
});

export default withSupabasePreviews({ fetch: app.fetch });
