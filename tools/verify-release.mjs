// RELEASE-INTEGRITY GATE (TEST-AUTOMATION-STRATEGY §3 — ported from rippers-guise Phase 1).
// Validates the PUBLISHED GitHub release — the shipped bytes as installers see them. It never
// rebuilds anything: for this repo the published artifact is the truth to check, not reproduce.
// Run:  node tools/verify-release.mjs [tag]   (default: latest). Non-zero exit on any failure.
// Checks: TWO-ASSET RULE (assets named exactly module.json + rippers-compendium.zip — a missing/mis-named
// manifest asset 404s releases/latest/download and Forge stops offering updates); version
// triple-match (tag == manifest asset == module.json inside the zip); every pack declared in
// the zip's module.json ships its compiled LevelDB CURRENT marker; every declared style/script/
// language file is present in the zip; diagnostic/instrumentation builds must be prereleases.
// Requires: gh (CI: GH_TOKEN) + unzip.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = 'RoscoeRackham/rippers-herald';
const ID = 'rippers-herald';
const tagArg = process.argv[2] ?? '';
const fails = [];
const check = (ok, msg) => { console.log(`${ok ? 'ok ' : 'FAIL'}  ${msg}`); if (!ok) fails.push(msg); };
const gh = (args) => execFileSync('gh', args, { stdio: ['ignore', 'pipe', 'inherit'] }).toString();

const view = JSON.parse(gh(['release', 'view', ...(tagArg ? [tagArg] : []), '--repo', REPO,
	'--json', 'tagName,name,body,isPrerelease,assets']));
const tag = view.tagName;
const version = tag.replace(/^v/, '');
console.log(`verifying ${REPO} ${tag}${view.isPrerelease ? ' (prerelease)' : ''}`);

const names = view.assets.map((a) => a.name);
check(names.includes('module.json'), `asset named exactly module.json (saw: ${names.join(', ')})`);
check(names.includes(`${ID}.zip`), `asset named exactly ${ID}.zip`);

const work = mkdtempSync(join(tmpdir(), 'verify-'));
try {
	gh(['release', 'download', tag, '--repo', REPO, '--dir', work,
		'--pattern', 'module.json', '--pattern', `${ID}.zip`]);

	const manifest = JSON.parse(readFileSync(join(work, 'module.json'), 'utf8'));
	check(manifest.version === version, `module.json asset version ${manifest.version} == tag ${version}`);
	const zip = join(work, `${ID}.zip`);
	// this repo's zips are FLAT (module.json at the zip root — no top-level folder prefix)
	const zipManifest = JSON.parse(execFileSync('unzip', ['-p', zip, 'module.json']).toString());
	check(zipManifest.version === version, `module.json INSIDE the zip ${zipManifest.version} == tag ${version}`);
	check(zipManifest.id === ID, `zip module id is ${ID}`);

	const listing = execFileSync('unzip', ['-l', zip]).toString();
	for (const p of zipManifest.packs ?? []) {
		check(listing.includes(`${p.path}/CURRENT`), `compiled pack shipped: ${p.path}/CURRENT`);
	}
	for (const f of [...(zipManifest.styles ?? []), ...(zipManifest.esmodules ?? []),
		...(zipManifest.languages ?? []).map((l) => l.path)]) {
		check(listing.includes(f), `declared file shipped: ${f}`);
	}

	// NO HIDDEN FILES. A release must be built from committed bytes plus deliberately generated
	// ones — never from "whatever is sitting in the folder". This check exists because a stray
	// `styles/.claude/.cc-writes/` harness directory reached the rippers-theme 0.3.0 zip and was
	// caught by eye rather than by a gate. Anything a dot-path could carry (editor state, agent
	// scratch, local credentials) has no business inside a distributed module.
	const dotPaths = listing.split('\n')
		.map((l) => l.trim().split(/\s+/).slice(3).join(' '))
		.filter((n) => n && /(^|\/)\.[^/]/.test(n));
	check(dotPaths.length === 0, `zip carries no dot-path entries${dotPaths.length ? ` (saw: ${dotPaths.join(', ')})` : ''}`);

	const diagnostic = /\bDIAGNOSTIC\b|instrumentation-only/i.test(`${view.name}\n${view.body}`);
	check(!diagnostic || view.isPrerelease, 'diagnostic/instrumentation build is marked prerelease');
} finally {
	rmSync(work, { recursive: true, force: true });
}

if (fails.length) { console.error(`\nRELEASE INVALID — ${fails.length} check(s) failed`); process.exit(1); }
console.log(`\n${tag}: all release-integrity checks passed`);
