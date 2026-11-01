"""Structural validation of this spec package, not a product/integration test suite.

Implements the JSON Schema keyword subset actually used here. Production must use
a conforming draft-2020-12 validator and execute SQL/TypeScript/provider tests.
"""
import json
import re
import uuid
import copy
import hashlib
from datetime import datetime
from pathlib import Path
from html.parser import HTMLParser
from collections import Counter
from build_reader import heading_ids, revision_metadata
from package_contents import COMPANION_FILES

ROOT=Path(__file__).resolve().parents[1]
checks=[]
def check(condition,message):
    if not condition:raise AssertionError(message)
    checks.append(message)
def read(p):return json.loads(p.read_text())
schema=read(ROOT/'contracts/domain.schema.json');defs=schema['$defs']

# Each exception is a (package, dependency): reason pair. The current backlog
# needs none; a later milestone is never allowed merely because it exists.
LATER_MILESTONE_ALLOWLIST = {}

def dependency_edges(item):
    """All possible edges for reference, cycle, milestone and reachability checks."""
    return item['dependsOn'] + [dep for group in item.get('dependsOnAny', []) for dep in group]

def prerequisites_satisfied(item, completed):
    return set(item['dependsOn']) <= completed and all(
        bool(set(group) & completed) for group in item.get('dependsOnAny', []))

def milestone_dependencies(work, allowlist=None):
    allowlist=LATER_MILESTONE_ALLOWLIST if allowlist is None else allowlist
    for (package,dependency),reason in allowlist.items():
        check(isinstance(reason,str) and bool(reason.strip()),'Milestone exception needs a reason: '+package+' → '+dependency)
        check(package in work and dependency in dependency_edges(work[package]),'Milestone exception names an existing edge: '+package+' → '+dependency)
        check(int(work[dependency]['milestone'][1:])>int(work[package]['milestone'][1:]),'Milestone exception is still needed: '+package+' → '+dependency)
    for package,item in work.items():
        check(bool(re.fullmatch(r'M\d+',item['milestone'])),'Valid milestone: '+package)
        for dependency in dependency_edges(item):
            check(int(work[dependency]['milestone'][1:])<=int(item['milestone'][1:]) or (package,dependency) in allowlist,
                  'Dependency must not be in a later milestone without a reasoned exception: '+package+' → '+dependency)

def defined_ids(text,prefix):
    rows=re.findall(r'^\| ('+prefix+r'-\d+) \|',text,re.M)
    check(len(rows)==len(set(rows)),'Unique definition rows: '+prefix)
    check(bool(rows),'Definition rows exist: '+prefix)
    return set(rows)

def prose_ids(text):
    references=set(re.findall(r'\b(?:INV|ADR|INT|W|AC)-\d+\b',text))
    for match in re.finditer(r'\b(INV|ADR|INT|W|AC)-(\d+)\s*[–—-]\s*(?:(INV|ADR|INT|W|AC)-)?(\d+)\b',text):
        prefix,start,end_prefix,end=match.groups()
        check(end_prefix in (None,prefix) and int(start)<=int(end),'Valid ID range: '+match[0])
        width=3 if prefix=='W' else 2
        references.update(f'{prefix}-{n:0{width}d}' for n in range(int(start),int(end)+1))
    # Abbreviated same-family references, such as INV-01/02/09.
    for match in re.finditer(r'\b(INV|ADR|INT|W|AC)-(\d+)((?:/\d+)+)\b',text):
        width=3 if match[1]=='W' else 2
        references.update(f'{match[1]}-{int(n):0{width}d}' for n in match[3][1:].split('/'))
    return references

def closure_checks(register,work,integrations):
    closed_integrations=set()
    for row in register.splitlines():
        if not re.match(r'^\| (ADR|INT)-\d+ \|',row):continue
        cells=[cell.strip() for cell in row.strip('|').split('|')]
        identifier=cells[0]
        if identifier.startswith('ADR-'):
            check(len(cells)==6 and all(cells[3:]) and cells[5] in ('proposed','adopted','superseded'),
                  'ADR has a closing gate, owner and status: '+identifier)
            closing=cells[3]
        else:
            check(len(cells)==5 and all(cells),'INT has owner, due and closing gate: '+identifier)
            closing=cells[4];closed_integrations.add(identifier)
        references=prose_ids(closing)
        packages={i for i in references if i.startswith('W-')}
        evidence={i for i in references if i.startswith('AC-')}
        check(bool(packages) and bool(evidence) and bool(re.search(r'\bM\d+\b',closing)),
              'Closing cell names milestone, work and acceptance: '+identifier)
        check(packages<=set(work),'Closing packages exist: '+identifier)
        owned={a for w in packages for a in work[w]['acceptance']}
        check(evidence<=owned,'Closing acceptance owned by cited packages: '+identifier+'; unowned: '+', '.join(sorted(evidence-owned)))
    check(closed_integrations==integrations,'Every integration has a backlog-owned closure gate')

def markdown_checks(root,identifiers):
    documents=set(root.rglob('*.md'))|{root.parent/name for name in COMPANION_FILES if name.endswith('.md')}
    for doc in sorted(documents):
        text=doc.read_text();name=str(doc.relative_to(root.parent))
        missing=prose_ids(text)-identifiers
        check(not missing,'Defined prose references: '+name+'; undefined: '+', '.join(sorted(missing)))
        lines=text.splitlines();in_code=False;previous_table=False;blank_after_table=False
        for index,line in enumerate(lines):
            if line.startswith('```'):in_code=not in_code
            if in_code:continue
            if not line.strip():
                blank_after_table=previous_table or blank_after_table
                continue
            table=line.startswith('|')
            separator=lines[index+1] if index+1<len(lines) else ''
            new_header=bool(re.fullmatch(r'\|(?:\s*:?-+:?\s*\|)+\s*',separator))
            check(not (table and blank_after_table) or new_header,'No blank line splits a table: '+name)
            previous_table=table;blank_after_table=False
        for href in re.findall(r'\[[^\]]+\]\(([^)]+)\)',text):
            if re.match(r'^[a-zA-Z][\w+.-]*:',href):continue
            target,separator,fragment=href.partition('#')
            path=doc.parent/target if target else doc
            check(path.exists(),'Markdown link: '+name+' → '+href)
            if separator:
                if path.suffix=='.md':anchors=heading_ids(path.read_text())
                elif path.suffix=='.html':
                    class Anchors(HTMLParser):
                        def __init__(self):super().__init__();self.ids=set()
                        def handle_starttag(self,tag,attrs):
                            if 'id' in dict(attrs):self.ids.add(dict(attrs)['id'])
                    parser=Anchors();parser.feed(path.read_text());anchors=parser.ids
                else:raise AssertionError('Unsupported local fragment target: '+name+' → '+href)
                check(fragment in anchors,'Markdown fragment: '+name+' → '+href)

