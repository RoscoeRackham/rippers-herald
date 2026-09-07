// rippers-herald — one-way calendar push, Foundry (GM) -> companion app.
//
// Scope of THIS build: calendar_state only. The journal-page half of
// lodge-docs/SPEC-foundry-herald-sync.md (§1 hooks, §2 the OBSERVER gate) is
// DEFERRED by the owner's ruling of 7 Sep 2026 ("A: calendar only") — no journal
// hook is registered below, deliberately. Do not add one without a new ruling.
//
// The load-bearing fact from the spec's §1: Calendaria DERIVES, it does not store.
// Core `game.time.worldTime` is the truth and core `updateWorldTime` is the trigger;
// Calendaria supplies the pretty string and nothing else. If Calendaria is disabled
// or swapped out, the push still carries a correct clock and only `display` degrades.

const MODULE_ID = 'rippers-herald';
const DEBOUNCE_MS = 2000;

/** Settings keys. */
const S = {
	endpoint: 'endpoint',
	sharedSecret: 'sharedSecret',
	enabled: 'enabled',
	sheets: 'sheets',
	verbose: 'verbose',
};

const log = (...a) => console.log(`${MODULE_ID} |`, ...a);
const warn = (...a) => console.warn(`${MODULE_ID} |`, ...a);

/** Last push outcome, exposed on the api for the settings UI, the harness and the GM's console. */
let lastResult = null;
let timer = null;
/**
 * Last calendar Calendaria handed us. STICKY on purpose: measured in the harness,
 * `getActiveCalendar()` does not merely warm up late, it also returns null again
 * intermittently once warm — which made the same instant publish `year: 1970` and
 * `year: 0` in alternating pushes. Once a calendar has been seen, a later null is
 * treated as a transient hiccup, not as "Calendaria went away".
 */
let warmCalendar = null;
/**
 * Serialised op of the last push the server accepted, PER SUBJECT — 'calendar' for the clock,
 * `sheet:<actorId>` for each character. One global slot would make two subjects cancel each
 * other: a sheet push would clear the clock's memory and vice versa, and every second push
 * would go out unnecessarily.
 */
const lastSentOp = new Map();

function setting(key) {
	try {
		return game.settings.get(MODULE_ID, key);
	} catch {
		return undefined;
	}
}

/**
 * Only ONE client posts. `game.users.activeGM` is Foundry's own single-writer
 * election (the lowest-id connected GM), so two open GM windows do not double-write.
 * A non-GM never reaches here — but the check is explicit rather than implied.
 */
function isPusher() {
	return game.user?.isGM === true && game.user === game.users?.activeGM;
}

/**
 * Read the clock.
 *
 * `worldTime` is core, always present, and is what the app stores as truth.
 * Everything else is presentation and may be absent.
 *
 * VERIFIED against the installed Calendaria 1.0.17 source, not from memory:
 * `CALENDARIA.api.getCurrentDateTime()` returns `{ ...game.time.components, year: +yearZero,
 * month: +1, day: dayOfMonth + 1 }` — note it returns **`day`**, NOT `dayOfMonth`, and both
 * month and day are 1-BASED while core's components are 0-based. The herald spec's §1 says
 * `dayOfMonth`; that is wrong, and reading it would have shipped `dayOfMonth: undefined`.
 * We accept either key so a future Calendaria rename cannot silently blank the field.
 *
 * THE WARM-UP TRAP, measured in the harness (herald-warmup-probe3.mjs): Calendaria's active
 * calendar is **null for ~35 seconds after `ready`**, and `getCurrentDateTime()` answers
 * anyway during that window — with `yearZero` NOT applied, so the same instant reads `year: 0`
 * cold and `year: 1970` warm. Trusting it cold publishes a wrong date and says nothing. So the
 * Calendaria branch is taken ONLY when `getActiveCalendar()` returns a calendar; until then we
 * report the core fallback honestly, and `watchForCalendar()` re-pushes once it warms.
 */
