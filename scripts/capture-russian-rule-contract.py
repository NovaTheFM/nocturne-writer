import hashlib
import html
import json
import pathlib
import re
import sys
import xml.etree.ElementTree as ET

source = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else 'release/tools/languagetool/unpacked/LanguageTool-6.6/org/languagetool/rules/ru/grammar.xml')
raw = source.read_bytes()
content = re.sub(r'<!--.*?-->', '', raw.decode('utf-8'), flags=re.S)
events = re.compile(r'<example\b[^>]*>.*?</example>|</?(?:category|rulegroup|rule)\b[^>]*>', re.S)
stack = []
rules = {}
cases = []
source_attributes = []
errors = []
category = {}

def decode_entities(text):
    def convert(match):
        name = match.group(1)
        if name in ['amp', 'lt', 'gt', 'quot', 'apos']:
            return match.group(0)
        decoded = html.unescape(match.group(0))
        return decoded if decoded != match.group(0) else match.group(0)
    return re.sub(r'&([A-Za-z][A-Za-z0-9]*);', convert, text)

def text_and_markers(root):
    pieces, markers = [], []
    def walk(node):
        start = sum(len(piece) for piece in pieces)
        if node.text:
            pieces.append(node.text)
        for child in node:
            walk(child)
            if child.tail:
                pieces.append(child.tail)
        if node.tag == 'marker':
            markers.append((start, sum(len(piece) for piece in pieces)))
    walk(root)
    text = ''.join(pieces)
    leading = len(text) - len(text.lstrip())
    return text.strip(), [(start-leading, end-leading) for start, end in markers]

for event in events.finditer(content):
    token = event.group(0)
    if token.startswith('<example'):
        try:
            root = ET.fromstring(decode_entities(token))
            owner = next(item for item in reversed(stack) if item.get('id'))
            text, markers = text_and_markers(root)
            correction = root.get('correction')
            gold = []
            if correction and len(markers) == 1:
                start, end = markers[0]
                gold = [text[:start] + value + text[end:] for value in correction.split('|')]
            cases.append(dict(id=f"ru-xml-{len(cases)+1}", ruleId=owner['id'], category=category.get('id'), categoryType=category.get('type'), tags=owner.get('tags', ''), text=text, expected='no-target-error' if correction is None else 'correction' if gold else 'diagnostic', gold=gold, sourceCorrection=correction, markers=[dict(start=len(text[:start].encode('utf-16-le'))//2,end=len(text[:end].encode('utf-16-le'))//2) for start,end in markers]))
            source_attributes.append(dict(id=cases[-1]['id'], sourceType=root.get('type'), sourceCorrection=correction, expected='diagnostic' if root.get('type') == 'incorrect' and correction is None else cases[-1]['expected']))
        except Exception as error:
            errors.append(dict(source=token[:400], error=str(error)))
    elif token.startswith('</category'):
        category = {}
    elif token.startswith('</rule'):
        stack.pop()
    else:
        attrs = ET.fromstring(decode_entities(token[:-1]+'/>')).attrib
        if token.startswith('<category'):
            category = attrs
        else:
            stack.append(attrs)
            if attrs.get('id'):
                rules[attrs['id']] = dict(**attrs, category=category.get('id'), categoryType=category.get('type'))

canonical = json.dumps(cases, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
result = dict(contractVersion=1, source='Unmodified LanguageTool 6.6 Russian grammar.xml examples; source conformance, not an independent accuracy corpus', sourceSha256=hashlib.sha256(raw).hexdigest(), corpusSha256=hashlib.sha256(canonical).hexdigest(), rules=rules, cases=cases, parseErrors=errors)
path = pathlib.Path(sys.argv[2] if len(sys.argv) > 2 else 'release/qa-smart-audit/russian-rule-contract.json')
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
validation = dict(sourceSha256=result['sourceSha256'], originalCorpusSha256=result['corpusSha256'], note='All original examples remain unchanged. Legacy type="incorrect" without a correction is a diagnostic, not a clean control.', cases=source_attributes)
validation['sha256'] = hashlib.sha256(json.dumps(source_attributes, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()
path.with_name('russian-rule-source-validation.json').write_text(json.dumps(validation, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print(json.dumps(dict(rules=len(rules), cases=len(cases), positive=sum(item['expected']!='no-target-error' for item in cases), controls=sum(item['expected']=='no-target-error' for item in cases), parseErrors=errors[:5], corpusSha256=result['corpusSha256']), ensure_ascii=False))
