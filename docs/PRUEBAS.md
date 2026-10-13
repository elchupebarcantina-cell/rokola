# Pruebas y resultados

Ejecutadas el 13 de octubre de 2026 con Node.js 22.22, PostgreSQL 16 y Chromium 141 (Playwright).

## Resumen

| Conjunto | Resultado | Qué ejercita |
|---|---|---|
| `npm test` | **29 de 29** | API real por HTTP + PostgreSQL real: concurrencia, idempotencia, avance, permisos, límites, cuota |
| `npm run e2e` | **17 de 17** | Navegadores reales: panel, televisor (1920×1080) y dos celulares emulados, con sonido y política de autoplay estricta |
| Proveedor YouTube | Solo con red simulada | Ver «Lo que NO se probó» |
| Revisión independiente del código | 12 hallazgos, todos corregidos | Autorización, fuga de datos, XSS, concurrencia, estabilidad, televisor |

La revisión independiente no encontró problemas de autorización, de fuga de datos ni de XSS. Encontró y se corrigieron: reintentos de conexión a la base que se multiplicaban en cada caída; una canción que podía repetirse tras un corte de red de más de 15 segundos; canciones marcadas como fallidas por un corte de internet; un falso «autoplay bloqueado» tras un corte; una consulta dentro del candado de sala que podía agotar las conexiones; el bloqueo de videos, que solo limpiaba una sala de la sede; y validaciones de entrada que respondían con error 500. Las cuatro últimas pruebas de `npm test` cubren esas correcciones.

## Escenarios de aceptación

| # | Escenario | Cómo se comprobó | Resultado |
|---|---|---|---|
| 1 | Cinco clientes agregan a la vez; orden único y consistente | Automática: 5 y luego 40 solicitudes simultáneas; turnos únicos y consecutivos; televisor y clientes ven la misma fila | Pasa |
| 2 | Doble clic o reintento no duplica | Automática: 5 envíos simultáneos con la misma clave y un reintento tardío → una sola fila. E2E: doble toque real en el botón | Pasa |
| 3 | Al terminar una canción empieza la siguiente una sola vez | Automática: 4 avisos de fin simultáneos → un solo avance. E2E: la pista termina sola y entra la siguiente | Pasa |
| 4 | Una solicitud nueva no interrumpe el video actual | Automática y E2E | Pasa |
| 5 | Con la fila vacía continúa el respaldo | Automática: el respaldo termina antes de atender solicitudes, retoma donde iba y rota. E2E | Pasa |
| 6 | Un video no reproducible se registra y no bloquea | Automática: queda «fallida» con motivo, aparece en Errores, suena la siguiente | Pasa |
| 7 | Una caída de internet no elimina solicitudes | Automática: tras 3 fallos seguidos se detiene, conserva la fila y el turno, y se reanuda. E2E: televisor sin red mientras un cliente pide; al volver, la fila está completa | Pasa |
| 8 | Recargar la pantalla recupera la sesión | Automática y E2E (misma fila, mismo liderazgo, vuelve a sonar) | Pasa |
| 9 | Una segunda pantalla no crea dos reproductores | Automática: la segunda no obtiene liderazgo ni puede avanzar. E2E: la segunda pestaña no carga ningún reproductor; al morir la principal, otra toma el control a los ~15 s | Pasa |
| 10 | Dos sedes independientes | Automática | Pasa |
| 11 | Un cliente no ejecuta acciones administrativas | Automática: cliente, pantalla, operador de otra sede, administrador de sede, y petición desde otro origen (CSRF). E2E | Pasa |
| 12 | El QR se escanea desde el televisor y funciona con datos móviles | Parcial: el QR se decodifica desde una captura de la pantalla a 1920×1080 y a un tercio del tamaño, y el enlace abre la sesión. **Falta la prueba física** | Parcial |
| 13 | El bloqueo de autoplay muestra una solución | E2E con política estricta: aparece «Reanudar reproducción» / «Activar sonido», y al pulsar suena | Pasa |
| 14 | Cuota agotada: mensaje claro y la fila no se borra | Automática con la respuesta de error de la API simulada | Pasa (simulado) |

