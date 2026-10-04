-- Permisos explícitos para el servidor; no se heredan de PUBLIC.
grant select, insert, update, delete on public.subscriptions to service_role;
grant select, insert, update, delete on public.cache_persistente to service_role;
