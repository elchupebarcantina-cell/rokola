-- Rockola El Chupe · esquema inicial

CREATE TABLE venues (
  id          SERIAL PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  logo_url    TEXT,
  accent      TEXT NOT NULL DEFAULT '#B08D3E',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rooms (
  id          SERIAL PRIMARY KEY,
  venue_id    INT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,
  provider    TEXT NOT NULL DEFAULT 'catalogo',
  settings    JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (venue_id, slug)
);

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin_general','admin_sede','operador')),
  venue_id      INT REFERENCES venues(id) ON DELETE CASCADE,
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- solo el administrador general existe sin sede
  CHECK (role = 'admin_general' OR venue_id IS NOT NULL)
);

CREATE TABLE admin_sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Credencial del equipo conectado al televisor (una por pantalla vinculada)
CREATE TABLE player_devices (
  id          SERIAL PRIMARY KEY,
  room_id     INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  label       TEXT,
  created_by  INT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ
);

CREATE TABLE pairing_codes (
  code        TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  room_id     INT REFERENCES rooms(id) ON DELETE CASCADE,
  approved_by INT REFERENCES users(id) ON DELETE SET NULL,
  expires_at  TIMESTAMPTZ NOT NULL
);

-- Una "noche": la sesión activa de una sala. El token público va en el QR.
CREATE TABLE room_sessions (
  id            BIGSERIAL PRIMARY KEY,
  room_id       INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  public_token  TEXT NOT NULL UNIQUE,
  door_code     TEXT,
  status        TEXT NOT NULL DEFAULT 'abierta' CHECK (status IN ('abierta','cerrada')),
  requests_open BOOLEAN NOT NULL DEFAULT true,
  started       BOOLEAN NOT NULL DEFAULT false,
  next_seq      BIGINT NOT NULL DEFAULT 1,
  opened_by     TEXT,
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ
);
-- Garantía dura: una sola sesión abierta por sala
CREATE UNIQUE INDEX room_sessions_una_abierta ON room_sessions(room_id) WHERE status = 'abierta';