function readCalendar() {
	const worldTime = game.time?.worldTime ?? 0;
	const out = {
		worldTime,
		year: null,
		month: null,
		dayOfMonth: null,
		hour: null,
		minute: null,
		calendarId: null,
		display: null,
		source: 'none',
	};

	const cal = globalThis.CALENDARIA?.api;
	const live = cal?.getActiveCalendar?.() ?? null;
	if (live) warmCalendar = live;
	const active = live ?? warmCalendar;
	if (cal?.getCurrentDateTime && active) {
		try {
			const dt = cal.getCurrentDateTime() ?? {};
			out.year = dt.year ?? null;
			out.month = dt.month ?? null;
			out.dayOfMonth = dt.day ?? dt.dayOfMonth ?? null;
			out.hour = dt.hour ?? null;
			out.minute = dt.minute ?? null;
			out.calendarId = active?.metadata?.id ?? active?.id ?? null;
			out.display = formatDisplay(out, active);
			out.source = 'calendaria';
			return out;
		} catch (e) {
			warn('Calendaria present but getCurrentDateTime() threw; falling back to core', e);
		}
	} else if (cal && !active) {
		out.calendariaCold = true;
	}

	// Fallback: core's own calendar components (Foundry 13 ships CONFIG.time.worldCalendar).
	// 0-based month/day in core, so normalise to the same 1-based shape Calendaria gives.
	const c = game.time?.components;
	if (c) {
		out.year = c.year ?? null;
		out.month = Number.isFinite(c.month) ? c.month + 1 : null;
		out.dayOfMonth = Number.isFinite(c.dayOfMonth) ? c.dayOfMonth + 1 : null;
		out.hour = c.hour ?? null;
		out.minute = c.minute ?? null;
		out.display = formatDisplay(out, null);
		out.source = 'core';
	}
	return out;
}

/**
 * The display string. Calendaria's own month names are localisation keys
 * (`CALENDARIA.Calendar.Gregorian.Month.January`), so they are localised here rather
 * than shipped raw. If anything is missing we emit an ISO-ish date instead of guessing
 * a name — the app treats `display` as decoration and never parses it.
 */
function formatDisplay(v, activeCalendar) {
	if (v.year == null || v.month == null || v.dayOfMonth == null) return null;
	const hh = String(v.hour ?? 0).padStart(2, '0');
	const mm = String(v.minute ?? 0).padStart(2, '0');
	const iso = `${v.year}-${String(v.month).padStart(2, '0')}-${String(v.dayOfMonth).padStart(2, '0')}`;

	const months = activeCalendar?.months?.values;
	if (months) {
		const entry = Object.values(months).find((m) => m?.ordinal === v.month);
		const name = entry?.name ? game.i18n.localize(entry.name) : null;
		if (name && !name.startsWith('CALENDARIA.')) {
			return `${v.dayOfMonth} ${name} ${v.year}, ${hh}:${mm}`;
		}
	}
	return `${iso} ${hh}:${mm}`;
}

/**
 * The wire body. The envelope is the spec's (§3) so the deferred journal half can be
 * added later as `kind: "journal"` without a breaking change; the op carries the fields
 * god's dispatch named. camelCase on the wire, snake_case in the table — the Netlify
 * function is the only place that mapping lives.
 */
function buildPayload(reason = 'manual') {
	const v = readCalendar();
	return {
		worldId: game.world?.id ?? null,
		kind: 'calendar',
		ops: [
			{
				op: 'upsert',
				worldTime: v.worldTime,
				year: v.year,
				month: v.month,
				dayOfMonth: v.dayOfMonth,
				hour: v.hour,
				minute: v.minute,
				calendarId: v.calendarId,
				display: v.display,
			},
		],
		// Diagnostics: not stored, but they turn a "the date is wrong" report into one
		// glance at the receiver's log. `_source` says which clock rendered it.
		_source: v.source,
		_reason: reason,
	};
}

