# Flight Trajectory Generator — Web UI

Click-driven front-end for **Phase 1** of the BearCat trajectory generator.
A user picks a route, presses one button, and gets a trajectory on an
interactive map plus GeoPackage / CSV / GeoJSON downloads — no code, no
terminal.

The web does **no trajectory math**. It calls the Python FastAPI server,
which runs the real `trajectory_sim` package (route parsing,
`pyproj.Geod` WGS-84 geodesy, GeoPackage export). **One engine.**

## Stack

| Concern   | Choice                          |
| --------- | ------------------------------- |
| Framework | Next.js 14 (App Router)         |
| Language  | TypeScript (strict)             |
| Map       | Leaflet 1.9 via react-leaflet 4 |
| Compute   | Python FastAPI → `trajectory_sim` |

## Run (two processes)

**1 — Python API** (from the project root, venv Python):

```powershell
$env:PYTHONPATH = (Get-Location).Path
.venv\Scripts\python.exe -m uvicorn api.server:app --reload --port 8000
```

**2 — Web** (from `web/`):

```bash
npm install   # first time only
npm run dev
```

Open the printed URL (http://localhost:3000, or :3001 if 3000 is busy).
If the API runs somewhere else, set `NEXT_PUBLIC_API_BASE` before `npm run dev`.

The dark basemap uses CARTO Dark Matter when `NEXT_PUBLIC_CARTO_API_KEY` is
set (free key from [carto.com](https://carto.com); CARTO watermarks tiles
served without one) and falls back to the keyless Esri Dark Gray Canvas when it
is not. Both are inlined at build time, so set them before starting the dev
server:

```bash
NEXT_PUBLIC_CARTO_API_KEY=your_key_here npm run dev
```

## Architecture

```
Browser (Next.js, :3000)
  └─ GeneratorPanel  ── POST /api/generate ──►  FastAPI (:8000)
                                                   └─ trajectory_sim
                                                      parse_route → navdata
                                                      → pyproj geodesy
                                                      → build_trajectory_gdf
                                                      → write_geopackage/csv
  ◄── stats + points + download URLs ───────────────┘
  └─ LeafletMap renders the trajectory; download links hit the API
```

- Leaflet still loads via `next/dynamic({ ssr:false })` inside the
  `MapApp` client component (App Router requirement).
- `lib/api.ts` is the only backend touchpoint; `lib/trajectory/types.ts`
  holds the shared result shape. The earlier client-side TS pipeline was
  removed so there is exactly one implementation (Python).

## Data

`public/data/` holds the Myanmar (Yangon FIR, ICAO `VY`) navdata the map
and the API read, all derived from the AIP Myanmar AIXM 2609 export:

- `aip_VY.json` — every significant point / navaid, the airways and the
  aerodromes; resolves idents in the route preview and RouteBuilder.
- `aixm_vy/airway_segments_vy.geojson`, `aixm_vy/airway_vor_vy.geojson` —
  the ATS route network and VOR/DME stations drawn on the map.
- `aixm_vy/airspace_boundaries.geojson` (CTR / TMA / CTA / FIR) and
  `aixm_vy/restricted_areas.geojson` (P / R / D) — the airspace layers
  (`ctr`, `tma`, `cta`, `fir`, `pdr`; hierarchy pdr > ctr > tma > cta > fir).
- `aixm_vy/{sid,star,pbn,ils}_*.geojson` — terminal procedures.
- `airports/Airport_with_AP_Main_vy.csv`, `airports/runway_vy.csv` —
  aerodromes and runway thresholds.

Routes are always Item-15 strings (e.g. `BGO W13 MIA`); there is no
airway-CSV corridor mode.

See [`../api/README.md`](../api/README.md) for the API contract.
