#!/usr/bin/env node
// Entry shim for `npx sfsh` / `sfsh.cmd`: runs the TypeScript CLI with Node's native type stripping
// (erasable syntax only, enforced by tsconfig `erasableSyntaxOnly`; CP-023 decision, CP-012 hand-over 4).
const { main } = await import("../src/cli.ts");
process.exitCode = await main(process.argv.slice(2));
