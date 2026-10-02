# FastAPI engine (api/ + trajectory_sim/). Build from the REPO ROOT:
#   docker build -f api/Dockerfile -t trajx-api .
# The engine reads its reference data from web/public/data/, so that folder is
# copied in too (the rest of web/ is excluded by the root .dockerignore).
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONPATH=/app

WORKDIR /app

# geopandas/pyproj/shapely/pyogrio ship manylinux wheels — no system GDAL needed.
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY trajectory_sim/ trajectory_sim/
COPY api/ api/
COPY web/public/data/ web/public/data/

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/health')" || exit 1

# Hosts like Render inject $PORT; locally it falls back to 8000.
CMD ["sh", "-c", "uvicorn api.server:app --host 0.0.0.0 --port ${PORT:-8000}"]
