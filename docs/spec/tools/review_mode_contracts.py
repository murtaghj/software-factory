"""Revision 1.13 ai-review/1.0 contracts and synthetic fixtures; no efficacy claim."""
import copy
import json

REPLACEABLE_REVIEW_GATES = ('intent_aligned', 'architecture_accepted', 'plan_accepted',
                            'plan_peer_approved', 'oracle_accepted', 'pr_review')
AI_MARKER = 'AI-reviewed — no human review'
PLAN_GATES = ('architecture_accepted', 'plan_accepted', 'plan_peer_approved')
PLAN_SECTIONS = ('intent_scope', 'current_state', 'design', 'interfaces_data', 'implementation',
                 'acceptance_tests', 'quality_security', 'delivery_recovery', 'operations',
                 'risks_decisions', 'definition_of_done', 'review_ownership')


# Shared by the generators and recursive validator. Citations never delegate
# approval authority; decision UUID projections use the ArtifactRef resolver.
REVIEW_FIELDS = {
    'human_authority': ('decisionRefs', 'decisionRef', 'decisionId', 'approvalSetRef',
        'planApprovalSetRef', 'intentDecisionRef', 'acceptedDecisionRef',
        'voluntaryHumanReviewRefs', 'acceptedReviewRef', 'clearanceDecisionRef',
        'unreproducedDecisionRef', 'pendingFactoryDecisionRefs', 'humanApprovals',
        'voluntaryHumanReviews', 'requiredDecisionIds', 'alignmentDecisionIds', 'pendingDecisionIds'),
    'ai_authority': ('aiReviewApprovalSetRefs', 'aiReviewApprovalSetRef', 'aiIntentApprovalSetRef',
        'aiDecisionRefs', 'AIReviewPage.approvalSetRefs'),
    'mode_authority': ('reviewModeDecisionRef', 'modeDecisionRef',
        'ApplicationReviewPolicy.decisionRef', 'ReviewModeStatus.decisionRef', 'ReviewModeTransition.decisionRef'),
    'citation': ('evidenceRefs', 'evidenceRef', 'sourceRefs', 'sourceRef', 'reviewEvidenceRef',
        'verificationEvidenceRef', 'recoveryEvidenceRef', 'providerEvidenceRef', 'acceptanceEvidenceRef',
        'selectionEvidenceRef', 'branchProtectionEvidenceRef', 'newEvidenceRefs', 'evidenceRequirementRefs'),
    'content': ('briefRef', 'intentBriefRef', 'packetRef', 'reviewPacketRef', 'contentRef'),
}
REVIEW_RECORD_BINDINGS = {'AIReviewDecision': 'decisions', 'AIReviewApprovalSet': 'approvalSet',
    'AIReviewPanelAssignment': 'assignment', 'AIReviewSubject': 'subject',
    'ReviewModeDecision': 'decision', 'ReviewModeRepositoryBinding': 'repositoryBinding'}
REVIEW_OUTPUTS = ('TaskView', 'PlanReviewView', 'IntentInterviewView', 'PRReviewState', 'OutcomeManifest', 'PullRequest')


def review_field_role(name, field):
    for key in (name + '.' + field, field):
        for role, fields in REVIEW_FIELDS.items():
            if key in fields:
                return role
    return None


