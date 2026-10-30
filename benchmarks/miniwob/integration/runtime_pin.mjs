import {createHash} from 'node:crypto';
export const LEGACY_VERSION='2.0.7-rc.6';
export const LEGACY_COMMIT='beef93d3aa9c2c1363e92a6b3b78c893bf1a0ad4';

/** Fail closed: a source branch is NOT a built runtime. Before opt-in gestures,
 * a separately validated candidate must be built with a manifest whose exact
 * version, source revision and content hash are explicitly supplied by owner.
 */
export function verifyIsolatedRuntimePin(manifest,manifestBytes,env={}){
  if(!manifest||typeof manifest!=='object'||typeof manifest.version!=='string'||
     typeof manifest.sourceCommit!=='string')throw Error('UNPINNED_RUNTIME');
  const wantsNative=env.MECORD_MINIWOB_NATIVE_GESTURES==='1';
  if(!wantsNative){
    if(manifest.version!==LEGACY_VERSION||manifest.sourceCommit!==LEGACY_COMMIT)
      throw Error('UNPINNED_RUNTIME');
    return {nativeGesturesEnabled:false,version:manifest.version,sourceCommit:manifest.sourceCommit};
  }
  const version=env.MECORD_MINIWOB_EXPECTED_RUNTIME_VERSION;
  const commit=env.MECORD_MINIWOB_EXPECTED_RUNTIME_COMMIT;
  const digest=env.MECORD_MINIWOB_EXPECTED_MANIFEST_SHA256;
  if(!/^2\\.0\\.7-rc\\.(?:[7-9]|[1-9][0-9]+)$/.test(version||'')||
     !/^[0-9a-f]{40}$/.test(commit||'')||commit===LEGACY_COMMIT||
     !/^[0-9a-f]{64}$/.test(digest||'')||!Buffer.isBuffer(manifestBytes)||
     createHash('sha256').update(manifestBytes).digest('hex')!==digest||
     manifest.version!==version||manifest.sourceCommit!==commit)
    throw Error('NATIVE_RUNTIME_PIN_NOT_VERIFIED');
  return {nativeGesturesEnabled:true,version,sourceCommit:commit};
}
