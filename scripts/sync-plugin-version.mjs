#!/usr/bin/env node
// Runs after `changeset version` so the Claude Code plugin manifest ships the package's version.
import { readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const path = ".claude-plugin/plugin.json";
const text = readFileSync(path, "utf8");
const updated = text.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`);
if (!updated.includes(`"version": "${version}"`)) throw new Error(`${path} has no "version" field to update`);
writeFileSync(path, updated);
console.log(`${path} -> ${version}`);
