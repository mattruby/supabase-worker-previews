export type Style = Record<"bold" | "dim" | "red" | "yellow" | "green" | "cyan", (text: string) => string>;

const CODES = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  yellow: [33, 39],
  green: [32, 39],
  cyan: [36, 39],
};

/** Color only on a terminal, and never when NO_COLOR is set (https://no-color.org). */
export function colorEnabled(
  stream: { isTTY?: boolean } = process.stdout,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return !!stream.isTTY && !env.NO_COLOR && env.TERM !== "dumb";
}

export function makeStyle(enabled: boolean): Style {
  const entries = Object.entries(CODES).map(([name, [open, close]]) => [
    name,
    (text: string) => (enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text),
  ]);
  return Object.fromEntries(entries) as Style;
}

export const out = makeStyle(colorEnabled(process.stdout));
export const err = makeStyle(colorEnabled(process.stderr));
