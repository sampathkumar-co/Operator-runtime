/**
 * C00-06: Read-only, explicitly scoped local-only source inventory.
 * It cannot reconstruct a missing historical controller, certify physical
 * workflows, or read original .operator receipts. No network or writes.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_ITEMS = 2_000;
const MAX_BYTES_PER_FILE = 1_048_576;
const MAX_TOTAL_BYTES = 16 * 1_048_576;
const MAX_GIT_STDOUT = 6 * 1_048_576;
const SHA = /^[0-9a-f]{40}$/;
const CODE_EXT = new Set(['.ts','.tsx','.js','.jsx','.mjs','.cjs','.py','.rs','.cs','.go','.java','.sh','.ps1','.yml','.yaml','.toml','.md']);
const EXCLUDED_PART = /^(?:\.git|\.operator|node_modules|\.venv|venv|dist|build|coverage|\.next|\.cache|__pycache__|\.aws|\.ssh|\.npm)$/i;
const SENSITIVE_NAME = /(?:^\.env(?:\.|$)|(?:secret|token|password|credential|private.?key|id_rsa|id_ed25519|\.pem$|\.p12$|\.pfx$|\.key$))/i;
const digest = s => crypto.createHash('sha256').update(s).digest('hex');
function fail(reason) { throw new Error('C00_LOCAL_SOURCE_INVENTORY: ' + reason); }
function cleanGitEnv() {
  const env = {...process.env};
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}
function git(root, ...args) {
  try {
    return execFileSync('git',['-C',root,...args],{
      encoding:'buffer', maxBuffer:MAX_GIT_STDOUT, timeout:20_000,
      windowsHide:true,env:cleanGitEnv(),stdio:['ignore','pipe','pipe']
    });
  } catch { fail('Git read failed or exceeded its bounded output; no complete inventory can be claimed.'); }
}
function pathsFromGit(bytes) {
  if (bytes.length && bytes.at(-1) !== 0) fail('Git path stream was incomplete.');
  return bytes.length ? bytes.toString('utf8').slice(0,-1).split('\0') : [];
}
function permittedPath(rel) {
  // Never consider original protected state or secret-like files as candidates.
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || path.isAbsolute(rel) ||
      rel.includes('\\') || rel.split('/').some(x => !x || x === '.' || x === '..' || EXCLUDED_PART.test(x) || SENSITIVE_NAME.test(x))) return false;
  return CODE_EXT.has(path.posix.extname(rel).toLowerCase());
}
function classify(rel) {
  const filename=path.posix.basename(rel).toLowerCase();
  if (/miniwob|browsergym/.test(rel.toLowerCase())) return 'BENCHMARK_RELATED_CANDIDATE';
  if (/controller|runner|gpt[-_]?oss/.test(filename)) return 'CONTROLLER_NAMED_CANDIDATE';
  return 'LOCAL_SOURCE_CANDIDATE';
}

/**
 * No implicit home scan. A caller must explicitly select exactly one complete
 * Git checkout; all paths and local bytes stay on that device. Default output
 * contains only hashes of names and contents, not their source code or paths.
 */
