# Trajectory API (FastAPI)

Thin HTTP wrapper so the web app can run the **real** `trajectory_sim`
Phase 1 pipeline (route parsing, `pyproj.Geod` WGS-84 geodesy, GeoPackage /
CSV export). No geodesy is re-implemented here — this just calls the
canonical Python package.

## Run

From the **project root**, with the virtualenv's Python:

```powershell
# Windows PowerShell
$env:PYTHONPATH = (Get-Location).Path
.venv\Scripts\python.exe -m uvicorn api.server:app --reload --port 8000
```

```bash
# bash
PYTHONPATH=. .venv/Scripts/python -m uvicorn api.server:app --reload --port 8000
```

Health check: <http://localhost:8000/api/health>

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET  | `/api/health` | liveness + data-file presence |
| POST | `/api/generate` | run pipeline → stats + route + points + download URLs |
| POST | `/api/generate_batch` | the same, for many flights in one call |
| GET  | `/api/download/{flight_key}.{gpkg\|csv\|geojson}` | fetch a generated file |
| GET  | `/api/flight_time_curve?actype=&cruise_alt_ft=` | distance → flight-time curve for one airframe (Thai APM performance) |
| GET  | `/api/procedures/{airport}` (+ `/{name}`) | SID/STAR/approach listing and legs |

`POST /api/generate` body (all fields optional; defaults shown):

```json
{
  "source": "fpl",             // the only supported source (Item-15 route)
  "adep": "VYYY",
  "ades": "VYMD",
  "route": "BGO W13 MIA",      // Item-15 route; airways are expanded
  "actype": "B738",
  "callsign": "SIM738",
  "eobt": "2026-01-03T08:15:00", // ISO, naive = UTC
  "rfl": 330,
  "sid": null, "star": null, "approach": null
}
```

Generated files are written to `api/_outputs/` (git-ignored). The `.gpkg`
is the genuine Phase 1 deliverable artefact written by
`trajectory_sim.output.write_geopackage`.

## Data

All navdata is Myanmar (Yangon FIR, ICAO VY), under `web/public/data/`:

- `aip_VY.json` — waypoints, airways and aerodromes (built from the VY AIXM
  5.1.1 export by `scripts/ingest_aixm_waypoints.py`,
  `scripts/ingest_aixm_airways.py` and `scripts/ingest_aixm_airports.py`);
- `airports/runway_vy.csv` — runway thresholds, bearings and elevations;
- `aixm_vy/*_waypoint.geojson`, `ils_wp.geojson` — coded SID/STAR/approach legs;
- `aixm_vy/airway_vor_vy.geojson` — VOR/DME navaids (terminal-VOR trimming);
- `aixm_vy/airspace_boundaries.geojson` + `restricted_areas.geojson` — the
  airspace volumes behind the export's `sector` column (PDR > CTR > TMA >
  CTA > FIR, see `trajectory_sim/airspace.py`).

Aircraft performance is the Thai APM dataset in `trajectory_sim/data/`.

## Notes

- CORS is open to `http://localhost:3000` (the Next.js dev server). If Next
  falls back to another port, add it in `api/server.py`.
