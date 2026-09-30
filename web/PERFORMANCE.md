# Web performance — what was slow and what was changed

This note records a performance pass on the web app, based on four Chrome
DevTools recordings taken on 2026-10-01:

| Recording | What it captured |
| --- | --- |
| `Trace-20261001T014230.json.gz` | Opening the app with an imported flight-plan file |
| `GenerateTrace-20261001T021815.json` | Generating trajectories |
| `ConflictandSectorTrace-20261001T022137.json` | Playback with CD&R auto-resolve and the sector tools |
| `ToolandExportTrace-20261001T022137.json` | **Byte-identical to the file above** (same recording saved twice) |

All four were recorded against `npm run dev`. The dev build runs React's extra
checks and renders every component twice (Strict Mode), so the absolute
numbers below are roughly 1.5–2× what a production build would show. The
*proportions* are still right, and they are what pointed at the fixes.

## The headline numbers

| | Before |
| --- | --- |
| Main thread busy during playback | **~90 % for 90 s straight** |
| Dropped frames during playback | **15,922** |
| Main thread busy after opening a plan file | 65–90 % for ~5 s, with no input |
| `GeneratorPanel` renders after opening a plan file | ~464 in 5 s (~90 per second) |

A browser has ~16 ms per frame to stay at 60 fps. When the main thread is 90 %
busy, the aircraft can only move when a frame happens to fit, which is the
stutter you see.

## What was wrong, and what was changed

Ordered by how much time each fix removes from the traces.

### 1. Every auto-resolve fix re-parsed every flight — 14.7 s

**Where:** `MapApp.tsx` (`pdrFlights`), `lib/pdr/usePdrCheck.ts`
(`pathFromTrajectory`).

Auto-resolve applies one fix at a time, and each fix replaces one trajectory.
The PDR (restricted-area) check was keyed on the whole trajectory list, so each
fix rebuilt the path for **every** flight. That meant calling `Date.parse` on
every timestamp and running the path decimation again, for flights that had not
changed.

**Fix:**
- `pathFromTrajectory` caches its result per points array (`WeakMap`). An
  unchanged flight keeps its array, so it costs nothing.
- `MapApp` reuses the same `PdrFlight` object for an unchanged trajectory.
- `usePdrCheck` caches each flight's verdict by that object, so a re-scan
  only analyses the flight that actually changed.

### 2. Leaflet redrew the whole map canvas every frame — ~12 s

**Where:** `components/LeafletMap.tsx`.

The map uses `preferCanvas`, so every line (airways, sectors, procedures,
routes) is drawn on **one** canvas. The moving aircraft trails were on that
same canvas. Each time a trail moved, Leaflet cleared that region and redrew
every static line crossing it. That was 60 times a second, and trails are
long, so the regions were large.

**Fix:** the trails are collected into their own pane (`aircraft-trails`).
Leaflet gives each pane its own canvas, so a moving trail now only redraws the
other trails. The pane has `pointer-events: none`, so clicks and hovers still
reach the aircraft and the map layers below it.

### 3. Every flight card re-rendered every frame — ~7.5 s

**Where:** `MapApp.tsx` (Route Profile "all routes" list),
`components/RouteResultTabs.tsx`.

The profile list mounts one card per flight. Each card was handed the live
clock (`simT`) plus new callback functions on every frame, so every card
re-rendered 60 times a second. That included collapsed cards, which only show
a header. The clock offset also parsed a date per card per frame.

**Fix:**
- Collapsed cards get no clock and no live airspace. They don't display
  either.
- `RouteResultTabs` is wrapped in `memo`. Its comparison ignores the two
  callback props, which now read the latest handler through a ref, so a card
  only re-renders when something it shows has changed.
- The per-card clock uses the precomputed `routeOffsets` instead of parsing
  a date.

### 4. Opening a plan file started an endless render loop

**Where:** `components/GeneratorPanel.tsx`, `MapApp.tsx`.

The loop:

1. `allDrafts` (every plan, plus the one being edited) was rebuilt on every
   render.
2. So the departure-conflict list was recomputed on every render, as a new
   array.
3. So the effect that reports it to `MapApp` fired on every render, and
   `MapApp` stored it (a state change, so another render).
4. `MapApp` passed `onOpenPdrCheck={() => openCdrView("pdr")}`, a new function
   each time. That defeated `memo(GeneratorPanel)`, so the panel rendered
   again, and the loop went back to step 1.