def validate(value,s,path='$'):
    if '$ref' in s:return validate(value,defs[s['$ref'].split('/')[-1]],path)
    if 'oneOf' in s:
        matches=0
        for branch in s['oneOf']:
            try:validate(value,branch,path)
            except ValueError:pass
            else:matches+=1
        if matches!=1:raise ValueError(path+' oneOf expected one matching branch')
    if 'const' in s and json.dumps(value,sort_keys=True)!=json.dumps(s['const'],sort_keys=True):raise ValueError(path+' const')
    if 'enum' in s and value not in s['enum']:raise ValueError(path+' enum')
    typ=s.get('type')
    ok={'object':isinstance(value,dict),'array':isinstance(value,list),'string':isinstance(value,str),'integer':isinstance(value,int) and not isinstance(value,bool),'boolean':isinstance(value,bool),'number':isinstance(value,(int,float)) and not isinstance(value,bool),'null':value is None}
    if typ and not ok[typ]:raise ValueError(path+' type '+typ)
    if isinstance(value,dict):
        for field in s.get('required',[]):
            if field not in value:raise ValueError(path+' missing '+field)
        props=s.get('properties',{})
        for k,v in value.items():
            if k in props:validate(v,props[k],path+'.'+k)
            elif s.get('additionalProperties') is False:raise ValueError(path+' extra '+k)
            elif isinstance(s.get('additionalProperties'),dict):validate(v,s['additionalProperties'],path+'.'+k)
    if isinstance(value,list):
        if len(value)<s.get('minItems',0):raise ValueError(path+' minItems')
        if len(value)>s.get('maxItems',10**15):raise ValueError(path+' maxItems')
        if s.get('uniqueItems') and len({json.dumps(v,sort_keys=True) for v in value})!=len(value):
            raise ValueError(path+' uniqueItems')
        if 'contains' in s:
            matches=0
            for v in value:
                try:validate(v,s['contains'],path)
                except ValueError:pass
                else:matches+=1
            if not s.get('minContains',1)<=matches<=s.get('maxContains',10**15):
                raise ValueError(path+' contains count')
        if 'items' in s:
            for i,v in enumerate(value):validate(v,s['items'],path+f'[{i}]')
    if isinstance(value,str):
        if len(value)<s.get('minLength',0) or len(value)>s.get('maxLength',10**15):raise ValueError(path+' length')
        if 'pattern' in s and not re.search(s['pattern'],value):raise ValueError(path+' pattern')
        if s.get('format')=='uuid':uuid.UUID(value)
        if s.get('format')=='date-time':
            dt=datetime.fromisoformat(value.replace('Z','+00:00'))
            if dt.tzinfo is None:raise ValueError(path+' missing timezone')
        if s.get('format')=='uri' and not re.match(r'^[a-z][a-z0-9+.-]*:',value):raise ValueError(path+' uri')
    if isinstance(value,(int,float)) and not isinstance(value,bool) and value<s.get('minimum',float('-inf')):raise ValueError(path+' minimum')
    if isinstance(value,(int,float)) and not isinstance(value,bool) and value>s.get('maximum',float('inf')):raise ValueError(path+' maximum')
    for branch in s.get('allOf',[]):validate(value,branch,path)
    if 'not' in s:
        try:validate(value,s['not'],path)
        except ValueError:pass
        else:raise ValueError(path+' not')
    if 'if' in s:
        try:validate(value,s['if'],path)
        except ValueError:
            if 'else' in s:validate(value,s['else'],path)
        else:
            if 'then' in s:validate(value,s['then'],path)

def walk(v):
    if isinstance(v,dict):
        if '$ref' in v:yield v['$ref']
        for item in v.values():yield from walk(item)
    elif isinstance(v,list):
        for item in v:yield from walk(item)

def pinned_tool_checks():
    from frozen_tool_contracts import MANIFESTS, BASELINE_FIXTURE_DIGESTS, BASELINE_FIXTURES, definitions, pinned
    frozen=definitions()
    for name,definition in frozen.items():
        check(defs.get(name)==definition,'Historical tool definition unchanged: '+name)
        check(all(ref.split('/')[-1] in frozen for ref in walk(definition)),
              'Historical tool references are transitively frozen: '+name)
    for version,manifest in MANIFESTS.items():
        retained=read(ROOT/'contracts'/('factory-tools.v'+version.rsplit('.',1)[0]+'.schema.json'))
        check(retained==pinned(manifest),'Historical tool manifest pinned: '+version)
        for name,tool,field in [('factory-submit-receipt.json','submit_result','outputSchema'),
                                ('factory-submit-result.json' if version=='1.0.0' else 'factory-submit-result-v1.1.json','submit_result','inputSchema'),
                                ('factory-verify-feedback.json' if version=='1.0.0' else 'factory-verify-feedback-v1.1.json','verify','outputSchema')]:
            validate(read(ROOT/'examples'/name),retained['x-tools'][tool][field])
            check(True,'Historical fixture accepted by pinned manifest: '+version+' '+name)
    for name,digest in BASELINE_FIXTURE_DIGESTS.items():
        check(hashlib.sha256(BASELINE_FIXTURES[name].encode()).hexdigest()==digest,
              'Revision 1.10 fixture bytes preserved: '+name)
        tool='submit_result' if name=='factory-submit-receipt.json' else 'verify'
        versions=('1.0.0','1.1.0') if tool=='submit_result' else ('1.1.0',)
        for version in versions:
            validate(json.loads(BASELINE_FIXTURES[name]),pinned(MANIFESTS[version])['x-tools'][tool]['outputSchema'])
            check(True,'Original revision 1.10 fixture accepted: '+version+' '+name)
    current=read(ROOT/'contracts/factory-tools.schema.json')
    for name,tool in [('factory-submit-receipt.json','submit_result'),('factory-verify-feedback-v1.1.json','verify')]:
        fixture=read(ROOT/'examples'/name);definition=current['x-tools'][tool]['outputSchema']
        try:validate(fixture,definition)
        except ValueError:check(True,'Current tools reject noncanonical legacy identity: '+tool)
        else:raise AssertionError('Current tools accepted legacy identity: '+tool)
        fixture['stageRunId']=read(ROOT/'examples/stage-result.json')['stageRunId']
        validate(fixture,definition)
        check(True,'Current tools accept canonical identity: '+tool)

def review_assurance(packet,task):
    if task['assurance']=='enhanced':
        gates={gate for item in packet['definitionOfDone'] for gate in item['requiredGateIds']}
        if not {'oracle_accepted','adversarial_passed'}<=gates:
            raise ValueError('Enhanced review packet omits oracle/adversarial evidence')

def task_semantics(task):
    """Static example predicates; authorization/resource checks need the implementation."""
    validate(task,defs['TaskRequest'])
    target=task['targetContext']
    if target['applicationId'] not in task['applicationIds']:raise ValueError('primary target absent')
    if target['kind']=='new_application':
        repo=target.get('repositoryIntent')
        if repo and repo['kind']=='existing_repository':
            path=repo['subpath']
            if path=='':
                if 'rootAdoption' not in repo:raise ValueError('root adoption requires retained bootstrap provenance')
            elif path.startswith('/') or '\\' in path or any(p in ('','..','.') for p in path.split('/')):
                raise ValueError('unsafe monorepo subpath')
        return 'greenfield_design' if task['deliveryScope']=='design' else 'greenfield'
    if task['deliveryScope']=='design':return task['workType']+'_design'
    return {'feature':'existing_feature','bug':'bug_fix'}.get(task['workType'],task['workType'])

