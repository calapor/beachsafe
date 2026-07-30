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
  notes          TEXT,
  wave_lat       DOUBLE PRECISION,
  wave_lon       DOUBLE PRECISION
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
  swell_height_m   REAL,
  swell_period_s   REAL,
  wind_wave_height_m REAL,
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
  id               SERIAL PRIMARY KEY,
  beach_id         INTEGER NOT NULL REFERENCES beaches(id),
  date             DATE NOT NULL,
  type             TEXT NOT NULL CHECK (type IN ('rnli_launch','drowning','rescue','near_miss')),
  severity         INTEGER DEFAULT 1,
  casualties       INTEGER DEFAULT 0,
  title            TEXT NOT NULL,
  description      TEXT,
  source_url       TEXT,
  source_type      TEXT,
  external_id      TEXT,
  UNIQUE (beach_id, date, title),
  time_of_day      TIME,
  time_source      TEXT CHECK (time_source IN ('rnli','reported','unknown')) DEFAULT 'unknown',
  activity         TEXT CHECK (activity IN ('swimmer','watercraft','shore','other','unknown')) DEFAULT 'unknown',
  activity_source  TEXT,
  condition_related BOOLEAN,
  exclusion_cause  TEXT
);

CREATE TABLE IF NOT EXISTS incident_fingerprints (
  incident_id  INTEGER PRIMARY KEY REFERENCES incidents(id),
  features     JSONB NOT NULL,
  computed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS climatology (
  beach_id       INT NOT NULL REFERENCES beaches(id),
  month          SMALLINT NOT NULL,
  metric         TEXT NOT NULL,
  n              INT NOT NULL,
  coverage_start DATE,
  coverage_end   DATE,
  ladder         JSONB NOT NULL,
  computed_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (beach_id, month, metric)
);

CREATE TABLE IF NOT EXISTS feature_discrimination (
  feature     TEXT NOT NULL,
  scope       TEXT NOT NULL,
  n_case      INT NOT NULL,
  n_control   INT NOT NULL,
  auc         REAL,
  auc_lo      REAL,
  auc_hi      REAL,
  lift        REAL,
  lift_lo     REAL,
  lift_hi     REAL,
  computed_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (feature, scope)
);
