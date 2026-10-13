#!/bin/sh
# Copia de seguridad de la base de datos. Uso: DATABASE_URL=… ./scripts/respaldo.sh
# Restaurar: pg_restore --clean --no-owner -d "$DATABASE_URL" respaldos/rockola-AAAA-MM-DD.dump
set -eu
mkdir -p respaldos
ARCHIVO="respaldos/rockola-$(date +%F-%H%M).dump"
pg_dump --format=custom --no-owner "$DATABASE_URL" > "$ARCHIVO"
# Conserva los últimos 14 respaldos locales
ls -1t respaldos/*.dump | tail -n +15 | xargs -r rm --
echo "Respaldo creado: $ARCHIVO"
