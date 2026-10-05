"""Convert a BEAM parquet split into the JSON beam.mjs reads. Needs: pip install pyarrow"""
import ast, json, re, sys
from datetime import datetime
import pyarrow.parquet as pq

size = sys.argv[1] if len(sys.argv) > 1 else '1M'

def ts(anchor):
    for f in ('%B-%d-%Y', '%b-%d-%Y'):
        try:
            return int(datetime.strptime(anchor, f).timestamp() * 1000)
        except ValueError:
            pass
    return None

out = []
for r in pq.read_table(f'data/beam-{size}.parquet').to_pylist():
    sessions, last = [], 0
    for batch in r['chat']:
        anchor = next((x.get('time_anchor') for x in batch if x.get('time_anchor')), None)
        t = (ts(anchor) if anchor else None) or last
        last = t
        rows = [{'role': x['role'], 'content': re.sub(r'\s*->->\s*\d+,\d+\s*$', '', x['content'])} for x in batch]
        sessions.append({'ts': t, 'turns': rows})
    qs = []
    for typ, lst in ast.literal_eval(r['probing_questions']).items():
        for i, q in enumerate(lst):
            rub = q.get('rubric', [])
            rub = rub if isinstance(rub, list) else rub.get('nuggets', [])
            rub = [x.get('description', str(x)) if isinstance(x, dict) else str(x) for x in rub]
            qs.append({'qid': f"{r['conversation_id']}-{typ}-{i}", 'type': typ, 'question': q.get('question', ''), 'rubric': rub})
    out.append({'id': str(r['conversation_id']), 'sessions': sessions, 'questions': qs})
json.dump(out, open(f'data/beam-{size}.json', 'w'))
print(f'beam-{size}: {len(out)} conversations, {sum(len(c["questions"]) for c in out)} questions')