## Lo que NO se probó

Dicho sin adornos, para que nadie lo dé por hecho:

1. **YouTube real.** No había clave de API ni acceso a YouTube desde el entorno de desarrollo. El adaptador de búsqueda se probó contra respuestas simuladas con el formato documentado de la API; el adaptador de reproducción (`createYouTubePlayer`) está escrito según la documentación del IFrame Player API y **nunca ha reproducido un video real**. No debe considerarse terminado hasta pasar la lista de abajo.
2. **Celulares físicos.** Android y iPhone se emularon (tamaño de pantalla táctil y agente de usuario de iPhone) en Chromium. No se probó en Safari real ni en Chrome de Android.
3. **Cámara real leyendo el QR** en un televisor, a distancia y con las luces del bar.
4. **Carga.** No se midió con cientos de clientes simultáneos.
5. **Archivos de video reales** en el catálogo autorizado. El reproductor de archivos (`<video>`) comparte la lógica probada con las pistas DEMO, pero no se reprodujo un mp4 real.

## Verificaciones manuales antes de abrir al público

### En cada sede (15 minutos)

- [ ] En el equipo del televisor: **Iniciar noche** → suena por los parlantes del bar y se ve en pantalla completa con el QR al lado.
- [ ] Desde la mesa más lejana: escanear el QR con un iPhone y con un Android, **con datos móviles**, sin wifi.
- [ ] Pedir desde dos celulares a la vez; revisar que ambos ven la misma fila y que el televisor la muestra.
- [ ] Dejar terminar una canción completa y ver que entra la siguiente sin tocar nada.
- [ ] Desconectar el internet del equipo 1 minuto: aparece el aviso; al reconectar, la fila sigue igual.
- [ ] Recargar la pantalla (F5): sigue la misma canción o aparece el botón para reanudar.
- [ ] Abrir `/tv` en una segunda pestaña: dice que otra pantalla es la reproductora y no suena doble.
- [ ] Desde el panel en el celular: pausar, continuar, saltar, quitar.
- [ ] Apagar y prender el equipo: anotar qué hay que pulsar para volver a sonar.

### Si algún día se habilita YouTube (además de lo anterior)

- [ ] Buscar, pedir y reproducir 10 videos musicales distintos; el título y quién lo pidió aparecen fuera del reproductor.
- [ ] Un video con anuncio previo: la fila **no** avanza durante el anuncio y sí al terminar el video.
- [ ] Un video que no permite reproducción integrada (errores 101/150): se marca como fallido y entra el siguiente.
- [ ] Un video eliminado o privado (error 100): lo mismo.
- [ ] Con la red lenta: el búfer no hace avanzar la fila.
- [ ] Pausar y continuar desde el panel.
- [ ] Los controles y el logo de YouTube se ven completos; nada de la aplicación los tapa en 1920×1080 ni en 1366×768.
- [ ] Recargar la página: el reproductor pide el gesto y el botón «Activar sonido» lo resuelve.
- [ ] En el panel, **Consumo de API** refleja 101 unidades por búsqueda nueva y 0 por una repetida.
- [ ] Probar en Chrome y en Edge.

## Cómo repetir las pruebas

```bash
# Automáticas (usa y borra una base aparte)
createdb rockola_test
TEST_DATABASE_URL=postgres://localhost/rockola_test npm test

# De punta a punta (servidor en marcha, datos sembrados, sala con catálogo DEMO)
BASE=http://localhost:3000 ADMIN_EMAIL=… ADMIN_PASSWORD=… CHROMIUM=/ruta/a/chrome npm run e2e
```

`npm run e2e` necesita `npm install` con dependencias de desarrollo y un Chrome o Chromium instalado. Deja capturas en `capturas/`.

## Salida de `npm test`

