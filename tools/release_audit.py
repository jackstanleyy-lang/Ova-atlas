#!/usr/bin/env python3
"""Read-only Atlas candidate-vs-checkout audit. Never pushes, edits, or fetches."""
import argparse
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

MARKERS = {
    'local_only': 'data-free-only="true"',
    'mask_rectangle': 'data-mask-tool="rect"',
    'mask_ellipse': 'data-mask-tool="ellipse"',
    'export_mask': 'id="export-mask"',
    'collection_visual_labels': 'id="organize-fields"',
    'collection_batch_import': 'id="gallery-import-input"',
    'exact_copy_review': 'id="duplicate-scan"',
    'camera_import': 'id="camera-input"',
    'privacy_erase': 'id="erase-local-data"',
}
SHELL = ('index.html', 'sw.js', 'manifest.webmanifest', '.nojekyll', 'icons/atlas-180.png', 'icons/atlas-192.png', 'icons/atlas-512.png')


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while (data := f.read(1 << 20)):
            h.update(data)
    return h.hexdigest()


def git(repo, *args):
    p = subprocess.run(['git', '-C', str(repo), *args], capture_output=True, text=True, timeout=15)
    return p.stdout.strip() if p.returncode == 0 else None


def is_private_asset_name(name):
    n = name.lower()
    if n.startswith('icons/') and n.endswith('.png'):
        return False
    return any(n.endswith(ext) for ext in ('.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.mp4', '.mov'))


def html_risks(html):
    risks = []
    if re.search(r'libfile_[0-9a-f]{8,}', html):
        risks.append('private Library identifier embedded')
    if re.search(r'data:image/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]{80}', html):
        risks.append('embedded image data found')
    if re.search(r'<script[^>]*\bsrc\s*=\s*["\']https?://', html, re.I):
        risks.append('network-loaded script found')
    if 'data-free-only="true"' not in html:
        risks.append('free-only HTML attribute missing')
    m = re.search(r'OVA_STARTER_ARCHIVE\s*=\s*(\[[\s\S]*?\])\s*;', html)
    if m and m.group(1).strip() != '[]':
        risks.append('nonempty bundled starter archive found')
    if re.search(r'"thumbnails"\s*:\s*\{\s*"', html):
        risks.append('populated thumbnail dictionary signature found')
    return risks