def template_semantics(template):
    validate(template,defs['WorkflowTemplateDefinition'])
    expected={'greenfield':('feature','new_application'),'existing_feature':('feature','existing_application'),'bug_fix':('bug','existing_application')}
    from design_delivery_contracts import DESIGN_TEMPLATES
    pair=DESIGN_TEMPLATES.get(template['id']) or expected.get(template['id'],(template['id'],'existing_application'))
    if (template['workType'],template['targetKind'])!=pair:raise ValueError('incompatible template target')
    if template['id'] in expected:
        ai_profile=template.get('reviewQualificationProfile')=='ai-review/1.0'
        version=('5.0.0' if template['id']=='greenfield' else '4.0.0') if ai_profile else ('4.0.0' if template['id']=='greenfield' else '3.0.0')
        if template['version']!=version:raise ValueError('template authority profile/version mismatch')
    nodes={n['id']:n for n in template['nodes']}
    if len(nodes)!=len(template['nodes']):raise ValueError('duplicate node')
    ancestors={};active=set()
    def visit(id):
        if id in active:raise ValueError('dependency cycle')
        if id in ancestors:return ancestors[id]
        active.add(id);node=nodes[id];prior=set()
        if not set(node['returnTargets'])<=set(nodes):raise ValueError('unknown return target')
        for dep in node['dependsOn']:
            if dep not in nodes:raise ValueError('unknown dependency')
            if node['mandatory'] and not nodes[dep]['mandatory']:raise ValueError('mandatory node depends on optional node')
            prior.add(dep);prior.update(visit(dep))
        active.remove(id);ancestors[id]=prior;return prior
    for id in nodes:visit(id)
    trusted={'baseline_valid','canonical_package_locked','outcome_verified','foundation_verified','vertical_slice_verified','parent_outcome_verified'}
    for node in nodes.values():
        if trusted.intersection(node['requiredGateIds']) and node['role']!='verifier':raise ValueError('trusted evidence assigned to author')
    def gate_node(gate):
        candidates=[n['id'] for n in nodes.values() if gate in n['requiredGateIds'] and n['mandatory']]
        if len(candidates)!=1:raise ValueError('missing/ambiguous mandatory gate '+gate)
        return candidates[0]
    def ordered(first,second):
        if first not in ancestors[second]:raise ValueError('missing required ordering '+first+' → '+second)
    if template['id'] in DESIGN_TEMPLATES:
        from design_delivery_validation import design_template_checks
        design_template_checks(template,nodes,gate_node,ordered)
    elif template['id']=='bug_fix':
        red=gate_node('baseline_valid');lock=gate_node('canonical_package_locked');green=gate_node('outcome_verified')
        repair=next((n['id'] for n in nodes.values() if n['stageKind']=='execute' and n['mandatory']),None)
        if not repair:raise ValueError('missing bug repair')
        ordered(gate_node('oracle_accepted'),red);ordered(red,lock);ordered(lock,repair);ordered(repair,green)
        ordered(green,gate_node('integration_passed'));ordered(gate_node('integration_passed'),gate_node('review_passed'))
    elif template['id']=='existing_feature':
        implementation=[n['id'] for n in nodes.values() if n['stageKind']=='execute' and n['mandatory']]
        if len(implementation)!=1:raise ValueError('missing/ambiguous feature implementation')
        ordered(gate_node('oracle_accepted'),implementation[0]);ordered(implementation[0],gate_node('outcome_verified'))
        ordered(gate_node('outcome_verified'),gate_node('integration_passed'))
        if any(n['stageKind']=='baseline_red' for n in nodes.values()):raise ValueError('feature fixture forces bug baseline')
    elif template['id']=='greenfield':
        sequence=['intent_aligned','architecture_accepted','bootstrap_ready','foundation_verified','application_registered','oracle_accepted','vertical_slice_verified','parent_outcome_verified','review_passed']
        for a,b in zip(sequence,sequence[1:]):ordered(gate_node(a),gate_node(b))
        interview=[n for n in nodes.values() if n['stageKind']=='intent_interview' and n['mandatory']]
        challenge=[n for n in nodes.values() if n['stageKind']=='intent_challenge' and n['mandatory']]
        if len(interview)!=1 or len(challenge)!=1:raise ValueError('missing mandatory intent inquiry or review')
        if challenge[0]['role']!='reviewer' or challenge[0]['sessionPolicy']!='fresh':raise ValueError('intent review is not independent')
        ordered(interview[0]['id'],challenge[0]['id']);ordered(challenge[0]['id'],gate_node('intent_aligned'))
        if nodes[gate_node('intent_aligned')]['stageKind']!='intent_confirmation':raise ValueError('missing explicit confirmation stage')
        if gate_node('scope_accepted')!=gate_node('intent_aligned'):raise ValueError('greenfield seed is prematurely accepted')
        for kind,before,after in [('scaffold','bootstrap_ready','foundation_verified'),('vertical_slice','oracle_accepted','vertical_slice_verified'),('compose_children','vertical_slice_verified','parent_outcome_verified')]:
            matches=[n['id'] for n in nodes.values() if n['stageKind']==kind and n['mandatory']]
            if len(matches)!=1:raise ValueError('missing mandatory '+kind)
            ordered(gate_node(before),matches[0]);ordered(matches[0],gate_node(after))
    if template['id'] in expected:
        peer=gate_node('plan_peer_approved')
        if nodes[peer]['stageKind']!='plan_peer_review' or nodes[peer]['role']!='reviewer':raise ValueError('missing independent peer controller')
        if nodes[peer]['timeoutClass']!='human_wait':raise ValueError('peer wait holds execution timeout')
        if gate_node('plan_accepted')!=peer:raise ValueError('author accepts own plan')
        for n in nodes.values():
            if n['stageKind'] in ('bootstrap_repository','scaffold','execute','criteria','author_regression','vertical_slice'):
                ordered(peer,n['id'])
        delivery=[n['id'] for n in nodes.values() if n['stageKind']=='deliver' and n['mandatory']]
        close=[n['id'] for n in nodes.values() if n['stageKind']=='learn_close' and n['mandatory']]
        if len(delivery)!=1 or len(close)!=1:raise ValueError('missing delivery/close')
        ordered(gate_node('review_passed'),delivery[0]);ordered(delivery[0],gate_node('delivery_complete'));ordered(gate_node('delivery_complete'),close[0])
        if nodes[gate_node('delivery_complete')]['stageKind']!='pr_review' or nodes[gate_node('delivery_complete')]['timeoutClass']!='human_wait':raise ValueError('missing durable PR completion controller')
        return_kinds={'existing_feature':{'feature_impact','plan','criteria','execute'},'bug_fix':{'diagnose','plan','author_regression','execute'},'greenfield':{'intent_interview','foundation_design','criteria','vertical_slice'}}
        targets=nodes[gate_node('delivery_complete')]['returnTargets']
        if {nodes[target]['stageKind'] for target in targets}!=return_kinds[template['id']]:raise ValueError('PR findings must return to scope/design/oracle/implementation authors')