async function push({ reason = 'manual', quiet = false, body: given = null, dedupeKey = null } = {}) {
	const endpoint = (setting(S.endpoint) ?? '').trim();
	const secret = (setting(S.sharedSecret) ?? '').trim();
	if (!endpoint || !secret) {
		lastResult = { ok: false, reason, error: 'endpoint or shared secret not set' };
		if (!quiet) warn(lastResult.error);
		return lastResult;
	}
	const body = given ?? buildPayload(reason);
	const opKey = dedupeKey ?? JSON.stringify(body.ops[0]);
	const dedupeSlot = dedupeKey ? dedupeKey.split('|')[0] : 'calendar';
	if (opKey === lastSentOp.get(dedupeSlot) && reason !== 'manual') {
		// Nothing about the clock changed. Two triggers (core's updateWorldTime and
		// Calendaria's own) describe one event, and a settings save can land after the
		// debounce; none of them is a reason to write the same row again.
		lastResult = { ok: true, reason, skipped: 'unchanged', at: Date.now() };
		return lastResult;
	}
	try {
		const res = await fetch(endpoint, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-herald-secret': secret },
			body: JSON.stringify(body),
		});
		const text = await res.text().catch(() => '');
		lastResult = { ok: res.ok, reason, status: res.status, body, response: text.slice(0, 400), at: Date.now() };
		if (res.ok) lastSentOp.set(dedupeSlot, opKey);
		if (!res.ok) warn(`push failed ${res.status}`, text.slice(0, 200));
		else if (setting(S.verbose)) log(`pushed (${reason})`, body.ops[0].display ?? body.ops[0].worldTime);
	} catch (e) {
		// A CORS failure lands here as an opaque TypeError with no status — the spec's §5
		// warns it is otherwise silent, so say so in words the GM can act on.
		lastResult = {
			ok: false,
			reason,
			error: String(e),
			hint: 'A network/CORS failure. Check the function answers OPTIONS and allows the x-herald-secret header for this origin.',
			at: Date.now(),
		};
		warn(lastResult.error, lastResult.hint);
	}
	return lastResult;
}

function schedulePush(reason) {
	if (!setting(S.enabled)) return;
	if (!isPusher()) return;
	// `updateWorldTime` fires on every clock tick; one trailing push per burst.
	if (timer) clearTimeout(timer);
	timer = setTimeout(() => {
		timer = null;
		// Re-check at FIRE time, not only at schedule time: the harness caught a push that was
		// queued a moment before the GM switched pushing off, and still went out. "Off pauses
		// all pushes" has to mean the one already in the air, too.
		if (!setting(S.enabled) || !isPusher()) return;
		push({ reason });
	}, DEBOUNCE_MS);
}


// ===========================================================================================
// SHEETS (v2) — lodge-docs/SPEC-herald-sheets.md
//
// The curated character export for actors a PLAYER actually owns, pushed to the companion app
// and readable at /sheet/<token>. Nothing here invents a payload: rippers-guise builds it, this
// module carries it.
// ===========================================================================================

const GUISE_ID = 'rippers-guise';
/** The release that put collectExportParts/buildCharacterExport/exportCharacterFiles/
 *  downloadCharacterExport on `mod.api` (rippers-guise commit 71aac70). Declared in
 *  module.json AND checked here: a manifest requirement does not stop a world running an
 *  older build, and a missing function would otherwise surface as a mid-push TypeError. */
const GUISE_MIN = '0.7.54';
const SHEET_TOKEN_FLAG = `flags.${MODULE_ID}.sheetToken`;

/** Per-actor debounce timers. NOT one shared timer: a party-wide rest fires updateActor for
 *  five actors at once, and a single slot would publish whichever landed last and silently
 *  drop the other four. */
const sheetTimers = new Map();

const cmpVersion = (a, b) => {
	const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (d) return d < 0 ? -1 : 1;
	}
	return 0;
};

/** The guise export api, or null with one clear reason. */
function guiseApi({ quiet = false } = {}) {
	const mod = game.modules.get(GUISE_ID);
	if (!mod?.active) {
		if (!quiet) warn(`${GUISE_ID} is not active — sheet sync is off (the payload is its export, not ours)`);
		return null;
	}
	if (cmpVersion(mod.version ?? '0', GUISE_MIN) < 0) {
		if (!quiet) warn(`${GUISE_ID} ${mod.version} is older than ${GUISE_MIN}; buildCharacterExport is not on its api. Sheet sync is off.`);
		return null;
	}
	if (typeof mod.api?.buildCharacterExport !== 'function') {
		if (!quiet) warn(`${GUISE_ID} ${mod.version} does not expose buildCharacterExport — sheet sync is off`);
		return null;
	}
	return mod.api;
}