def audit(repo, candidate):
    repo = Path(repo).resolve()
    archive = Path(candidate).resolve()
    if not repo.is_dir():
        raise ValueError('Repository checkout does not exist')
    if not archive.is_file():
        raise ValueError('Candidate archive does not exist')
    is_git = git(repo, 'rev-parse', '--is-inside-work-tree') == 'true'
    branch = git(repo, 'branch', '--show-current') if is_git else None
    commit = git(repo, 'rev-parse', '--short', 'HEAD') if is_git else None
    remote = git(repo, 'remote', 'get-url', 'origin') if is_git else None
    dirty = git(repo, 'status', '--porcelain') if is_git else None
    result = {
        'repository': str(repo),
        'git': {'checkout': is_git, 'branch': branch, 'head': commit, 'origin': remote, 'clean': dirty == '' if dirty is not None else None},
        'file_comparison': [],
        'remote_only_paths': [],
        'feature_matrix': {},
        'candidate_risks': [],
        'repository_risks': [],
        'blockers': [],
        'next_action': 'read-only audit; no deployment attempted',
    }
    if not is_git:
        result['blockers'].append('Target folder is not a Git checkout')
    if dirty:
        result['blockers'].append('Local working tree has uncommitted changes')
    if remote and 'jackstanleyy-lang/ova-atlas' not in remote.lower():
        result['blockers'].append('Git origin does not match expected Atlas repository')
    if not remote:
        result['blockers'].append('Git origin cannot be verified')
    with tempfile.TemporaryDirectory(prefix='atlas_audit_') as temp:
        root = Path(temp)
        with zipfile.ZipFile(archive) as z:
            names = [i.filename for i in z.infolist() if not i.is_dir()]
            if len(names) != len(set(names)):
                result['blockers'].append('Candidate archive contains duplicate filenames')
            for info in z.infolist():
                path = Path(info.filename)
                if path.is_absolute() or '..' in path.parts or info.filename.startswith('/'):
                    raise ValueError('Unsafe archive path')
            for name in names:
                # No extraction is necessary except for needed files; prevent zip-slip.
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(z.read(name))
        if any(is_private_asset_name(name) for name in names):
            result['blockers'].append('Candidate includes unexpected media files outside icon allowlist')
        for name in SHELL:
            if not (root / name).is_file():
                result['blockers'].append(f'Candidate missing required static asset: {name}')
        for name in sorted(names):
            origin = repo / name
            source = root / name
            if not source.is_file():
                continue
            source_sha = digest(source)
            remote_sha = digest(origin) if origin.is_file() else None
            status = ('same' if source_sha == remote_sha else 'different') if remote_sha else 'missing_in_repo'
            result['file_comparison'].append({'path': name, 'status': status, 'candidate_sha256': source_sha, 'repo_sha256': remote_sha})
        paths = git(repo, 'ls-files')
        if paths is not None:
            result['remote_only_paths'] = sorted(set(paths.splitlines()) - set(names))
        candidate_html = (root / 'index.html').read_text(encoding='utf8') if (root / 'index.html').exists() else ''
        repo_html = (repo / 'index.html').read_text(encoding='utf8') if (repo / 'index.html').exists() else ''
        result['candidate_risks'] = html_risks(candidate_html)
        result['repository_risks'] = html_risks(repo_html) if repo_html else ['Root index.html absent or unreadable']
        for k, marker in MARKERS.items():
            result['feature_matrix'][k] = {'candidate': marker in candidate_html, 'repository': marker in repo_html}
        if result['candidate_risks']:
            result['blockers'].append('Candidate HTML requires privacy review')
        if result['repository_risks']:
            result['blockers'].append('Repository HTML requires privacy review before public release')
        if (repo / 'package.json').exists():
            result['blockers'].append('Repository has a Node app/build layout: manually reconcile architecture rather than replacing root')
        critical = [f for f in result['file_comparison'] if f['path'] in SHELL and f['status'] != 'same']
        if critical:
            result['next_action'] = 'MANUAL MERGE REQUIRED: inspect remote changes, preserve working features, then run tests'
        else:
            result['next_action'] = 'Candidate static shell matches checked-out files; run GitHub Actions and verify Pages settings'
        if result['blockers']:
            result['next_action'] = 'BLOCKED: resolve blockers and manually review before any publication'
    return result


def md(result):
    g = result['git']
    out = ['# OVA Atlas — read-only reconciliation report', '',
           f'- Checkout: `{g["checkout"]}`; branch: `{g["branch"]}`; commit: `{g["head"]}`; clean: `{g["clean"]}`',
           f'- Git origin: `{g["origin"]}`', f'- Recommendation: **{result["next_action"]}**', '',
           '## Safety blockers', '']
    out += ['- ' + b for b in result['blockers']] or ['- None found by static checks']
    out += ['', '## Candidate vs checkout', '', '| Path | Status |', '|---|---|']
    out += [f'| `{x["path"]}` | {x["status"]} |' for x in result['file_comparison']]
    out += ['', '## Feature matrix', '', '| Feature | Candidate | Checkout |', '|---|---|---|']
    out += [f'| {k} | {"yes" if d["candidate"] else "no"} | {"yes" if d["repository"] else "no"} |' for k, d in result['feature_matrix'].items()]
    out += ['', '## Other tracked repository paths', '']
    out += ['- `' + s + '`' for s in result['remote_only_paths']] or ['- None']
    out += ['', '**No Git writes, pushes, or network requests were performed by this audit.**']
    return '\n'.join(out) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--report', default='atlas_reconciliation.md')
    parser.add_argument('--json', default='atlas_reconciliation.json')
    args = parser.parse_args()
    try:
        result = audit(args.repo, args.candidate)
    except (OSError, ValueError, zipfile.BadZipFile) as ex:
        print(f'Audit failed safely: {ex}', file=sys.stderr)
        return 2
    Path(args.report).write_text(md(result), encoding='utf8')
    Path(args.json).write_text(json.dumps(result, indent=2) + '\n', encoding='utf8')
    print(result['next_action'])
    print(f'Report: {args.report} ({len(result["file_comparison"])} candidate files compared)')
    return 1 if result['blockers'] or 'MANUAL MERGE' in result['next_action'] else 0


if __name__ == '__main__':
    sys.exit(main())
