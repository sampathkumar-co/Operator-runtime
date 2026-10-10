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

-- Enforce irreversibility even for an old publisher that mistakenly issues
-- DELETE/UPDATE at a reused epoch. The signed manifest remains separately
-- authenticated by the runtime's pinned Ed25519 public key.
CREATE OR REPLACE FUNCTION public.mecord_restore_witness_generation_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $witness_generation$
DECLARE
  next_epoch BIGINT;
  previous_epoch BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'RESTORE_WITNESS_DELETE_FENCED: deleting a published witness is prohibited';
  END IF;
  IF NEW.anchor_id IS NULL OR length(NEW.anchor_id) > 128 OR
     NEW.signed_manifest ->> 'anchorId' IS DISTINCT FROM NEW.anchor_id OR
     jsonb_typeof(NEW.signed_manifest -> 'epoch') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'RESTORE_WITNESS_INVALID: anchor binding or epoch is malformed';
  END IF;
  BEGIN
    next_epoch := (NEW.signed_manifest ->> 'epoch')::BIGINT;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'RESTORE_WITNESS_INVALID: epoch is not a valid integer';
  END;
  IF next_epoch < 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'RESTORE_WITNESS_INVALID: epoch must be positive';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.anchor_id IS DISTINCT FROM OLD.anchor_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'RESTORE_WITNESS_REBIND_FENCED: anchor identity is immutable';
    END IF;
    previous_epoch := (OLD.signed_manifest ->> 'epoch')::BIGINT;
    IF next_epoch <= previous_epoch THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'RESTORE_WITNESS_EPOCH_FENCED: publisher must strictly advance epoch';
    END IF;
  END IF;
  RETURN NEW;
END
$witness_generation$;
CREATE OR REPLACE TRIGGER mecord_restore_witness_generation_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.mecord_restore_witness_anchor
FOR EACH ROW EXECUTE FUNCTION public.mecord_restore_witness_generation_guard();

CREATE OR REPLACE FUNCTION public.mecord_restore_witness_deny_truncate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $witness_truncate$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514',
    MESSAGE = 'RESTORE_WITNESS_TRUNCATE_FENCED: witness history cannot be truncated';
END
$witness_truncate$;
CREATE OR REPLACE TRIGGER mecord_restore_witness_deny_truncate
BEFORE TRUNCATE ON public.mecord_restore_witness_anchor
FOR EACH STATEMENT EXECUTE FUNCTION public.mecord_restore_witness_deny_truncate();
REVOKE ALL ON FUNCTION public.mecord_restore_witness_generation_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mecord_restore_witness_deny_truncate() FROM PUBLIC;


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
