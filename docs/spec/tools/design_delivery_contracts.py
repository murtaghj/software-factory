"""Revision 1.13 design-delivery/1.0 contracts and synthetic fixtures.

Design is a DeliveryScope value, not a ninth WorkType: the approved engineering
packet is the delivered artifact and no implementation stage exists. These
fixtures model wire shapes and static predicates only; rendering, Git delivery,
binding currency and reviewer behavior are not yet proven at runtime.
"""
import copy
import json

DESIGN_PROFILE = 'design-delivery/1.0'
DESIGN_WORK_TYPES = ('feature', 'refactor', 'performance', 'platform')
BUILD_SCOPES = ('patch', 'pr', 'preview', 'production')
DESIGN_GATES = ('intent_aligned', 'architecture_accepted', 'plan_peer_approved', 'plan_accepted')
PLAN_GATES = ('architecture_accepted', 'plan_peer_approved', 'plan_accepted')
# Template ID → (workType, targetKind). Each pair is pinned like the journey templates.
DESIGN_TEMPLATES = {
    'greenfield_design': ('feature', 'new_application'),
    'feature_design': ('feature', 'existing_application'),
    'refactor_design': ('refactor', 'existing_application'),
    'performance_design': ('performance', 'existing_application'),
    'platform_design': ('platform', 'existing_application'),
}
HUMAN_VERSION, AI_VERSION = '1.0.0', '2.0.0'
ALLOWED_STAGE_KINDS = ('product_brief', 'intent_interview', 'intent_challenge', 'intent_confirmation', 'discover',
                       'feature_impact', 'plan', 'foundation_design', 'plan_peer_review', 'render_design',
                       'deliver', 'pr_review', 'learn_close')
ALLOWED_GATES = ('scope_accepted', 'intent_aligned', 'architecture_accepted', 'plan_accepted',
                 'plan_peer_approved', 'delivery_complete', 'outcome_recorded')
# Gates a design outcome may cite. Anything else would claim implementation or verification.
OUTCOME_GATES = ALLOWED_GATES
DRIFT_KINDS = ('source_pins', 'application_snapshot', 'rules', 'policy', 'intent', 'assurance', 'build_scope',
               'approvals_expired', 'review_mode')
