-- BeachSafe schema

CREATE TABLE IF NOT EXISTS beaches (
  id             SERIAL PRIMARY KEY,
  slug           TEXT UNIQUE NOT NULL,
  name           TEXT NOT NULL,
  county         TEXT NOT NULL,
  lat            DOUBLE PRECISION NOT NULL,
  lon            DOUBLE PRECISION NOT NULL,
  met_station_no TEXT,
  wave_buoy_id   TEXT,
  tide_station_id TEXT,
  notes          TEXT
);

CREATE TABLE IF NOT EXISTS observations (
  id               BIGSERIAL PRIMARY KEY,
  beach_id         INTEGER NOT NULL REFERENCES beaches(id),
  date             DATE NOT NULL,
  -- weather (Met Éireann daily)
  rain_mm          REAL,
  temp_max_c       REAL,
  temp_min_c       REAL,
  mean_wind_knots  REAL,
  max_gust_knots   REAL,
  wind_dir_deg     REAL,
  mslp_hpa         REAL,
  -- waves (nearest buoy, nullable pre-buoy era)
  wave_height_m    REAL,
  wave_period_s    REAL,
  sea_temp_c       REAL,
  -- astronomical (computed)
  moon_phase       REAL,
  moon_illum       REAL,
  tide_range_m     REAL,
  high_tide_times  TEXT,
  low_tide_times   TEXT,
  source_flags     JSONB,
  UNIQUE(beach_id, date)
);

CREATE INDEX IF NOT EXISTS obs_beach_date ON observations(beach_id, date);

CREATE TABLE IF NOT EXISTS incidents (
  id           SERIAL PRIMARY KEY,
  beach_id     INTEGER NOT NULL REFERENCES beaches(id),
  date         DATE NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('rnli_launch','drowning','rescue','near_miss')),
  severity     INTEGER DEFAULT 1,
  casualties   INTEGER DEFAULT 0,
  title        TEXT NOT NULL,
  description  TEXT,
  source_url   TEXT,
  source_type  TEXT,
  external_id  TEXT
);

CREATE TABLE IF NOT EXISTS incident_fingerprints (
  incident_id  INTEGER PRIMARY KEY REFERENCES incidents(id),
  features     JSONB NOT NULL,
  computed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
