// The clock resolver is a pure function of (name, max, value) and it decides two things that
// fail SILENTLY when wrong: which row a clock is filed under on the site, and which picture it
// wears in Foundry. Both are invisible-until-embarrassing, so both get tested.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kindOf, districtOf, faceFor, revealedClocks, clockOps, FACE_STEM, FACE_SEGMENTS } from '../scripts/clocks.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ID = 'rippers-herald';

test('kind is read from the name, and only for kinds whose art we ship', () => {
	assert.equal(kindOf('Whitechapel — Miasma'), 'miasma');
	assert.equal(kindOf('the miasma over Limehouse'), 'miasma');
	assert.equal(kindOf('Docks — Damage Control'), 'damage_control');
	assert.equal(kindOf('Docks — damage-control'), 'damage_control');
	// Prosperity is CUT: no art ships, so it must resolve to nothing and keep GPC's drawing.
	assert.equal(kindOf('City — Prosperity'), null);
	assert.equal(kindOf('A Clock'), null);
	assert.equal(kindOf(undefined), null);
});

test('"damage control" wins over a shorter match, whatever the order of the table', () => {
	assert.equal(kindOf('Docks — Damage Control and Miasma'), 'damage_control');
});

test('district is the prefix before the first dash or colon, slugified', () => {
	assert.equal(districtOf('Whitechapel — Miasma'), 'whitechapel');
	assert.equal(districtOf('Whitechapel - Miasma'), 'whitechapel');
	assert.equal(districtOf('Whitechapel: Miasma'), 'whitechapel');
	assert.equal(districtOf('St Giles — Miasma'), 'st-giles');
	// No separator: the clock goes to the roll-up and is NEVER guessed onto a district page.
	assert.equal(districtOf('Hyde Park Miasma'), null);
	assert.equal(districtOf(''), null);
});

test('the face indexes the FILE by current and selects the SET by max', () => {
	assert.equal(faceFor({ name: 'Whitechapel — Miasma', max: 6, value: 0 }, ID).src, `modules/${ID}/faces/miasma-6-00.png`);
	assert.equal(faceFor({ name: 'Whitechapel — Miasma', max: 6, value: 4 }, ID).src, `modules/${ID}/faces/miasma-6-04.png`);
	assert.equal(faceFor({ name: 'Docks — Damage Control', max: 3, value: 2 }, ID).src, `modules/${ID}/faces/damage-control-3-02.png`);
});

test('a max that disagrees with the art has NO face — GPC keeps drawing it', () => {
	assert.equal(faceFor({ name: 'Whitechapel — Miasma', max: 8, value: 4 }, ID), null);
	assert.equal(faceFor({ name: 'Docks — Damage Control', max: 4, value: 1 }, ID), null);
	assert.equal(faceFor({ name: 'City — Prosperity', max: 25, value: 17 }, ID), null);
});

test('fill is clamped into the art, never past either end', () => {
	assert.equal(faceFor({ name: 'X — Miasma', max: 6, value: 99 }, ID).fill, 6);
	assert.equal(faceFor({ name: 'X — Miasma', max: 6, value: -5 }, ID).fill, 0);
	assert.equal(faceFor({ name: 'X — Miasma', max: 6, value: null }, ID).fill, 0);
});

test('every face the resolver can name is a file that actually ships', () => {
	const dir = join(ROOT, 'faces');
	assert.ok(existsSync(dir), 'faces/ must ship with the module');
	const shipped = new Set(readdirSync(dir));
	for (const [kind, segments] of Object.entries(FACE_SEGMENTS)) {
		for (let fill = 0; fill <= segments; fill++) {
			const f = `${FACE_STEM[kind]}-${String(fill).padStart(2, '0')}.png`;
			assert.ok(shipped.has(f), `${kind} fill ${fill} resolves to ${f}, which is not in faces/`);
		}
	}
	// and nothing else rides along — prosperity in particular
	assert.equal(shipped.size, 7 + 4, `faces/ should hold exactly 11 files, saw ${[...shipped].join(', ')}`);
	assert.ok(![...shipped].some((f) => /prosperity/i.test(f)), 'prosperity art must not ship (owner, 8 Sep 2026)');
});

test('a PRIVATE clock is never published, and there is no override', () => {
	const active = {
		a: { id: 'a', type: 'clock', name: 'Whitechapel — Miasma', value: 2, max: 6, private: false },
		b: { id: 'b', type: 'clock', name: 'Limehouse — Miasma', value: 5, max: 6, private: true },
	};
	const rows = revealedClocks(active);
	assert.equal(rows.length, 1);
	assert.equal(rows[0].clockId, 'a');
	assert.ok(!JSON.stringify(rows).includes('Limehouse'), 'a private clock leaked into the payload');
});

test('a points tracker is not a clock', () => {
	const rows = revealedClocks({ p: { id: 'p', type: 'points', name: 'Coin', value: 7, max: 0, private: false } });
	assert.equal(rows.length, 0);
});

test('making a clock private WITHDRAWS it — the half that matters', () => {
	const before = { a: { id: 'a', type: 'clock', name: 'W — Miasma', value: 1, max: 6, private: false } };
	const after = { a: { ...before.a, private: true } };
	const ops = clockOps(after, ['a']);
	assert.deepEqual(ops, [{ op: 'delete', clockId: 'a' }]);
});

test('a deleted clock is withdrawn too', () => {
	assert.deepEqual(clockOps({}, ['gone']), [{ op: 'delete', clockId: 'gone' }]);
});

test('an unmapped clock still publishes — to the roll-up, with null kind and district', () => {
	const rows = revealedClocks({ x: { id: 'x', type: 'clock', name: 'A Nameless Thing', value: 1, max: 4, private: false } });
	assert.equal(rows.length, 1);
	assert.equal(rows[0].kind, null);
	assert.equal(rows[0].district, null);
	assert.equal(rows[0].max, 4);
});

test('rows carry exactly the columns the table has, and nothing of GPC\'s internals', () => {
	const rows = revealedClocks({ a: { id: 'a', type: 'clock', name: 'W — Miasma', value: 2, max: 6, private: false, colorId: 'red' } });
	assert.deepEqual(Object.keys(rows[0]).sort(), ['clockId', 'current', 'district', 'kind', 'label', 'max']);
});