/**
 * THE GATE: a non-GM user holds OWNER on this actor.
 *
 * Deliberately stricter than the journal half's OBSERVER. This publishes a character sheet to a
 * URL that needs no login, so the test is "a player at this table plays this character", not "a
 * player may look at it". A GM-only actor therefore never gets a token, never a row and never a
 * URL — there is nothing to leak because nothing is ever created.
 */
function playerOwned(actor) {
	if (!actor || actor.type !== 'character') return false;
	return game.users.filter((u) => !u.isGM).some((u) => actor.testUserPermission(u, 'OWNER'));
}

function sheetToken(actor) {
	return foundry.utils.getProperty(actor, SHEET_TOKEN_FLAG) ?? null;
}

/**
 * Mint a token if there is not one. `randomID` IS crypto-backed in v13 — verified in
 * common/utils/helpers.mjs:1035, `crypto.getRandomValues` over a 62-character alphabet with
 * modulo-bias rejection — so 24 characters is ~143 bits and no separate helper is needed.
 *
 * Written with update(), never setFlag(): setFlag THROWS for a scope that is not core, the
 * system, or an active module, which is a live hazard for a GM-side tool and cost v1 two macros.
 */
async function ensureSheetToken(actor) {
	const existing = sheetToken(actor);
	if (existing) return existing;
	const token = foundry.utils.randomID(24);
	await actor.update({ [SHEET_TOKEN_FLAG]: token });
	return token;
}

async function buildSheetBody(actor, op) {
	if (op === 'delete') {
		return { worldId: game.world?.id ?? null, kind: 'sheet', ops: [{ op: 'delete', actorId: actor.id }] };
	}
	const api = guiseApi();
	if (!api) return null;
	const payload = await api.buildCharacterExport(actor);
	const token = await ensureSheetToken(actor);
	return {
		worldId: game.world?.id ?? null,
		kind: 'sheet',
		ops: [{ op: 'upsert', actorId: actor.id, token, name: actor.name, schemaVersion: payload?.schemaVersion ?? null, payload }],
	};
}

/**
 * One actor's push. An actor that has LOST its last player owner sends a DELETE rather than
 * falling silent — otherwise a character who left the table stays published forever.
 */
async function pushSheet(actor, reason) {
	if (!setting(S.sheets)) return null;
	if (!actor?.id) return null;
	const owned = playerOwned(actor);
	if (!owned && !sheetToken(actor)) return null;   // never published; nothing to withdraw
	const body = await buildSheetBody(actor, owned ? 'upsert' : 'delete');
	if (!body) return null;
	// Dedupe per actor: sheets are edited far more often than they change.
	return push({ reason, body, dedupeKey: `sheet:${actor.id}|${JSON.stringify(body.ops[0])}` });
}

function scheduleSheet(actor, reason) {
	if (!setting(S.enabled) || !setting(S.sheets)) return;
	if (!isPusher()) return;
	if (!actor?.id) return;
	const prev = sheetTimers.get(actor.id);
	if (prev) clearTimeout(prev);
	sheetTimers.set(actor.id, setTimeout(() => {
		sheetTimers.delete(actor.id);
		if (!setting(S.enabled) || !setting(S.sheets) || !isPusher()) return;
		pushSheet(actor, reason);
	}, DEBOUNCE_MS));
}

/** Regenerate: a NEW token, and the old row dies with it. */
async function regenerateSheetLink(actor) {
	const old = sheetToken(actor);
	if (old) {
		// Withdraw first. The function replaces by ACTOR, so this is belt-and-braces rather than
		// load-bearing — but a leaked link must stop working when the GM says so, not whenever
		// the next update happens to land.
		await push({ reason: 'regenerate-withdraw', body: { worldId: game.world?.id ?? null, kind: 'sheet', ops: [{ op: 'delete', actorId: actor.id }] }, dedupeKey: `sheet:${actor.id}|withdraw-${Date.now()}` });
	}
	const token = foundry.utils.randomID(24);
	await actor.update({ [SHEET_TOKEN_FLAG]: token });
	lastSentOp.delete(`sheet:${actor.id}`);
	await pushSheet(actor, 'regenerate');
	return sheetUrl(token);
}