# Drift → plan sections that MUST reopen through the chapter 19 replan path.
DRIFT_SECTIONS = {
    'source_pins': ('current_state', 'design', 'interfaces_data', 'implementation', 'acceptance_tests', 'risks_decisions'),
    'application_snapshot': ('current_state', 'design', 'interfaces_data', 'risks_decisions'),
    'rules': ('implementation', 'acceptance_tests', 'quality_security', 'review_ownership'),
    'policy': ('quality_security', 'delivery_recovery', 'review_ownership'),
    'intent': ('intent_scope', 'design', 'acceptance_tests', 'definition_of_done'),
    'assurance': ('acceptance_tests', 'quality_security', 'review_ownership'),
    'build_scope': ('delivery_recovery', 'definition_of_done'),
    'approvals_expired': (),
    'review_mode': (),
}
NOT_IMPLEMENTED = 'Design only: not implemented, executed or verified; planned scenarios remain planned.'
def intent_digest(task):
    """Digest of a TaskSpec's accepted intent and criteria; RFC 8785 is approximated by sorted compact JSON."""
    import hashlib
    body = {'intent': task['intent'], 'acceptanceCriteria': sorted(task['acceptanceCriteria'])}
    return hashlib.sha256(json.dumps(body, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


NEGATIVE_REASONS = {  # every negative names the rule it must trip; shape failures cannot mask it
    'binding-ai-design-cohort-change-reuse': 'binding drift does not match current pins/approvals: expected review_mode',
    'binding-ai-design-expired-reuse': 'binding drift does not match current pins/approvals: expected review_mode',
    'binding-ai-design-hotfix-reuse': 'binding drift does not match current pins/approvals: expected review_mode',
    'binding-ai-design-out-of-scope-class-reuse': 'binding drift does not match current pins/approvals: expected review_mode',
    'binding-ai-design-revoked-reuse': 'binding drift does not match current pins/approvals: expected review_mode',
    'binding-ai-design-stop-reuse': 'binding drift does not match current pins/approvals: expected review_mode',
    'binding-changed-criteria-reuse': 'binding drift does not match current pins/approvals: expected intent',
    'binding-changed-intent-reuse': 'binding drift does not match current pins/approvals: expected intent',
    'binding-changed-packet-transfer': 'approvals cannot transfer to a changed packet/subject',
    'binding-changed-policy-reuse': 'binding drift does not match current pins/approvals: expected policy',
    'binding-changed-rules-reuse': 'binding drift does not match current pins/approvals: expected rules',
    'binding-changed-scope-reuse': 'binding drift does not match current pins/approvals: expected build_scope',
    'binding-changed-tier-reuse': 'binding drift does not match current pins/approvals: expected assurance',
    'binding-different-work-type': 'build task differs from design intent/target',
    'binding-embargoed-no-group': 'embargoed design can be bound only by a task in the same security group',
    'binding-embargoed-other-group': 'embargoed design can be bound only by a task in the same security group',
    'binding-expired-approvals-reuse': 'binding drift does not match current pins/approvals: expected approvals_expired',
    'binding-intent-without-intent-gate': 'replan must re-request exactly the affected approvals',
    'binding-missing-reapproval': 'replan must re-request exactly the affected approvals',
    'binding-partial-reopen': 'replan must reopen exactly the affected sections',
    'binding-security-on-ordinary-design': 'build security metadata may only inherit an embargoed design',
    'binding-self-asserted-basis': "current basis is not derived from the build task's accepted intent/criteria and tier",
    'binding-stale-source-reuse': 'binding drift does not match current pins/approvals: expected source_pins',
    'binding-unaffected-reapproval': 'replan must re-request exactly the affected approvals',
    'delivery-ai-approval-in-human-mode': '$.approvals[0].authority const',
    'delivery-ai-only-emergency-stop': 'inactive decision or emergency stop',
    'delivery-ai-only-expired-decision': 'decision expired or premature',
    'delivery-ai-only-incident-task': 'ai_only excluded for security, embargoed, incident or hotfix design task',
    'delivery-ai-only-not-opted-in-application': 'application not opted in under the decision',
    'delivery-ai-only-revoked': 'inactive decision or emergency stop',
    'delivery-ai-only-stale-qualification': 'configuration changed',
    'delivery-ai-only-unflagged-embargoed-task': 'ai_only excluded for security, embargoed, incident or hotfix design task',
    'delivery-ai-only-unknown-approval-set': 'unknown AI approval set for design gate',
    'delivery-ai-only-unknown-decision': 'design decision reference differs from panel authority',
    'delivery-ai-set-as-human-approval': 'AI decision presented as human approval',
    'delivery-approval-after-delivery': 'approval after recorded design approval',
    'delivery-classification-downgrade': 'rendered packet classification exceeds delivery target (INV-28)',
    'delivery-draft-design-pr': '$.target oneOf expected one matching branch',
    'delivery-embargo-ai-only': '$.reviewMode const',
    'delivery-embargo-ordinary-target': '$.target oneOf expected one matching branch',
    'delivery-embargoed-ordinary-docs-repo': "confidential design PR must use the task's security-group PublicationTarget",
    'delivery-embargoed-other-group-target': "confidential design PR must use the task's security-group PublicationTarget",
    'delivery-greenfield-missing-intent-gate': '$.approvals contains count',
    'delivery-greenfield-pr': '$.target missing reason',
    'delivery-missing-anchor': 'rendered packet lacks stable section/criterion/scenario anchors',
    'delivery-missing-gate': '$.approvals minItems',
    'delivery-missing-review-mode': '$ missing reviewMode',
    'delivery-ordinary-confidential-flag': '$.target oneOf expected one matching branch',
    'delivery-pr-outside-location': 'design PR must target the configured design-docs location',
    'delivery-rendered-other-packet': 'rendered artifact is not the approved packet',
    'delivery-report-despite-location': 'report fallback used although a design-docs location is configured',
    'delivery-security-flagged-ai-only': '$.reviewMode const',
    'outcome-ai-approval-set-differs': 'outcome approval set differs from delivery record',
    'outcome-ai-decision-differs': 'outcome decision differs from delivery record',
    'outcome-ai-ref-in-human-decisionRefs': 'AI decision presented as human approval',
    'outcome-ai-ref-in-human-voluntaryHumanReviewRefs': 'AI decision presented as human approval',
    'outcome-ai-revoked': 'inactive decision or emergency stop',
    'outcome-ai-without-marker': '$ missing reviewMarker',
    'outcome-ai-wrong-review-subject': 'AI design outcome must name the reviewed packet subject',
    'outcome-claims-delivered': '$.outcomeKind enum',
    'outcome-claims-implemented-candidate': '$ not',
    'outcome-claims-outcome-verified': 'design outcome cites implementation/verification evidence',
    'outcome-claims-verified-fix': '$.outcomeKind enum',
    'outcome-hides-design-only-limitation': 'design outcome must state it is not implemented or verified',
    'policy-design-budget-wrong-class': '$.designBudget.budgetClass const',
    'task-bug': '$.workType enum',
    'task-build-unembargoed-security': '$ oneOf expected one matching branch',
    'task-build-with-design-budget-class': '$.deliveryScope const',
    'task-documentation': '$.deliveryScope enum',
    'task-investigation': '$.deliveryScope const',
    'task-maintenance': '$.workType enum',
    'task-pr-completion': '$.deliveryScope const',
    'task-security-on-feature-pr': '$ oneOf expected one matching branch',
    'task-security-on-investigation-design': '$.deliveryScope const',
    'task-self-binding': '$ not',
    'task-task-budget-class': '$.budget.budgetClass const',
    'template-implementation-stage': 'design template contains implementation/verification stage execute',
    'template-missing-architecture-gate': 'missing/ambiguous mandatory gate architecture_accepted',
    'template-missing-intent-gate': 'missing/ambiguous mandatory gate intent_aligned',
    'template-missing-peer-gate': 'missing/ambiguous mandatory gate plan_peer_approved',
    'template-missing-plan-review': 'missing/ambiguous mandatory gate plan_peer_approved',
    'template-preview-stage': 'design template claims non-design gate',
    'template-render-before-approval': 'missing required ordering plan_review → render',
    'template-unmarked-design-template': '$ missing deliveryScope',
    'template-verification-stage': 'design template contains implementation/verification stage verify',
    'template-workspace-write': 'design template requests code/environment write capability',
}


DESIGN_ROUTES = [
    ('get', '/tasks/{taskId}/design-delivery', None, 'DesignDeliveryView', 200),
    ('get', '/applications/{applicationId}/designs', None, 'DesignDeliveryPage', 200),
]


def extend(D, define, ref, obj, text, integer, array, enum, UUID, TIME, BOOL, AR, ARS):
    def fields(name, values):
        D[name]['properties'].update(values)
    D['DeliveryScope']['enum'].append('design')
    D['StageKind']['enum'].append('render_design')
    D['WorkflowTemplateId']['enum'] += list(DESIGN_TEMPLATES)
    D['OutcomeKind']['enum'].append('design_approved')
    D['DesignWorkType'] = enum(*DESIGN_WORK_TYPES)
    D['BuildDeliveryScope'] = enum(*BUILD_SCOPES)
    D['DesignGate'] = enum(*DESIGN_GATES)
    D['DesignDrift'] = enum(*DRIFT_KINDS)
    D['BudgetClass'] = dict(enum('task', 'design'), default='task')
    fields('Budget', {'budgetClass': ref('BudgetClass')})
    define('DesignDocsLocation', {'repositoryId': UUID, 'subpath': text(), 'baseBranch': text(), 'adrIndexPath': text()},
           ('adrIndexPath',))
    fields('ApplicationDefinition', {'designDocsLocation': ref('DesignDocsLocation')})
    fields('PolicyProfile', {'designBudget': ref('Budget'), 'designApprovalTtlSeconds': integer(1)})
    D['PolicyProfile'].setdefault('allOf', []).append({'if': {'required': ['designBudget']}, 'then': {'properties': {'designBudget': {
        'required': ['budgetClass'], 'properties': {'budgetClass': {'const': 'design'}}}}}})
    fields('PlanReviewPacket', {'plannedBuildDeliveryScope': ref('BuildDeliveryScope')})
    define('DesignSourcePin', {'repositoryId': UUID, 'commit': ref('GitOid'), 'subpath': text(0)})
    # Everything that must still be current before a later build may skip re-authoring.
    define('DesignBasis', {'applicationSnapshotRef': AR, 'sourcePins': array(ref('DesignSourcePin')),
        'resolvedRulesRef': AR, 'policyRef': AR, 'taskSpecVersion': integer(1), 'intentRef': AR,
        'acceptedIntentDigest': ref('Digest'), 'assurance': ref('Assurance'),
        'plannedBuildDeliveryScope': ref('BuildDeliveryScope')})
    D['DesignBasis']['properties']['acceptedIntentDigest']['description'] = (
        'SHA-256 of the RFC 8785 canonical {intent, acceptanceCriteria (sorted)} of the accepted TaskSpec; '
        'a build derives it from its own accepted spec, never from the binding.')
    # Human and AI authority use separate fields so the shared review field roles classify each one correctly.
    define('DesignGateApproval', {'gateId': ref('DesignGate'), 'gateEvaluationRef': AR,
        'authority': enum('human', 'ai_panel'), 'approvalSetRef': AR, 'aiReviewApprovalSetRef': AR, 'approvedAt': TIME},
        ('approvalSetRef', 'aiReviewApprovalSetRef'))
    D['DesignGateApproval']['allOf'] = [{'if': {'properties': {'authority': {'const': 'human'}}},
        'then': {'required': ['approvalSetRef'], 'not': {'required': ['aiReviewApprovalSetRef']}},
        'else': {'required': ['aiReviewApprovalSetRef'], 'not': {'required': ['approvalSetRef']}}}]
    define('DesignRendering', {'mediaType': {'const': 'text/markdown'}, 'renderedRef': AR, 'rendererVersion': text(),
        'sourcePacketRef': AR, 'anchorIds': dict(array(text(), 12), uniqueItems=True)})
    define('DesignPrTarget', {'kind': {'const': 'design_pr'}, 'repositoryId': UUID, 'subpath': text(), 'baseBranch': text(),
        'publicationTargetRef': AR, 'gitChangeId': UUID, 'providerHandle': text(), 'headCommit': ref('GitOid'),
        'draft': {'const': False}, 'confidential': BOOL,
        'publicationMode': enum('ordinary', 'private_fork', 'separate_repo'), 'securityGroupId': UUID}, ('securityGroupId',))
    # A confidential mode is the task's resolved PublicationTarget for its security group (D4/INT-15).
    D['DesignPrTarget']['allOf'] = [{'if': {'properties': {'publicationMode': enum('private_fork', 'separate_repo')}},
        'then': {'required': ['securityGroupId'], 'properties': {'confidential': {'const': True}}},
        'else': {'properties': {'confidential': {'const': False}}, 'not': {'required': ['securityGroupId']}}}]
    define('DesignReportTarget', {'kind': {'const': 'report'}, 'artifactRef': AR,
        'reason': enum('no_design_docs_location', 'owner_selected_report', 'confidential_report')})
    D['DesignDeliveryTarget'] = {'oneOf': [ref('DesignPrTarget'), ref('DesignReportTarget')]}
    define('DesignDeliveryRecord', {'schemaVersion': {'const': '2.0'}, 'taskId': UUID, 'applicationId': UUID,
        'workType': ref('DesignWorkType'), 'targetKind': enum('new_application', 'existing_application'),
        'workflowTemplate': ref('WorkflowTemplateRef'), 'designProfile': {'const': DESIGN_PROFILE},
        'packetRef': AR, 'planReviewSubjectRef': AR, 'subjectHash': ref('Digest'), 'basis': ref('DesignBasis'),
        'approvals': dict(array(ref('DesignGateApproval'), 3), maxItems=4), 'rendering': ref('DesignRendering'),
        'target': ref('DesignDeliveryTarget'), 'dataClassification': ref('DataClassification'),
        'securityFlagged': BOOL, 'embargoed': BOOL, 'securityGroupId': UUID, 'approvedAt': TIME, 'approvalsExpireAt': TIME,
        'deliveredAt': TIME}, ('securityGroupId',))
    contains = lambda gate: {'contains': {'properties': {'gateId': {'const': gate}}}}
    D['DesignDeliveryRecord']['allOf'] = [{'properties': {'approvals': {'allOf': [contains(g) for g in PLAN_GATES]}}},
        # A draft application has no design-docs location, so greenfield designs deliver as a report.
        {'if': {'properties': {'targetKind': {'const': 'new_application'}}},
         'then': {'properties': {'approvals': contains('intent_aligned'), 'workType': {'const': 'feature'},
             'target': {'required': ['reason'], 'properties': {'kind': {'const': 'report'}}}}}},
        # Security-flagged design work is excluded from ai_only (as D5 excludes security embargo work).
        {'if': {'properties': {'securityFlagged': {'const': True}}}, 'then': {'properties': {'reviewMode': {'const': 'human'}}}},
        # D4 (embargoed=true only): human review and only the isolated confidential target or report.
        {'if': {'properties': {'embargoed': {'const': True}}},
         'then': {'required': ['securityGroupId'], 'properties': {'securityFlagged': {'const': True}, 'reviewMode': {'const': 'human'}, 'target': {'oneOf': [
             {'required': ['publicationMode'], 'properties': {'kind': {'const': 'design_pr'}, 'publicationMode': enum('private_fork', 'separate_repo')}},
             {'required': ['reason'], 'properties': {'kind': {'const': 'report'}, 'reason': {'const': 'confidential_report'}}}]}}},
         'else': {'not': {'required': ['securityGroupId']}, 'properties': {'target': {'not': {
             'required': ['publicationMode'], 'properties': {'publicationMode': enum('private_fork', 'separate_repo')}}}}}},
        {'if': {'properties': {'reviewMode': {'const': 'human'}}},
         'then': {'properties': {'approvals': {'items': {'properties': {'authority': {'const': 'human'}}}}}},
         'else': {'properties': {'approvals': {'items': {'properties': {'authority': {'const': 'ai_panel'}}}}}}}]
    define('DesignBuildBinding', {'schemaVersion': {'const': '2.0'}, 'taskId': UUID, 'designTaskId': UUID,
        'designDeliveryRef': AR, 'packetRef': AR, 'subjectHash': ref('Digest'), 'currentBasis': ref('DesignBasis'),
        'result': enum('reuse', 'replan'), 'drift': dict(array(ref('DesignDrift')), uniqueItems=True),
        'reopenedSectionIds': dict(array(ref('PlanSectionId')), uniqueItems=True),
        'rerequestedGateIds': dict(array(ref('DesignGate')), uniqueItems=True),
        'replacementPacketRef': AR, 'evaluatedAt': TIME}, ('replacementPacketRef',))
    D['DesignBuildBinding']['allOf'] = [
        {'if': {'properties': {'result': {'const': 'reuse'}}},
         'then': {'properties': {'drift': {'maxItems': 0}, 'reopenedSectionIds': {'maxItems': 0},
                                 'rerequestedGateIds': {'maxItems': 0}}, 'not': {'required': ['replacementPacketRef']}},
         'else': {'properties': {'drift': {'minItems': 1}, 'rerequestedGateIds': {'minItems': 1}}}},
        {'if': {'properties': {'reopenedSectionIds': {'minItems': 1}}}, 'then': {'required': ['replacementPacketRef']}}]
    define('DesignSource', {'designTaskId': UUID, 'designDeliveryRef': AR})
    define('DesignCurrency', {'state': enum('current', 'stale', 'expired', 'unknown'),
        'drift': dict(array(ref('DesignDrift')), uniqueItems=True), 'evaluatedAt': TIME})
    define('DesignDeliveryView', {'taskId': UUID, 'deliveryRef': AR, 'record': ref('DesignDeliveryRecord'),
        'currency': ref('DesignCurrency'), 'buildTaskIds': array(UUID)})
    define('DesignDeliveryPage', {'items': array(ref('DesignDeliveryView')), 'nextCursor': text()}, ('nextCursor',))
    fields('TaskRequest', {'designSource': ref('DesignSource')})
    design_scope = {'properties': {'deliveryScope': {'const': 'design'}}}
    D['TaskRequest']['allOf'] += [
        {'if': design_scope, 'then': {'properties': {'workType': ref('DesignWorkType'),
            'budget': {'required': ['budgetClass'], 'properties': {'budgetClass': {'const': 'design'}}}},
            'allOf': [{'not': {'required': ['prCompletion']}}, {'not': {'required': ['designSource']}}]}},
        {'if': {'properties': {'budget': {'required': ['budgetClass'], 'properties': {'budgetClass': {'const': 'design'}}}}},
         'then': design_scope},
        {'if': {'required': ['designSource']}, 'then': {'properties': {'deliveryScope': ref('BuildDeliveryScope'),
            'workType': ref('DesignWorkType')}}}]
    for name in ('InputBinding', 'ExecutionPlan'):
        fields(name, {'designBuildBindingRef': AR, 'designProfile': {'const': DESIGN_PROFILE}})
        D[name].setdefault('allOf', []).append({'if': {'required': ['designBuildBindingRef']}, 'then': {'required': ['designProfile']}})
    D['ExecutionPlan']['allOf'].append({'if': design_scope, 'then': {'required': ['designProfile'],
        'properties': {'workflowTemplate': {'properties': {'id': enum(*DESIGN_TEMPLATES)}}}, 'not': {'required': ['designBuildBindingRef']}}})
    fields('WorkflowTemplateDefinition', {'deliveryScope': {'const': 'design'}, 'designProfile': {'const': DESIGN_PROFILE}})
    D['WorkflowTemplateDefinition'].setdefault('allOf', []).append(
        {'if': {'properties': {'id': enum(*DESIGN_TEMPLATES)}}, 'then': {'required': ['deliveryScope', 'designProfile']},
         'else': {'allOf': [{'not': {'required': ['deliveryScope']}}, {'not': {'required': ['designProfile']}}]}})
    fields('TaskView', {'designDeliveryRef': AR, 'designBuildBindingRef': AR})
    fields('OutcomeManifest', {'designDeliveryRef': AR})
    D['OutcomeManifest']['allOf'] += [
        # Design outcomes cannot claim implementation, verification or a fix.
        {'if': design_scope, 'then': {'required': ['outcomeKind'], 'not': {'required': ['candidateRef']},
            'properties': {'outcomeKind': enum('design_approved', 'abandoned', 'handed_over')}}},
        {'if': {'required': ['outcomeKind'], 'properties': {'outcomeKind': {'const': 'design_approved'}}},
         'then': {'required': ['designDeliveryRef'], 'properties': {'status': {'const': 'succeeded'}, 'deliveryScope': {'const': 'design'}}}},
        {'if': {'required': ['designDeliveryRef']}, 'then': design_scope}]
    # Same honest provenance fields as other outputs (INV-29).
    from review_mode_contracts import AI_MARKER
    fields('DesignDeliveryRecord', {'reviewMode': ref('ReviewMode'), 'reviewModeDecisionRef': AR,
        'reviewMarker': {'const': AI_MARKER}, 'aiReviewApprovalSetRefs': ARS})
    D['DesignDeliveryRecord']['required'].append('reviewMode')
    D['DesignDeliveryRecord']['allOf'] += [
        {'if': {'required': ['reviewMode'], 'properties': {'reviewMode': {'const': 'ai_only'}}},
         'then': {'required': ['reviewModeDecisionRef', 'reviewMarker', 'aiReviewApprovalSetRefs']}}] + [
        {'if': {'required': [field]}, 'then': {'required': ['reviewMode', 'reviewMarker'],
            'properties': {'reviewMode': {'const': 'ai_only'}}}}
        for field in ('reviewModeDecisionRef', 'aiReviewApprovalSetRefs', 'reviewMarker')]


def node(id, kind, role, deps, gates=(), returns=()):
    timeout = 'human_wait' if kind in ('intent_interview', 'intent_confirmation', 'plan_peer_review') else \
        'provider' if kind in ('deliver', 'pr_review') else 'resolve' if kind == 'render_design' else 'execute'
    return {'id': id, 'stageKind': kind, 'role': role, 'dependsOn': list(deps), 'inputArtifactRefs': [],
            'requiredGateIds': list(gates), 'requiredCapabilities': [], 'timeoutClass': timeout,
            'sessionPolicy': 'fresh', 'returnTargets': list(returns), 'mandatory': True}


def template(template_id):
    work_type, target_kind = DESIGN_TEMPLATES[template_id]
    if target_kind == 'new_application':
        nodes = [node('brief', 'product_brief', 'discovery', []),
                 node('interview', 'intent_interview', 'discovery', ['brief'], (), ['brief']),
                 node('challenge', 'intent_challenge', 'reviewer', ['interview'], (), ['interview']),
                 node('confirm_intent', 'intent_confirmation', 'publisher', ['challenge'], ['intent_aligned', 'scope_accepted'], ['interview']),
                 node('design', 'foundation_design', 'planner', ['confirm_intent'], (), ['interview']),
                 node('design_review', 'plan_peer_review', 'reviewer', ['design'], PLAN_GATES, ['design', 'interview'])]
        review = 'design_review'
    else:
        kind = 'feature_impact' if work_type == 'feature' else 'discover'
        nodes = [node('discover', kind, 'discovery', [], ['scope_accepted']),
                 node('plan', 'plan', 'planner', ['discover'], (), ['discover']),
                 node('plan_review', 'plan_peer_review', 'reviewer', ['plan'], PLAN_GATES, ['plan', 'discover'])]
        review = 'plan_review'
    # Deterministic controller rendering and delivery; no runner workspace or harness coding stage.
    nodes += [node('render', 'render_design', 'publisher', [review], (), [review]),
              node('deliver', 'deliver', 'publisher', ['render'], (), ['render']),
              node('pr_review', 'pr_review', 'publisher', ['deliver'], ['delivery_complete'], ['render']),
              node('close', 'learn_close', 'knowledge_curator', ['pr_review'], ['outcome_recorded'])]
    return {'schemaVersion': '2.0', 'id': template_id, 'version': HUMAN_VERSION, 'workType': work_type,
            'targetKind': target_kind, 'deliveryScope': 'design', 'designProfile': DESIGN_PROFILE, 'nodes': nodes}


def task_view(base, task_id, spec):
    """Trusted control-plane snapshot of a design/build task (admission-derived fields included)."""
    view = copy.deepcopy(base)
    view.update(id=task_id, spec=copy.deepcopy(spec), priorityClass=spec.get('priorityClass', 'normal'))
    for field in ('security', 'incidentRef'):
        view.pop(field, None)
        if field in spec: view[field] = copy.deepcopy(spec[field])
    return view


def review_evidence(E, uid, art, task_id, subject_ref, content_ref, ai_view, human_view):
    """ai-review/1.0 panel bundles per design gate plus resolvable human approvals."""
    base = json.loads((E/'ai-review'/'in-force.json').read_text())
    gates = []
    for n, gate in enumerate(PLAN_GATES):
        b = copy.deepcopy(base)
        b.update(now='2026-10-29T13:00:00Z', subjectRef=copy.deepcopy(subject_ref), approvalSetRef=art(3080+n), taskView=copy.deepcopy(ai_view))
        for value in (b['assignment'], b['subject']):
            value.update(taskId=task_id, gateId=gate, contentRef=copy.deepcopy(content_ref))
        b['approvalSet'].update(taskId=task_id, gateId=gate, subjectRef=copy.deepcopy(subject_ref), subjectHash=subject_ref['sha256'])
        for vote in b['decisions']:
            vote['value'].update(taskId=task_id, gateId=gate, subjectRef=copy.deepcopy(subject_ref), subjectHash=subject_ref['sha256'])
        gates.append(b)
    def human_bundle(subject, artifacts):
        b = copy.deepcopy(gates[-1]); b.update(reviewMode='human', subjectRef=copy.deepcopy(subject), taskView=copy.deepcopy(human_view),
            humanArtifacts=artifacts, humanApprovals=[], voluntaryHumanReviews=[], approvalSetRef=art(3089))
        b['subject'].update(gateId='plan_accepted'); return b
    def decision(n, action, subject, principal):
        return {'ref': art(n), 'value': {'id': uid(n), 'taskId': task_id, 'action': action, 'subjectHash': subject['sha256'],
            'subjectRef': copy.deepcopy(subject), 'policyRef': art(3003), 'evidenceRefs': [art(3086)], 'eligibleRoles': ['engineering_peer'],
            'state': 'approved', 'reason': 'Exact-subject human decision.', 'expiresAt': '2027-01-27T10:00:00Z',
            'deciderId': uid(principal), 'requiredPrincipalId': uid(principal), 'actorKind': 'human'}}
    plan_votes = [decision(3047, 'approve_plan', subject_ref, 3090), decision(3048, 'approve_plan', subject_ref, 3091)]
    plan_set = {'ref': art(3020), 'value': {'schemaVersion': '2.0', 'taskId': task_id, 'subjectRef': copy.deepcopy(subject_ref),
        'decisionRefs': [v['ref'] for v in plan_votes], 'actorKind': 'human'}}
    intent_subject = art(3049)
    intent_vote = decision(3058, 'confirm_intent', intent_subject, 3092)
    intent_set = {'ref': art(3046), 'value': {'schemaVersion': '2.0', 'taskId': task_id, 'confirmationSubjectRef': intent_subject,
        'requiredOwnerIds': [uid(3092)], 'decisionRefs': [intent_vote['ref']], 'actorKind': 'human'}}
    return {'ai': gates, 'human': {'plan': human_bundle(subject_ref, [plan_set] + plan_votes),
                                   'intent': human_bundle(intent_subject, [intent_set, intent_vote])}}


def examples(E, write, uid, art, task):
    folder = E/'design'; folder.mkdir(exist_ok=True)
    for stale in folder.glob('negative-*.json'): stale.unlink()
    (folder/'templates').mkdir(exist_ok=True); (folder/'templates'/'ai_only').mkdir(exist_ok=True)
    for template_id in DESIGN_TEMPLATES:
        human = template(template_id)
        write(folder/'templates'/(template_id+'.json'), human)
        ai = dict(copy.deepcopy(human), version=AI_VERSION, reviewQualificationProfile='ai-review/1.0')
        write(folder/'templates'/'ai_only'/(template_id+'.json'), ai)
    budget = {'maxMicroUsd': 10000000, 'maxActiveSeconds': 7200, 'maxCalendarSeconds': 1209600,
              'maxAuthoringInvocations': 6, 'maxSemanticAttemptsPerNode': 3, 'maxDesignReturns': 2,
              'invocationMode': 'bounded', 'budgetClass': 'design'}
    design_task = copy.deepcopy(task)
    design_task.pop('prCompletion')
    design_task.update(title='Design order cancellation', deliveryScope='design', budget=budget)
    write(folder/'design-task.json', design_task)
    refactor = copy.deepcopy(design_task)
    refactor.update(title='Design order module boundary refactor', workType='refactor', assurance='fast',
        acceptanceCriteria=['Order persistence is isolated behind one repository interface.', 'Public API behavior is preserved.'])
    write(folder/'refactor-design-task.json', refactor)
    greenfield = json.loads((E/'greenfield-task.json').read_text())
    greenfield.pop('prCompletion'); greenfield.update(deliveryScope='design', budget=budget)
    write(folder/'greenfield-design-task.json', greenfield)
    location = {'repositoryId': uid(20), 'subpath': 'docs/design', 'baseBranch': 'main', 'adrIndexPath': 'docs/adr/README.md'}
    application = json.loads((E/'application.json').read_text())
    application.update(designDocsLocation=location, dataClassification='internal')
    write(folder/'application-with-design-location.json', application)
    policy = json.loads((E/'policy.json').read_text())
    policy.update(designBudget=budget, designApprovalTtlSeconds=7776000)
    write(folder/'policy-design.json', policy)
    sections = ('intent_scope', 'current_state', 'design', 'interfaces_data', 'implementation', 'acceptance_tests',
                'quality_security', 'delivery_recovery', 'operations', 'risks_decisions', 'definition_of_done', 'review_ownership')
    criteria = ['C1', 'C2', 'C3', 'C4']; scenarios = ['S1', 'S2', 'S3', 'S4', 'S5']
    packet_ids = {'sectionIds': list(sections), 'criterionIds': criteria, 'scenarioIds': scenarios,
                  'plannedBuildDeliveryScope': 'pr'}
    basis = {'applicationSnapshotRef': art(3001), 'sourcePins': [{'repositoryId': uid(20), 'commit': 'a'*40, 'subpath': 'services/orders'}],
             'resolvedRulesRef': art(3002), 'policyRef': art(3003), 'taskSpecVersion': 1, 'intentRef': art(3004),
             'acceptedIntentDigest': intent_digest(design_task), 'assurance': design_task['assurance'],
             'plannedBuildDeliveryScope': 'pr'}
    gate_refs = {gate: art(3010+n) for n, gate in enumerate(('scope_accepted',) + DESIGN_GATES + ('delivery_complete', 'outcome_recorded'))}
    approvals = [{'gateId': gate, 'gateEvaluationRef': gate_refs[gate], 'authority': 'human', 'approvalSetRef': art(3020),
                  'approvedAt': '2026-10-29T10:00:00Z'} for gate in PLAN_GATES]
    template_ref = {'id': 'feature_design', 'version': HUMAN_VERSION, 'definitionRef': art(3005)}
    record = {'schemaVersion': '2.0', 'taskId': uid(3030), 'applicationId': uid(10), 'workType': 'feature',
        'targetKind': 'existing_application', 'workflowTemplate': template_ref, 'designProfile': DESIGN_PROFILE,
        'packetRef': art(3006), 'planReviewSubjectRef': art(3007), 'subjectHash': art(3007)['sha256'], 'basis': basis,
        'approvals': approvals, 'rendering': {'mediaType': 'text/markdown', 'renderedRef': art(3008), 'rendererVersion': 'design-render/1.0.0',
            'sourcePacketRef': art(3006), 'anchorIds': list(sections) + criteria + scenarios},
        'target': {'kind': 'design_pr', 'repositoryId': uid(20), 'subpath': 'docs/design', 'baseBranch': 'main',
            'publicationTargetRef': art(3009), 'gitChangeId': uid(3031), 'providerHandle': 'github:example/orders#241',
            'headCommit': 'c'*40, 'draft': False, 'confidential': False, 'publicationMode': 'ordinary'},
        'dataClassification': 'internal', 'securityFlagged': False, 'embargoed': False, 'reviewMode': 'human',
        'approvedAt': '2026-10-29T10:00:00Z', 'approvalsExpireAt': '2027-01-27T10:00:00Z', 'deliveredAt': '2026-10-29T10:05:00Z'}
    order = ['public', 'internal', 'restricted', 'regulated']
    bundle = {'deliveryRef': art(3040), 'record': record, 'packet': packet_ids, 'application': application,
              'targetDataClassification': 'internal', 'classificationOrder': order,
              'gateEvaluations': [{'ref': ref, 'gateId': gate} for gate, ref in gate_refs.items()]}
    base_view = json.loads((E/'ai-review'/'in-force.json').read_text())['taskView']
    ai_task = dict(copy.deepcopy(design_task), assurance='standard')
    bundle['taskView'] = task_view(base_view, record['taskId'], design_task)
    evidence = review_evidence(E, uid, art, record['taskId'], record['planReviewSubjectRef'], record['packetRef'],
                               task_view(base_view, record['taskId'], ai_task), bundle['taskView'])
    write(folder/'review-evidence.json', evidence)
    bundle['reviewEvidenceFile'] = 'review-evidence.json'
    write(folder/'delivery-pr.json', bundle)
    report = copy.deepcopy(bundle); report['application'].pop('designDocsLocation')
    report['record']['target'] = {'kind': 'report', 'artifactRef': art(3041), 'reason': 'no_design_docs_location'}
    write(folder/'delivery-report.json', report)
    from review_mode_contracts import AI_MARKER
    # AI design: each gate cites its own panel approval set under the in-force ai-review decision.
    ai_sets = [b['approvalSetRef'] for b in evidence['ai']]; decision_ref = evidence['ai'][0]['decisionRef']
    def make_ai(value):
        value['record'].update(reviewMode='ai_only', reviewModeDecisionRef=decision_ref, reviewMarker=AI_MARKER, aiReviewApprovalSetRefs=ai_sets,
            approvedAt='2026-10-29T12:01:00Z', deliveredAt='2026-10-29T12:05:00Z')
        value['record']['basis']['assurance'] = 'standard'
        for approval in value['record']['approvals']:
            approval.pop('approvalSetRef', None)
            approval.update(authority='ai_panel', aiReviewApprovalSetRef=ai_sets[PLAN_GATES.index(approval['gateId'])], approvedAt='2026-10-29T12:01:00Z')
        value['taskView'] = task_view(base_view, record['taskId'], ai_task)
        return value
    ai = make_ai(copy.deepcopy(bundle))
    write(folder/'delivery-ai-only.json', ai)
    embargoed = copy.deepcopy(bundle)
    security = {'severity': 'high', 'sourceRef': art(3067), 'embargoed': True, 'securityGroupId': uid(3044)}
    embargoed_task = dict(copy.deepcopy(design_task), title='Design confidential token rotation', security=security)
    write(folder/'embargoed-design-task.json', embargoed_task)
    flagged_task = dict(copy.deepcopy(design_task), security=dict(security, embargoed=False, severity='medium'))
    flagged_task['security'].pop('securityGroupId')
    write(folder/'security-flagged-design-task.json', flagged_task)
    embargoed['record'].update(securityFlagged=True, embargoed=True, securityGroupId=uid(3044), dataClassification='restricted')
    # D4: the task's resolved separate_repo PublicationTarget, never the ordinary docs repository.
    embargoed['record']['target'].update(repositoryId=uid(3070), confidential=True, publicationMode='separate_repo',
        securityGroupId=uid(3044), publicationTargetRef=art(3045), providerHandle='github:example-security/orders-design#7')
    embargoed['publicationTarget'] = {'schemaVersion': '2.0', 'taskId': record['taskId'], 'sourceRepositoryId': uid(20),
        'publicationRepositoryId': uid(3070), 'baseBranch': 'main', 'mode': 'separate_repo', 'securityGroupId': uid(3044),
        'assignmentPolicyRef': art(3068)}
    embargoed['targetDataClassification'] = 'restricted'
    embargoed['taskView'] = task_view(base_view, record['taskId'], embargoed_task)
    write(folder/'delivery-embargoed.json', embargoed)
    flagged = copy.deepcopy(bundle); flagged['record']['securityFlagged'] = True
    flagged['taskView'] = task_view(base_view, record['taskId'], flagged_task)
    write(folder/'delivery-security-flagged.json', flagged)
    greenfield_record = copy.deepcopy(bundle)
    greenfield_record['record'].update(targetKind='new_application', applicationId=uid(70),
        workflowTemplate=dict(template_ref, id='greenfield_design'))
    greenfield_record['record']['basis'].update(sourcePins=[], acceptedIntentDigest=intent_digest(greenfield), assurance=greenfield['assurance'])
    # A draft has no ApplicationDefinition or design-docs location: greenfield designs deliver as a report.
    greenfield_record['record']['target'] = {'kind': 'report', 'artifactRef': art(3069), 'reason': 'no_design_docs_location'}
    greenfield_record['record']['approvals'].insert(0, dict(approvals[0], gateId='intent_aligned', gateEvaluationRef=gate_refs['intent_aligned'], approvalSetRef=art(3046)))
    greenfield_record['application'] = None
    greenfield_record['taskView'] = task_view(base_view, record['taskId'], greenfield)
    write(folder/'delivery-greenfield.json', greenfield_record)
    outcome = {'schemaVersion': '2.0', 'taskId': record['taskId'], 'status': 'succeeded', 'deliveryScope': 'design',
        'outcomeKind': 'design_approved', 'designDeliveryRef': bundle['deliveryRef'],
        'deliveredArtifactRefs': [record['rendering']['renderedRef'], record['packetRef']],
        'providerHandles': [record['target']['providerHandle']], 'gateEvaluationRefs': list(gate_refs.values()),
        'decisionRefs': [art(3047), art(3048)], 'usage': [], 'limitations': [NOT_IMPLEMENTED],
        'knowledgeProposalIds': [], 'cleanupObligationRefs': [], 'completedAt': '2026-10-29T10:06:00Z', 'reviewMode': 'human'}
    write(folder/'outcome-design-approved.json', dict(bundle, outcome=outcome))
    # The outcome cites the final plan_accepted panel set; the record lists every gate's set.
    ai_outcome = copy.deepcopy(outcome); ai_outcome.update(reviewMode='ai_only', reviewModeDecisionRef=decision_ref,
        reviewMarker=AI_MARKER, reviewSubjectRef=record['planReviewSubjectRef'], aiReviewApprovalSetRefs=[ai_sets[-1]],
        voluntaryHumanReviewRefs=[], decisionRefs=[], completedAt='2026-10-29T12:06:00Z')
    write(folder/'outcome-design-approved-ai-only.json', dict(ai, outcome=ai_outcome))
    build = copy.deepcopy(task); build.update(title='Build approved order cancellation design',
        designSource={'designTaskId': record['taskId'], 'designDeliveryRef': bundle['deliveryRef']})
    binding = {'schemaVersion': '2.0', 'taskId': uid(3050), 'designTaskId': record['taskId'], 'designDeliveryRef': bundle['deliveryRef'],
        'packetRef': record['packetRef'], 'subjectHash': record['subjectHash'], 'currentBasis': copy.deepcopy(basis),
        'result': 'reuse', 'drift': [], 'reopenedSectionIds': [], 'rerequestedGateIds': [], 'evaluatedAt': '2026-11-05T09:00:00Z'}
    current = {'delivery': record, 'deliveryRef': bundle['deliveryRef'], 'buildTask': build, 'binding': binding,
               'buildChangeClass': 'fixture', 'reviewEvidenceFile': 'review-evidence.json'}
    write(folder/'build-task.json', build)
    write(folder/'binding-reuse.json', current)
    replan = copy.deepcopy(current)
    replan['binding']['currentBasis']['sourcePins'][0]['commit'] = 'd'*40
    replan['binding'].update(result='replan', drift=['source_pins'], reopenedSectionIds=list(DRIFT_SECTIONS['source_pins']),
        rerequestedGateIds=list(PLAN_GATES), replacementPacketRef=art(3051))
    write(folder/'binding-replan.json', replan)
    expired = copy.deepcopy(current)
    expired['binding'].update(evaluatedAt='2027-02-01T00:00:00Z', result='replan', drift=['approvals_expired'],
        rerequestedGateIds=list(PLAN_GATES))
    write(folder/'binding-expired-reapproval.json', expired)
    gf = {'delivery': greenfield_record['record'], 'deliveryRef': bundle['deliveryRef'], 'buildChangeClass': 'fixture',
          'reviewEvidenceFile': 'review-evidence.json'}
    gf_build = json.loads((E/'greenfield-task.json').read_text())
    gf_build['designSource'] = build['designSource']; gf['buildTask'] = gf_build
    gf['binding'] = dict(copy.deepcopy(binding), currentBasis=copy.deepcopy(greenfield_record['record']['basis']))
    # The build's own accepted spec adds a criterion, so its derived intent digest differs.
    gf_build['acceptanceCriteria'] = gf_build['acceptanceCriteria'] + ['A support operator can read any return status.']
    gf['binding']['currentBasis'].update(intentRef=art(3052), taskSpecVersion=2, acceptedIntentDigest=intent_digest(gf_build))
    gf['binding'].update(result='replan', drift=['intent'], reopenedSectionIds=list(DRIFT_SECTIONS['intent']),
        rerequestedGateIds=['intent_aligned'] + list(PLAN_GATES), replacementPacketRef=art(3053))
    write(folder/'binding-greenfield-intent-replan.json', gf)
    tier = copy.deepcopy(current); tier['buildTask']['assurance'] = 'standard'
    tier['binding']['currentBasis']['assurance'] = 'standard'
    tier['binding'].update(result='replan', drift=['assurance'], reopenedSectionIds=list(DRIFT_SECTIONS['assurance']),
        rerequestedGateIds=list(PLAN_GATES), replacementPacketRef=art(3054))
    write(folder/'binding-assurance-replan.json', tier)
    # An embargoed design is buildable only by a task inheriting the same security group.
    secure = {'delivery': embargoed['record'], 'deliveryRef': bundle['deliveryRef'], 'buildChangeClass': 'fixture',
              'reviewEvidenceFile': 'review-evidence.json',
              'buildTask': dict(copy.deepcopy(build), security=copy.deepcopy(security)), 'binding': copy.deepcopy(binding)}
    write(folder/'embargoed-build-task.json', secure['buildTask'])
    write(folder/'binding-embargoed-same-group.json', secure)
    # AI approvals are reusable only while the decision is in force for the BUILD task (scope, class, not excluded).
    ai_bind = copy.deepcopy(current); ai_bind['delivery'] = copy.deepcopy(ai['record'])
    ai_bind['buildTask']['assurance'] = 'standard'; ai_bind['binding']['currentBasis']['assurance'] = 'standard'
    write(folder/'binding-ai-reuse.json', ai_bind)
    ai_lost = copy.deepcopy(ai_bind); ai_lost['reviewEvidenceOverrides'] = {'state': 'revoked'}
    ai_lost['binding'].update(result='replan', drift=['review_mode'], rerequestedGateIds=list(PLAN_GATES))
    write(folder/'binding-ai-revoked-replan.json', ai_lost)

    def negative(name, kind, value):
        write(folder/('negative-'+name+'.json'), {'kind': kind, 'expect': NEGATIVE_REASONS[name], 'value': value})
    out = dict(bundle, outcome=outcome)
    for kind in ('verified_fix', 'delivered'):
        value = copy.deepcopy(out); value['outcome']['outcomeKind'] = kind
        negative('outcome-claims-'+kind.replace('_', '-'), 'outcome', value)
    value = copy.deepcopy(out); value['gateEvaluations'].append({'ref': art(3060), 'gateId': 'outcome_verified'})
    value['outcome']['gateEvaluationRefs'].append(art(3060)); negative('outcome-claims-outcome-verified', 'outcome', value)
    value = copy.deepcopy(out); value['outcome']['candidateRef'] = art(3061); negative('outcome-claims-implemented-candidate', 'outcome', value)
    value = copy.deepcopy(out); value['outcome']['limitations'] = []; negative('outcome-hides-design-only-limitation', 'outcome', value)
    value = copy.deepcopy(dict(ai, outcome=ai_outcome)); value['outcome'].pop('reviewMarker'); negative('outcome-ai-without-marker', 'outcome', value)
    value = copy.deepcopy(dict(ai, outcome=ai_outcome)); value['outcome']['reviewSubjectRef'] = art(3066); negative('outcome-ai-wrong-review-subject', 'outcome', value)
    for template_id, mutate, label in [
        ('feature_design', lambda t: t['nodes'].insert(4, node('implement', 'execute', 'implementer', ['render'])), 'implementation-stage'),
        ('refactor_design', lambda t: t['nodes'].insert(4, node('verify', 'verify', 'verifier', ['render'], ['outcome_verified'])), 'verification-stage'),
        ('platform_design', lambda t: t['nodes'][3].update(requiredCapabilities=['workspace_write']), 'workspace-write'),
        ('performance_design', lambda t: t['nodes'].insert(4, node('preview', 'deliver', 'publisher', ['render'], ['deployed_verified'])), 'preview-stage'),
        ('feature_design', lambda t: t['nodes'][2].update(requiredGateIds=['plan_accepted', 'plan_peer_approved']), 'missing-architecture-gate'),
        ('refactor_design', lambda t: t['nodes'][2].update(requiredGateIds=['architecture_accepted', 'plan_accepted']), 'missing-peer-gate'),
        ('greenfield_design', lambda t: t['nodes'][3].update(requiredGateIds=['scope_accepted']), 'missing-intent-gate'),
        ('feature_design', lambda t: t['nodes'].pop(2), 'missing-plan-review'),
        ('feature_design', lambda t: t['nodes'][3].update(dependsOn=['plan']), 'render-before-approval'),
        ('platform_design', lambda t: t.pop('deliveryScope'), 'unmarked-design-template'),
    ]:
        value = template(template_id); mutate(value)
        if label == 'missing-plan-review': value['nodes'][2]['dependsOn'] = ['plan']; value['nodes'][2]['returnTargets'] = ['plan']
        negative('template-'+label, 'template', value)
    for label, mutate in [('investigation', {'workType': 'investigation'}), ('documentation', {'workType': 'documentation'}),
                          ('bug', {'workType': 'bug'}), ('maintenance', {'workType': 'maintenance'}),
                          ('pr-completion', {'prCompletion': task['prCompletion']}),
                          ('task-budget-class', {'budget': dict(budget, budgetClass='task')}),
                          ('self-binding', {'designSource': build['designSource']})]:
        negative('task-'+label, 'TaskRequest', dict(copy.deepcopy(design_task), **mutate))
    negative('policy-design-budget-wrong-class', 'PolicyProfile', dict(policy, designBudget=dict(budget, budgetClass='task')))
    negative('task-build-with-design-budget-class', 'TaskRequest', dict(copy.deepcopy(build), budget=budget))
    for label, mutate in [
        ('stale-source-reuse', lambda b: b['binding']['currentBasis']['sourcePins'][0].update(commit='d'*40)),
        ('changed-rules-reuse', lambda b: b['binding']['currentBasis'].update(resolvedRulesRef=art(3062))),
        ('changed-policy-reuse', lambda b: b['binding']['currentBasis'].update(policyRef=art(3063))),
        ('changed-intent-reuse', lambda b: b['binding']['currentBasis'].update(intentRef=art(3064), taskSpecVersion=2)),
        ('changed-scope-reuse', lambda b: (b['buildTask'].pop('prCompletion'), b['buildTask'].update(deliveryScope='preview'))),
        ('expired-approvals-reuse', lambda b: b['binding'].update(evaluatedAt='2027-02-01T00:00:00Z')),
        ('changed-packet-transfer', lambda b: b['binding'].update(packetRef=art(3065), subjectHash=art(3065)['sha256'])),
        ('different-work-type', lambda b: b['buildTask'].update(workType='platform')),
    ]:
        value = copy.deepcopy(current); mutate(value); negative('binding-'+label, 'binding', value)
    for label, mutate in [
        ('changed-criteria-reuse', lambda b: (b['buildTask'].update(acceptanceCriteria=['Any customer can cancel any order, including fulfilled ones.']),
            b['binding']['currentBasis'].update(acceptedIntentDigest=intent_digest(b['buildTask'])))),
        ('changed-tier-reuse', lambda b: (b['buildTask'].update(assurance='fast'), b['binding']['currentBasis'].update(assurance='fast'))),
        ('self-asserted-basis', lambda b: b['buildTask'].update(intent='Let support staff bulk-delete orders without audit.')),
        ('security-on-ordinary-design', lambda b: b['buildTask'].update(security=copy.deepcopy(security))),
    ]:
        value = copy.deepcopy(current); mutate(value); negative('binding-'+label, 'binding', value)
    value = copy.deepcopy(secure); value['buildTask']['security']['securityGroupId'] = uid(3071); negative('binding-embargoed-other-group', 'binding', value)
    value = copy.deepcopy(secure); value['buildTask'].pop('security'); negative('binding-embargoed-no-group', 'binding', value)
    value = copy.deepcopy(secure); value['buildTask']['security']['embargoed'] = False; value['buildTask']['security'].pop('securityGroupId')
    negative('task-build-unembargoed-security', 'TaskRequest', value['buildTask'])
    negative('task-security-on-feature-pr', 'TaskRequest', dict(copy.deepcopy(task), security=copy.deepcopy(security)))
    negative('task-security-on-investigation-design', 'TaskRequest', dict(copy.deepcopy(embargoed_task), workType='investigation'))
    value = copy.deepcopy(replan); value['binding']['reopenedSectionIds'] = ['implementation']; negative('binding-partial-reopen', 'binding', value)
    value = copy.deepcopy(replan); value['binding']['rerequestedGateIds'] = ['plan_accepted']; negative('binding-missing-reapproval', 'binding', value)
    value = copy.deepcopy(gf); value['binding']['rerequestedGateIds'] = list(PLAN_GATES); negative('binding-intent-without-intent-gate', 'binding', value)
    value = copy.deepcopy(expired); value['binding']['rerequestedGateIds'] = list(DESIGN_GATES); negative('binding-unaffected-reapproval', 'binding', value)
    for label, mutate in [
        ('missing-gate', lambda b: b['record']['approvals'].pop()),
        ('missing-anchor', lambda b: b['record']['rendering']['anchorIds'].remove('S3')),
        ('rendered-other-packet', lambda b: b['record']['rendering'].update(sourcePacketRef=art(3066))),
        ('embargo-ordinary-target', lambda b: b['record'].update(embargoed=True, securityGroupId=uid(3044))),
        ('embargo-ai-only', lambda b: (b['record'].update(securityFlagged=True, embargoed=True, securityGroupId=uid(3044)),
            b['record']['target'].update(confidential=True, publicationMode='separate_repo', securityGroupId=uid(3044), repositoryId=uid(3070)))),
        ('security-flagged-ai-only', lambda b: b['record'].update(securityFlagged=True)),
        ('missing-review-mode', lambda b: b['record'].pop('reviewMode')),
        ('ordinary-confidential-flag', lambda b: b['record']['target'].update(confidential=True)),
        ('classification-downgrade', lambda b: b['record'].update(dataClassification='restricted')),
        ('report-despite-location', lambda b: b['record'].update(target={'kind': 'report', 'artifactRef': art(3041), 'reason': 'no_design_docs_location'})),
        ('pr-outside-location', lambda b: b['record']['target'].update(subpath='services/orders')),
        ('draft-design-pr', lambda b: b['record']['target'].update(draft=True)),
        ('approval-after-delivery', lambda b: b['record']['approvals'][0].update(approvedAt='2026-10-29T11:00:00Z')),
        ('ai-approval-in-human-mode', lambda b: (b['record']['approvals'][0].pop('approvalSetRef'),
            b['record']['approvals'][0].update(authority='ai_panel', aiReviewApprovalSetRef=art(3080)))),
        ('ai-set-as-human-approval', lambda b: [a.update(approvalSetRef=art(3080)) for a in b['record']['approvals']]),
    ]:
        value = copy.deepcopy(bundle); mutate(value)
        if label in ('embargo-ai-only', 'security-flagged-ai-only'):
            embargo = copy.deepcopy(value['record']); make_ai(value)
            value['record'].update({k: embargo[k] for k in ('securityFlagged', 'embargoed', 'target') + (('securityGroupId',) if 'securityGroupId' in embargo else ())})
            value['targetDataClassification'] = 'internal'
        negative('delivery-'+label, 'delivery', value)
    value = copy.deepcopy(greenfield_record); value['record']['approvals'].pop(0); negative('delivery-greenfield-missing-intent-gate', 'delivery', value)
    value = copy.deepcopy(greenfield_record); value['record']['target'] = copy.deepcopy(record['target']); value['application'] = application
    negative('delivery-greenfield-pr', 'delivery', value)
    value = copy.deepcopy(embargoed); value['record']['target'].update(repositoryId=uid(20)); negative('delivery-embargoed-ordinary-docs-repo', 'delivery', value)
    value = copy.deepcopy(embargoed); value['publicationTarget']['securityGroupId'] = uid(3071); negative('delivery-embargoed-other-group-target', 'delivery', value)
    # ai-review authority for AI designs is resolved from the evaluated decision/panel evidence.
    for label, mutate in [
        ('revoked', lambda b: b.update(reviewEvidenceOverrides={'state': 'revoked'})),
        ('emergency-stop', lambda b: b.update(reviewEvidenceOverrides={'emergencyStop': True})),
        ('stale-qualification', lambda b: b.update(reviewEvidenceOverrides={'currentCohortRef': art(3099)})),
        ('expired-decision', lambda b: b['record'].update(deliveredAt='2027-01-20T00:00:00Z')),
        ('not-opted-in-application', lambda b: (b['record'].update(applicationId=uid(99)), b['application'].update(applicationId=uid(99)),
            b['taskView']['spec'].update(applicationIds=[uid(99)], targetContext={'kind': 'existing_application', 'applicationId': uid(99)}))),
        ('unknown-decision', lambda b: b['record'].update(reviewModeDecisionRef=art(9999))),
        ('unknown-approval-set', lambda b: (b['record']['approvals'][0].update(aiReviewApprovalSetRef=art(7777)),
            b['record']['aiReviewApprovalSetRefs'].__setitem__(0, art(7777)))),
        ('unflagged-embargoed-task', lambda b: b.update(taskView=task_view(base_view, record['taskId'], dict(embargoed_task, assurance='standard')))),
        ('incident-task', lambda b: b['taskView'].update(priorityClass='incident')),
    ]:
        value = copy.deepcopy(ai); mutate(value); negative('delivery-ai-only-'+label, 'delivery', value)
    ai_out = dict(copy.deepcopy(ai), outcome=ai_outcome)
    for label, mutate in [
        ('decision-differs', lambda b: b['outcome'].update(reviewModeDecisionRef=art(8888))),
        ('approval-set-differs', lambda b: b['outcome'].update(aiReviewApprovalSetRefs=[art(8889)])),
        ('revoked', lambda b: b.update(reviewEvidenceOverrides={'state': 'revoked'})),
    ]:
        value = copy.deepcopy(ai_out); mutate(value); negative('outcome-ai-'+label, 'outcome', value)
    for field in ('decisionRefs', 'voluntaryHumanReviewRefs'):
        value = copy.deepcopy(out); value['outcome'][field] = [art(3080)]
        negative('outcome-ai-ref-in-human-'+field, 'outcome', value)
    for label, mutate in [
        ('revoked', lambda b: b.update(reviewEvidenceOverrides={'state': 'revoked'})),
        ('stop', lambda b: b.update(reviewEvidenceOverrides={'emergencyStop': True})),
        ('cohort-change', lambda b: b.update(reviewEvidenceOverrides={'currentCohortRef': art(3099)})),
        ('expired', lambda b: b['binding'].update(evaluatedAt='2026-12-15T00:00:00Z')),
        ('hotfix', lambda b: b['buildTask'].update(priorityClass='incident')),
        ('out-of-scope-class', lambda b: b.update(buildChangeClass='unscoped-change')),
    ]:
        value = copy.deepcopy(ai_bind); mutate(value); negative('binding-ai-design-'+label+'-reuse', 'binding', value)
