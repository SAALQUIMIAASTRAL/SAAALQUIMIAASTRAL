# Compras nativas: estado en pruebas

Rama: pruebas-luna-ux-2026-10-03. PRD no se modificó.

## Hallazgos
- El frontend ya distingue Apple, Google Play y web.
- NativePurchases no está instalado en package.json ni package-lock.json.
- No se localizaron los proyectos nativos ni capacitor.config en la raíz de esta rama; se necesita el proyecto usado para generar los builds.
- No existe /suscripcion/validar-compra-nativa en el servidor.
- Los IDs de productos del código no están confirmados contra las tiendas.
- Los planes base Android contienen PENDIENTE.
- No se confirmó ninguna conexión RevenueCat.

## Protección implementada
/suscripcion/configuracion-nativa exige sesión y devuelve disponible:false, sin almacenar en caché.
No hay variable para habilitarlo accidentalmente. Solo cambiar después de implementar validación completa.
El frontend consulta disponibilidad antes de comprar o restaurar, bloquea planes provisionales y evita doble compra por doble toque.
No activa acceso sin respuesta activa:true del servidor.
La gestión de suscripciones nativas abre la tienda en iOS y Android; si falta el plugin, muestra advertencia y no redirige a Stripe.

## Productos existentes en código, pendientes de confirmar
| Plan | Android producto | Android plan base | iOS producto |
|---|---|---|---|
| Mensual | com.samalquimiaastral.app.mensual | PENDIENTE-plan-base-mensual | com.samalquimiaastral.app.monthly |
| Semestral | com.samalquimiaastral.app.seismeses | PENDIENTE-plan-base-6-meses | com.samalquimiaastral.app.sixmonths |
| Anual | com.samalquimiaastral.app.anual | PENDIENTE-plan-base-anual | com.samalquimiaastral.app.yearly |

No crear duplicados ni renombrar productos a partir de esta tabla: primero comprobar los existentes.

## Información necesaria para completar conexión
1. Pantalla de suscripciones en Google Play: ID producto y plan base, duración, precio y estado.
2. Pantalla de suscripciones de App Store Connect: ID producto, grupo, duración, precio y estado.
3. Proyecto nativo actual de iOS/Android y configuración Capacitor.
4. Confirmar conexión directa o RevenueCat antes de incorporar dependencias e infraestructura.
5. Credenciales privadas exclusivamente en el entorno servidor; nunca en frontend, repositorio o chat.

## Integración pendiente
- Asociar cada compra a la cuenta autenticada (no email ni ID enviados como autoridad por el cliente).
- Validar servidor a servidor, comprobar app/producto/entorno/estado/vencimiento y impedir reutilizar un comprobante entre cuentas.
- Conservar comprobantes/estado en almacenamiento duradero, con acceso protegido, separado de PRD en pruebas.
- Renovaciones, cancelación, reembolsos, vencimiento y pagos pendientes mediante notificaciones y reconciliación.
- Restaurar compras con comprobación del servidor.
- Mostrar precios localizados de la tienda y condiciones de prueba/renovación.
- Reconocer/finalizar transacciones según las reglas del SDK elegido.
- Generar y subir builds nuevos con el módulo nativo.

## Pruebas antes de habilitar
Android: cuentas configuradas como license testers y tarjetas de prueba; el canal interno por sí solo no evita cargos.
iOS: sandbox/TestFlight, confirmar que se usa el entorno de pruebas.
Verificar compra exitosa/rechazada/pendiente, cancelación, vencimiento, renovación, restauración, reinstalación y cambio de cuenta.
No se realizó ninguna compra ni se activó ningún cobro en este trabajo.

Referencias:
- https://developer.android.com/google/play/billing/test
- https://developer.apple.com/documentation/storekit/testing-in-app-purchases-with-sandbox
- https://capgo.app/docs/plugins/native-purchases/
- https://www.revenuecat.com/docs/getting-started/installation/capacitor

## Regla comercial confirmada por Sam
Mensual US$4.99, semestral y anual dan el mismo acceso completo a todas las funciones. Solo varían duración y precio. Sam confirmó mensual US$4.99, semestral US$25.99 y anual US$45.99. Falta comprobar esos precios contra los productos de las tiendas. No son niveles de funciones. Prueba gratis de 3 días aprobada por Sam. La prueba empieza al aceptar la suscripción, para usuarios elegibles; después se renueva al precio del plan elegido si no cancelan y el pago se autoriza.

## Revisión de prueba y cobro
- Web/Stripe: trial_period_days cambió de 7 a 3 en pruebas.
- Se comprueba el precio real de Stripe: USD 499/mes, 2599/6 meses y 4599/año (centavos), precio activo y recurrente por unidad.
- Se rechazan planes desconocidos en vez de sustituirlos silenciosamente por mensual.
- Un servicio cuyo host contiene pruebas o BILLING_ENV distinto de production no inicia Checkout con un precio livemode.
- Las notificaciones Stripe requieren firma y secreto; no se aceptan eventos sin verificar.
- Esto no modifica ofertas de Apple/Google: configurarlas en ambas consolas y comprobar elegibilidad, duración, renovación y precio localizado.
- Las pruebas realizadas aquí son simuladas; no verifican credenciales, ofertas, impuestos/regiones ni entrega de notificaciones reales.
