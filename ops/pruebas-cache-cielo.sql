-- PREPARADO, NO EJECUTADO.
-- Aplicar EXCLUSIVAMENTE a la base de pruebas verificada.
-- No ejecutar en una base compartida con PRD.
-- La tabla contiene solo cielo público; cartas y resúmenes siguen en sus tablas con RLS.
BEGIN;
ALTER TABLE public.cache_persistente ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.cache_persistente FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.cache_persistente TO service_role;
COMMIT;
-- Después: configurar CACHE_CIELO_PERSISTENTE=true SOLO en el servicio de pruebas.
-- Confirmar guardado/lectura y reutilización tras reinicio antes de activarlo en PRD.
-- Consultas de verificación:
-- SELECT relrowsecurity FROM pg_class WHERE oid='public.cache_persistente'::regclass;
-- SELECT has_table_privilege('anon','public.cache_persistente','SELECT');
-- SELECT has_table_privilege('service_role','public.cache_persistente','INSERT');
