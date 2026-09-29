"""Check published legal sources, Word/PDF parity and publication hashes."""
from pathlib import Path
import hashlib
import json
import re
from docx import Document
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
LEGAL = ROOT / 'legal'

def normalized(text):
    return re.sub(r'\s+', '', text)

def main():
    manifest = json.loads((LEGAL / 'manifest.json').read_text(encoding='utf-8'))
    for name, meta in manifest.items():
        source = (LEGAL / 'source' / f'{name}.md').read_text(encoding='utf-8')
        doc = Document(LEGAL / f'{name}.docx')
        word = '\n'.join(p.text for p in doc.paragraphs)
        path = LEGAL / 'public' / f'{name}.pdf'
        pdf = PdfReader(path)
        text = '\n'.join(p.extract_text() or '' for p in pdf.pages)
        assert hashlib.sha256(path.read_bytes()).hexdigest() == meta['sha256']
        assert (LEGAL / 'pdf' / path.name).read_bytes() == path.read_bytes()
        assert meta['version'] == '2.0'
        for block in source.strip().split('\n\n'):
            if block == '<!-- pagebreak -->': continue
            clean = block.removeprefix('## ').removeprefix('# ')
            assert normalized(clean) in normalized(word), (name, 'Word text missing', clean[:70])
            assert normalized(clean) in normalized(text), (name, 'PDF text missing', clean[:70])
        for current in [word, text]:
            assert 'На связи_регион40' in current
            assert not re.search(r'искр[аыой]', current, re.I)
            assert 'min_digital@adm.kaluga.ru' in current
            assert '1194027000221' in current
            assert 'Редакция 2.0 от 29.09.2026' in current
            assert 'Защитники Отечества' in current
            assert 'Социального фонда России' in current
            assert 'сами по себе не относятся' not in current
        assert all(len(p.extract_text() or '') > 100 for p in pdf.pages), 'Unexpected near-empty page'
        print(f'OK {name}: {len(pdf.pages)} pages; source, Word, PDF and hash match')

if __name__ == '__main__': main()