```
ok 1 - 1 · cinco clientes agregan a la vez: orden único y consistente
ok 2 - 1b · cuarenta solicitudes simultáneas no pierden ni repiten turnos
ok 3 - 2 · doble clic o reintento no duplica la solicitud
ok 4 - 3 · al terminar una canción empieza la siguiente una sola vez
ok 5 - 4 · una solicitud nueva no interrumpe el video actual
ok 6 - 5 · con la fila vacía continúa la lista de respaldo, y el respaldo se termina antes de atender solicitudes
ok 7 - 6 · un video no reproducible se registra y no bloquea la sesión
ok 8 - 7 · una caída general no descarta la fila: se detiene y pide intervención
ok 9 - 7b · una canción que sí suena reinicia el contador de fallos
ok 10 - 8 · recargar la pantalla recupera la sesión sin vaciar la fila
ok 11 - 9 · abrir una segunda pantalla no crea dos reproductores principales
ok 12 - 10 · dos sedes funcionan de manera independiente
ok 13 - 11 · permisos: clientes, pantallas y otros roles no ejecutan acciones ajenas
ok 14 - 11b · CSRF: un origen ajeno no puede mutar con la cookie del administrador
ok 15 - límites y moderación configurables
ok 16 - aprobación manual, retiro propio y reordenamiento con auditoría
ok 17 - privacidad: el teléfono nunca sale en pantallas públicas; código del local; borrado de datos
ok 18 - tiempo real: los clientes reciben la fila actualizada por SSE
ok 19 - un aviso de fin que llega tarde (corte de red > vigencia del líder) no repite la canción
ok 20 - bloquear un video aplica a toda la sede: sale de las filas y se salta si está sonando
ok 21 - entradas malformadas no producen errores 500 ni filtran mensajes internos
ok 22 - quien conserva el canal de una sesión cerrada no recibe la fila de la noche siguiente
ok 23 - duraciones ISO 8601 y día de cuota (hora del Pacífico)
ok 24 - búsqueda: resultados anotados, caché y contabilidad de cuota
ok 25 - una solicitud de YouTube se valida en el servidor antes de entrar a la fila
ok 26 - 14 · cuota agotada: mensaje claro y la fila no se borra
ok 27 - presupuesto propio: las búsquedas se frenan antes de tocar la reserva para validar videos
ok 28 - YouTube deshabilitado: no se puede asignar a una sala
# tests 28
# pass 28
# fail 0
```

## Salida de `npm run e2e`

```
Panel
  ✓ el administrador entra al panel
Televisor
  ✓ la pantalla se vincula con código desde el panel
  ✓ «Iniciar noche» arranca con sonido, QR y lista de respaldo
  ✓ el QR se lee desde una captura del televisor y lleva a la sesión
Clientes
  ✓ un cliente entra con el QR, sin instalar nada, y se registra
  ✓ busca, confirma y ve su posición; no interrumpe lo que suena
  ✓ un segundo cliente ve la misma fila en tiempo real
  ✓ pedir la misma canción explica por qué no se acepta
Operación
  ✓ el panel refleja la fila y «Saltar canción» avanza una sola vez
  ✓ al terminar una canción (evento del reproductor) empieza la siguiente
  ✓ pausar y continuar desde el panel llega al televisor
  ✓ un corte de internet no borra la fila y la pantalla se recupera sola
  ✓ recargar el televisor conserva sesión, fila y liderazgo, y sigue sonando
  ✓ si el equipo se reinicia, otra pestaña toma el control sola y el autoplay bloqueado muestra un botón
  ✓ catálogo autorizado: el crossfade mezcla la canción que sale con la que entra
  ✓ un cliente no puede abrir el panel ni la pantalla
  ✓ cerrar la noche invalida el QR

17 de 17 pasos correctos
```

## Capturas

En `docs/capturas/`: pantalla del televisor (inicio, sonando, sin conexión, autoplay bloqueado), página del cliente (registro, búsqueda, confirmación, turno, rechazo) y panel en vivo.
