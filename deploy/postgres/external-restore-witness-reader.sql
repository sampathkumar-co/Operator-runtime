-- Run ONLY on the independently managed PostgreSQL WITNESS database.
-- This database, its WAL and backups MUST NOT be inside the control-plane
-- restore domain. The runtime needs EXECUTE on one function, never UPDATE.
-- Run as a trusted schema owner. Replace the role name in the GRANT below
-- with the actual independently provisioned restore reader role.
--
-- Create latest signed witness records through a DIFFERENT authenticated
-- publisher with a strictly increasing epoch, outside this read-only API.
CREATE TABLE IF NOT EXISTS public.mecord_restore_witness_anchor (
  anchor_id TEXT PRIMARY KEY,
  signed_manifest JSONB NOT NULL,
  signature TEXT NOT NULL
);
REVOKE ALL ON TABLE public.mecord_restore_witness_anchor FROM PUBLIC;

-- Definer ownership MUST remain with a trusted, non-login schema authority
-- owning the witness table, never with the runtime read-only principal.
-- Explicit qualification and search_path eliminate function hijacking.
CREATE OR REPLACE FUNCTION public.mecord_restore_witness_lock_read(p_anchor_id TEXT)
RETURNS TABLE (anchor_id TEXT, signed_manifest JSONB, signature TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $witness$
BEGIN
  RETURN QUERY
    SELECT w.anchor_id, w.signed_manifest, w.signature
    FROM public.mecord_restore_witness_anchor AS w
    WHERE w.anchor_id = p_anchor_id
    FOR UPDATE;
END
$witness$;
REVOKE ALL ON FUNCTION public.mecord_restore_witness_lock_read(TEXT) FROM PUBLIC;

-- Grant only to the explicitly authorized reader role after provisioning it:
-- GRANT USAGE ON SCHEMA public TO <restore_reader_role>;
-- GRANT EXECUTE ON FUNCTION public.mecord_restore_witness_lock_read(TEXT)
--   TO <restore_reader_role>;
--
-- No UPDATE/DELETE/TRUNCATE/INSERT on the witness table may be granted to
-- the runtime role. The publisher must enforce monotonic epoch, signed
-- snapshot digest, and no row deletion/truncation. REVOKE PUBLIC EXECUTE
-- whenever replacing this function and verify the owner's privileges.
