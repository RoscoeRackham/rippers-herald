// clocks.mjs — the Global Progress Clocks half of the herald.
//
// TWO JOBS, ONE RESOLVER. The push needs a clock's `kind` and `district` to file the row; the
// faces hook needs the same `kind` to choose a picture. They MUST agree — a clock filed as
// `miasma` on the site while wearing the damage-control face in Foundry would be a bug nobody
// would think to look for. So the resolver lives here once and both callers use it.
//
// Source of the data: GPC's world setting `global-progress-clocks.activeClocks`, an object keyed
// by clock id. Record: { id, type: 'clock'|'points'|'tracker', name, value, max, private, colorId? }.
// Verified in its source (module/settings/index.mjs:50, module/database.mjs) and driven.

/** kind key -> the file stem that kind's art actually uses. NEVER interpolate the key into a
 *  path: the key is `damage_control` and the stem is `damage-control-3`, and that one mismatch
 *  is a silently missing image. Prosperity is CUT (owner, 8 Sep 2026 — the circle is huge and was
 *  designed as a rider on another clock), so it is absent here and no prosperity art ships. */
export const FACE_STEM = {
	miasma: 'miasma-6',
	damage_control: 'damage-control-3',
};

/** Segment count each kind's art was drawn for. A clock whose max disagrees has NO face — it
 *  keeps GPC's own drawing rather than being shown the nearest file. A wrong face is worse than
 *  no face, and this is the line that enforces it. */
export const FACE_SEGMENTS = {
	miasma: 6,
	damage_control: 3,
};

/** Longest first, so "damage control" is matched before any shorter substring could win. */
const KIND_WORDS = [
	['damage control', 'damage_control'],
	['damage-control', 'damage_control'],
	['damage_control', 'damage_control'],
	['miasma', 'miasma'],
];

/** The kind, read out of the clock's own name. Null when the name says nothing we recognise. */
export function kindOf(name) {
	const n = String(name ?? '').toLowerCase();
	for (const [word, kind] of KIND_WORDS) if (n.includes(word)) return kind;
	return null;
}

/**
 * The district slug: the label's prefix before the first dash or colon, slugified.
 * "Whitechapel — Miasma" -> "whitechapel". Null when there is no separator, which means the
 * clock lands on the roll-up and is NEVER guessed onto a district page.
 */
export function districtOf(name) {
	const raw = String(name ?? '');
	const m = raw.split(/\s*[—–\-:]\s*/);
	if (m.length < 2) return null;
	const slug = m[0].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	return slug || null;
}

/**
 * The face for a clock, or null to leave GPC's drawing alone.
 * `fill` is clamped into the art's range; `current` indexes the FILE and `max` selects the SET.
 */
export function faceFor(clock, moduleId) {
	const kind = kindOf(clock?.name);
	if (!kind) return null;
	if (Number(clock?.max) !== FACE_SEGMENTS[kind]) return null;
	const fill = Math.max(0, Math.min(Number(clock?.value) || 0, FACE_SEGMENTS[kind]));
	return { kind, fill, src: `modules/${moduleId}/faces/${FACE_STEM[kind]}-${String(fill).padStart(2, '0')}.png` };
}

/**
 * The rows this world should be publishing, from GPC's setting.
 *
 * THE REVEAL GATE IS GPC's OWN `private` FLAG, and there is deliberately no way around it:
 * private (or absent) means no row, and a row that existed is deleted. There is no GM
 * "publish anyway" switch — the owner ruled `override no`, and the reason is sound: two places
 * to hide a clock means one of them is eventually wrong, and the wrong one leaks a secret.
 */
export function revealedClocks(activeClocks) {
	const out = [];
	for (const [id, c] of Object.entries(activeClocks ?? {})) {
		if (!c || c.private) continue;
		if (c.type === 'points') continue;   // a points tracker is not a clock; it has no max to fill
		out.push({
			clockId: id,
			label: String(c.name ?? '').slice(0, 200),
			current: Math.trunc(Number(c.value) || 0),
			max: Math.trunc(Number(c.max) || 0),
			kind: kindOf(c.name),
			district: districtOf(c.name),
		});
	}
	out.sort((a, b) => (a.clockId < b.clockId ? -1 : 1));
	return out;
}

/**
 * The ops to send: every revealed clock as an upsert, plus a delete for anything we published
 * last time that is no longer revealed. Withdrawal is the half that matters — a clock the GM
 * makes private again must LEAVE the site, not merely stop being updated.
 */
export function clockOps(activeClocks, previouslySent = []) {
	const revealed = revealedClocks(activeClocks);
	const live = new Set(revealed.map((c) => c.clockId));
	const ops = revealed.map((c) => ({ op: 'upsert', ...c }));
	for (const id of previouslySent) if (!live.has(id)) ops.push({ op: 'delete', clockId: id });
	return ops;
}