def intent_brief_ready(brief):
    """Check fixture consistency only; human authority/review need real service evidence."""
    validate(brief,defs['IntentBrief'])
    for key in ('problem','targetUsers','desiredOutcomes','journeys','criteria','firstSliceJourneyIds','humanAnswerRefs'):
        if not brief[key]:raise ValueError('incomplete intent '+key)
    coverage={c['topic']:c for c in brief['coverage']}
    if len(coverage)!=len(brief['coverage']) or set(coverage)!=set(defs['IntentTopic']['enum']):raise ValueError('missing or duplicated topic')
    if any(c['status']=='unknown' or not c['evidenceRefs'] for c in coverage.values()):raise ValueError('unevidenced coverage')
    journeys={j['id'] for j in brief['journeys']}
    if len(journeys)!=len(brief['journeys']):raise ValueError('duplicate journey')
    criteria={c['id'] for c in brief['criteria']}
    if len(criteria)!=len(brief['criteria']):raise ValueError('duplicate criterion')
    if not set(brief['firstSliceJourneyIds'])<=journeys:raise ValueError('unknown slice journey')
    mapped=set()
    for c in brief['criteria']:
        if not set(c['journeyIds'])<=journeys:raise ValueError('criterion references unknown journey')
        mapped.update(c['journeyIds'])
    if mapped!=journeys:raise ValueError('unmapped journey')
    for issue in brief['issues']:
        if (issue['blocking'] or issue['kind']=='contradiction') and issue['status']!='resolved':raise ValueError('unresolved material issue')
        if issue['status']=='resolved' and 'resolutionRef' not in issue:raise ValueError('unproven issue resolution')
    for assumption in brief['assumptions']:
        if assumption['impact']!='low' or not assumption['reversible'] or assumption['status']!='accepted' or 'acceptanceEvidenceRef' not in assumption:raise ValueError('unaccepted/material assumption')

def review_packet_ready(packet,assignment):
    """Fixture coverage/assignment checks; live peer identity and decisions need the service."""
    validate(packet,defs['PlanReviewPacket']);validate(assignment,defs['PlanReviewAssignment'])
    sections={s['id'] for s in packet['sections']}
    if len(sections)!=len(packet['sections']) or sections!=set(defs['PlanSectionId']['enum']):raise ValueError('missing/duplicate plan section')
    if any(s['status']=='incomplete' for s in packet['sections']):raise ValueError('incomplete plan section')
    criteria={c['id'] for c in packet['criteria']};scenarios={s['id'] for s in packet['scenarios']}
    if len(criteria)!=len(packet['criteria']) or len(scenarios)!=len(packet['scenarios']):raise ValueError('duplicate criterion/scenario')
    mapped=set()
    for scenario in packet['scenarios']:
        if not set(scenario['criterionIds'])<=criteria:raise ValueError('unknown criterion')
        mapped.update(scenario['criterionIds'])
    if mapped!=criteria:raise ValueError('untested criterion')
    done=set()
    for item in packet['definitionOfDone']:
        if not set(item['criterionIds'])<=criteria:raise ValueError('undefined DoD criterion')
        done.update(item['criterionIds'])
    if done!=criteria:raise ValueError('criterion absent from DoD')
    if len({d['id'] for d in packet['definitionOfDone']})!=len(packet['definitionOfDone']):raise ValueError('duplicate DoD')
    for risk in packet['risks']:
        if not set(risk['scenarioIds'])<=scenarios:raise ValueError('unknown risk scenario')
        if risk['blocking'] or risk['severity'] in ('critical','high') and risk['state']=='open':raise ValueError('blocking plan risk')
        if risk['state']=='mitigation_planned' and not risk['scenarioIds']:raise ValueError('unverifiable mitigation')
    outline=packet.get('structureOutline')
    if not outline:raise ValueError('missing signed structure outline')
    components={c['id'] for c in outline['components']}
    if len(components)!=len(outline['components']):raise ValueError('duplicate outline component')
    outlined=set()
    for item in outline['slices']:
        if not set(item['componentIds'])<=components or not set(item['criterionIds'])<=criteria:raise ValueError('unbound outline slice')
        outlined.update(item['criterionIds'])
    if outlined!=criteria:raise ValueError('criterion absent from structure outline')
    peers=assignment['requiredPeers'];people={p['principalId'] for p in peers}
    if assignment['taskId']!=packet['taskId']:raise ValueError('assignment for another task')
    if len(people)!=len(peers) or people.intersection(packet['authorPrincipalIds']):raise ValueError('duplicate or self peer')
    primary=[p for p in peers if p['kind']=='primary']
    if len(primary)!=1 or set(primary[0]['sectionIds'])!=sections:raise ValueError('primary must cover whole packet')
    if any(not set(p['sectionIds'])<=sections for p in peers):raise ValueError('unknown assigned section')

