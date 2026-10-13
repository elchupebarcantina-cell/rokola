-- Repertorio: listas de reproducción de YouTube importadas (1 unidad por cada 50 videos)
-- para que la búsqueda de los clientes no gaste cuota. Solo metadatos; se refresca cada 25 días.

CREATE TABLE repertoire_lists (
  id            SERIAL PRIMARY KEY,
  venue_id      INT REFERENCES venues(id) ON DELETE CASCADE,   -- NULL = todas las sedes
  provider      TEXT NOT NULL DEFAULT 'youtube',
  list_id       TEXT NOT NULL,
  title         TEXT,
  channel       TEXT,
  item_count    INT NOT NULL DEFAULT 0,
  units_spent   INT NOT NULL DEFAULT 0,
  last_error    TEXT,
  created_by    INT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  refreshed_at  TIMESTAMPTZ,
  UNIQUE (venue_id, provider, list_id)
);

CREATE TABLE repertoire_items (
  list_id      INT NOT NULL REFERENCES repertoire_lists(id) ON DELETE CASCADE,
  media_id     TEXT NOT NULL,
  title        TEXT NOT NULL,
  channel      TEXT,
  thumbnail    TEXT,
  duration_sec INT,
  embeddable   BOOLEAN NOT NULL DEFAULT true,
  live         BOOLEAN NOT NULL DEFAULT false,
  made_for_kids BOOLEAN NOT NULL DEFAULT false,
  position     INT NOT NULL DEFAULT 0,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, media_id)
);
CREATE INDEX repertoire_items_title ON repertoire_items (lower(title));
CREATE INDEX repertoire_items_media ON repertoire_items (media_id);