def extend(D, define, ref, obj, text, integer, array, enum, UUID, TIME, BOOL, AR, ARS):
    def fields(name, values):
        D[name]['properties'].update(values)
    bp = dict(integer(), maximum=10000)
    D['ReviewMode'] = dict(enum('human', 'ai_only'), default='human')
    D['AIReviewGate'] = enum(*REPLACEABLE_REVIEW_GATES)
    define('ApplicationReviewScope', {'applicationId': UUID, 'workTypes': array(ref('WorkType'), 1),
        'changeClasses': array(text(), 1), 'pathProfileRef': AR, 'assuranceTiers': array(ref('Assurance'), 1)})
    define('ApplicationReviewPolicy', {'scope': ref('ApplicationReviewScope'), 'reviewMode': ref('ReviewMode'),
        'decisionRef': AR}, ('decisionRef',))
    D['ApplicationReviewPolicy']['allOf'] = [{'if': {'properties': {'reviewMode': {'const': 'ai_only'}}},
        'then': {'required': ['decisionRef']}}]
    define('ReviewModeOwnerApproval', {'actorKind': {'const': 'human'}, 'role': enum('policy_owner', 'application_owner'),
        'principalId': UUID, 'subjectRef': AR, 'subjectHash': ref('Digest'), 'approvedAt': TIME, 'authenticationRef': AR})
    define('ReviewModeDecision', {'schemaVersion': {'const': '2.0'}, 'id': UUID, 'reviewMode': {'const': 'ai_only'},
        'scope': ref('ApplicationReviewScope'), 'revision': integer(1), 'subjectRef': AR, 'subjectHash': ref('Digest'),
        'ownerApprovals': array(ref('ReviewModeOwnerApproval'), 2), 'policyRef': AR, 'validFrom': TIME, 'expiresAt': TIME,
        'qualificationCohortRef': AR, 'reviewerQualificationRefs': array(AR, 1), 'degradationPolicyRef': AR,
        'devRepositoryId': UUID, 'devRepositoryIdentity': ref('GitRepositoryIdentity'), 'devBranch': text(), 'factoryGitIdentityRef': AR, 'branchProtectionEvidenceRef': AR,
        'auditSampleBasisPoints': dict(bp, minimum=1), 'auditPolicyRef': AR,
        'repositoryBindingState': enum('pre_repository', 'bound'), 'repositoryIntentPolicyRef': AR},
        ('devRepositoryId', 'devRepositoryIdentity', 'branchProtectionEvidenceRef', 'repositoryIntentPolicyRef'))
    D['ReviewModeDecision']['properties']['ownerApprovals']['maxItems'] = 2
    D['ReviewModeDecision']['allOf'] = [
        {'properties': {'ownerApprovals': {'contains': {'properties': {'role': {'const': role}}}}}}
         for role in ('policy_owner', 'application_owner')]
    D['ReviewModeDecision']['allOf'].append({
        'if': {'properties': {'repositoryBindingState': {'const': 'bound'}}},
        'then': {'required': ['devRepositoryId', 'devRepositoryIdentity', 'branchProtectionEvidenceRef']},
        'else': {'required': ['repositoryIntentPolicyRef'], 'allOf': [
            {'not': {'required': [field]}} for field in ('devRepositoryId', 'devRepositoryIdentity', 'branchProtectionEvidenceRef')]}})
    define('ReviewModeRepositoryBinding', {'schemaVersion': {'const': '2.0'}, 'applicationId': UUID,
        'reviewModeDecisionRef': AR, 'repositoryIntentPolicyRef': AR, 'bootstrapReceiptRef': AR,
        'devRepositoryId': UUID, 'devRepositoryIdentity': ref('GitRepositoryIdentity'), 'devBranch': text(), 'factoryGitIdentityRef': AR,
        'branchProtectionEvidenceRef': AR, 'boundAt': TIME})
    define('ReviewModeTransition', {'schemaVersion': {'const': '2.0'}, 'applicationId': UUID, 'revision': integer(1),
        'decisionRef': AR, 'effectiveMode': {'const': 'human'}, 'reason': enum('revoked', 'expired', 'emergency_stop', 'degraded', 'configuration_changed'),
        'actorKind': enum('human', 'authorized_rule'), 'authorityRef': AR, 'effectiveAt': TIME})
    define('ReviewerConfiguration', {'schemaVersion': {'const': '2.0'}, 'modelFamily': text(), 'modelReleaseRef': AR,
        'promptRef': AR, 'toolSetRef': AR, 'evaluatorRef': AR, 'rolePackageRef': AR, 'behaviorReleaseRef': AR,
        'qualificationCohortRef': AR})
    define('ReviewerCorpusResult', {'kind': enum('plan', 'pr'), 'cleanCount': integer(1), 'seededDefectCount': integer(1),
        'caughtDefects': integer(), 'falseApprovals': integer(), 'breakdownRef': AR})
    define('ReviewerQualification', {'schemaVersion': {'const': '2.0'}, 'configurationRef': AR, 'corpusRef': AR,
        'thresholdsRef': AR, 'minimumCatchBasisPoints': bp, 'maximumFalseApprovalBasisPoints': bp,
        'results': array(ref('ReviewerCorpusResult'), 2), 'result': enum('passed', 'failed'), 'evaluatedAt': TIME,
        'qualificationCohortRef': AR, 'roleCoverageRef': AR})
    define('AIReviewerSlot', {'id': text(), 'role': enum('primary', 'peer', 'adversarial', 'specialist'),
        'specialistRole': text(), 'sectionIds': array(text(), 1), 'configurationRef': AR, 'modelFamily': text()}, ('specialistRole',))
    D['AIReviewerSlot']['allOf'] = [{'if': {'properties': {'role': {'const': 'specialist'}}}, 'then': {'required': ['specialistRole']}}]
    # Acyclic binding: assignment names content; subject names assignment; votes
    # name the subject. Never hash an assignment that points back to its subject.
    define('AIReviewSubject', {'schemaVersion': {'const': '2.0'}, 'taskId': UUID, 'gateId': ref('AIReviewGate'),
        'contentRef': AR, 'assignmentRef': AR, 'policyRef': AR, 'inputBindingRef': AR,
        'repositoryId': UUID, 'pullRequestId': text(), 'baseBranch': text(),
        'providerId': text(), 'headRepository': ref('GitRepositoryIdentity'), 'baseRepository': ref('GitRepositoryIdentity'),
        'expectedHead': ref('GitOid'), 'expectedBase': ref('GitOid')},
        ('repositoryId', 'pullRequestId', 'baseBranch', 'expectedHead', 'expectedBase', 'providerId', 'headRepository', 'baseRepository'))
    D['AIReviewSubject']['allOf'] = [{'if': {'properties': {'gateId': {'const': 'pr_review'}}},
        'then': {'required': ['repositoryId', 'pullRequestId', 'baseBranch', 'expectedHead', 'expectedBase', 'providerId', 'headRepository', 'baseRepository']}}]
    define('AIReviewPanelAssignment', {'schemaVersion': {'const': '2.0'}, 'taskId': UUID, 'applicationId': UUID,
        'gateId': ref('AIReviewGate'), 'contentRef': AR, 'policyRef': AR,
        'reviewModeDecisionRef': AR, 'authorModelFamily': text(), 'authorConfigurationRef': AR, 'assurance': ref('Assurance'),
        'slots': array(ref('AIReviewerSlot'), 2), 'requiredSpecialistRoles': array(text()),
        'verdictVisibility': {'const': 'isolated_until_all_submitted'}, 'round': integer(1)})
    primary = {'properties': {'role': {'const': 'primary'}}}
    D['AIReviewPanelAssignment']['allOf'] = [
        {'properties': {'slots': {'contains': primary, 'minContains': 1, 'maxContains': 1}}},
        {'if': {'properties': {'gateId': enum(*PLAN_GATES)}}, 'then': {'properties': {'slots': {
            'items': {'properties': {'sectionIds': {'items': ref('PlanSectionId')}}},
            'contains': {'properties': {'role': {'const': 'primary'}, 'sectionIds': {
                'uniqueItems': True, 'allOf': [{'contains': {'const': section}} for section in PLAN_SECTIONS]}}}}}}},
        {'if': {'properties': {'gateId': enum('plan_accepted', 'plan_peer_approved', 'oracle_accepted')}},
         'then': {'properties': {'slots': {'contains': {'properties': {'role': {'const': 'adversarial'}}}}}}},
        {'if': {'properties': {'assurance': {'const': 'enhanced'}}},
         'then': {'properties': {'slots': {'contains': {'properties': {'role': enum('primary', 'peer')}}, 'minContains': 3}}},
         'else': {'properties': {'slots': {'contains': {'properties': {'role': enum('primary', 'peer')}}, 'minContains': 2}}}},
    ]
    define('AIReviewDecision', {'schemaVersion': {'const': '2.0'}, 'decisionKind': {'const': 'ai_review'},
        'taskId': UUID, 'gateId': ref('AIReviewGate'), 'subjectRef': AR, 'subjectHash': ref('Digest'), 'assignmentRef': AR,
        'reviewerSlotId': text(), 'reviewerConfigurationRef': AR, 'modelFamily': text(), 'round': integer(1),
        'verdict': enum('approve', 'reject', 'request_changes'), 'findingRefs': ARS,
        'reviewedSectionIds': dict(array(text(), 1), uniqueItems=True), 'reviewEvidenceRef': AR, 'submittedAt': TIME})
    define('AIReviewApprovalSet', {'schemaVersion': {'const': '2.0'}, 'taskId': UUID, 'gateId': ref('AIReviewGate'),
        'subjectRef': AR, 'subjectHash': ref('Digest'), 'assignmentRef': AR, 'reviewModeDecisionRef': AR,
        'aiDecisionRefs': array(AR, 2), 'aggregation': {'const': 'unanimous'}, 'round': integer(1)})
    define('AIReviewAdjudication', {'schemaVersion': {'const': '2.0'}, 'taskId': UUID, 'subjectRef': AR,
        'subjectHash': ref('Digest'), 'assignmentRef': AR, 'reviewModeDecisionRef': AR, 'findingRef': AR,
        'adjudicatorConfigurationRef': AR, 'qualificationRef': AR, 'modelFamily': text(),
        'authorConfigurationRef': AR, 'panelConfigurationRefs': array(AR, 2), 'rebuttalRef': AR,
        'evidenceRef': AR, 'outcome': enum('upheld', 'rejected', 'escalate_human'), 'completedAt': TIME,
        'reviewRound': integer(1), 'rebuttalRound': {'const': 1}, 'adjudicationRound': {'const': 1}})
    define('AIReviewFinding', {'schemaVersion': {'const': '2.0'}, 'taskId': UUID, 'subjectRef': AR,
        'assignmentRef': AR, 'round': integer(1), 'blocking': BOOL, 'status': enum('open', 'fixed', 'rejected'),
        'dispositionRef': AR}, ('dispositionRef',))
    D['AIReviewFinding']['allOf'] = [{'if': {'properties': {'status': enum('fixed', 'rejected')}},
        'then': {'required': ['dispositionRef']}, 'else': {'not': {'required': ['dispositionRef']}}}]
    define('AIReviewFindingResolution', {'schemaVersion': {'const': '2.0'}, 'taskId': UUID,
        'findingRef': AR, 'originalSubjectRef': AR, 'correctedSubjectRef': AR,
        'verificationEvidenceRef': AR, 'resolvedAt': TIME})
    define('AIReviewPage', {'items': array(ref('AIReviewDecision')), 'approvalSetRefs': ARS, 'nextCursor': text()}, ('nextCursor',))
    define('ReviewModeStatus', {'reviewMode': ref('ReviewMode'), 'status': enum('human', 'active', 'suspended', 'expired', 'revoked'),
        'revision': integer(), 'decisionRef': AR, 'expiresAt': TIME, 'reason': text(), 'auditBacklog': integer(),
        'overdueAudits': integer()}, ('decisionRef', 'expiresAt', 'reason'))
    D['ReviewModeStatus']['allOf'] = [{'if': {'properties': {'status': {'const': 'active'}}},
        'then': {'required': ['decisionRef', 'expiresAt'], 'properties': {'reviewMode': {'const': 'ai_only'}}},
        'else': {'properties': {'reviewMode': {'const': 'human'}}}}]
    define('ReviewAuditSelection', {'schemaVersion': {'const': '2.0'}, 'taskId': UUID, 'applicationId': UUID,
        'reviewModeDecisionRef': AR, 'sampleBasisPoints': dict(bp, minimum=1), 'selected': BOOL, 'selectedAt': TIME, 'selectionEvidenceRef': AR})
    define('ReviewAuditResult', {'schemaVersion': {'const': '2.0'}, 'taskId': UUID, 'selectionRef': AR,
        'outcomeRef': AR, 'auditorPrincipalId': UUID, 'actorKind': {'const': 'human'}, 'findingRefs': ARS,
        'result': enum('pass', 'missed_defect', 'inconclusive'), 'completedAt': TIME})
    # Human wire shapes stay human; absence on historical data still means human,
    # never permission to place an AI record behind a human artifact reference.
    for name in ('DecisionView', 'DecisionResponse', 'PlanApprovalSet', 'IntentApprovalSet'):
        fields(name, {'actorKind': {'const': 'human'}})
    D['GateMode']['enum'].append('ai_panel')
    fields('GateModeRule', {'reviewModeDecisionRef': AR})
    from operational_contracts import MANDATORY_HUMAN_GATES
    human = {'properties': {'mode': {'const': 'human'}, 'humanFloor': {'const': True}}}
    panel = {'required': ['reviewModeDecisionRef'], 'properties': {'mode': {'const': 'ai_panel'}, 'humanFloor': {'const': False}, 'sampleBasisPoints': {'const': 0}}}
    D['GateModeRule']['allOf'] = [
        {'if': {'properties': {'gateId': {'const': 'release_authorized'}}}, 'then': human},
        {'if': {'properties': {'gateId': enum(*(g for g in MANDATORY_HUMAN_GATES if g != 'release_authorized'))}},
         'then': {'oneOf': [human, panel]}},
        {'if': {'properties': {'mode': {'const': 'ai_panel'}}}, 'then': dict(panel, properties={**panel['properties'],
            'gateId': enum(*(g for g in REPLACEABLE_REVIEW_GATES if g != 'pr_review'))})},
        {'if': {'properties': {'humanFloor': {'const': True}}}, 'then': {'properties': {'mode': {'const': 'human'}}}},
    ]
    # Shape is necessary but not authority. The resolver checks the referenced
    # decision's current state/scope/qualification before returning ai_panel.
    # An autonomy rule cannot use establishment as a disguised relaxation.
    D['AutonomyPolicyDecision']['allOf'].append({
        'if': {'properties': {'actorKind': {'const': 'authorized_rule'}}},
        'then': {'properties': {'gateModes': {'items': {'not': {'properties': {'mode': {'const': 'ai_panel'}}}}}}}})
    fields('PolicyProfile', {'applicationReviewPolicies': array(ref('ApplicationReviewPolicy'))})
    fields('ApplicationView', {'reviewModeStatus': ref('ReviewModeStatus')})
    fields('PullRequest', {'taskId': UUID})
    fields('PRHeadObservation', {'baseBranch': text(), 'baseCommit': ref('GitOid'),
        'headRepository': ref('GitRepositoryIdentity'), 'baseRepository': ref('GitRepositoryIdentity')})
    for name in REVIEW_OUTPUTS:
        fields(name, {'reviewMode': ref('ReviewMode'), 'reviewModeDecisionRef': AR, 'reviewMarker': {'const': AI_MARKER},
            'reviewSubjectRef': AR, 'aiReviewApprovalSetRefs': ARS, 'voluntaryHumanReviewRefs': ARS})
        D[name].setdefault('allOf', []).append({'if': {'required': ['reviewMode'], 'properties': {'reviewMode': {'const': 'ai_only'}}},
            'then': {'required': ['reviewModeDecisionRef', 'reviewSubjectRef', 'reviewMarker', 'aiReviewApprovalSetRefs', 'voluntaryHumanReviewRefs']
                     + (['taskId'] if name == 'PullRequest' else [])}})
        # New AI fields cannot masquerade as a legacy human record by omitting mode.
        for field in ('reviewModeDecisionRef', 'reviewSubjectRef', 'aiReviewApprovalSetRefs', 'reviewMarker'):
            D[name]['allOf'].append({'if': {'required': [field]}, 'then': {
                'required': ['reviewMode', 'reviewMarker'], 'properties': {'reviewMode': {'const': 'ai_only'}}}})
    for name in ('InputBinding', 'ExecutionPlan', 'WorkflowCheckpoint', 'PlanReviewState', 'IntentInterviewState'):
        fields(name, {'reviewMode': ref('ReviewMode'), 'reviewModeDecisionRef': AR,
            'aiReviewApprovalSetRef': AR, 'aiIntentApprovalSetRef': AR, 'reviewQualificationProfile': {'const': 'ai-review/1.0'}})
    for name in ('InputBinding', 'ExecutionPlan', 'WorkflowCheckpoint', 'PlanReviewState', 'IntentInterviewState'):
        D[name].setdefault('allOf', []).append({
            'if': {'required': ['reviewMode'], 'properties': {'reviewMode': {'const': 'ai_only'}}},
            'then': {'required': ['reviewModeDecisionRef', 'reviewQualificationProfile'],
                     'allOf': [{'not': {'required': ['planApprovalSetRef']}}, {'not': {'required': ['intentDecisionRef']}}, {'not': {'required': ['approvalSetRef']}}, {'not': {'required': ['acceptedDecisionRef']}}]}})
    fields('WorkflowTemplateDefinition', {'reviewQualificationProfile': {'const': 'ai-review/1.0'}})
    fields('BehaviorRelease', {'reviewQualificationProfile': {'const': 'ai-review/1.0'}, 'reviewerQualificationRefs': ARS})
    D['HealthMetric']['properties']['name']['enum'] += ['ai_audit_misses', 'ai_audit_backlog', 'ai_merged_reverts', 'reviewer_disagreements']

    annotate_review_fields(D)


