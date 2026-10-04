# Formato adaptable y recordatorio diario

Cambios destinados a main para la validación en los builds de iOS y Android.

## Formato
- Marco de teléfono simulado retirado; altura disponible del viewport, incluido teclado y cambios de orientación.
- Barra superior e inferior permanecen en el flujo de la pantalla; área central desplazable.
- Márgenes safe-area para cámara, gestos y orientación horizontal.
- Botones de navegación de al menos 44 px, cinco accesos que comparten el ancho.
- Contenido centrado con ancho limitado en tablet/computadora y acceso legible.
- Modales y pantallas de cuenta respetan safe areas.

Verificación visual pendiente en iPhone pequeño/grande, Android con gestos/botones, iPad vertical/horizontal y navegador de escritorio. No se pudo obtener acceso al navegador de revisión; no se afirman pruebas visuales.

## Notificaciones
Mi cuenta > Notificaciones ofrece interruptor, hora local (09:00 inicial) y guardar.
La preferencia se guarda por cuenta en este dispositivo; no se sincroniza entre dispositivos.
Capacitor LocalNotifications 8.3.1 está fijado en package y lockfile.
Tras actualizar el proyecto local: npm ci y npx cap sync, después generar nuevos builds.
Los builds previos y la web no pueden enviar este recordatorio: muestran advertencia y permiten guardar preferencia.
Se pide permiso al guardar, no al entrar. Si se rechaza, muestra advertencia sin éxito falso.
Usa un único ID diario; cambiar hora reemplaza el anterior, desactivar o cerrar sesión cancela el aviso.
Tocar el aviso abre Hoy o pide iniciar sesión.
Se programa cerca de la hora local del teléfono; Android usa alarma inexacta para no solicitar permisos especiales. Ahorro de energía puede retrasarla.
No es push remoto ni afirma que un horóscopo generado ya esté listo. Invita a consultar la guía diaria que la app calcula con su flujo existente.
No consume IA ni API al enviar el aviso.

## Pruebas
Sintaxis de JavaScript comprobada; mocks de horario, cambio de hora, desactivación, rechazo de permiso, módulo ausente, doble toque, separación por cuenta y apertura desde aviso.
Pendiente: entrega real con app cerrada, reinicio, cambio de zona horaria, permisos revocados y ahorro de batería en iOS/Android.
Referencia: https://capacitorjs.com/docs/apis/local-notifications

## Seguridad revisada
- Identidad obtenida de Supabase Auth; no se usa un ID enviado por el cliente para autorizar.
- Respuestas privadas con Cache-Control no-store, clientes por petición sin persistir sesiones.
- Fallas de Auth o de comprobación de suscripción se bloquean; no conceden acceso.
- Estado de suscripción escrito con cliente de servidor, nunca por la cuenta cliente.
- Migración versionada restringe INSERT/UPDATE de subscriptions, conserva lectura y eliminación propias.
- Función interna rls_auto_enable sin permiso EXECUTE para clientes; caché con RLS y sin permisos de cliente.
- Encabezados nosniff, protección contra marcos, base-uri y object-src. No es una CSP completa de scripts.
- Nombres, preguntas, diario y mensajes de error escapados en los puntos corregidos del frontend.
- Webhook devuelve error si no puede guardar la confirmación; permite que Stripe reintente.
No equivale a una auditoría integral ni a prueba de penetración. La prueba con dos cuentas reales y los builds sigue pendiente.

## Respaldos: configuración pendiente de comprobar
No se dispone aquí de un resultado del estado de backups, del plan ni de una prueba de restauración.
Verificar Supabase Dashboard > Database > Backups: último backup exitoso, retención y recuperación.
Supabase Pro ofrece backups diarios con 7 días; Free requiere copias externas periódicas.
Los backups de base de datos no incluyen los archivos de Storage: respaldarlos por separado.
No guardar exportaciones de correos/datos en Git ni en enlaces públicos. Cifrar las copias, limitar acceso y mantener una copia fuera del proyecto.
Antes de publicar: restaurar una copia en un proyecto aislado, comprobar perfiles/cartas/diario y documentar fecha/resultado, sin enviar mensajes ni iniciar cobros.
Protección contra contraseñas filtradas figura desactivada en el asesor: comprobar disponibilidad del plan y activar en Auth > Settings sin asumir que ya está encendida.
No se ha contratado ningún plan/add-on ni programado una copia automática con credenciales sin verificar.
Referencias: https://supabase.com/docs/guides/platform/backups ; https://supabase.com/docs/guides/database/postgres/row-level-security