/** The player-facing URL, derived from the configured endpoint's origin. */
function sheetUrl(token) {
	const endpoint = (setting(S.endpoint) ?? '').trim();
	if (!endpoint || !token) return null;
	try {
		return `${new URL(endpoint).origin}/sheet/${token}`;
	} catch {
		return null;
	}
}

async function copySheetLink(actor) {
	const token = await ensureSheetToken(actor);
	const url = sheetUrl(token);
	if (!url) {
		ui.notifications?.warn('Set the herald endpoint in Module Settings first.');
		return null;
	}
	await pushSheet(actor, 'copy-link');
	await game.clipboard?.copyPlainText?.(url);
	ui.notifications?.info(`Sheet link copied for ${actor.name}.`);
	return url;
}

/**
 * GM-only header buttons on a character sheet. Foundry 13 fires `getHeaderControlsApplicationV2`
 * for ApplicationV2 sheets and the older `getActorSheetHeaderButtons` for V1 ones; projectfu's
 * sheet is V1-shaped, and rippers-guise's is its own class, so BOTH are registered rather than
 * guessing which one a given world will use.
 */
function sheetHeaderControls(app, controls) {
	const actor = app?.actor ?? app?.document;
	if (!actor || !game.user?.isGM) return;
	if (actor.type !== 'character') return;
	controls.unshift(
		{
			label: 'Copy sheet link',
			icon: 'fas fa-link',
			class: 'herald-copy-link',
			action: 'heraldCopyLink',
			onClick: () => copySheetLink(actor),
			onclick: () => copySheetLink(actor),
		},
		{
			label: 'Regenerate sheet link',
			icon: 'fas fa-rotate',
			class: 'herald-regen-link',
			action: 'heraldRegenLink',
			onClick: () => confirmRegenerate(actor),
			onclick: () => confirmRegenerate(actor),
		},
	);
}

/** Regenerating breaks every copy of the old link, including the player's bookmark. Ask. */
async function confirmRegenerate(actor) {
	const proceed = await foundry.applications.api.DialogV2.confirm({
		window: { title: 'Regenerate sheet link' },
		content: `<p>Issue a new link for <strong>${foundry.utils.escapeHTML?.(actor.name) ?? actor.name}</strong>?</p>
			<p>The current link stops working immediately — including any copy the player has bookmarked.</p>`,
		modal: true,
	}).catch(() => false);
	if (!proceed) return null;
	const url = await regenerateSheetLink(actor);
	if (url) {
		await game.clipboard?.copyPlainText?.(url);
		ui.notifications?.info(`New sheet link copied for ${actor.name}.`);
	}
	return url;
}

