// Build the RELEASE zip for rippers-herald.
//
// `git archive HEAD` with a pathspec naming exactly what a Foundry install needs. The pathspec,
// not an exclude list, is the safety: an untracked file cannot enter a git archive at all, so a
// local harness artifact or an editor's scratch directory cannot ride along. (That is not
// hypothetical — a stray `.claude/.cc-writes/` reached the rippers-theme 0.3.0 zip when it was
// built by hand from the working tree.)
//
// No packs in this module, so there is no compile step.
//
// Usage: node tools/release-zip.mjs [outDir]   (default: repo root; writes rippers-herald.zip)
import { execFileSync } from 'node:child_process';
import { rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ID = 'rippers-herald';
const PATHS = ['module.json', 'scripts', 'lang', 'styles', 'faces', 'README.md', 'LICENSE'];

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outDir = resolve(process.argv[2] ?? root);
const zipPath = join(outDir, `${ID}.zip`);
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], ...opts });

rmSync(zipPath, { force: true });
run('git', ['archive', '--format=zip', '-o', zipPath, 'HEAD', '--', ...PATHS]);

const listing = run('unzip', ['-l', zipPath]).toString();
const manifest = JSON.parse(readFileSync(join(root, 'module.json'), 'utf8'));
const fails = [];

for (const f of [...(manifest.esmodules ?? []), ...(manifest.styles ?? []), ...(manifest.languages ?? []).map((l) => l.path)]) {
	if (!listing.includes(f)) fails.push(`declared file missing from the zip: ${f}`);
}
const dotPaths = listing.split('\n')
	.map((l) => l.trim().split(/\s+/).slice(3).join(' '))
	.filter((n) => n && /(^|\/)\.[^/]/.test(n));
if (dotPaths.length) fails.push(`dot-path entries in the zip: ${dotPaths.join(', ')}`);
const zipManifest = JSON.parse(run('unzip', ['-p', zipPath, 'module.json']).toString());
if (zipManifest.version !== manifest.version) {
	fails.push(`zip module.json is ${zipManifest.version} but the working tree says ${manifest.version}`);
}
if (fails.length) {
	console.error(`RELEASE ZIP INVALID:\n  - ${fails.join('\n  - ')}`);
	process.exit(1);
}
const count = listing.trim().split('\n').at(-1).trim().split(/\s+/)[1];
console.log(`ok: ${zipPath} — v${zipManifest.version}, ${count} entries, 0 dot-paths`);
