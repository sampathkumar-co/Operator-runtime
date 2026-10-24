#!/usr/bin/env python3
"""Compare generated npm runtime to a separate Windows build. No code execution.

PE normalization is limited to COFF/debug timestamps and the RSDS PDB GUID.
Every compiled JS byte and every other PE byte must be identical.
"""
import argparse
import hashlib
import json
import pathlib
import re
import struct
import tarfile


def field(data, offset, fmt):
    length = struct.calcsize(fmt)
    if offset < 0 or offset + length > len(data):
        raise ValueError('truncated PE field')
    return struct.unpack_from(fmt, data, offset)[0]


def normalize_pe(raw):
    if len(raw) < 0x100 or raw[:2] != b'MZ':
        raise ValueError('not a PE executable')
    pe = field(raw, 0x3c, '<I')
    if raw[pe:pe + 4] != b'PE\x00\x00':
        raise ValueError('missing PE signature')
    sections_count = field(raw, pe + 6, '<H')
    optional_size = field(raw, pe + 20, '<H')
    optional = pe + 24
    magic = field(raw, optional, '<H')
    directories = optional + {0x20b: 112, 0x10b: 96}.get(magic, -10000)
    if not 1 <= sections_count <= 96 or directories < optional:
        raise ValueError('unsupported PE headers')
    if directories + 7 * 8 > optional + optional_size:
        raise ValueError('truncated PE data directories')
    sections = []
    for i in range(sections_count):
        offset = optional + optional_size + i * 40
        virtual_size, virtual_address, raw_size, raw_offset = struct.unpack_from('<IIII', raw, offset + 8)
        if raw_offset + raw_size > len(raw):
            raise ValueError('truncated PE section')
        sections.append((virtual_address, max(virtual_size, raw_size), raw_offset))

    def offset_of(rva, size):
        for start, length, offset in sections:
            delta = rva - start
            if delta >= 0 and delta + size <= length and offset + delta + size <= len(raw):
                return offset + delta
        raise ValueError('unmapped PE debug directory')

    normalized = bytearray(raw)
    normalized[pe + 8:pe + 12] = b'\x00' * 4
    debug_rva = field(raw, directories + 6 * 8, '<I')
    debug_size = field(raw, directories + 6 * 8 + 4, '<I')
    if debug_size:
        if not debug_rva or debug_size % 28 or debug_size > 4096:
            raise ValueError('invalid PE debug directory')
        debug_at = offset_of(debug_rva, debug_size)
        for i in range(debug_size // 28):
            offset = debug_at + i * 28
            normalized[offset + 4:offset + 8] = b'\x00' * 4
            kind = field(raw, offset + 12, '<I')
            size = field(raw, offset + 16, '<I')
            pointer = field(raw, offset + 24, '<I')
            if kind == 2 and size >= 24 and pointer + size <= len(raw):
                if raw[pointer:pointer + 4] == b'RSDS':
                    normalized[pointer + 4:pointer + 20] = b'\x00' * 16
    return bytes(normalized)


def read_candidate(path):
    result = {}
    with tarfile.open(path, 'r:gz') as archive:
        for member in archive.getmembers():
            if member.isfile() and member.name.startswith('package/runtime/'):
                relative = member.name[len('package/runtime/'):]
                if not relative or relative in result:
                    raise ValueError('invalid or duplicate runtime tar entry')
                result[relative] = archive.extractfile(member).read()
    return result


def compare(candidate, witness_root, expected_source):
    manifest = json.loads(candidate['runtime-manifest.json'].decode('utf-8'))
    if manifest['sourceCommit'] != expected_source:
        raise ValueError('candidate source binding mismatch')
    entries = manifest['files']
    if not isinstance(entries, list) or len(entries) < 5:
        raise ValueError('runtime manifest missing files')
    declared = {item['path'] for item in entries}
    if len(declared) != len(entries) or set(candidate) != declared | {'runtime-manifest.json'}:
        raise ValueError('candidate runtime file-set mismatch')
    actual = {p.relative_to(witness_root).as_posix() for p in witness_root.rglob('*') if p.is_file()}
    if actual != set(candidate):
        raise ValueError('independent runtime file-set mismatch')
    witness_manifest = json.loads((witness_root / 'runtime-manifest.json').read_text(encoding='utf-8'))
    if witness_manifest['sourceCommit'] != expected_source:
        raise ValueError('independent witness source mismatch')
    if {entry['path'] for entry in witness_manifest['files']} != declared:
        raise ValueError('independent witness manifest paths differ')
    for entry in entries:
        name = entry['path']
        if not name or any(part in ('', '.', '..') for part in name.split('/')):
            raise ValueError('unsafe runtime path')
        archive_bytes = candidate[name]
        witness_bytes = (witness_root / name).read_bytes()
        if len(archive_bytes) != entry['sizeBytes'] or hashlib.sha256(archive_bytes).hexdigest() != entry['sha256']:
            raise ValueError('candidate runtime manifest digest mismatch: ' + name)
        if name.endswith('.exe'):
            if normalize_pe(archive_bytes) != normalize_pe(witness_bytes):
                raise ValueError('independent native PE code mismatch: ' + name)
        elif archive_bytes != witness_bytes:
            raise ValueError('independent generated JS mismatch: ' + name)
    print('GENERATED_RUNTIME_INDEPENDENT_WITNESS_VERIFIED', expected_source, len(entries))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--candidate-tarball', type=pathlib.Path, required=True)
    parser.add_argument('--witness-runtime', type=pathlib.Path, required=True)
    parser.add_argument('--expected-source', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[0-9a-f]{40}', args.expected_source):
        parser.error('source SHA must be 40 lowercase hex characters')
    compare(read_candidate(args.candidate_tarball), args.witness_runtime.resolve(strict=True), args.expected_source)


if __name__ == '__main__':
    main()
