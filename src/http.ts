const REPO = "https://github.com/mattruby/supabase-worker-previews";
export const DOCS_URL = `${REPO}#readme`;
export const QUICKSTART_URL = `${REPO}/blob/main/docs/quickstart.md`;
export const TOKENS_URL = `${REPO}/blob/main/docs/tokens.md`;

/** An API error body in one short line: the JSON message when there is one, else the text, cut. */
export function summarizeBody(body: string, max = 200): string {
  let text = body;
  try {
    text = messageOf(JSON.parse(body)) ?? body;
  } catch {
    const title = /<title>([^<]*)<\/title>/i.exec(body)?.[1];
    if (title) text = title;
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function messageOf(json: unknown): string | undefined {
  if (!json || typeof json !== "object") return undefined;
  const o = json as { message?: unknown; msg?: unknown; error?: unknown; errors?: unknown };
  for (const value of [o.message, o.msg, o.error]) if (typeof value === "string" && value) return value;
  if (o.error && typeof o.error === "object") return messageOf(o.error);
  if (Array.isArray(o.errors)) {
    const messages = o.errors.map(messageOf).filter((m) => m !== undefined);
    if (messages.length) return messages.join("; ");
  }
  return undefined;
}

/** `<prefix>: <status> <summary>`, plus what a 401 or 403 says about the token that made the call. */
export function apiErrorMessage(prefix: string, status: number, body: string, variable: string): string {
  const summary = summarizeBody(body);
  const line = `${prefix}: ${status}${summary ? ` ${summary}` : ""}`;
  if (status === 401) return `${line}. ${variable} is invalid or expired; see ${TOKENS_URL}`;
  if (status === 403) return `${line}. ${variable} lacks a permission this call needs; see ${TOKENS_URL}`;
  return line;
}
