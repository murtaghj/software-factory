"""Refresh the specification manifest and ZIP after generation and validation."""
from pathlib import Path
import hashlib
import json
import zipfile
import validate_spec
from package_contents import COMPANION_FILES

SPEC = Path(__file__).resolve().parents[1]
ROOT = SPEC.parent
MANIFEST = SPEC / 'MANIFEST.sha256'


def main():
    validate_spec.main()
    report = json.loads((SPEC / 'validation-report.json').read_text())
    if report.get('staticChecksPassed') is not True or report.get('productValidationExecuted') is not False:
        raise RuntimeError('Run validate_spec.py successfully before packaging')
    files = [ROOT / name for name in COMPANION_FILES]
    files += [p for p in SPEC.rglob('*') if p.is_file()
                    and p != MANIFEST and '__pycache__' not in p.parts
                    and p.name != '.DS_Store']
    files.sort(key=lambda p: p.relative_to(ROOT).as_posix())
    hashes = {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest()
              for p in files}
    MANIFEST.write_text(''.join(f'{digest}  {name}\n' for name, digest in hashes.items()))
    archive = ROOT / 'implementation-package.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as bundle:
        for p in sorted(files + [MANIFEST], key=lambda p: p.relative_to(ROOT).as_posix()):
            entry = zipfile.ZipInfo(p.relative_to(ROOT).as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            entry.compress_type = zipfile.ZIP_DEFLATED
            bundle.writestr(entry, p.read_bytes(), compresslevel=9)
    with zipfile.ZipFile(archive) as bundle:
        if bundle.namelist() != sorted(bundle.namelist()) or any(
                entry.date_time != (1980, 1, 1, 0, 0, 0) for entry in bundle.infolist()):
            raise RuntimeError('ZIP ordering/timestamp determinism failure')
        if bundle.testzip() is not None:
            raise RuntimeError('ZIP integrity failure')
        for name, expected in hashes.items():
            if hashlib.sha256(bundle.read(name)).hexdigest() != expected:
                raise RuntimeError('ZIP content integrity failure: ' + name)
    print(f'Packaged and verified {len(files) + 1} files: {archive}')


if __name__ == '__main__':
    main()
