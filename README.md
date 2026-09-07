# rippers-herald

One-way calendar push: Foundry (GM client) → the Rippers Unmasked companion app.

```
Foundry (active GM)  ──fetch──▶  /api/herald  ──service key──▶  Supabase.calendar_state  ──▶  /almanack
```

**This build is calendar-only.** The journal-page half of
`lodge-docs/SPEC-foundry-herald-sync.md` is deferred by the owner's 7 Sep 2026 ruling; no
journal hook is registered. Do not add one without a new ruling.

## What it does

- Listens to core **`updateWorldTime`** and reads **`game.time.worldTime`** as the truth.
  Calendaria supplies only the display string, so the sync survives Calendaria being
  disabled — you lose the pretty date, not the date.
- Only the **active GM** posts (`game.users.activeGM`), so two GM windows don't double-write.
- Pushes are **debounced 2 s**; a clock advance that fires many ticks sends one POST.
- Holds **no Supabase keys** — a world-scoped endpoint + shared secret, nothing else.

## Setup (GM)

1. Install the module and enable it in the world.
2. **Settings → Module Settings → Rippers — Herald**: set the endpoint
   (`https://<site>/api/herald`) and the shared secret. The secret must match
   `HERALD_SHARED_SECRET` in the app's Netlify environment.
3. Advance the clock. `Push the calendar` off pauses without clearing the settings.

To test from the console: `game.modules.get('rippers-herald').api.pushNow()` then
`game.modules.get('rippers-herald').api.lastResult`.

## The wire body

```json
{ "worldId": "…", "kind": "calendar",
  "ops": [{ "op": "upsert", "worldTime": 63600, "year": 1892, "month": 1, "dayOfMonth": 1,
            "hour": 17, "minute": 40, "calendarId": "gregorian", "display": "1 January 1892, 17:40" }] }
```

camelCase on the wire, snake_case in the table; the Netlify function is the only place
that mapping lives. The envelope is the spec's, so the deferred journal half can arrive
later as `kind: "journal"` without a breaking change.

## A Calendaria fact worth not re-deriving

`CALENDARIA.api.getCurrentDateTime()` (1.0.17) returns **`day`**, not `dayOfMonth`, and its
`month`/`day` are **1-based** while core's `game.time.components` are 0-based. The herald
spec's §1 says `dayOfMonth`; that is wrong. `readCalendar()` accepts either key and
normalises the core fallback to the 1-based shape.

## The warm-up trap (measured, not assumed)

Calendaria's **active calendar is `null` for ~35 seconds after `ready`**, and
`getCurrentDateTime()` answers anyway during that window — with `yearZero` NOT applied, so the
same instant reads `year: 0` cold and `year: 1970` warm. An earlier build of this module took
Calendaria's word for it and published the cold, wrong date silently.

The module now takes the Calendaria branch **only when `getActiveCalendar()` returns a
calendar**. Until then it reports the core fallback honestly (`source: "core"`,
`calendariaCold: true`), and a bounded watcher re-pushes once the calendar lands, so a world
that is opened and left alone still ends up publishing the right date.