With ~2000 imported plans, every pass also rebuilt ~4000 tab buttons. The same
inline function made `GeneratorPanel` re-render on every playback frame too.

**Fix:**
- `allDrafts` and the live plan snapshot are memoized on the editor fields,
  so they only change when a plan does. This breaks the loop at its source.
- `onOpenPdrCheck` is a stable `useCallback` (`openPdrCheck`).
- Each plan tab is a small memoized `PlanTab` component with stable handlers.
  Typing in one plan re-renders one tab, not all of them.
- The tab search and route count are memoized.

### 5. Plane icons were rebuilt every frame — ~2–3 s

**Where:** `components/LeafletMap.tsx` (`planeIcon`).

Each frame created a new `L.divIcon` for every aircraft. `react-leaflet` sees a
new icon and calls `setIcon`, which deletes the aircraft's DOM element and
builds a new one from an HTML string.

**Fix:** icons are cached by heading (whole degrees), colour and
"followed" state. An aircraft flying straight at a steady level keeps the same
icon object, so its DOM element is reused and only moved. This also helps
clicks on aircraft land more reliably.

### 6. The conflict log re-walked every conflict — 2.1 s

**Where:** `lib/cdr/conflictLog.ts`.

Each time the conflict scan changed (after every auto-resolve fix), the log
re-ran the loss-of-separation window walk (`losWindows`) for **every** live
conflict. The scan is incremental, though: untouched pairs keep the same
object.

**Fix:** log entries are cached per conflict object. The cache is only reused
while both flights' sample tables, offsets and the CD&R config are unchanged,
so an entry is only rebuilt when its inputs actually changed.

### 7. The filter panel worked while it was closed — 2.1 s

**Where:** `components/FilterPanel.tsx`, `lib/useSimPlayback.ts`.

`MapApp` keeps the filter panel mounted. Its Results list (status and sort
order for every flight) was recomputed on every frame, even with the panel
closed. It also called `totalSeconds`, which parses two dates per flight per
call.

**Fix:**
- The list is not computed while the panel is closed.
- Durations are computed once per trajectory set.
- `totalSeconds` is cached per points array. It is called from several
  per-frame paths, so this helps everywhere.

## How it was checked

- `npx tsc --noEmit` — clean.
- `npx vitest run` — all 61 existing test files pass (984 tests), plus
  `lib/perfCaches.test.ts`, which checks the new caches (same array → cached
  result, replaced array → recomputed).
- `npm run build` — the production build succeeds.

These results confirm the code is correct. They don't measure the speed-up;
to see that, re-record the same scenarios (see below).

## How to measure it yourself

1. Run the **production** build, not the dev server:
   ```bash
   cd web
   npm run build
   npm start
   ```
2. In Chrome DevTools → Performance, record the same scenario: open the plan
   file, generate, then play with auto-resolve on.
3. Compare the recordings on:
   - the red "long task" bars in the Main track;
   - the Frames track (dropped / partial frames);
   - Bottom-Up → Self time: `pathFromTrajectory`, `_draw`, `RouteResultTabs`
     and `GeneratorPanel` should have dropped out of the top of the list.

## What is left (not changed in this pass)

- **`MapApp` still re-renders on every animation frame.** The playback clock
  lives in `MapApp` state, so the 5,500-line component runs 60 times a second.
  Most of its children now skip work, but the render itself remains. The larger
  fix would be moving the clock into a small store (`useSyncExternalStore`) that
  only the map and the visible panels subscribe to. That is a bigger
  refactor, worth doing if playback is still not smooth enough.
- **Permanent aircraft tag tooltips.** Leaflet measures each tooltip
  (`offsetWidth` / `offsetHeight`) when it is placed. With many aircraft
  appearing at once (right after Generate), that forces a layout per aircraft
  and causes a ~1 s long task. Drawing the tag as part of the marker icon would
  avoid it.
- **Auto-resolve planning** (`generatePlanResolutions`, ~4.5 s over the run).
  This is real work, and it already runs in a paced timer loop that leaves
  gaps for painting. Moving it to a Web Worker would take it off the main
  thread entirely.
- **55 `console.error` calls** appear in the first recording. The trace doesn't
  include their text, so check the browser console for what they are.
