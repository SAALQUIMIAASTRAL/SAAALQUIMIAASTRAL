# Correos y acceso: preparación en pruebas

Rama: pruebas-luna-ux-2026-10-03. No se modificaron ajustes de Auth ni SMTP de la base compartida con producción. Los tests usan respuestas simuladas: no hubo envíos ni eliminaciones reales.

## Confirmación y bienvenida
La app muestra un aviso antes del registro y una pantalla Revisa tu correo cuando Supabase devuelve una cuenta sin sesión. No intenta un segundo login al registrarse.
Supabase debe tener Confirm email habilitado para exigir la confirmación.
Plantilla preparada: ops/correos/bienvenida-confirmacion.html.
Asunto sugerido: Te damos la bienvenida · Confirma tu correo.
La bienvenida se incluye en el correo de confirmación para evitar un envío adicional. No utiliza IA.

## Recuperación
Plantilla preparada: ops/correos/recuperacion.html.
Asunto sugerido: Recupera tu acceso · Sam Alquimia Astral.
El enlace abre /restablecer.html en el servicio de pruebas. La credencial se mantiene solo en memoria y se retira de la URL visible. Los enlaces inválidos o vencidos muestran un aviso.
Añadir a Auth > URL Configuration los destinos completos del servicio de pruebas: /confirmar.html y /restablecer.html. No cambiar Site URL de PRD.
No aplicar las plantillas ni habilitar confirmación en la base compartida sin coordinar el impacto en producción. Para aislamiento completo, usar un proyecto Supabase de pruebas.

## Eliminación
El backend envía al correo autenticado después de borrar los datos de cuenta y confirmar deleteUser sin error.
Configurar exclusivamente en el servicio Render de pruebas:
- RESEND_API_KEY: clave del proveedor, nunca en frontend ni repositorio.
- EMAIL_FROM: remitente autorizado y verificado.
Sin esas variables no se envía correo; la respuesta incluye correo_eliminacion_enviado:false.
Un fallo del proveedor no revierte la eliminación y se registra sin correo ni credenciales. No hay reintentos durables todavía.
La eliminación existente comprende varias operaciones, no una transacción única. Un fallo parcial responde con error y pide soporte.
No se ha cambiado la lógica de cobros o cancelación de suscripciones.

## Validación pendiente de entrega real
Con una cuenta de pruebas y correo controlado:
1. Registrar, recibir bienvenida y confirmar el correo; iniciar sesión.
2. Solicitar recuperación, abrir el enlace y guardar una contraseña nueva; comprobar el acceso.
3. Probar un enlace inválido o vencido.
4. Eliminar exclusivamente la cuenta de pruebas creada para esta validación; comprobar que ya no accede y llega el correo.
5. Revisar el resultado de envío y logs del proveedor si no llega.
Se requiere verificar SMTP de Supabase, remitente del proveedor y destinos autorizados antes de afirmar que los correos llegan.
