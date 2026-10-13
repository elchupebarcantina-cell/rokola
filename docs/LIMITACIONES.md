# Limitaciones reales

Lo que el sistema no hace, no garantiza o todavía no tiene probado.

## YouTube

- **No está autorizado para uso en un bar** con los Términos actuales de YouTube, y viene apagado. Ver [LEGAL-Y-COSTOS.md](LEGAL-Y-COSTOS.md).
- **No está probado con el servicio real.** Ver [PRUEBAS.md](PRUEBAS.md).
- **Cuota**: unas 95 búsquedas nuevas al día entre todas las sedes. En una noche concurrida se agota; cuando pasa, los clientes solo pueden elegir entre sugerencias y búsquedas ya guardadas hasta las 2–3 a. m.
- **Anuncios**: los decide YouTube. No se bloquean, no se saltan y no se puede prometer reproducción sin pausas.
- **Disponibilidad**: un video puede dejar de estar disponible entre que se pide y que le llega el turno (eliminado, privado, bloqueado en el país, sin permiso de reproducción integrada). En ese caso se marca como fallido y sigue la fila.
- **Sin mezcla**: no hay crossfade, ni ajuste de volumen entre canciones, ni mezcla por BPM. Las condiciones de YouTube prohíben procesar o separar el audio y usar reproductores ocultos.
- **Restricción de edad y videos para niños**: no se ofrecen.
- **Punto abierto para la auditoría**: las políticas piden que la reproducción la inicie el usuario y que la aplicación aporte valor propio y no sustituya a YouTube. Una rockola donde alguien pide y otro equipo reproduce es defendible, pero la decisión es de YouTube.

## Reproducción

- **El sonido necesita un clic.** Los navegadores no dejan reproducir con sonido sin una acción de la persona. Tras reiniciar el equipo hay que pulsar «Reanudar reproducción», salvo que el navegador se abra con la opción descrita en [TELEVISOR.md](TELEVISOR.md).
- **Smart TV**: no se garantiza el navegador integrado de los televisores ni los TV Box. La configuración probada es computador con Chrome o Edge por HDMI.
- **Crossfade** (solo catálogo autorizado): es un fundido de volumen y de imagen entre dos pistas. No iguala tempo ni tonalidad; no es una mezcla de DJ.
- Con crossfade activo, la canción se registra como terminada unos segundos antes de que deje de sonar.
- Tras 3 fallos seguidos la reproducción se detiene y pide intervención. Es a propósito, para no vaciar la fila si se cae el internet, pero significa que alguien debe pulsar «Reanudar».

## Fila y moderación

- **Los filtros no garantizan contenido apropiado.** Duración máxima, exclusión de transmisiones en vivo y lista de bloqueados reducen problemas; no revisan letras ni imágenes. Para eso están la aprobación manual y el bloqueo en caliente.
- **El código del local no prueba presencia.** Quien esté en el bar puede pasárselo a alguien de fuera. Reduce el abuso de enlaces guardados, nada más. Cerrar la sesión cada noche invalida el QR.
- **Los límites por persona son por navegador.** Alguien puede abrir una ventana privada o usar otro celular y registrarse de nuevo. El límite global de la fila y el bloqueo de participantes lo contienen.
- **El tiempo de espera es aproximado**: no conoce anuncios, pausas ni cambios del administrador.
- La posición en la fila sí es exacta.

## Plataforma

- **Una sola instancia del servidor.** El limitador de abuso guarda sus contadores en memoria. Para correr varias réplicas habría que moverlo a Redis o a la base.
- **Sin carga de archivos.** El catálogo autorizado apunta a archivos alojados en otra parte; el sistema no los sube, convierte ni almacena.
- **Sin recuperación de contraseña por correo.** Un administrador cambia la contraseña de otro usuario desde Usuarios.
- **Sin reportes consolidados** entre sedes; hay historial, errores y auditoría por sala.
- **Sin integración con el POS.** Son sistemas separados.
- **No hay borrado de sedes ni de salas** desde el panel, para no perder historial por accidente.
- El aviso de privacidad tiene un bloque pendiente con los datos del responsable.

## Datos personales

- Por defecto solo se pide un alias. El celular es opcional y hay que activarlo por sala.
- El celular se borra solo 30 días después de cerrada la sesión (`RETENCION_TELEFONO_DIAS`) o cuando la persona pulsa «Eliminar mis datos y salir».
- El administrador de sede y el general ven los celulares; el operador no. Nunca aparecen en el televisor ni en la página de los clientes.
- El sistema guarda el consentimiento de promociones, pero **no envía mensajes**: no tiene integración con WhatsApp ni SMS.