Hooks.once('init', () => {
	game.settings.register(MODULE_ID, S.endpoint, {
		name: 'RIPPERS_HERALD.Settings.Endpoint.Name',
		hint: 'RIPPERS_HERALD.Settings.Endpoint.Hint',
		scope: 'world',
		config: true,
		type: String,
		default: '',
	});
	game.settings.register(MODULE_ID, S.sharedSecret, {
		name: 'RIPPERS_HERALD.Settings.Secret.Name',
		hint: 'RIPPERS_HERALD.Settings.Secret.Hint',
		scope: 'world',
		config: true,
		type: String,
		default: '',
	});
	game.settings.register(MODULE_ID, S.enabled, {
		name: 'RIPPERS_HERALD.Settings.Enabled.Name',
		hint: 'RIPPERS_HERALD.Settings.Enabled.Hint',
		scope: 'world',
		config: true,
		type: Boolean,
		default: true,
		onChange: (v) => {
			if (!v && timer) {
				clearTimeout(timer);
				timer = null;
			}
		},
	});
	game.settings.register(MODULE_ID, S.sheets, {
		name: 'RIPPERS_HERALD.Settings.Sheets.Name',
		hint: 'RIPPERS_HERALD.Settings.Sheets.Hint',
		scope: 'world',
		config: true,
		type: Boolean,
		default: true,
		onChange: (v) => {
			if (v) return;
			for (const t of sheetTimers.values()) clearTimeout(t);
			sheetTimers.clear();
		},
	});
	game.settings.register(MODULE_ID, S.verbose, {
		name: 'RIPPERS_HERALD.Settings.Verbose.Name',
		hint: 'RIPPERS_HERALD.Settings.Verbose.Hint',
		scope: 'world',
		config: true,
		type: Boolean,
		default: false,
	});

	// Core is the trigger. Calendaria's own hook is a SUPPLEMENT (a Calendaria-side edit
	// that lands on the same worldTime still repaints the date); both funnel through the
	// same debounce, so a doubled trigger is still one POST.
	Hooks.on('updateWorldTime', () => schedulePush('updateWorldTime'));
	Hooks.on('calendaria.dateTimeChange', () => schedulePush('calendaria.dateTimeChange'));

	// Sheets. An item change is an actor change as far as the sheet is concerned — equipping a
	// weapon alters the export as much as taking damage does — so the item hooks resolve to the
	// parent actor rather than being ignored.
	Hooks.on('updateActor', (actor) => scheduleSheet(actor, 'updateActor'));
	Hooks.on('createItem', (item) => scheduleSheet(item?.parent, 'createItem'));
	Hooks.on('updateItem', (item) => scheduleSheet(item?.parent, 'updateItem'));
	Hooks.on('deleteItem', (item) => scheduleSheet(item?.parent, 'deleteItem'));
	// Ownership can change without touching the actor's data, and losing the last player owner
	// is precisely when a published sheet must be WITHDRAWN.
	Hooks.on('updateActor', (actor, changed) => {
		if (changed?.ownership) scheduleSheet(actor, 'ownership');
	});

	Hooks.on('getHeaderControlsApplicationV2', sheetHeaderControls);
	Hooks.on('getActorSheetHeaderButtons', sheetHeaderControls);
});

/**
 * Calendaria warms up late (see readCalendar's note). Poll for its calendar and push once
 * more the moment it lands, so a world opened and left alone still ends up publishing the
 * right date instead of the cold-read one. Bounded: if Calendaria never warms — or is not
 * installed at all — this gives up quietly and the core fallback stands.
 */
function watchForCalendar() {
	if (!globalThis.CALENDARIA?.api) return; // not installed; nothing to wait for
	if (warmCalendar || globalThis.CALENDARIA.api.getActiveCalendar?.()) return; // already warm
	const deadline = Date.now() + 180_000;
	const iv = setInterval(() => {
		const warm = !!globalThis.CALENDARIA?.api?.getActiveCalendar?.() || !!warmCalendar;
		if (warm) {
			clearInterval(iv);
			log('Calendaria calendar became available — re-pushing the corrected date');
			schedulePush('calendaria-warm');
		} else if (Date.now() > deadline) {
			clearInterval(iv);
			warn('Calendaria is active but never produced a calendar; display falls back to core components');
		}
	}, 5000);
}

Hooks.once('ready', () => {
	const mod = game.modules.get(MODULE_ID);
	if (mod) {
		mod.api = {
			readCalendar,
			buildPayload,
			// sheets (v2)
			playerOwned,
			sheetToken,
			sheetUrl,
			pushSheet,
			buildSheetBody,
			regenerateSheetLink,
			copySheetLink,
			guiseApi,
			pushNow: (opts) => push({ reason: 'manual', ...opts }),
			isPusher,
			get lastResult() {
				return lastResult;
			},
		};
	}
	if (!game.user.isGM) return;
	// One push at ready so a freshly opened world publishes its date without waiting
	// for the clock to move. Quiet: an unconfigured install must not nag.
	schedulePush('ready');
	watchForCalendar();
	log(`ready — ${isPusher() ? 'this client is the pusher' : 'another GM is the pusher'}`);
});
