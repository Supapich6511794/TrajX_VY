# Flight Playback — UI Reference

A reference to every screen and control in **Cat's Flight Playback**, the flight-track replay
viewer (`flight-animation-main`, React + TypeScript + Leaflet). 51 figures captured from the
running application, with control identifiers, the data contract, and the interaction reference.

This documents the interface **as it exists today**. It is not a proposal for changes.

---

## Open it

Open `index.html` in any browser. Everything is local — no server, no build step.

The page pulls its webfonts from Google Fonts. Offline it falls back to system faces, which
changes the typography slightly and nothing else.

```
index.html                  the reference — start here
shots/                      51 figures, referenced by the page
sample-data/                a loadable dataset and its generator (see below)
```

---

## Running the viewer without the backend

The application normally sits behind a reverse proxy that serves the built front end and
proxies several data APIs. **Without those APIs the app still runs**, because the CSV path is
entirely client-side. That is the route to use for simulated traffic.

Load through the loader's **CSV** tab. Nothing else is required.

### What works with no backend at all

| Area | Notes |
| --- | --- |
| CSV dataset load | Parsed in the browser. This whole reference was built through it. |
| Timeline, playback, speed | Scrubber spans the dataset's own extent. |
| Targets, trails, labels | Trail *colour by* attributes only work for columns your CSV actually carries. |
| Symbology, speed vectors, rings | Controller-working-position presentation. |
| Filter panel | All sections, including the results list. |
| Flight list | Per-flight visibility. |
| Measurement tools | RBL, SEP, BRL and track rings. |
| Holding panel | The detector is pure client-side geometry — it fires on CSV data. |
| Airports layer | Airports, runways and gates load from static files in `public/airports/`. |
| Basemap switch | **Needs internet** — the tiles come from external tile servers. |

### What needs the backend, and will be inert without it

| Area | Depends on |
| --- | --- |
| Airborne / Ground / Recent / Aireon loader tabs | The dataset API |
| Create-dataset page | The dataset API |
| Sector timeline strip | Control-period lookup — see the caveat below |
| Airspace, Routes, IFPs, CNS layers | The aeronautical and CNS data hubs |
| Weather and terrain overlays | External weather, satellite and elevation sources |

### Two caveats worth knowing before you start

**The runway / arrival-manager panel will not show arrivals or departures from CSV data.**
Both detectors gate on ground speed, and the CSV parser builds each track point as a fixed
tuple with no ground-speed field — there is no column you can add to supply it. The
go-around detector works from flight-level climb instead, so it *does* fire; a climb-out off
the threshold is therefore reported as a go-around. Supporting this properly from CSV means
adding ground speed to the parser. It is a small, self-contained change.

**The sector timeline strip cannot be driven from CSV at all.** Sector periods come from a
backend lookup that is gated on the date derived from the loaded flights and keyed by real
flight key, so synthetic tracks match nothing and the strip does not render. It is documented
in the reference for completeness; treat it as out of scope for a simulated feed unless you
replace that lookup with your own source.

---

## Feeding your own simulated traffic

`sample-data/synthetic_traffic_sample.csv` is a complete, loadable dataset — 25 fabricated
flights over about 2 h 27 min around Bangkok. Drop it into the CSV tab to get a populated
viewer immediately.

`sample-data/generate_synthetic_traffic.py` is what produced it. Standard library only:

```bash
python3 generate_synthetic_traffic.py     # writes synthetic_traffic_sample.csv
```

It builds each flight as a polyline of waypoints — `(lat, lon, altitude, IAS)` — and then walks
that polyline at a fixed sample interval, using each leg's speed to advance. That one sampler
produces runway-aligned finals to touchdown, take-off rolls, racetrack holding patterns and
en-route legs without special-casing any of them. To model your own traffic, edit the `FLIGHTS`
table near the bottom; the geometry helpers handle the rest.

### CSV contract

Rows are grouped into flights by `flight_key` and sorted by time.

| Column | | Meaning |
| --- | --- | --- |
| `flight_key` | required | Groups rows into one track. Any stable string. |
| `timestamp_utc` | required | ISO 8601 UTC, e.g. `2026-03-04T02:41:30Z`. |
| `latitude` | required | Decimal degrees. |
| `longitude` | required | Decimal degrees. |
| `flight_level` | optional | Hundreds of feet. `0.0` on the ground. |
| `acid` | optional | Callsign, shown in labels and the detail card. |
| `actype` | optional | ICAO type designator; drives wake category. |
| `dep` / `dest` | optional | Aerodromes — feed the movement filters. |
| `ias_dap` | optional | Indicated airspeed, kt. |
| `mag_heading_dap` | optional | Magnetic heading, degrees — rotates the target symbol. |
| `rate_cd` | optional | Climb/descend rate, ft/min. Positive is climb. |
| `vert` | optional | Vertical state: `1` climb, `2` descend, `0` or `3` cruise. |
| `mode_a_code` | optional | Squawk; selectable as a trail colour attribute. |
| `cfl` | optional | Cleared flight level. |

There is deliberately no ground-speed column, for the reason given above.

---

## About the data in the figures

Every figure was captured against **synthetic data**. The callsigns and operator codes
(`DEM`, `SMP`, `TST`, `SYN`, `EXA`, `MOC`) are invented and are not real ICAO airline
designators. Aerodrome codes and runway thresholds are real, because they are public
aeronautical data and the movement filters, runway panel and holding detector need true
geometry to behave normally.

Three figures — the sector timeline strip — could only come from a real dataset, since that
feature cannot be driven synthetically. In those, the callsign, dataset name and date were
substituted, and every value from the filed flight plan or the airframe record is redacted.
They are flagged where they appear in the reference.