def main():
    for p in ROOT.rglob('*.json'):read(p);checks.append('JSON parses: '+str(p.relative_to(ROOT)))
    for reference in walk(schema):check(reference.startswith('#/$defs/') and reference.split('/')[-1] in defs,'Domain ref: '+reference)
    pinned_tool_checks()
    mapping={'feature-task.json':'TaskRequest','bug-task.json':'TaskRequest','greenfield-task.json':'TaskRequest','greenfield-monorepo-task.json':'TaskRequest','greenfield-root-adoption-task.json':'TaskRequest','application-draft.json':'ApplicationDraftRequest','bootstrap-plan.json':'BootstrapPlan','bootstrap-receipt.json':'BootstrapReceipt','application.json':'ApplicationDefinition','policy.json':'PolicyProfile','stage-result.json':'StageResult','gate-evaluation.json':'GateEvaluation','environment-plan.json':'EnvironmentPlan','branch-preview-plan.json':'EnvironmentPlan','deployment-status.json':'DeploymentStatus'}
    mapping.update({'draft-preview-pr.json':'PullRequest','queued-environment.json':'EnvironmentView','queued-environments.json':'EnvironmentPage','pr-review-preview-only.json':'PRReviewState'})
    for file,name in mapping.items():validate(read(ROOT/'examples'/file),defs[name]);checks.append('Example validates: '+file)
    queued=read(ROOT/'examples/queued-environment.json')
    check(read(ROOT/'examples/queued-environments.json')['items']==[queued], 'Queued list and detail responses expose the same durable status')
    pr=read(ROOT/'examples/draft-preview-pr.json')
    validate(dict(pr,headRepository=None),defs['PullRequest'])
    checks.append('Unobservable head identity is representable; admission must fail closed')
    for file,name in [('intent-brief.json','IntentBrief'),('intent-interview.json','IntentInterviewView'),('intent-answer.json','IntentAnswerRequest'),('intent-confirmation.json','IntentConfirmationSubject')]:
        validate(read(ROOT/'examples'/file),defs[name]);checks.append('Interview example validates: '+file)
    packet=read(ROOT/'examples/plan-review-packet.json');assignment=read(ROOT/'examples/plan-review-assignment.json')
    review_packet_ready(packet,assignment);validate(read(ROOT/'examples/plan-review-subject.json'),defs['PlanReviewSubject'])
    checks.append('Complete peer-review packet, traceability and independent assignment')
    invalid_packets=[]
    bad=copy.deepcopy(packet);bad['sections'].pop();invalid_packets.append(('missing engineering section',bad,assignment))
    bad=copy.deepcopy(packet);bad['scenarios']=[s for s in bad['scenarios'] if 'C3' not in s['criterionIds']];invalid_packets.append(('criterion without scenario',bad,assignment))
    bad=copy.deepcopy(packet);bad['scenarios'][0]['status']='passed';invalid_packets.append(('planned test represented as passed',bad,assignment))
    bad=copy.deepcopy(packet);bad['definitionOfDone'][0]['evidenceKinds']=[];invalid_packets.append(('DoD without evidence',bad,assignment))
    bad=copy.deepcopy(assignment);bad['requiredPeers'][0]['principalId']=packet['authorPrincipalIds'][0];invalid_packets.append(('self-assigned primary peer',packet,bad))
    bad=copy.deepcopy(assignment);bad['requiredPeers'][0]['sectionIds'].pop();invalid_packets.append(('incomplete primary review scope',packet,bad))
    bad=copy.deepcopy(packet);bad.pop('structureOutline');invalid_packets.append(('missing structure outline',bad,assignment))
    bad=copy.deepcopy(packet);bad['structureOutline']['slices'][0]['criterionIds']=['invented'];invalid_packets.append(('unbound outline criterion',bad,assignment))
    for label,bad_packet,bad_assignment in invalid_packets:
        try:review_packet_ready(bad_packet,bad_assignment)
        except ValueError:checks.append('Rejected review fixture: '+label)
        else:raise AssertionError(label+' accepted')
    task=read(ROOT/'examples/feature-task.json')
    check(task['assurance']==read(ROOT/'examples/review-followthrough-task.json')['assurance']=='enhanced',
          'Cancellation task fixtures escalate new API, authorization and persistent migration to Enhanced')
    review_assurance(packet,task)
    check('<span>Assurance</span><strong>Enhanced</strong>' in (ROOT.parent/'plan-review.html').read_text(),
          'Review sidebar agrees with Enhanced task fixtures')
    for gate in ('oracle_accepted','adversarial_passed'):
        bad=copy.deepcopy(packet)
        for item in bad['definitionOfDone']:item['requiredGateIds']=[g for g in item['requiredGateIds'] if g!=gate]
        try:review_assurance(bad,task)
        except ValueError:checks.append('Rejected Enhanced packet without '+gate)
        else:raise AssertionError('Enhanced packet accepted without '+gate)
    invalid=[]
    bad=copy.deepcopy(task);bad['workType']='unknown';invalid.append(('unknown work type',bad,'TaskRequest'))
    bad=copy.deepcopy(task);bad['unexpected']=True;invalid.append(('unknown task field',bad,'TaskRequest'))
    bad=copy.deepcopy(task);bad['workType']='investigation';bad['deliveryScope']='production';invalid.append(('investigation deployment',bad,'TaskRequest'))
    bad=copy.deepcopy(task);bad['workType']='documentation';bad['deliveryScope']='preview';invalid.append(('docs preview',bad,'TaskRequest'))
    bad=copy.deepcopy(task);bad['budget']['maxMicroUsd']=-1;invalid.append(('negative budget',bad,'TaskRequest'))
    bad=copy.deepcopy(task);bad.pop('targetContext');invalid.append(('missing target context',bad,'TaskRequest'))
    bad=copy.deepcopy(task);bad['schemaVersion']='1.0';invalid.append(('legacy task format',bad,'TaskRequest'))
    greenfield=read(ROOT/'examples/greenfield-task.json')
    bad=copy.deepcopy(greenfield);bad['workType']='bug';invalid.append(('new-target bug',bad,'TaskRequest'))
    bad=copy.deepcopy(greenfield);bad['targetContext']['repositoryIntent']['kind']='unknown';invalid.append(('unknown repository kind',bad,'TaskRequest'))
    bad=copy.deepcopy(task);bad['targetContext']['draftRevision']=1;invalid.append(('draft fields on existing target',bad,'TaskRequest'))
    bad=read(ROOT/'examples/application-draft.json');bad['ownerIds']=[];invalid.append(('ownerless draft',bad,'ApplicationDraftRequest'))
    bad=read(ROOT/'examples/bootstrap-receipt.json');bad['baseCommit']='0'*40;invalid.append(('zero base commit',bad,'BootstrapReceipt'))
    bad=read(ROOT/'examples/bootstrap-receipt.json');bad['baseCommit']='';invalid.append(('empty base commit',bad,'BootstrapReceipt'))
    bad=read(ROOT/'examples/bootstrap-plan.json');bad['target'].pop('repositoryIntent');invalid.append(('bootstrap without repository choice',bad,'BootstrapPlan'))
    bad=read(ROOT/'examples/intent-answer.json');bad['answers']=bad['answers']*4;invalid.append(('oversized question batch',bad,'IntentAnswerRequest'))
    bad=read(ROOT/'examples/intent-answer.json');bad.pop('interviewRevision');invalid.append(('unversioned answer',bad,'IntentAnswerRequest'))
    invalid.append(('missing interview command payload',{'commandId':'00000000-0000-4000-8000-000000000001','expectedRevision':1,'kind':'answer_intent','reason':'human response'},'CommandEnvelope'))
    invalid.append(('missing command payload',{'commandId':'00000000-0000-4000-8000-000000000001','expectedRevision':1,'kind':'amend_spec','reason':'changed intent'},'CommandEnvelope'))
    invalid.append(('owner reassignment without principal',{'commandId':'00000000-0000-4000-8000-000000000001','expectedRevision':1,'kind':'reassign_owner','reason':'handoff'},'CommandEnvelope'))
    for field in ('status','statusObservedAt','generation','currentOperationId'):
        bad=copy.deepcopy(queued);bad.pop(field)
        invalid.append(('environment observation without '+field,bad,'EnvironmentView'))
    for field in ('draft','labels','baseRepository','headRepository'):
        bad=copy.deepcopy(pr);bad.pop(field)
        invalid.append(('PR observation without '+field,bad,'PullRequest'))
    for stage_id in ('00000000-0000-4000-8000-000000000002','task-2/plan-1/implement/attempt-1','task-00000000-0000-4000-8000-000000000002/plan-0/implement/attempt-1'):
        bad=read(ROOT/'examples/stage-result.json');bad['stageRunId']=stage_id
        invalid.append(('noncanonical stage identity: '+stage_id,bad,'StageResult'))
    invalid += [('not-ready success body',{'status':'not_ready','requestId':'probe'},'Health'),
                ('supersession overwrites stage outcome','superseded','StageStatus'),
                ('undefined decision action','invented_approval','DecisionAction')]
    artifact=read(ROOT/'examples/stage-result.json')['checkpointRef']
    for kind in ('take_over','hand_back'):
        command={'commandId':task['applicationIds'][0],'expectedRevision':1,'kind':kind,'reason':'Transfer ownership'}
        invalid.append((kind+' without epoch transfer',copy.deepcopy(command),'CommandEnvelope'))
        command['epochTransfer']={'workspaceId':task['applicationIds'][0],'expectedEpoch':1,'checkpointRef':artifact,'targetRef':'workspace:authorized'}
        validate(command,defs['CommandEnvelope']);checks.append('Valid epoch-transfer command: '+kind)
    metadata={'ref':artifact,'classification':'ordinary','producerId':'registry','links':[],
              'mediaType':artifact['mediaType'],'sizeBytes':artifact['sizeBytes'],
              'createdAt':'2026-10-09T12:00:00Z','retentionUntil':'2027-10-09T12:00:00Z'}
    validate(metadata,defs['ArtifactView']);checks.append('Pre-task artifact metadata needs no taskId')
    recovery={'type':'about:blank','title':'Cursor expired','status':410,'code':'event_cursor_expired',
              'detail':'Fetch the task snapshot','requestId':'stream','retryable':True,
              'snapshotUrl':'/v2/tasks/'+task['applicationIds'][0],'resumeAfterSequence':42}
    validate(recovery,defs['EventCursorExpired'])
    for field in ('snapshotUrl','resumeAfterSequence'):
        bad=copy.deepcopy(recovery);bad.pop(field);invalid.append(('cursor recovery without '+field,bad,'EventCursorExpired'))
    for name,value,kind in invalid:
        try:validate(value,defs[kind])
        except ValueError:checks.append('Rejected: '+name)
        else:raise AssertionError('Invalid example accepted: '+name)
    for file,route in [('feature-task.json','existing_feature'),('bug-task.json','bug_fix'),('greenfield-task.json','greenfield'),('greenfield-monorepo-task.json','greenfield'),('greenfield-root-adoption-task.json','greenfield')]:
        check(task_semantics(read(ROOT/'examples'/file))==route,'Journey routing: '+file)
    provisional=copy.deepcopy(greenfield);provisional['targetContext'].pop('repositoryIntent')
    check(task_semantics(provisional)=='greenfield','Greenfield interview can start before repository choice')
    brief=read(ROOT/'examples/intent-brief.json');intent_brief_ready(brief)
    checks.append('Intent fixture covers concrete journeys, criteria and all required topics')
    invalid_briefs=[]
    bad=copy.deepcopy(brief);bad['coverage'][0]['status']='unknown';invalid_briefs.append(('unknown coverage',bad))
    bad=copy.deepcopy(brief);bad['issues']=[{'id':'conflict','kind':'contradiction','statement':'Stakeholders disagree about refund execution.','blocking':False,'status':'deferred','sourceRefs':brief['humanAnswerRefs']}];invalid_briefs.append(('downgraded contradiction',bad))
    bad=copy.deepcopy(brief);bad['firstSliceJourneyIds']=['invented'];invalid_briefs.append(('undefined first slice',bad))
    bad=copy.deepcopy(brief);bad['assumptions']=[{'id':'policy-guess','statement':'Assume refunds are authorized.','impact':'high','reversible':True,'status':'accepted','ownerId':brief['intentOwnerIds'][0],'validationPlan':'Check later','acceptanceEvidenceRef':brief['humanAnswerRefs'][0]}];invalid_briefs.append(('material uncertainty bypass',bad))
    bad=copy.deepcopy(brief);bad['humanAnswerRefs']=[];invalid_briefs.append(('brief without human evidence',bad))
    for label,bad in invalid_briefs:
        try:intent_brief_ready(bad)
        except ValueError:checks.append('Rejected unready intent fixture: '+label)
        else:raise AssertionError(label+' accepted')
    for label,bad in [('missing primary target',dict(task,applicationIds=[])),('path escape',read(ROOT/'examples/greenfield-monorepo-task.json'))]:
        if label=='missing primary target':bad['applicationIds']=[greenfield['targetContext']['applicationId']]
        else:bad['targetContext']['repositoryIntent']['subpath']='../other-service'
        try:task_semantics(bad)
        except ValueError:checks.append('Rejected semantic input: '+label)
        else:raise AssertionError(label+' accepted')
    root_adoption=read(ROOT/'examples/greenfield-root-adoption-task.json')
    bad=copy.deepcopy(root_adoption);bad['targetContext']['repositoryIntent'].pop('rootAdoption')
    try:task_semantics(bad)
    except ValueError:checks.append('Rejected root adoption without provenance')
    else:raise AssertionError('bare root adoption accepted')
    for path in ('.','./','/','../service','services//new','services/./new','services/../new','services\\new'):
        bad=read(ROOT/'examples/greenfield-monorepo-task.json');bad['targetContext']['repositoryIntent']['subpath']=path
        try:task_semantics(bad)
        except ValueError:checks.append('Rejected unsafe adoption path: '+path)
        else:raise AssertionError('unsafe adoption path accepted: '+path)
    templates={}
    for p in sorted((ROOT/'examples/templates').glob('*.json')):
        t=read(p);template_semantics(t);templates[t['id']]=t;checks.append('Template shape, ordering and authority: '+t['id'])
    check(set(templates)=={'greenfield','existing_feature','bug_fix'},'All three journey templates supplied')
    mutations=[]
    bad=copy.deepcopy(templates['existing_feature']);next(n for n in bad['nodes'] if n['id']=='criteria')['dependsOn']=['plan'];mutations.append(('execution without peer sign-off',bad))
    bad=copy.deepcopy(templates['bug_fix']);next(n for n in bad['nodes'] if n['id']=='plan_review')['requiredGateIds']=['plan_accepted'];mutations.append(('mode omits peer gate',bad))
    bad=copy.deepcopy(templates['greenfield']);next(n for n in bad['nodes'] if n['id']=='design')['dependsOn']=['brief'];mutations.append(('architecture before human confirmation',bad))
    bad=copy.deepcopy(templates['greenfield']);next(n for n in bad['nodes'] if n['id']=='confirm_intent')['requiredGateIds']=['scope_accepted'];mutations.append(('missing intent gate',bad))
    bad=copy.deepcopy(templates['greenfield']);next(n for n in bad['nodes'] if n['id']=='challenge')['sessionPolicy']='resume';mutations.append(('interviewer reviews own context',bad))
    bad=copy.deepcopy(templates['bug_fix']);next(n for n in bad['nodes'] if n['id']=='lock')['dependsOn']=['oracle'];mutations.append(('bug lock before red',bad))
    bad=copy.deepcopy(templates['greenfield']);next(n for n in bad['nodes'] if n['id']=='slice_verify')['role']='implementer';mutations.append(('self-verified slice',bad))
    bad=copy.deepcopy(templates['greenfield']);next(n for n in bad['nodes'] if n['id']=='integrated')['mandatory']=False;mutations.append(('optional parent outcome',bad))
    bad=copy.deepcopy(templates['greenfield']);next(n for n in bad['nodes'] if n['id']=='scaffold')['dependsOn']=['design'];mutations.append(('scaffold before base',bad))
    bad=copy.deepcopy(templates['existing_feature']);bad['nodes'][0]['dependsOn']=['close'];mutations.append(('template cycle',bad))
    bad=copy.deepcopy(templates['existing_feature']);bad['nodes'][0]['stageKind']='agent_invented_step';mutations.append(('unknown stage kind',bad))
    bad=copy.deepcopy(templates['existing_feature']);bad['nodes'][0]['requiredGateIds']=['agent_says_success'];mutations.append(('unknown gate',bad))
    bad=copy.deepcopy(templates['existing_feature']);next(n for n in bad['nodes'] if n['id']=='implement')['dependsOn']=['plan_review'];next(n for n in bad['nodes'] if n['id']=='verify')['dependsOn']=['implement','criteria'];mutations.append(('feature implementation before oracle',bad))
    bad=copy.deepcopy(templates['greenfield']);next(n for n in bad['nodes'] if n['id']=='slice')['dependsOn']=['register'];next(n for n in bad['nodes'] if n['id']=='slice_verify')['dependsOn']=['slice','slice_criteria'];mutations.append(('slice before oracle',bad))
    bad=copy.deepcopy(templates['existing_feature']);next(n for n in bad['nodes'] if n['id']=='implement')['stageKind']='review';mutations.append(('missing feature implementation',bad))
    bad=copy.deepcopy(templates['greenfield']);next(n for n in bad['nodes'] if n['id']=='interview')['mandatory']=False;mutations.append(('optional predecessor for required node',bad))
    bad=copy.deepcopy(templates['existing_feature']);next(n for n in bad['nodes'] if n['id']=='plan')['dependsOn']=['missing'];mutations.append(('unknown dependency',bad))
    for template_id in templates:
        for target_kind in ('discovery','planner'):
            bad=copy.deepcopy(templates[template_id]);nodes={n['id']:n for n in bad['nodes']}
            nodes['pr_review']['returnTargets']=[target for target in nodes['pr_review']['returnTargets'] if nodes[target]['role']!=target_kind]
            mutations.append((template_id+' PR return without '+target_kind+' author',bad))
        bad=copy.deepcopy(templates[template_id]);next(n for n in bad['nodes'] if n['id']=='pr_review')['returnTargets'].append('design_review' if template_id=='greenfield' else 'plan_review');mutations.append((template_id+' PR return to peer controller',bad))
    for label,bad in mutations:
        try:template_semantics(bad)
        except ValueError:checks.append('Rejected template: '+label)
        else:raise AssertionError(label+' accepted')
    check(defs['ArtifactRef']['properties']['schemaVersion']=={'type':'string','minLength':1},'Artifact references retain independent format versions')
    result=read(ROOT/'examples/stage-result.json');validate(result,defs['StageOutcome'])
    controller=dict(result,producerKind='controller');controller.pop('allocationEpoch');validate(controller,defs['StageOutcome'])
    checks.append('Runner and controller outcomes have distinct authority envelopes')
    api=read(ROOT/'contracts/api.openapi.json');ids=[]
    for path,methods in api['paths'].items():
        for method,op in methods.items():
            ids.append(op['operationId'])
            actual={p['name'] for p in op['parameters'] if p['in']=='path'}
            check(actual==set(re.findall(r'\{(.*?)\}',path)),'Path parameters: '+path)
            for reference in walk(op):check(reference.split('/')[-1] in defs,'API ref: '+reference)
    check(len(ids)==len(set(ids)),'Unique OpenAPI operation IDs')
    check(api['servers']==[{'url':'/v2'}],'Breaking API revision is explicit')
    check(api['info']['version']=='2.5.0','API description includes the revised views')
    ready=api['paths']['/health/ready']['get']['responses']
    validate({'status':'ok','requestId':'probe'},defs[ready['200']['content']['application/json']['schema']['$ref'].split('/')[-1]])
    validate({'status':'not_ready','requestId':'probe'},defs[ready['503']['content']['application/json']['schema']['$ref'].split('/')[-1]])
    check('Retry-After' in ready['503']['headers'],'Unavailable readiness has retry guidance')
    events=api['paths']['/tasks/{taskId}/events']['get']
    check(any(p['name']=='after' and p['in']=='query' and p['schema']['minimum']==0 for p in events['parameters']),'SSE supports the after sequence cursor')
    check(events['responses']['410']['content']['application/problem+json']['schema']['$ref'].endswith('/EventCursorExpired') and 'Location' in events['responses']['410']['headers'],'SSE expiry exposes typed snapshot recovery')
    imported=re.search(r'import type\s*\{(.*?)\}\s*from', (ROOT/'contracts/interfaces.ts').read_text(),re.S)[1]
    check(all(n.strip() in defs for n in imported.split(',')),'Interface imports resolve to generated domain types')
    acceptance=read(ROOT/'acceptance.json')['scenarios'];backlog=read(ROOT/'backlog.json')['packages']
    aid={x['id'] for x in acceptance};work={x['id']:x for x in backlog}
    inv=defined_ids((ROOT/'01-scope-architecture.md').read_text(),'INV')
    register=(ROOT/'15-decisions-sources.md').read_text()
    adr=defined_ids(register,'ADR');integrations=defined_ids(register,'INT')
    check(len(aid)==len(acceptance),'Unique acceptance IDs');check(len(work)==len(backlog),'Unique work IDs')
    covered=set()
    for item in backlog:
        groups=item.get('dependsOnAny', [])
        check(isinstance(groups,list) and all(isinstance(g,list) and len(g)>=2 and all(isinstance(d,str) for d in g) and len(g)==len(set(g)) for g in groups),'Nonempty distinct dependency alternatives: '+item['id'])
        check(set(dependency_edges(item))<=set(work),'Backlog dependencies exist: '+item['id'])
        check(not set(item['dependsOn']).intersection(d for g in groups for d in g),'Alternatives are not also mandatory: '+item['id'])
        check(set(item['acceptance'])<=aid,'Acceptance references exist: '+item['id']);covered.update(item['acceptance'])
        check(item['estimatedEngineeringDays']['high']>=item['estimatedEngineeringDays']['low']>0,'Positive effort range: '+item['id'])
    check(covered==aid,'Every acceptance scenario has an implementation owner/package')
    for item in acceptance:check(set(item['invariants'])<=inv,'Invariant references: '+item['id'])
    check(inv=={i for item in acceptance for i in item['invariants']},'Every invariant has acceptance coverage')
    milestone_dependencies(work)
    closure_checks(register,work,integrations)
    markdown_checks(ROOT,aid|set(work)|inv|adr|integrations)
    done=set();active=set()
    def visit(i):
        if i in active:raise AssertionError('Backlog cycle: '+i)
        if i in done:return
        active.add(i)
        for dep in dependency_edges(work[i]):visit(dep)
        active.remove(i);done.add(i)
    for i in work:visit(i)
    checks.append('Backlog graph is acyclic')
    launch_dependencies=set()
    def include_launch(i):
        if i in launch_dependencies:return
        launch_dependencies.add(i)
        for dep in dependency_edges(work[i]):include_launch(dep)
    include_launch('W-062')
    check(all(p.get('launchScope','required') in ('required','optional') for p in backlog),'Known backlog launch scopes')
    missing_launch={p['id'] for p in backlog if p.get('launchScope','required')=='required'}-launch_dependencies
    check(not missing_launch,'Every required package precedes W-062 controlled launch; missing: '+', '.join(sorted(missing_launch)))
    for package in ('W-042','W-045'):
        item=work[package];base=set(item['dependsOn'])
        check(item.get('dependsOnAny')==[['W-041','W-139']], 'Preview requires a real provider alternative: '+package)
        check(not prerequisites_satisfied(item,base), 'No provider cannot satisfy preview dependencies: '+package)
        for provider in ('W-041','W-139'):
            check(prerequisites_satisfied(item,base|{provider}), 'Either qualified provider can satisfy preview dependencies: '+package+' '+provider)
        check(not prerequisites_satisfied(item,{'W-041','W-139'}), 'Provider choice does not waive ordinary prerequisites: '+package)
    types=set(defs['WorkType']['enum']);body=(ROOT/'05-workflows-gates.md').read_text().lower()
    for t in types:check(bool(re.search(r'^## '+t+r'[^\n]*path$',body,re.M)),'Workflow defined: '+t)
    check('## greenfield path' in body,'Greenfield workflow defined alongside work types')
    # DDL checks are intentionally structural. A PostgreSQL engine must execute it in M1.
    sql=(ROOT/'contracts/schema.sql').read_text();tables=re.findall(r'CREATE TABLE (\w+)',sql)
    check(len(tables)==len(set(tables))==59,'59 distinct reference tables')
    upload=re.search(r'CREATE TABLE artifact_upload \((.*?)\n\);',sql,re.S)[1]
    check('task_id uuid NOT NULL' not in upload and 'stage_run_id uuid NOT NULL' not in upload,
          'Owner-scope upload reservations require no fabricated task/stage')
    for scope,fields in [('task_stage','task_id IS NOT NULL AND stage_run_id IS NOT NULL AND application_id IS NULL AND controller_kind IS NULL'),
                         ('application_draft','task_id IS NULL AND stage_run_id IS NULL AND application_id IS NOT NULL AND controller_kind IS NULL'),
                         ('organization_controller','task_id IS NULL AND stage_run_id IS NULL AND application_id IS NULL AND controller_kind IS NOT NULL')]:
        check("reservation_scope='"+scope+"' AND "+fields in upload,'Exclusive upload scope constraint: '+scope)
    check('authority_ref jsonb NOT NULL' in upload and 'FOREIGN KEY(org_id,task_id,stage_run_id) REFERENCES stage_run(org_id,task_id,id)' in sql,
          'Upload authorization is durable and stage/task ownership is tenant-qualified')
    check('CREATE POLICY artifact_upload_task_visibility' in sql and 'CREATE POLICY artifact_upload_embargo' in sql,
          'Optional task binding retains upload task/embargo visibility')
    finding=re.search(r'CREATE TABLE finding \((.*?)\n\);',sql,re.S)[1]
    check("consequence text CHECK(length(consequence)>0)" in finding and "confidence text CHECK(confidence IN ('low','medium','high'))" in finding,
          'Finding optional metadata has durable typed columns')
    dispute=re.search(r'CREATE TABLE knowledge_dispute \((.*?)\n\);',sql,re.S)[1]
    for column in ('record_id','disputing_record_id'):
        check('FOREIGN KEY(org_id,'+column+') REFERENCES knowledge_record(org_id,id)' in dispute,
              'Durable tenant-qualified knowledge dispute endpoint: '+column)
    check('CREATE POLICY knowledge_dispute_visibility' in sql and not re.search(r'GRANT UPDATE[^;]*ON knowledge_dispute\b',sql),
          'Knowledge dispute links retain both-record visibility and append-only history')
    interfaces=(ROOT/'contracts/interfaces.ts').read_text()
    check('reserveOwned(ctx: AuthContext' in interfaces and "kind: 'application_draft'" in interfaces and "kind: 'organization_controller'" in interfaces,
          'ArtifactStore exposes explicitly authorized owner scopes')
    check('export type { FailureSignature };' in interfaces and not re.search(r'export type FailureSignature\s*=',interfaces),
          'IncidentMemory re-exports the generated canonical FailureSignature')
    action_values=re.search(r'action text NOT NULL CHECK\(action IN \(([^)]+)\)\)',sql)[1]
    check(set(re.findall(r"'([^']+)'",action_values))==set(defs['DecisionAction']['enum']),'SQL and API decision actions agree')
    check('UNIQUE NULLS NOT DISTINCT (org_id, sha256, media_type, schema_version, classification, data_classification, embargo_group_id)' in sql and 'UNIQUE (org_id, storage_key, storage_version)' not in sql,'Artifact registration metadata is distinct from shared object identity')
    check('CREATE TRIGGER stage_run_guard' in sql and 'terminal stage outcome is immutable' in sql,'Terminal stage outcomes retain append-only supersession metadata')
    check('CREATE UNIQUE INDEX one_active_application_bootstrap' in sql,'Active bootstrap claim is unique')
    check("action NOT IN ('confirm_intent','approve_plan','approve_rule_exception') OR required_principal_id IS NOT NULL" in sql,'SQL requires each human decision principal')
    check(not re.search(r'GRANT UPDATE ON|GRANT SELECT, INSERT ON ALL TABLES',sql),'Runtime grants are per-table and column-limited')
    check(not re.search(r'GRANT[^;]*(?:INSERT|UPDATE)[^;]*ON organization\b',sql),'Runtime cannot provision organizations')
    environment_grants=re.search(r'GRANT UPDATE \(([^)]+)\) ON environment TO factory_runtime;',sql)[1]
    check({'plan_ref','generation','current_operation_id','deployment_status','status_observed_at'}<=set(environment_grants.split(', ')),
          'Environment current-plan and public-status projection columns are writable by runtime')
    check('CREATE TRIGGER environment_generation_guard' in sql and 'new environment plan requires a fresh generation and cleared evidence' in sql,
          'Environment plan advancement has a storage guard')
    for table in tables:
        if table!='organization':check('CREATE POLICY '+table+'_org_scope' in sql,'Tenant policy: '+table)
    for table in re.findall(r'REFERENCES\s+(\w+)',sql):check(table in tables,'SQL referenced table: '+table)
    from operational_validation import validate_operational
    validate_operational(ROOT,defs,validate,check,read)
    from rules_validation import validate_rules
    validate_rules(ROOT,defs,validate,check,read)
    from review_mode_validation import validate_review_mode
    validate_review_mode(ROOT,defs,validate,check,read,template_semantics)
    from design_delivery_validation import validate_design_delivery
    validate_design_delivery(ROOT,defs,validate,check,read,template_semantics)
    for file,route in [('design-task.json','feature_design'),('refactor-design-task.json','refactor_design'),('greenfield-design-task.json','greenfield_design'),('build-task.json','existing_feature')]:
        check(task_semantics(read(ROOT/'examples/design'/file))==route,'Design scope routing: '+file)
    revision,date=revision_metadata(ROOT)
    reader_text=(ROOT.parent/'implementation-plan.html').read_text()
    sidebar=re.search(r'<div class="sub">Implementation specification · v([^<]+)<br>([^<]+)</div>',reader_text)
    check(bool(sidebar) and sidebar.groups()==(revision,date),'Reader sidebar revision/date match README and CHANGELOG')
    class Parser(HTMLParser):
        def __init__(self):super().__init__();self.stack=[];self.ids=[];self.hrefs=[]
        def handle_starttag(self,tag,attrs):
            a=dict(attrs)
            if 'id' in a:self.ids.append(a['id'])
            if 'href' in a:self.hrefs.append(a['href'])
            if tag not in {'meta','link','br','hr','img','input','source','wbr','area','base','col','embed','param','track'}:self.stack.append(tag)
        def handle_endtag(self,tag):
            if not self.stack or self.stack[-1]!=tag:raise AssertionError('Unbalanced HTML: '+tag)
            self.stack.pop()
    for filename in ('implementation-plan.html','plan-review.html'):
        reader=ROOT.parent/filename;p=Parser();p.feed(reader.read_text())
        check(not p.stack,'HTML tags balanced: '+filename);check(len(p.ids)==len(set(p.ids)),'HTML IDs unique: '+filename)
        for href in p.hrefs:
            if href.startswith('#'):check(href[1:] in p.ids,'HTML fragment: '+filename+' '+href)
            elif not href.startswith(('https://','http://')):check((reader.parent/href.split('#')[0]).exists(),'HTML local link: '+filename+' '+href)
    for py in (ROOT/'tools').glob('*.py'):compile(py.read_text(),str(py),'exec');checks.append('Python syntax: '+py.name)
    report={'staticChecksPassed':True,'productValidationExecuted':False,'checks':len(checks),'schemaDefinitions':len(defs),'apiOperations':len(ids),'workPackages':len(backlog),'acceptanceScenarios':len(acceptance),'referenceTables':len(tables),'scope':'Static specification/package checks and example validation using the keyword subset present in this package.','notExecuted':['PostgreSQL migrations/privilege tests','TypeScript compiler','Browser rendering','Temporal/Kubernetes/provider integration tests']}
    (ROOT/'validation-report.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))

if __name__=='__main__':main()
