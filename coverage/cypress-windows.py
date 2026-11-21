#!/usr/bin/env python3
"""Makes test-windows.json from a Cypress run, so analyze.py can match requests to Cypress tests.

Usage: python3 cypress-windows.py <cucumber-messages.ndjson> [out-file]
out-file defaults to coverage-data/test-windows.json.

The Cypress tests use @badeball/cypress-cucumber-preprocessor. With "messages" turned on
in its config, it writes one JSON message per line. This script reads:
  gherkinDocument   - the feature file: scenario lines, rule names, example rows
  pickle            - one runnable scenario (one per example row of an outline)
  testCase          - links a pickle to its run
  testCaseStarted   - start time of one attempt (a retry is a new attempt)
  testStepFinished  - step results, for the status
  testCaseFinished  - end time of the attempt
The times are the clock of the test computer, the same clock that coverage/prepend.php uses.

Each attempt gives one window, in the same form as the Playwright reporter
(coverage/test-window-reporter.cjs), with project "cypress".
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
src = sys.argv[1]
out_file = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, '..', 'coverage-data', 'test-windows.json')

nodes = {}       # AST node id -> {line, name, rule}
pickles = {}     # pickle id -> pickle
cases = {}       # test case id -> pickle id
started = {}     # (block, test case started id) -> testCaseStarted
statuses = {}    # (block, test case started id) -> step statuses
finished = {}    # (block, test case started id) -> testCaseFinished
last_step = {}   # (block, test case started id) -> time of the last finished step
step_defs = {}   # (block, step definition id) -> its pattern (the messages give no source file)
case_steps = {}  # (block, test case id) -> step definition ids it used


def walk(children, rule):
    for c in children:
        if 'rule' in c:
            walk(c['rule'].get('children', []), c['rule']['name'])
        elif 'scenario' in c:
            s = c['scenario']
            nodes[s['id']] = {'line': s['location']['line'], 'name': s['name'], 'rule': rule}
            for ex in s.get('examples', []):
                for row in ex.get('tableBody', []):
                    nodes[row['id']] = {'line': row['location']['line']}


def seconds(ts):
    return ts['seconds'] + ts['nanos'] / 1e9


# The file holds one block of messages per feature file, and each block starts with its
# gherkinDocument. Feature, scenario and pickle IDs are random UUIDs. The IDs of attempts
# come from a seed that is the time when the feature file was prepared, so two files can
# share them: key attempts by block too.
block = 0
with open(src) as fh:
    for raw in fh:
        if not raw.strip():
            continue
        m = json.loads(raw)
        if 'gherkinDocument' in m:
            block += 1
            if m['gherkinDocument'].get('feature'):
                walk(m['gherkinDocument']['feature'].get('children', []), None)
        elif 'pickle' in m:
            pickles[m['pickle']['id']] = m['pickle']
        elif 'stepDefinition' in m:
            step_defs[(block, m['stepDefinition']['id'])] = m['stepDefinition'].get('pattern', {}).get('source', '')
        elif 'testCase' in m:
            cases[m['testCase']['id']] = m['testCase']['pickleId']
            case_steps[(block, m['testCase']['id'])] = [i for s in m['testCase'].get('testSteps', []) for i in s.get('stepDefinitionIds', [])]
        elif 'testCaseStarted' in m:
            started[(block, m['testCaseStarted']['id'])] = m['testCaseStarted']
        elif 'testStepFinished' in m:
            r = m['testStepFinished']
            statuses.setdefault((block, r['testCaseStartedId']), []).append(r['testStepResult']['status'])
            if 'timestamp' in r:
                last_step[(block, r['testCaseStartedId'])] = seconds(r['timestamp'])
        elif 'testCaseFinished' in m:
            finished[(block, m['testCaseFinished']['testCaseStartedId'])] = m['testCaseFinished']


def status_of(steps):
    if any(s in ('FAILED', 'UNDEFINED', 'AMBIGUOUS', 'UNKNOWN') for s in steps):
        return 'failed'
    if steps and all(s == 'PASSED' for s in steps):
        return 'passed'
    return 'skipped'


windows = []
missing_end = 0
for sid, st in started.items():
    pickle = pickles.get(cases.get(st['testCaseId']))
    if not pickle:
        continue
    scenario = nodes.get(pickle['astNodeIds'][0], {})
    row = nodes.get(pickle['astNodeIds'][1]) if len(pickle['astNodeIds']) > 1 else None
    end = finished.get(sid)
    if not end:
        missing_end += 1  # the run stopped during this test
    rule = scenario.get('rule')
    windows.append({
        # One ID per pickle: the attempts (retries) of one example row share it.
        'id': 'CY:' + pickle['id'],
        'title': ' > '.join(x for x in ('cypress', pickle['uri'], rule, pickle['name']) if x),
        'project': 'cypress',
        'path': [x for x in (pickle['uri'], rule, pickle['name']) if x],
        # Relative to the Cypress project folder (for example cypress/tests/Admin/x.feature).
        'file': pickle['uri'],
        # The Scenario line, so the app can match it to the scanned scenario. exampleLine: the row of an outline.
        'line': scenario.get('line', pickle.get('location', {}).get('line', 0)),
        'exampleLine': row['line'] if row else None,
        'tags': [t['name'] for t in pickle.get('tags', [])],
        'retry': st.get('attempt', 0),
        'status': status_of(statuses.get(sid, [])) if end else 'interrupted',
        'start': seconds(st['timestamp']),
        # The run stopped during this attempt: it ends at its last finished step.
        'end': seconds(end['timestamp']) if end else last_step.get(sid, seconds(st['timestamp'])),
        # The patterns of the step definitions the test used. coverage/select-tests.py selects the
        # test when the definition of one of them changed.
        'steps': sorted({step_defs[(sid[0], i)] for i in case_steps.get((sid[0], st['testCaseId']), []) if step_defs.get((sid[0], i))}),
    })

windows.sort(key=lambda w: w['start'])

os.makedirs(os.path.dirname(os.path.abspath(out_file)), exist_ok=True)
with open(out_file, 'w') as fh:
    json.dump(windows, fh, indent=2)
print(f'{len(windows)} test windows from {len({w["id"] for w in windows})} Cypress scenario runs written to {out_file}'
      + (f' ({missing_end} without an end time)' if missing_end else ''))