export async function inventoryLocalSource({root,showPaths=false}={}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) ||
      typeof showPaths !== 'boolean') fail('Explicit absolute checkout root and boolean showPaths required.');
  const realRoot = await fs.realpath(root);
  const rootInfo = await fs.lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() ||
      realRoot.split(path.sep).some(x => x.toLowerCase() === '.operator')) {
    fail('Root must be a real Git checkout outside protected state.');
  }
  const top = git(realRoot,'rev-parse','--show-toplevel').toString('utf8').trim();
  if (path.resolve(top).toLowerCase() !== realRoot.toLowerCase()) {
    fail('Root must be the exact Git worktree top level, not a parent or child.');
  }
  if (git(realRoot,'rev-parse','--is-bare-repository').toString('utf8').trim() !== 'false') fail('Bare repositories are unsupported.');
  const head=git(realRoot,'rev-parse','HEAD').toString('utf8').trim();
  if (!SHA.test(head)) fail('Missing exact checked-out Git HEAD.');

  // Ignored files are not traversed; they may contain original receipts,
  // credentials and private caches. Never claim complete physical discovery.
  const groups=[
    ['TRACKED_WORKTREE_CHANGE',pathsFromGit(git(realRoot,'ls-files','--modified','-z'))],
    ['TRACKED_INDEX_CHANGE',pathsFromGit(git(realRoot,'diff','--cached','--name-only','-z'))],
    ['UNTRACKED',pathsFromGit(git(realRoot,'ls-files','--others','--exclude-standard','-z'))]
  ];
  const all=new Map();
  for (const [group,values] of groups) for (const rel of values) {
    if (!all.has(rel)) all.set(rel,[]);
    all.get(rel).push(group);
  }
  if (all.size > MAX_ITEMS) fail('Too many candidate paths; review exact root before re-running.');
  const entries=[];
  let skippedSensitive=0,skippedOther=0,skippedSymlink=0,totalHashedBytes=0;
  for (const [rel,kinds] of [...all].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (!permittedPath(rel)) { skippedSensitive++; continue; }
    const abs=path.resolve(realRoot,rel);
    if (!abs.startsWith(realRoot + path.sep)) fail('Candidate escaped its explicit checkout.');
    let info;
    try { info=await fs.lstat(abs); } catch (e) {
      if (e?.code === 'ENOENT') {skippedOther++;continue;}
      throw e;
    }
    if (info.isSymbolicLink()) {skippedSymlink++;continue;}
    if (!info.isFile() || info.size > MAX_BYTES_PER_FILE) {skippedOther++;continue;}
    const realFile=await fs.realpath(abs);
    if (!realFile.startsWith(realRoot + path.sep)) fail('Candidate resolved outside checkout.');
    // O_NOFOLLOW on POSIX; compare file identity after opening on all OSes.
    const nofollow = process.platform === 'win32' ? 0 : (await import('node:fs')).constants.O_NOFOLLOW;
    let handle;
    try {
      handle=await fs.open(abs,(await import('node:fs')).constants.O_RDONLY | nofollow);
      const fresh=await handle.stat();
      // Node on Windows may report lstat.dev=0 but a real volume id for
      // FileHandle.stat(). Preserve inode/size identity; compare devices when
      // lstat actually supplied a device identity rather than a zero sentinel.
      const deviceComparable = process.platform !== 'win32' || info.dev !== 0;
      if (!fresh.isFile() || fresh.size !== info.size ||
          (deviceComparable && fresh.dev !== info.dev) ||
          fresh.ino !== info.ino || fresh.size > MAX_BYTES_PER_FILE) {
        fail('File changed during read; inventory must be rerun.');
      }
      if (totalHashedBytes + fresh.size > MAX_TOTAL_BYTES) fail('Source hash budget exceeded; no complete inventory.');
      const bytes=await handle.readFile();
      if (bytes.length !== fresh.size) fail('File changed during read; inventory must be rerun.');
      totalHashedBytes+=bytes.length;
      entries.push({pathSha256:digest(rel),contentSha256:digest(bytes),bytes:bytes.length,
        kinds:[...new Set(kinds)].sort(),classification:classify(rel),
        ...(showPaths?{relativePath:rel}:{})});
    } finally {await handle?.close();}
  }
  const evidenceBody={checkoutHead:head,entries,skippedSensitive,skippedSymlink,skippedOther,ignoredFiles:'NOT_INSPECTED'};
  return {
    schemaVersion:1,workstream:'C00-06',checkoutHead:head,
    sourceCandidateCount:entries.length,sourcePathExposure:showPaths?'EXPLICIT_OWNER_OPT_IN':'SHA256_ONLY',
    inventorySha256:digest(JSON.stringify(evidenceBody)),
    entries,skippedSensitive,skippedSymlink,skippedOther,totalHashedBytes,
    ignoredFiles:'NOT_INSPECTED',historicalOriginalController:'NOT_RECOVERED_OR_AUTHENTICATED',
    originalProtectedReceipts:'NOT_ACCESSED',physicalAcceptance:'NOT_VERIFIED',
    sourceUniqueness:'LOCAL_CANDIDATES_ONLY_NOT_UPSTREAM_COMPARED',
    releaseAcceptance:'NOT_ACCEPTED'
  };
}

if (process.argv[1] && path.resolve(process.argv[1])===path.resolve(fileURLToPath(import.meta.url))) {
  const args=process.argv.slice(2),roots=args.filter(x=>x.startsWith('--root=')),flags=args.filter(x=>x==='--show-paths');
  if (roots.length!==1 || flags.length>1 || roots.length+flags.length!==args.length) {
    fail('Usage: node scripts/c00-local-source-inventory.mjs --root=<absolute-authorized-git-root> [--show-paths]');
  }
  process.stdout.write(JSON.stringify(await inventoryLocalSource({root:roots[0].slice(7),showPaths:flags.length===1}),null,2)+'\n');
}