def annotate_review_fields(D):
    # Idempotent; build_contracts.py calls it again after later modules define their records.
    for name, schema in D.items():
        if name.endswith('FrozenToolsV1'):
            continue
        if name in REVIEW_RECORD_BINDINGS:
            schema['x-review-bundle-key'] = REVIEW_RECORD_BINDINGS[name]
        for field, shape in schema.get('properties', {}).items():
            role = review_field_role(name, field)
            if role:
                schema['properties'][field] = dict(shape, **{'x-review-field-role': role})


def examples(E, write, uid, art, task):
    folder = E/'ai-review'; folder.mkdir(exist_ok=True)
    repository_identity = {'providerId': 'github-reference', 'installationRef': 'installation:demo', 'externalId': 'repo20'}
    scope = {'applicationId': uid(10), 'workTypes': ['feature', 'bug', 'maintenance'], 'changeClasses': ['fixture'],
             'pathProfileRef': art(1601), 'assuranceTiers': ['fast', 'standard', 'enhanced']}
    decision = {'schemaVersion': '2.0', 'id': uid(1602), 'reviewMode': 'ai_only', 'scope': scope, 'revision': 1,
        'subjectRef': art(1603), 'subjectHash': art(1603)['sha256'], 'ownerApprovals': [], 'policyRef': art(1604),
        'validFrom': '2026-10-29T00:00:00Z', 'expiresAt': '2026-11-29T00:00:00Z',
        'qualificationCohortRef': art(1605), 'reviewerQualificationRefs': [], 'degradationPolicyRef': art(1606),
        'repositoryBindingState': 'bound', 'devRepositoryId': uid(20), 'devRepositoryIdentity': repository_identity, 'devBranch': 'dev', 'factoryGitIdentityRef': art(1607),
        'branchProtectionEvidenceRef': art(1608), 'auditSampleBasisPoints': 2000, 'auditPolicyRef': art(1609)}
    for n, role in enumerate(('policy_owner', 'application_owner')):
        decision['ownerApprovals'].append({'actorKind': 'human', 'role': role, 'principalId': uid(1610+n),
            'subjectRef': decision['subjectRef'], 'subjectHash': decision['subjectHash'],
            'approvedAt': '2026-10-29T00:00:00Z', 'authenticationRef': art(1612+n)})
    assignment = {'schemaVersion': '2.0', 'taskId': task['taskId'] if 'taskId' in task else uid(2),
        'applicationId': uid(10), 'gateId': 'plan_peer_approved', 'contentRef': art(1621),
        'policyRef': art(1604), 'reviewModeDecisionRef': art(1615), 'authorModelFamily': 'fixture-family-a', 'authorConfigurationRef': art(1623),
        'assurance': 'standard', 'slots': [], 'requiredSpecialistRoles': ['security'],
        'verdictVisibility': 'isolated_until_all_submitted', 'round': 1}
    subject={'schemaVersion': '2.0', 'taskId': assignment['taskId'], 'gateId': assignment['gateId'],
        'providerId': repository_identity['providerId'], 'headRepository': repository_identity, 'baseRepository': repository_identity,
        'contentRef': assignment['contentRef'], 'assignmentRef': art(1710), 'policyRef': art(1604), 'inputBindingRef': art(1622)}
    configurations=[]; qualifications=[]; votes=[]
    for n,role in enumerate(('primary', 'peer', 'adversarial', 'specialist')):
        family = 'fixture-family-a' if n == 0 else 'fixture-family-b'
        config = {'schemaVersion': '2.0', 'modelFamily': family, 'modelReleaseRef': art(1630+n), 'promptRef': art(1640+n),
            'toolSetRef': art(1650), 'evaluatorRef': art(1651), 'rolePackageRef': art(1660+n),
            'behaviorReleaseRef': art(1670), 'qualificationCohortRef': art(1605)}
        config_ref=art(1680+n); qref=art(1690+n)
        configurations.append({'ref': config_ref, 'value': config})
        qualification={'schemaVersion': '2.0', 'configurationRef': config_ref, 'corpusRef': art(1700),
            'thresholdsRef': art(1701), 'minimumCatchBasisPoints': 9000, 'maximumFalseApprovalBasisPoints': 1000,
            'results': [{'kind': kind, 'cleanCount': 10, 'seededDefectCount': 10, 'caughtDefects': 10,
                        'falseApprovals': 0, 'breakdownRef': art(1702)} for kind in ('plan', 'pr')],
            'result': 'passed', 'evaluatedAt': '2026-10-28T12:00:00Z', 'qualificationCohortRef': art(1605), 'roleCoverageRef': art(1703)}
        qualifications.append({'ref': qref, 'value': qualification});decision['reviewerQualificationRefs'].append(qref)
        slot={'id': 'slot-'+str(n), 'role': role, 'sectionIds': list(PLAN_SECTIONS) if role == 'primary' else ['design', 'quality_security'],
            'configurationRef': config_ref, 'modelFamily': family}
        if role=='specialist':slot['specialistRole']='security'
        assignment['slots'].append(slot)
        vote={'schemaVersion': '2.0', 'decisionKind': 'ai_review', 'taskId': assignment['taskId'], 'gateId': assignment['gateId'],
            'subjectRef': art(1620), 'subjectHash': art(1620)['sha256'], 'assignmentRef': art(1710),
            'reviewerSlotId': slot['id'], 'reviewerConfigurationRef': config_ref, 'modelFamily': family, 'round': 1,
            'verdict': 'approve', 'findingRefs': [], 'reviewedSectionIds': slot['sectionIds'],
            'reviewEvidenceRef': art(1720+n), 'submittedAt': '2026-10-29T12:00:00Z'}
        votes.append({'ref': art(1730+n), 'value': vote})
    approval={'schemaVersion': '2.0', 'taskId': assignment['taskId'], 'gateId': assignment['gateId'],
        'subjectRef': art(1620), 'subjectHash': art(1620)['sha256'], 'assignmentRef': art(1710),
        'reviewModeDecisionRef': art(1615), 'aiDecisionRefs': [v['ref'] for v in votes], 'aggregation': 'unanimous', 'round': 1}
    bundle={'now': '2026-10-29T12:01:00Z', 'reviewMode': 'ai_only', 'decisionRef': art(1615), 'decision': decision,
        'state': 'active', 'emergencyStop': False, 'embargoed': False, 'urgentHotfix': False, 'workType': 'feature',
        'changeClass': 'fixture', 'pathProfileRef': scope['pathProfileRef'], 'currentCohortRef': art(1605),
        'subjectRef': art(1620), 'subject': subject, 'assignmentRef': art(1710), 'assignment': assignment, 'configurations': configurations,
        'qualifications': qualifications, 'decisions': votes, 'approvalSet': approval, 'openBlockingFindings': [],
        'humanApprovals': [], 'voluntaryHumanReviews': [], 'humanArtifacts': [], 'reviewMarker': AI_MARKER,
        'approvalSetRef': art(1740), 'priorDecisions': [], 'priorAssignments': [], 'findings': [], 'adjudications': [], 'findingResolutions': [],
        'requiredSpecialistScopes': {'security': ['quality_security']}, 'executionStartedAt': '2026-10-29T01:00:00Z'}
    # Trusted task snapshot accompanies authority evidence for standalone outputs.
    task_spec = json.loads((E/'feature-task.json').read_text())
    task_spec.update(assurance=assignment['assurance'], repositoryIds=[decision['devRepositoryId']])
    bundle['taskView'] = {'id':assignment['taskId'], 'orgId':uid(1), 'creatorId':uid(1), 'ownerPrincipalId':uid(1),
        'spec':task_spec, 'status':'running', 'revision':1, 'planVersion':1, 'projectionSequence':1,
        'projectedAt':bundle['now'], 'createdAt':decision['validFrom'], 'updatedAt':bundle['now'],
        'cleanupState':'pending', 'lastEventSequence':1, 'priorityClass':'normal', 'changeClass':bundle['changeClass']}
    write(folder/'application-review-policy.json', {'scope': scope, 'reviewMode': 'ai_only', 'decisionRef': bundle['decisionRef']})
    write(folder/'gate-mode-rule.json', {'gateId': assignment['gateId'], 'mode': 'ai_panel', 'humanFloor': False,
        'sampleBasisPoints': 0, 'reviewModeDecisionRef': bundle['decisionRef']})
    marker={'reviewMode': 'ai_only', 'reviewModeDecisionRef': bundle['decisionRef'], 'reviewSubjectRef': bundle['subjectRef'], 'reviewMarker': AI_MARKER,
        'aiReviewApprovalSetRefs': [art(1740)], 'voluntaryHumanReviewRefs': []}
    # No-change export still records the mode honestly without inventing a PR.
    outcome=json.loads((E/'outcome-already_compliant.json').read_text());outcome.update(marker, completedAt=bundle['now'])
    write(folder/'outcome-manifest.json',outcome)
    pr=json.loads((E/'draft-preview-pr.json').read_text())
    pr.update(marker,aiReviewApprovalSetRefs=[],taskId=assignment['taskId'],baseBranch=decision['devBranch'])
    write(folder/'draft-preview-pr.json',pr)
    write(folder/'in-force.json',bundle)
    write(folder/'review-mode-decision.json',decision)
    write(folder/'ai-review-subject.json',subject)
    write(folder/'ai-review-decision.json',votes[0]['value'])
    write(folder/'reviewer-qualification.json',qualifications[0]['value'])
    audit={'schemaVersion': '2.0', 'taskId': assignment['taskId'], 'applicationId': scope['applicationId'],
        'reviewModeDecisionRef': bundle['decisionRef'], 'sampleBasisPoints': decision['auditSampleBasisPoints'],
        'selected': True, 'selectedAt': '2026-10-29T00:30:00Z', 'selectionEvidenceRef': art(1741)}
    write(folder/'audit-selection.json',audit)
    # A pre-repository joint decision is bound to the draft application and an
    # organization namespace policy, without fabricating an existing repository.
    pre=copy.deepcopy(bundle); pre['decision']['repositoryBindingState']='pre_repository'
    pre['decision']['repositoryIntentPolicyRef']=art(1742)
    pre['taskView']['spec']['repositoryIds']=[]
    for field in ('devRepositoryId','devRepositoryIdentity','branchProtectionEvidenceRef'):pre['decision'].pop(field)
    write(folder/'pre-repository.json',pre)
    bound=copy.deepcopy(pre)
    bound['taskView']['spec']['repositoryIds']=[uid(20)]
    bound['repositoryBinding']={'schemaVersion': '2.0', 'applicationId': scope['applicationId'],
        'reviewModeDecisionRef': bundle['decisionRef'], 'repositoryIntentPolicyRef': art(1742),
        'bootstrapReceiptRef': art(1743), 'devRepositoryId': uid(20), 'devRepositoryIdentity': repository_identity, 'devBranch': 'dev',
        'factoryGitIdentityRef': art(1607), 'branchProtectionEvidenceRef': art(1608), 'boundAt': '2026-10-29T11:00:00Z'}
    write(folder/'repository-bound.json',bound)
    def pr_review(value):
        value=copy.deepcopy(value)
        for record in [value['assignment'], value['approvalSet'], value['subject']] + [v['value'] for v in value['decisions']]:
            record['gateId']='pr_review'
        value['subject'].update(repositoryId=pr['repositoryId'],pullRequestId=pr['externalId'],baseBranch=pr['baseBranch'],
                                expectedHead=pr['headCommit'],expectedBase=pr['baseCommit'])
        return value
    pr_bundle=pr_review(bound)
    write(folder/'pr-panel.json',pr_bundle)
    merged=copy.deepcopy(pr);merged.update(state='merged',draft=False,aiReviewApprovalSetRefs=[bundle['approvalSetRef']])
    write(folder/'merged-dev-pr.json',merged)
    # Retain the original finding and votes through adjudication; every reviewer
    # casts a fresh unanimous vote after the independent adjudicator resolves it.
    adjudicated=copy.deepcopy(bundle)
    config=copy.deepcopy(configurations[0]);config['ref']=art(1750);config['value']['rolePackageRef']=art(1751)
    q=copy.deepcopy(qualifications[0]);q['ref']=art(1752);q['value']['configurationRef']=config['ref']
    adjudicated['configurations'].append(config);adjudicated['qualifications'].append(q)
    adjudicated['decision']['reviewerQualificationRefs'].append(q['ref'])
    adjudicated['priorDecisions']=copy.deepcopy(votes)
    adjudicated['priorAssignments']=[{'ref': bundle['assignmentRef'], 'value': copy.deepcopy(assignment)}]
    adjudicated['priorDecisions'][0]['value'].update(verdict='request_changes',findingRefs=[art(1753)])
    for n,vote in enumerate(adjudicated['decisions']):
        vote['ref']=art(1760+n);vote['value'].update(round=2, submittedAt='2026-10-29T12:00:30Z')
    adjudicated['assignment']['round']=2;adjudicated['approvalSet']['round']=2
    adjudicated['assignmentRef']=art(1770);adjudicated['subjectRef']=art(1771)
    adjudicated['subject']['assignmentRef']=adjudicated['assignmentRef']
    for value in [adjudicated['approvalSet']] + [v['value'] for v in adjudicated['decisions']]:
        value.update(assignmentRef=adjudicated['assignmentRef'], subjectRef=adjudicated['subjectRef'], subjectHash=adjudicated['subjectRef']['sha256'])
    adjudicated['approvalSet']['aiDecisionRefs']=[v['ref'] for v in adjudicated['decisions']]
    adjudicated['findings']=[{'ref': art(1753), 'value': {'schemaVersion': '2.0', 'taskId': assignment['taskId'],
        'subjectRef': bundle['subjectRef'], 'assignmentRef': bundle['assignmentRef'], 'round': 1,
        'blocking': True, 'status': 'rejected', 'dispositionRef': art(1754)}}]
    adjudicated['adjudications']=[{'ref': art(1754), 'value': {'schemaVersion': '2.0', 'taskId': assignment['taskId'],
        'subjectRef': bundle['subjectRef'], 'subjectHash': bundle['subjectRef']['sha256'], 'assignmentRef': bundle['assignmentRef'],
        'reviewModeDecisionRef': bundle['decisionRef'], 'findingRef': art(1753), 'adjudicatorConfigurationRef': config['ref'],
        'qualificationRef': q['ref'], 'modelFamily': config['value']['modelFamily'],
        'authorConfigurationRef': assignment['authorConfigurationRef'],
        'panelConfigurationRefs': [s['configurationRef'] for s in assignment['slots']], 'rebuttalRef': art(1755),
        'evidenceRef': art(1756), 'outcome': 'rejected', 'completedAt': '2026-10-29T12:00:15Z',
        'reviewRound': 1, 'rebuttalRound': 1, 'adjudicationRound': 1}}]
    write(folder/'adjudicated.json',adjudicated)
    fixed=copy.deepcopy(adjudicated);fixed['adjudications']=[]
    fixed['findings'][0]['value'].update(status='fixed',dispositionRef=art(1772))
    fixed['findingResolutions']=[{'ref': art(1772), 'value': {'schemaVersion': '2.0', 'taskId': assignment['taskId'],
        'findingRef': art(1753), 'originalSubjectRef': bundle['subjectRef'], 'correctedSubjectRef': fixed['subjectRef'],
        'verificationEvidenceRef': art(1773), 'resolvedAt': '2026-10-29T12:00:15Z'}}]
    write(folder/'fixed-finding.json',fixed)
    voluntary=copy.deepcopy(bundle)
    # A human decision remains in its own immutable record, resolved separately.
    human_vote={'id': uid(1774), 'taskId': assignment['taskId'], 'action': 'approve_plan',
        'subjectHash': bundle['subjectRef']['sha256'], 'subjectRef': bundle['subjectRef'], 'policyRef': decision['policyRef'],
        'evidenceRefs': [art(1775)], 'eligibleRoles': ['engineering_peer'], 'state': 'approved',
        'reason': 'Separate voluntary human review of this exact subject.', 'expiresAt': decision['expiresAt'],
        'deciderId': uid(1776), 'requiredPrincipalId': uid(1776), 'actorKind': 'human'}
    voluntary['humanArtifacts']=[{'ref': art(1774), 'value': human_vote}]
    voluntary['voluntaryHumanReviews']=[dict(art(1774),actorKind='human')]
    write(folder/'voluntary-human-review.json',voluntary)
    invalid={}
    def bad(name, mutate):
        value=copy.deepcopy(bundle);mutate(value);invalid[name]=value
    bad('expired',lambda b:b['decision'].update(expiresAt='2026-10-29T12:00:00Z'))
    bad('revoked',lambda b:b.update(state='revoked'))
    bad('missing',lambda b:b.pop('decision'))
    bad('release',lambda b:b['assignment'].update(gateId='release_authorized'))
    bad('embargoed',lambda b:b.update(embargoed=True))
    bad('hotfix',lambda b:b.update(urgentHotfix=True))
    bad('ai-as-human',lambda b:b['humanApprovals'].append(b['decisions'][0]['value']))
    def single_family(b):
        for item in b['configurations']:item['value']['modelFamily']='fixture-family-a'
        for slot in b['assignment']['slots']:slot['modelFamily']='fixture-family-a'
        for vote in b['decisions']:vote['value']['modelFamily']='fixture-family-a'
    bad('single-family',single_family)
    bad('majority-only',lambda b:b['decisions'][-1]['value'].update(verdict='reject'))
    bad('majority-label',lambda b:b['approvalSet'].update(aggregation='majority'))
    bad('configuration-changed',lambda b:b.update(currentCohortRef=art(1799)))
    bad('emergency-stop',lambda b:b.update(emergencyStop=True))
    bad('ai-reference-as-human',lambda b:b['humanApprovals'].append(dict(b['decisions'][0]['ref'], actorKind='human')))
    bad('wrong-application',lambda b:b['assignment'].update(applicationId=uid(999)))
    bad('not-yet-valid',lambda b:b['decision'].update(validFrom='2026-10-30T00:00:00Z'))
    bad('missing-owner',lambda b:b['decision']['ownerApprovals'].pop())
    bad('missing-specialist',lambda b:b['assignment']['slots'].pop())
    bad('missing-adversarial',lambda b:b['assignment']['slots'].pop(2))
    bad('stale-subject',lambda b:b['decisions'][0]['value'].update(subjectRef=art(1799)))
    bad('qualification-failed',lambda b:b['qualifications'][0]['value']['results'][0].update(caughtDefects=0))
    bad('unresolved-finding',lambda b:b['openBlockingFindings'].append(art(1798)))
    bad('shared-verdicts',lambda b:b['assignment'].update(verdictVisibility='shared'))
    bad('enhanced-small-panel',lambda b:b['assignment'].update(assurance='enhanced'))
    bad('missing-marker',lambda b:b.pop('reviewMarker'))
    bad('future-owner-approvals',lambda b:[a.update(approvedAt='2026-11-01T00:00:00Z') for a in b['decision']['ownerApprovals']])
    bad('late-establishment-approvals',lambda b:[a.update(approvedAt='2026-10-29T01:00:00Z') for a in b['decision']['ownerApprovals']])
    bad('dropped-finding',lambda b:b['decisions'][0]['value']['findingRefs'].append(b['subjectRef']))
    bad('no-primary',lambda b:b['assignment']['slots'][0].update(role='peer'))
    bad('incomplete-primary',lambda b:b['assignment']['slots'][0].update(sectionIds=['design','quality_security']))
    bad('incomplete-vote-coverage',lambda b:b['decisions'][0]['value'].update(reviewedSectionIds=['design','quality_security']))
    bad('missing-specialist-scope',lambda b:b['assignment']['slots'][-1].update(sectionIds=['design']))
    human={'schemaVersion': '2.0', 'taskId': assignment['taskId'], 'subjectRef': bundle['subjectRef'],
           'actorKind': 'human', 'decisionRefs': approval['aiDecisionRefs']}
    bad('ai-refs-in-human-plan-set',lambda b:b['humanApprovals'].append(human))
    bad('ai-refs-in-voluntary-human-set',lambda b:b['voluntaryHumanReviews'].append(human))
    def indirect_human(b):
        b['humanArtifacts']=[{'ref': art(1780), 'value': human}]
        b['humanApprovals']=[dict(art(1780),actorKind='human')]
    bad('indirect-ai-refs-in-human-set',indirect_human)
    for name, mutate in {
        'self-adjudication': lambda b:b['adjudications'][0]['value'].update(
            adjudicatorConfigurationRef=b['assignment']['authorConfigurationRef']),
        'panel-adjudication': lambda b:b['adjudications'][0]['value'].update(
            adjudicatorConfigurationRef=b['assignment']['slots'][0]['configurationRef'],qualificationRef=b['qualifications'][0]['ref']),
        'unqualified-adjudicator': lambda b:b['qualifications'][-1]['value'].update(result='failed'),
        'adjudication-no-fresh-votes': lambda b:b['decisions'][0]['value'].update(submittedAt='2026-10-29T12:00:00Z'),
        'adjudication-wrong-finding': lambda b:b['adjudications'][0]['value'].update(findingRef=art(1798)),
        'adjudication-over-bound': lambda b:b['adjudications'][0]['value'].update(adjudicationRound=2),
        'adjudication-escalated': lambda b:b['adjudications'][0]['value'].update(outcome='escalate_human'),
        'adjudication-missing': lambda b:b.update(adjudications=[]),
        'adjudication-upheld': lambda b:b['adjudications'][0]['value'].update(outcome='upheld'),
        'adjudication-too-many': lambda b:b['adjudications'].append(copy.deepcopy(b['adjudications'][0])),
    }.items():
        value=copy.deepcopy(adjudicated);mutate(value);invalid[name]=value
    unresolved=copy.deepcopy(adjudicated);unresolved['adjudications']=[]
    unresolved['findings'][0]['value']['status']='open';unresolved['findings'][0]['value'].pop('dispositionRef')
    invalid['dropped-ledger-blocker']=unresolved
    for name,value in invalid.items():write(folder/('invalid-'+name+'.json'),value)
    # Non-panel negatives carry an explicit evaluator; never count rejection by a
    # missing unrelated bundle field as a successful counterexample check.
    def negative(name, kind, value, evidence=None, error=None):
        case={'kind': kind, 'value': value}
        if evidence is not None:case['bundle']=evidence
        if error is not None:case['error']=error
        write(folder/('negative-'+name+'.json'), case)
    for name,value in [('OutcomeManifest',outcome),('PullRequest',pr)]:
        for removed in [('reviewMarker',),('reviewMode','reviewMarker')]:
            unmarked=copy.deepcopy(value)
            for field in removed:unmarked.pop(field)
            negative(name.lower()+'-without-'+'-'.join(removed), name, unmarked)
        human_mode=copy.deepcopy(value);human_mode['reviewMode']='human'
        negative(name.lower()+'-ai-fields-human-mode',name,human_mode)
    for mode in ('automated','human_sampled'):
        for review_mode in ('human','ai_only'):
            value=copy.deepcopy(bundle);value['assignment']['assurance']='enhanced';value['reviewMode']=review_mode;value['decision']=None
            negative('enhanced-oracle-'+mode+'-'+review_mode, 'gate', {'bundle': value, 'rule': {
                'gateId': 'oracle_accepted', 'mode': mode, 'humanFloor': False, 'sampleBasisPoints': 1000 if mode=='human_sampled' else 0}})
    early=copy.deepcopy(outcome);early['completedAt']='2026-10-09T12:00:00Z'
    negative('outcome-before-authority','OutcomeManifest',early)
    for rate in (0,1000):
        bad_audit=copy.deepcopy(audit);bad_audit['sampleBasisPoints']=rate
        negative('audit-rate-'+str(rate),'audit',bad_audit)
    negative('merge-before-repository-binding','repository',pre)
    wrong=copy.deepcopy(bound);wrong['repositoryBinding']['applicationId']=uid(999)
    negative('repository-binding-wrong-application','repository',wrong)
    missing=copy.deepcopy(pre);missing['decision'].pop('repositoryIntentPolicyRef')
    negative('pre-repository-without-policy','ReviewModeDecision',missing['decision'])
    fabricated=copy.deepcopy(pre);fabricated['decision']['devRepositoryId']=uid(20)
    negative('pre-repository-fabricated-id','ReviewModeDecision',fabricated['decision'])
    # Second repair: schema-valid reproductions assert the semantic rejection,
    # including output fields rather than only the panel's internal records.
    def output_case(label, kind, source, evidence, mutate, error):
        value=copy.deepcopy(source);evidence=copy.deepcopy(evidence)
        mutate(value,evidence)
        negative(label,kind,value,evidence,error)
    for kind,source,evidence in [('OutcomeManifest',outcome,bundle),('PullRequest',pr,pr_bundle)]:
        for mode in ('ai_only','human','legacy'):
            for field in (('decisionRefs','voluntaryHumanReviewRefs') if kind=='OutcomeManifest' else ('voluntaryHumanReviewRefs',)):
                def launder(value,evidence,mode=mode,field=field):
                    if mode != 'ai_only':
                        for key in ('reviewModeDecisionRef','reviewSubjectRef','reviewMarker','aiReviewApprovalSetRefs'):value.pop(key)
                        if mode == 'legacy':value.pop('reviewMode')
                        else:value['reviewMode']='human'
                    value[field]=[evidence['decisions'][0]['ref']]
                output_case(kind.lower()+'-'+mode+'-ai-in-'+field,kind,source,evidence,launder,
                            'AI decision presented as human approval')
        output_case(kind.lower()+'-unknown-human-ref',kind,source,evidence,
                    lambda v,b:v.update(voluntaryHumanReviewRefs=[art(1798)]),'unknown or cyclic human approval reference')
    for label,change,error in [
        ('task',{'taskId':uid(999)},'output task mismatch'),
        ('repository',{'repositoryId':uid(999)},'output PR subject mismatch'),
        ('pr-id',{'externalId':'999'},'output PR subject mismatch'),
        ('head',{'headCommit':'c'*40},'output PR subject mismatch'),
        ('base',{'baseCommit':'c'*40},'output PR subject mismatch'),
        ('branch',{'baseBranch':'main'},'output PR subject mismatch'),
        ('subject',{'reviewSubjectRef':art(1798)},'output subject mismatch'),
    ]:
        output_case('merged-pr-wrong-'+label,'PullRequest',merged,pr_bundle,lambda v,b,c=change:v.update(c),error)
    output_case('outcome-wrong-task','OutcomeManifest',outcome,bundle,
                lambda v,b:v.update(taskId=uid(999)),'output task mismatch')
    output_case('merged-pr-plan-panel','PullRequest',merged,bundle,
                lambda v,b:v.update(baseBranch='main'),'PR output requires pr_review panel')
    output_case('merged-main-no-panel-refs','PullRequest',merged,pr_bundle,
                lambda v,b:v.update(baseBranch='main',aiReviewApprovalSetRefs=[]),'missing or unknown output approval')
    output_case('merged-main-matching-pr-panel','PullRequest',merged,pr_bundle,
                lambda v,b:(v.update(baseBranch='main'),b['subject'].update(baseBranch='main')),
                'AI merge requires configured dev branch')
    output_case('outcome-empty-refs-rejected-vote','OutcomeManifest',outcome,bundle,
                lambda v,b:(v.update(aiReviewApprovalSetRefs=[]),b['decisions'][0]['value'].update(verdict='reject')),
                'majority-only approval')
    output_case('outcome-empty-refs','OutcomeManifest',outcome,bundle,
                lambda v,b:v.update(aiReviewApprovalSetRefs=[]),'missing or unknown output approval')
    output_case('draft-unqualified-reviewer','PullRequest',pr,pr_bundle,
                lambda v,b:b['qualifications'][0]['value'].update(result='failed'),'unqualified reviewer')
    output_case('draft-rejected-vote','PullRequest',pr,pr_bundle,
                lambda v,b:b['decisions'][0]['value'].update(verdict='reject'),'majority-only approval')
    output_case('draft-no-votes','PullRequest',pr,pr_bundle,
                lambda v,b:b.update(decisions=[]),'every panel member must approve')
    output_case('draft-missing-qualification','PullRequest',pr,pr_bundle,
                lambda v,b:b.update(qualifications=[]),'missing or ambiguous configuration/qualification')
    # Direct and nested human reference resolution, including cycles and altered refs.
    human_output=copy.deepcopy(outcome);human_output['voluntaryHumanReviewRefs']=[art(1774)]
    write(folder/'positive-output-voluntary-human.json',{'kind':'OutcomeManifest','value':human_output,'bundle':voluntary})
    for mode in ('human','legacy'):
        value=copy.deepcopy(human_output)
        for key in ('reviewModeDecisionRef','reviewSubjectRef','reviewMarker','aiReviewApprovalSetRefs'):value.pop(key)
        if mode=='legacy':value.pop('reviewMode')
        else:value['reviewMode']='human'
        write(folder/('positive-output-'+mode+'.json'),{'kind':'OutcomeManifest','value':value,'bundle':voluntary})
    nested=copy.deepcopy(voluntary)
    nested['humanArtifacts'].append({'ref':art(1780),'value':dict(human,decisionRefs=[art(1774)])})
    value=copy.deepcopy(outcome);value['decisionRefs']=[art(1780)]
    write(folder/'positive-output-nested-human.json',{'kind':'OutcomeManifest','value':value,'bundle':nested})
    output_case('output-nested-ai-human-ref','OutcomeManifest',value,nested,
                lambda v,b:b['humanArtifacts'][-1]['value'].update(decisionRefs=approval['aiDecisionRefs']),
                'AI decision presented as human approval')
    output_case('output-cyclic-human-ref','OutcomeManifest',value,nested,
                lambda v,b:b['humanArtifacts'][-1]['value'].update(decisionRefs=[art(1780)]),
                'unknown or cyclic human approval reference')
    output_case('output-mismatched-human-ref','OutcomeManifest',value,nested,
                lambda v,b:v['decisionRefs'][0].update(sha256='f'*64),'human artifact ref mismatch')
    for label,source,field in [('adjudication',adjudicated,'completedAt'),('fix',fixed,'resolvedAt')]:
        for suffix,time in [('before','2026-10-29T01:00:00Z'),('same-time','2026-10-29T12:00:00Z')]:
            value=copy.deepcopy(source)
            records=value['adjudications'] if label=='adjudication' else value['findingResolutions']
            records[0]['value'][field]=time
            negative(label+'-'+suffix+'-finding','panel',value,error='finding vote must precede disposition')
    for label,time in [('future','2026-11-01T00:00:00Z'),('before-authority','2026-10-28T23:59:59Z')]:
        value=copy.deepcopy(adjudicated);value['priorDecisions'][0]['value']['submittedAt']=time
        negative('historical-vote-'+label,'panel',value,error='vote outside authority or evaluation time')
    value=copy.deepcopy(pr_bundle);value['repositoryBinding']['boundAt']=value['now']
    negative('pr-votes-before-repository-binding','panel',value,error='PR vote predates repository binding')
    # A later valid current round must not hide pre-binding historical PR votes.
    value=pr_review(adjudicated);value['decision']=copy.deepcopy(bound['decision'])
    value['decision']['reviewerQualificationRefs']=copy.deepcopy(adjudicated['decision']['reviewerQualificationRefs'])
    value['repositoryBinding']=copy.deepcopy(bound['repositoryBinding'])
    for record in value['priorAssignments']+value['priorDecisions']:record['value']['gateId']='pr_review'
    value['repositoryBinding']['boundAt']='2026-10-29T12:00:10Z'
    negative('historical-pr-votes-before-binding','panel',value,error='PR vote predates repository binding')
    from review_mode_adversarial import examples as adversarial_examples
    adversarial_examples(E, write, uid, art)
    # Explicit major template versions retain the human histories at their old pins.
    out=E/'templates'/'ai_only';out.mkdir(exist_ok=True)
    for name in ('greenfield','existing_feature','bug_fix'):
        template=json.loads((E/'templates'/(name+'.json')).read_text())
        template['version']='5.0.0' if name=='greenfield' else '4.0.0'
        template['reviewQualificationProfile']='ai-review/1.0'
        write(out/(name+'.json'),template)