CREATE TABLE participants (
  id                  BIGSERIAL PRIMARY KEY,
  session_id          BIGINT NOT NULL REFERENCES room_sessions(id) ON DELETE CASCADE,
  alias               TEXT NOT NULL,
  phone               TEXT,
  marketing_consent   BOOLEAN NOT NULL DEFAULT false,
  privacy_accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  token_hash          TEXT NOT NULL UNIQUE,
  blocked             BOOLEAN NOT NULL DEFAULT false,
  last_request_at     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX participants_session ON participants(session_id);

CREATE TABLE requests (
  id             BIGSERIAL PRIMARY KEY,
  session_id     BIGINT NOT NULL REFERENCES room_sessions(id) ON DELETE CASCADE,
  room_id        INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  participant_id BIGINT REFERENCES participants(id) ON DELETE SET NULL,
  source         TEXT NOT NULL DEFAULT 'cliente' CHECK (source IN ('cliente','respaldo')),
  provider       TEXT NOT NULL,
  media_id       TEXT NOT NULL,
  title          TEXT NOT NULL,
  channel        TEXT,
  thumbnail      TEXT,
  duration_sec   INT,
  status         TEXT NOT NULL CHECK (status IN
                   ('por_aprobar','pendiente','reproduciendo','completada','omitida','cancelada','fallida')),
  seq            BIGINT,
  idem_key       TEXT,
  fail_reason    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at    TIMESTAMPTZ,
  started_at     TIMESTAMPTZ,
  ended_at       TIMESTAMPTZ
);
-- Idempotencia: el mismo intento del mismo participante produce una sola fila
CREATE UNIQUE INDEX requests_idem ON requests(session_id, participant_id, idem_key) WHERE idem_key IS NOT NULL;
-- Orden único dentro de la sesión
CREATE UNIQUE INDEX requests_seq ON requests(session_id, seq) WHERE seq IS NOT NULL;
-- Garantía dura: nunca dos canciones "reproduciendo" en la misma sesión
CREATE UNIQUE INDEX requests_una_sonando ON requests(session_id) WHERE status = 'reproduciendo';
CREATE INDEX requests_fila ON requests(session_id, status, seq);
CREATE INDEX requests_room_media ON requests(room_id, provider, media_id, ended_at);

-- Estado de reproducción por sala. Su fila es además el candado (mutex) de la fila.
CREATE TABLE playback_state (
  room_id              INT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  session_id           BIGINT REFERENCES room_sessions(id) ON DELETE SET NULL,
  current_request_id   BIGINT REFERENCES requests(id) ON DELETE SET NULL,
  desired              TEXT NOT NULL DEFAULT 'play' CHECK (desired IN ('play','pause')),
  leader_id            TEXT,
  leader_expires_at    TIMESTAMPTZ,
  player_status        TEXT,
  player_detail        TEXT,
  last_heartbeat       TIMESTAMPTZ,
  consecutive_failures INT NOT NULL DEFAULT 0,
  attention            TEXT,
  fallback_cursor      INT NOT NULL DEFAULT 0,
  version              BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE fallback_items (
  id           SERIAL PRIMARY KEY,
  room_id      INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  provider     TEXT NOT NULL,
  media_id     TEXT NOT NULL,
  title        TEXT NOT NULL,
  channel      TEXT,
  thumbnail    TEXT,
  duration_sec INT,
  position     INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE blocked_media (
  id         SERIAL PRIMARY KEY,
  venue_id   INT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL,
  media_id   TEXT NOT NULL,
  title      TEXT,
  reason     TEXT,
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (venue_id, provider, media_id)
);

-- Catálogo propio o con licencia (proveedor "catalogo"). is_demo marca el contenido de demostración.
CREATE TABLE catalog_items (
  id           SERIAL PRIMARY KEY,
  venue_id     INT REFERENCES venues(id) ON DELETE CASCADE,  -- NULL = disponible en todas las sedes
  media_id     TEXT NOT NULL UNIQUE,
  title        TEXT NOT NULL,
  artist       TEXT,
  duration_sec INT NOT NULL,
  url          TEXT NOT NULL,       -- https://… (mp4/webm/mp3) o synth:<semilla> para la demo
  thumbnail    TEXT,
  license_note TEXT,
  is_demo      BOOLEAN NOT NULL DEFAULT false,
  active       BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  venue_id   INT,
  room_id    INT,
  session_id BIGINT,
  actor      TEXT NOT NULL,          -- "usuario:3", "pantalla:2", "sistema"
  action     TEXT NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_room ON audit_log(room_id, created_at DESC);

-- Registro de fallos. Nunca guarda teléfonos ni datos personales.
CREATE TABLE error_log (
  id         BIGSERIAL PRIMARY KEY,
  room_id    INT,
  session_id BIGINT,
  kind       TEXT NOT NULL,
  message    TEXT NOT NULL,
  detail     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX error_room ON error_log(room_id, created_at DESC);

CREATE TABLE api_usage (
  day          DATE NOT NULL,
  provider     TEXT NOT NULL,
  units        INT NOT NULL DEFAULT 0,
  searches     INT NOT NULL DEFAULT 0,
  cache_hits   INT NOT NULL DEFAULT 0,
  errors       INT NOT NULL DEFAULT 0,
  exhausted_at TIMESTAMPTZ,
  PRIMARY KEY (day, provider)
);

-- Caché de metadatos (nunca video ni audio). Se purga a los 30 días como máximo.
CREATE TABLE media_cache (
  provider   TEXT NOT NULL,
  media_id   TEXT NOT NULL,
  data       JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, media_id)
);
CREATE TABLE search_cache (
  provider   TEXT NOT NULL,
  query      TEXT NOT NULL,
  page       TEXT NOT NULL DEFAULT '',
  data       JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, query, page)
);
