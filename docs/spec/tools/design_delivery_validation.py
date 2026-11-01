"""Static design-delivery/1.0 predicates imported by validate_spec.py.

They check fixture consistency: template shape, honest outcomes, delivery targets
and binding currency. They do not qualify rendering, Git delivery or review quality.
"""
import copy
import json
from datetime import datetime

from design_delivery_contracts import (DESIGN_TEMPLATES, DESIGN_PROFILE, HUMAN_VERSION, AI_VERSION, DESIGN_GATES,
    PLAN_GATES, ALLOWED_STAGE_KINDS, ALLOWED_GATES, OUTCOME_GATES, DRIFT_SECTIONS, NOT_IMPLEMENTED, intent_digest)

from pathlib import Path
from review_mode_validation import in_force, panel_ready, human_provenance_ready, output_ready

EVIDENCE_ROOT = Path(__file__).resolve().parents[1]/'examples'/'design'
FORBIDDEN_CAPABILITY_WORDS = ('workspace_write', 'environment', 'merge', 'deploy', 'publish_code')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def instant(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def design_template_checks(template, nodes, gate_node, ordered):
    """Called from validate_spec.template_semantics after DAG/cycle checks."""
    require(template.get('deliveryScope') == 'design' and template.get('designProfile') == DESIGN_PROFILE,
            'design template must declare design scope and profile')
    ai = template.get('reviewQualificationProfile') == 'ai-review/1.0'
    require(template['version'] == (AI_VERSION if ai else HUMAN_VERSION), 'design template authority profile/version mismatch')
    for node in nodes.values():
        require(node['mandatory'], 'design template nodes are mandatory')
        require(node['stageKind'] in ALLOWED_STAGE_KINDS, 'design template contains implementation/verification stage '+node['stageKind'])
        require(set(node['requiredGateIds']) <= set(ALLOWED_GATES), 'design template claims non-design gate')
        require(not any(word in cap for cap in node['requiredCapabilities'] for word in FORBIDDEN_CAPABILITY_WORDS),
                'design template requests code/environment write capability')
    review = gate_node('plan_peer_approved')
    require(nodes[review]['stageKind'] == 'plan_peer_review' and nodes[review]['role'] == 'reviewer'
            and nodes[review]['timeoutClass'] == 'human_wait', 'missing independent design peer controller')
    for gate in PLAN_GATES:
        require(gate_node(gate) == review, 'plan gates must be evaluated by the peer review controller')
    if template['targetKind'] == 'new_application':
        intent = gate_node('intent_aligned')
        require(nodes[intent]['stageKind'] == 'intent_confirmation', 'missing explicit greenfield intent confirmation')
        ordered(intent, review)
        require(gate_node('scope_accepted') == intent, 'greenfield seed is prematurely accepted')
    else:
        ordered(gate_node('scope_accepted'), review)
    render = [n['id'] for n in nodes.values() if n['stageKind'] == 'render_design']
    deliver = [n['id'] for n in nodes.values() if n['stageKind'] == 'deliver']
    require(len(render) == 1 and len(deliver) == 1, 'design template needs one render and one delivery')
    ordered(review, render[0]); ordered(render[0], deliver[0])
    complete = gate_node('delivery_complete')
    require(nodes[complete]['stageKind'] == 'pr_review', 'design delivery completion uses the delivery controller')
    ordered(deliver[0], complete); ordered(complete, gate_node('outcome_recorded'))


def classification_ok(order, record_class, target_class):
    require(record_class in order and target_class in order, 'unknown classification fails closed')
    return order.index(record_class) <= order.index(target_class)


def review_evidence(bundle):
    """Trusted ai-review/human approval evidence; overrides model control-plane state changes."""
    evidence = copy.deepcopy(bundle['reviewEvidence']) if 'reviewEvidence' in bundle else \
        json.loads((EVIDENCE_ROOT/bundle['reviewEvidenceFile']).read_text())
    for gate in evidence['ai']:
        gate.update(copy.deepcopy(bundle.get('reviewEvidenceOverrides', {})))
    for human in evidence['human'].values():
        human['reviewBundles'] = evidence['ai']
    return evidence


def trusted_eligibility(evaluation, view, spec, change_class):
    """D5 exclusions come from the control-plane task snapshot, never the record's own flags."""
    security = view.get('security') or spec.get('security') or {}
    evaluation.update(embargoed=bool(security.get('embargoed')), workType=spec['workType'], changeClass=change_class,
        urgentHotfix=(view.get('priorityClass', spec.get('priorityClass')) == 'incident' or 'incidentRef' in spec
                      or 'incidentRef' in view or bool(security)))
    evaluation['assignment']['assurance'] = spec['assurance']
    return evaluation


def ai_gate_evidence(record, approval, evidence):
    matches = [b for b in evidence['ai'] if b['approvalSetRef'] == approval['aiReviewApprovalSetRef']]
    require(len(matches) == 1, 'unknown AI approval set for design gate')
    gate = matches[0]
    require(gate['assignment']['gateId'] == approval['gateId'] and gate['approvalSet']['gateId'] == approval['gateId'],
            'AI approval set belongs to another gate')
    require(gate['decisionRef'] == record['reviewModeDecisionRef'], 'design decision reference differs from panel authority')
    require(gate['decision']['scope']['applicationId'] == record['applicationId'], 'application not opted in under the decision')
    require(gate['subject']['taskId'] == record['taskId'] and gate['subject']['contentRef'] == record['packetRef'],
            'panel subject is not this design packet')
    if approval['gateId'] in PLAN_GATES:
        require(gate['subjectRef'] == record['planReviewSubjectRef'], 'panel subject is not the plan review subject')
    return gate


def delivery_ready(bundle, defs, validate):
    record = bundle['record']; validate(record, defs['DesignDeliveryRecord'])
    view = bundle['taskView']; validate(view, defs['TaskView']); spec = view['spec']
    require(view['id'] == record['taskId'] and spec['deliveryScope'] == 'design' and spec['workType'] == record['workType']
            and spec['targetContext']['kind'] == record['targetKind'] and spec['targetContext']['applicationId'] == record['applicationId'],
            'delivery record differs from the trusted design task snapshot')
    security = view.get('security') or spec.get('security')
    if record.get('reviewMode') == 'ai_only':
        require(not security and view.get('priorityClass') != 'incident' and 'incidentRef' not in spec,
                'ai_only excluded for security, embargoed, incident or hotfix design task')
    require(record['securityFlagged'] == (security is not None) and record['embargoed'] == bool(security and security['embargoed'])
            and record.get('securityGroupId') == ((security or {}).get('securityGroupId') if record['embargoed'] else None),
            'record security/embargo flags differ from the trusted task snapshot')
    evidence = review_evidence(bundle)
    gates = [a['gateId'] for a in record['approvals']]
    required = set(PLAN_GATES) | ({'intent_aligned'} if record['targetKind'] == 'new_application' else set())
    require(len(gates) == len(set(gates)) and set(gates) == required, 'design approvals must be exactly the applicable gates')
    mode = record.get('reviewMode', 'human')
    for approval in record['approvals']:
        require(approval['authority'] == ('ai_panel' if mode == 'ai_only' else 'human'), 'approval authority does not match ReviewMode')
        require(instant(approval['approvedAt']) <= instant(record['approvedAt']), 'approval after recorded design approval')
        if mode == 'ai_only':
            require(approval['aiReviewApprovalSetRef'] in record['aiReviewApprovalSetRefs'], 'unlisted AI approval set')
    require(instant(record['approvedAt']) <= instant(record['deliveredAt']) < instant(record['approvalsExpireAt']),
            'design approval chronology/expiry invalid')
    if mode == 'ai_only':
        require(record['aiReviewApprovalSetRefs'] == [a['aiReviewApprovalSetRef'] for a in record['approvals']],
                'record AI approval sets differ from its gate approvals')
        for approval in record['approvals']:
            gate = ai_gate_evidence(record, approval, evidence)
            # Authority, panel, qualification and chronology at approval and again at delivery.
            for when in (approval['approvedAt'], record['deliveredAt']):
                evaluation = trusted_eligibility(copy.deepcopy(gate), view, spec, view['changeClass'])
                evaluation['now'] = when; evaluation['taskView'] = view
                panel_ready(evaluation, defs, validate)
    else:
        # INV-29: every human approval field resolves to authenticated human records, never AI sets.
        for approval in record['approvals']:
            human = evidence['human']['intent' if approval['gateId'] == 'intent_aligned' else 'plan']
            if approval['gateId'] in PLAN_GATES:
                require(human['subjectRef'] == record['planReviewSubjectRef'], 'human approvals name another subject')
            require(human_provenance_ready(human, defs, validate, approval, 'DesignGateApproval'), 'unresolved human approval')
    evaluations = {json.dumps(e['ref'], sort_keys=True): e['gateId'] for e in bundle['gateEvaluations']}
    for approval in record['approvals']:
        require(evaluations.get(json.dumps(approval['gateEvaluationRef'], sort_keys=True)) == approval['gateId'],
                'approval does not cite its own gate evaluation')
    rendering = record['rendering']; packet = bundle['packet']
    require(rendering['sourcePacketRef'] == record['packetRef'], 'rendered artifact is not the approved packet')
    require(set(packet['sectionIds']) | set(packet['criterionIds']) | set(packet['scenarioIds']) <= set(rendering['anchorIds']),
            'rendered packet lacks stable section/criterion/scenario anchors')
    require(packet['plannedBuildDeliveryScope'] == record['basis']['plannedBuildDeliveryScope'], 'basis build scope differs from packet')
    location = (bundle['application'] or {}).get('designDocsLocation')
    target = record['target']
    if target['kind'] == 'design_pr' and target['publicationMode'] == 'ordinary':
        require(location is not None and all(target[k] == location[k] for k in ('repositoryId', 'subpath', 'baseBranch')),
                'design PR must target the configured design-docs location')
    elif target['kind'] == 'design_pr':
        # D4: the task's own resolved confidential PublicationTarget for its security group.
        publication = bundle.get('publicationTarget'); validate(publication, defs['PublicationTarget'])
        require(record['embargoed'] and publication['taskId'] == record['taskId'] and publication['mode'] == target['publicationMode']
                and publication['publicationRepositoryId'] == target['repositoryId'] and publication['baseBranch'] == target['baseBranch']
                and publication.get('securityGroupId') == target['securityGroupId'] == record['securityGroupId'],
                'confidential design PR must use the task\'s security-group PublicationTarget')
        require(location is None or target['repositoryId'] != location['repositoryId'],
                'embargoed design PR cannot use the ordinary design-docs repository')
    elif target['reason'] == 'no_design_docs_location':
        require(location is None, 'report fallback used although a design-docs location is configured')
    require(classification_ok(bundle['classificationOrder'], record['dataClassification'], bundle['targetDataClassification']),
            'rendered packet classification exceeds delivery target (INV-28)')
    return record


def outcome_ready(bundle, defs, validate):
    record = delivery_ready(bundle, defs, validate)
    outcome = bundle['outcome']; validate(outcome, defs['OutcomeManifest'])
    require(outcome['outcomeKind'] == 'design_approved' and outcome['designDeliveryRef'] == bundle['deliveryRef'],
            'design outcome must record design_approved for this delivery')
    evidence = review_evidence(bundle)
    if outcome.get('reviewMode') == 'ai_only':
        require(outcome['reviewSubjectRef'] == record['planReviewSubjectRef'], 'AI design outcome must name the reviewed packet subject')
        require(outcome['reviewModeDecisionRef'] == record.get('reviewModeDecisionRef'), 'outcome decision differs from delivery record')
        final = next(a for a in record['approvals'] if a['gateId'] == 'plan_accepted')
        require(outcome['aiReviewApprovalSetRefs'] == [final['aiReviewApprovalSetRef']], 'outcome approval set differs from delivery record')
        gate = ai_gate_evidence(record, final, evidence)
        trusted = trusted_eligibility(copy.deepcopy(gate), bundle['taskView'], bundle['taskView']['spec'], bundle['taskView']['changeClass'])
        trusted['taskView'] = bundle['taskView']
        output_ready(outcome, 'OutcomeManifest', trusted, defs, validate)
    elif record.get('reviewMode') == 'human':
        human = copy.deepcopy(evidence['human']['plan']); human['taskView'] = bundle['taskView']
        output_ready(outcome, 'OutcomeManifest', human, defs, validate)
    evaluations = {json.dumps(e['ref'], sort_keys=True): e['gateId'] for e in bundle['gateEvaluations']}
    cited = [evaluations.get(json.dumps(ref, sort_keys=True)) for ref in outcome['gateEvaluationRefs']]
    require(all(gate in OUTCOME_GATES for gate in cited), 'design outcome cites implementation/verification evidence')
    require({a['gateId'] for a in record['approvals']} <= set(cited), 'design outcome omits an approval gate')
    require(NOT_IMPLEMENTED in outcome['limitations'], 'design outcome must state it is not implemented or verified')
    require(outcome.get('reviewMode', 'human') == record.get('reviewMode', 'human'), 'outcome ReviewMode differs from delivery')
    expected = [record['target']['providerHandle']] if record['target']['kind'] == 'design_pr' else []
    require(outcome['providerHandles'] == expected, 'outcome handles do not match the design delivery target')


def expected_drift(bundle):
    record = bundle['delivery']; binding = bundle['binding']; old = record['basis']; new = binding['currentBasis']
    pins = lambda b: sorted(json.dumps(p, sort_keys=True) for p in b['sourcePins'])
    drift = set()
    if pins(old) != pins(new): drift.add('source_pins')
    if old['applicationSnapshotRef'] != new['applicationSnapshotRef']: drift.add('application_snapshot')
    if old['resolvedRulesRef'] != new['resolvedRulesRef']: drift.add('rules')
    if old['policyRef'] != new['policyRef']: drift.add('policy')
    if (old['intentRef'], old['taskSpecVersion'], old['acceptedIntentDigest']) != (new['intentRef'], new['taskSpecVersion'], new['acceptedIntentDigest']):
        drift.add('intent')
    if old['assurance'] != new['assurance']: drift.add('assurance')
    if old['plannedBuildDeliveryScope'] != bundle['buildTask']['deliveryScope'] or new['plannedBuildDeliveryScope'] != bundle['buildTask']['deliveryScope']:
        drift.add('build_scope')
    if instant(binding['evaluatedAt']) >= instant(record['approvalsExpireAt']): drift.add('approvals_expired')
    if record.get('reviewMode') == 'ai_only' and not ai_reuse_current(bundle):
        drift.add('review_mode')
    return drift


def ai_reuse_current(bundle):
    """Reuse of AI approvals needs the decision in force at evaluatedAt FOR THE BUILD task."""
    record = bundle['delivery']; task = bundle['buildTask']; evidence = review_evidence(bundle)
    try:
        for approval in record['approvals']:
            gate = ai_gate_evidence(record, approval, evidence)
            evaluation = trusted_eligibility(copy.deepcopy(gate), {}, task, bundle['buildChangeClass'])
            evaluation['now'] = bundle['binding']['evaluatedAt']
            decision = in_force(evaluation)
            require(task['targetContext']['applicationId'] == decision['scope']['applicationId']
                    and set(task['applicationIds']) == {decision['scope']['applicationId']}, 'build outside decision scope')
    except ValueError:
        return False
    return True


def binding_ready(bundle, defs, validate):
    record = bundle['delivery']; binding = bundle['binding']; task = bundle['buildTask']
    validate(record, defs['DesignDeliveryRecord']); validate(binding, defs['DesignBuildBinding']); validate(task, defs['TaskRequest'])
    require(task['designSource'] == {'designTaskId': record['taskId'], 'designDeliveryRef': bundle['deliveryRef']}, 'build task names another design')
    require(binding['designTaskId'] == record['taskId'] and binding['designDeliveryRef'] == bundle['deliveryRef'] and binding['taskId'] != record['taskId'],
            'binding names another design or binds the design task to itself')
    # INV-22: approvals belong to one immutable subject; they never move to a different packet.
    require(binding['packetRef'] == record['packetRef'] and binding['subjectHash'] == record['subjectHash'],
            'approvals cannot transfer to a changed packet/subject')
    require(task['workType'] == record['workType'] and task['targetContext']['kind'] == record['targetKind']
            and task['targetContext']['applicationId'] == record['applicationId'], 'build task differs from design intent/target')
    # The current basis is derived from the build's own accepted spec and tier, never asserted by the binding.
    require(binding['currentBasis']['acceptedIntentDigest'] == intent_digest(task) and binding['currentBasis']['assurance'] == task['assurance'],
            'current basis is not derived from the build task\'s accepted intent/criteria and tier')
    # D4: a build inherits the design's embargo; only the same security group may bind.
    if record['embargoed']:
        security = task.get('security') or {}
        require(security.get('embargoed') is True and security.get('securityGroupId') == record['securityGroupId'],
                'embargoed design can be bound only by a task in the same security group')
    else:
        require('security' not in task, 'build security metadata may only inherit an embargoed design')
    drift = expected_drift(bundle)
    require(set(binding['drift']) == drift, 'binding drift does not match current pins/approvals: expected '+','.join(sorted(drift) or ['none']))
    if binding['result'] == 'reuse':
        require(not drift, 'stale or changed design reused without re-review')
        return 'reuse'
    sections = {s for kind in drift for s in DRIFT_SECTIONS[kind]}
    require(set(binding['reopenedSectionIds']) == sections, 'replan must reopen exactly the affected sections')
    gates = set(PLAN_GATES) if sections or drift & {'rules', 'policy'} else set()
    if 'intent' in drift and record['targetKind'] == 'new_application': gates.add('intent_aligned')
    if drift & {'approvals_expired', 'review_mode'}: gates |= {a['gateId'] for a in record['approvals']}
    require(set(binding['rerequestedGateIds']) == gates, 'replan must re-request exactly the affected approvals')
    return 'replan'


def validate_design_delivery(ROOT, defs, validate, check, read, template_semantics):
    folder = ROOT/'examples/design'
    for path in sorted((folder/'templates').glob('*.json')) + sorted((folder/'templates/ai_only').glob('*.json')):
        template = read(path); template_semantics(template)
        check(template['id'] in DESIGN_TEMPLATES, 'Design template shape, gates and no implementation: '+str(path.relative_to(folder)))
    for name in DESIGN_TEMPLATES:
        human = read(folder/'templates'/(name+'.json')); ai = read(folder/'templates/ai_only'/(name+'.json'))
        check(ai['nodes'] == human['nodes'] and ai['version'] == AI_VERSION and human['version'] == HUMAN_VERSION,
              'AI design template changes authority pin without removing gates: '+name)
        for variant in ('missing-profile', 'old-version'):
            bad = copy.deepcopy(ai)
            if variant == 'missing-profile': bad.pop('reviewQualificationProfile')
            else: bad['version'] = HUMAN_VERSION
            try: template_semantics(bad)
            except ValueError: check(True, 'Rejected AI design template '+variant+': '+name)
            else: raise AssertionError('AI design template lost its authority pin: '+name)
    for name in ('design-task.json', 'refactor-design-task.json', 'greenfield-design-task.json', 'build-task.json',
                 'embargoed-design-task.json', 'security-flagged-design-task.json', 'embargoed-build-task.json'):
        validate(read(folder/name), defs['TaskRequest']); check(True, 'Design task request validates: '+name)
    validate(read(folder/'application-with-design-location.json'), defs['ApplicationDefinition'])
    validate(read(folder/'policy-design.json'), defs['PolicyProfile'])
    check(True, 'Design docs location and design budget class validate')
    for name in ('delivery-pr.json', 'delivery-report.json', 'delivery-ai-only.json', 'delivery-embargoed.json',
                 'delivery-security-flagged.json', 'delivery-greenfield.json'):
        delivery_ready(read(folder/name), defs, validate); check(True, 'Design delivery accepted: '+name)
    for name in ('outcome-design-approved.json', 'outcome-design-approved-ai-only.json'):
        outcome_ready(read(folder/name), defs, validate); check(True, 'Honest design_approved outcome: '+name)
    for name, result in (('binding-reuse.json', 'reuse'), ('binding-replan.json', 'replan'), ('binding-expired-reapproval.json', 'replan'),
                         ('binding-greenfield-intent-replan.json', 'replan'), ('binding-assurance-replan.json', 'replan'),
                         ('binding-embargoed-same-group.json', 'reuse'), ('binding-ai-reuse.json', 'reuse'),
                         ('binding-ai-revoked-replan.json', 'replan')):
        check(binding_ready(read(folder/name), defs, validate) == result, 'Design build binding '+result+': '+name)
    evaluators = {'outcome': outcome_ready, 'delivery': delivery_ready, 'binding': binding_ready,
                  'template': lambda value, d, v: template_semantics(value)}
    negatives = sorted(folder.glob('negative-*.json'))
    for path in negatives:
        case = read(path); kind = case['kind']; value = case['value']
        check(bool(case['expect']), 'Design negative declares its expected rejection: '+path.stem)
        try:
            if kind in evaluators: evaluators[kind](value, defs, validate)
            else: validate(value, defs[kind])
        except ValueError as error:
            # The intended rule must fire; a shape failure cannot mask it.
            check(case['expect'] in str(error), 'Rejected design fixture for its rule: '+path.stem+' ('+str(error)+')')
        else: raise AssertionError('Invalid design fixture accepted: '+path.stem)
    for required in ('outcome-claims-verified-fix', 'outcome-claims-delivered', 'outcome-claims-outcome-verified',
                     'template-implementation-stage', 'binding-stale-source-reuse', 'binding-changed-packet-transfer',
                     'template-missing-architecture-gate', 'delivery-missing-gate', 'binding-embargoed-other-group',
                     'binding-embargoed-no-group', 'binding-self-asserted-basis', 'binding-changed-criteria-reuse',
                     'binding-changed-tier-reuse', 'delivery-embargoed-ordinary-docs-repo', 'delivery-security-flagged-ai-only',
                     'delivery-greenfield-pr', 'delivery-missing-review-mode', 'task-security-on-feature-pr',
                     'delivery-ai-only-revoked', 'delivery-ai-only-expired-decision', 'delivery-ai-only-emergency-stop',
                     'delivery-ai-only-not-opted-in-application', 'delivery-ai-only-unknown-approval-set',
                     'delivery-ai-only-stale-qualification', 'delivery-ai-only-unflagged-embargoed-task',
                     'outcome-ai-decision-differs', 'outcome-ai-approval-set-differs', 'delivery-ai-set-as-human-approval',
                     'outcome-ai-ref-in-human-decisionRefs', 'binding-ai-design-revoked-reuse', 'binding-ai-design-expired-reuse',
                     'binding-ai-design-stop-reuse', 'binding-ai-design-cohort-change-reuse', 'binding-ai-design-hotfix-reuse'):
        check((folder/('negative-'+required+'.json')).exists(), 'Required design negative present: '+required)
    check('design' in defs['DeliveryScope']['enum'] and 'design' not in defs['WorkType']['enum'],
          'Design is a delivery scope, not a ninth work type')
    sql = (ROOT/'contracts/schema.sql').read_text()
    for table in ('design_delivery', 'design_build_binding'):
        check('CREATE POLICY '+table+'_org_scope' in sql and 'ALTER TABLE '+table+' FORCE ROW LEVEL SECURITY' in sql
              and 'CREATE POLICY '+table+'_task_visibility' in sql, 'Design storage has forced tenant/task RLS: '+table)
        check('GRANT SELECT, INSERT ON '+table+' TO factory_runtime;' in sql and not any(
              line.startswith('GRANT UPDATE') and ' ON '+table+' TO' in line for line in sql.splitlines()), 'Design storage is append-only: '+table)
    check('CREATE TRIGGER task_delivery_scope_guard' in sql and 'design delivery scope requires a new task' in sql,
          'Design scope cannot be toggled on an existing task')
    check("CHECK(delivery_scope <> 'design' OR work_type IN ('feature','refactor','performance','platform'))" in sql,
          'SQL restricts design scope to eligible work types')
    check('REFERENCES task(org_id,id,delivery_scope)' in sql, 'Design delivery rows belong to design-scope tasks')
    check('CREATE TRIGGER design_build_binding_guard' in sql and 'builder.primary_application_id <> dd.application_id' in sql
          and 'NEW.evaluated_at >= dd.approvals_expire_at' in sql and 'builder.design_source_task_id IS DISTINCT FROM NEW.design_task_id' in sql,
          'Build binding guard checks builder scope, application, target, source, embargo and approval expiry')
    check("AI design approvals are not reusable: decision not in force for this build" in sql
          and 't.decision_id = dd.review_mode_decision_id AND t.effective_at <= NEW.evaluated_at' in sql,
          'SQL rejects AI design reuse outside an in-force decision for the builder')
    check('CREATE TRIGGER task_design_source_guard' in sql and 'design_source_task_id IS NOT NULL AND delivery_scope <> \'design\'' in sql,
          'Build tasks inherit an embargoed design source only through a verified design source')
    check("CHECK((budget_class='design') = (task_delivery_scope='design'))" in sql
          and 'REFERENCES budget_account(org_id,id,budget_class)' in sql, 'Design budget class is tied to task scope and parent class')
    journeys = (ROOT/'17-project-journeys.md').read_text()
    for name in DESIGN_TEMPLATES:
        check(f'{name}: human {HUMAN_VERSION}; ai_only {AI_VERSION} (ai-review/1.0)' in journeys, 'Journey table pins design template: '+name)
    api = read(ROOT/'contracts/api.openapi.json')
    for path in ('/tasks/{taskId}/design-delivery', '/applications/{applicationId}/designs'):
        check(path in api['paths'], 'Design API route: '+path)
    check(any(p['name'] == 'deliveryScope' for p in api['paths']['/tasks']['get']['parameters']), 'Task list filters design scope')
