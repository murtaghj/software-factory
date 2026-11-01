"""Additive revision 1.4 contracts and examples, invoked by build_contracts.py."""
import copy
import hashlib
import json

# Default human-mode floors. ai-review/1.0 may replace review gates only through
# its in-force decision resolver; release_authorized is unconditionally human.
MANDATORY_HUMAN_GATES = ('intent_aligned', 'architecture_accepted', 'plan_accepted', 'plan_peer_approved', 'release_authorized')
DEFAULT_STAGE_WALL_SECONDS = {'resolve': 600, 'execute': 2700, 'verify': 1800, 'provider': 900, 'cleanup': 1200}
RUNNER_FINALISATION_GRACE_SECONDS = 300
RUNNER_TERMINATION_GRACE_SECONDS = 15


def extend(D, define, ref, obj, text, integer, array, enum, UUID, TIME, BOOL, AR, ARS):
    def fields(name, values):
        D[name]['properties'].update(values)

    D['GateMode'] = enum('human', 'human_sampled', 'automated')
    D['EvidenceClass'] = enum('in_process', 'out_of_process', 'human_observed')
    D['PRCompletionMode'] = enum('pr_created', 'review_completed', 'merged')
    D['OutcomeKind'] = enum('delivered', 'verified_fix', 'fix_proposed_unreproduced', 'mitigated', 'abandoned', 'handed_over', 'no_change_compliant', 'no_change_not_applicable')
    D['RecipeOutcome'] = enum('changed', 'already_compliant', 'not_applicable', 'needs_judgement')
    define('RecipeOutcomeRecord', {'schemaVersion': {'const': '2.0'}, 'taskId': UUID, 'recipeRef': AR, 'repositoryId': UUID, 'sourceCommit': ref('GitOid'), 'inputBinding': ref('InputBinding'), 'inputHash': ref('Digest'), 'outcome': ref('RecipeOutcome'), 'evidenceRefs': array(AR, 1)})
    D['RecipeOutcomeRecord']['allOf'] = [{'if': {'properties': {'outcome': {'enum': ['already_compliant', 'not_applicable']}}}, 'then': {'properties': {'inputBinding': {'not': {'required': ['candidateRef']}}}}}]
    define('PRCompletionPolicy', {'mode': ref('PRCompletionMode'), 'maxReviewRounds': integer(1), 'maxWaitSeconds': integer(1)})
    fields('TaskRequest', {'prCompletion': ref('PRCompletionPolicy')})
    D['TaskRequest']['allOf'].append({'if': {'required': ['prCompletion']}, 'then': {'properties': {'deliveryScope': {'const': 'pr'}}}})
    fields('ExecutionPlan', {'prCompletion': ref('PRCompletionPolicy'), 'behaviorReleaseRef': AR, 'resolvedGatePolicyRef': AR})
    fields('InputBinding', {'behaviorReleaseRef': AR, 'resolvedGatePolicyRef': AR, 'factoryToolSetRef': AR, 'failureSignatureProfileRef': AR})
    fields('RunLimits', {'maxVerifyCalls': integer(), 'maxVerifyWallSeconds': integer(1)})
    fields('StageInput', {'factoryToolSetVersion': {'const': '1.0.0'}})
    fields('StageContext', {'humanAnswerRefs': ARS})
    fields('ProviderCapabilities', {'factoryTools': enum('mcp', 'cli_shim', 'unsupported'), 'factoryToolSetVersion': text(), 'toolHooks': BOOL, 'cooperativeCheckpoint': BOOL, 'contextOccupancy': enum('exact', 'estimated', 'unavailable'), 'subagents': BOOL})
    fields('CheckpointManifest', {'sourceDigest': ref('Digest'), 'sessionBindingRef': AR})
    fields('ReviewReport', {'reviewerModelFamily': text(), 'behaviorReleaseRef': AR, 'processIndependenceRef': AR})
    fields('GateEvaluation', {'resolvedMode': ref('GateMode'), 'modeDecisionRef': AR})
    fields('VerificationReport', {'evidenceClass': ref('EvidenceClass'), 'collectionProfileRef': AR})
    fields('SuiteResult', {'evidenceClass': ref('EvidenceClass'), 'failureSignatureRef': AR})
    fields('TestPackage', {'visibleContentRef': AR, 'holdoutContentRef': AR, 'failureSignatureProfileRef': AR, 'testShimRef': AR, 'mutationPlanRef': AR})
    fields('OutcomeManifest', {'outcomeKind': ref('OutcomeKind'), 'prReviewStateRef': AR, 'unreproducedDecisionRef': AR, 'recipeOutcomeRef': AR})
    D['OutcomeManifest']['allOf'] = [{'if': {'required': ['outcomeKind'], 'properties': {'outcomeKind': {'const': 'fix_proposed_unreproduced'}}}, 'then': {'required': ['unreproducedDecisionRef'], 'properties': {'status': {'const': 'incomplete'}, 'deliveryScope': {'const': 'pr'}}}}]
    fields('OutcomeManifest', {'mitigationOperationRef': AR, 'recoveryEvidenceRef': AR, 'followUpTaskId': UUID})
    D['OutcomeManifest']['allOf'].append({'if': {'required': ['outcomeKind'], 'properties': {'outcomeKind': {'const': 'mitigated'}}}, 'then': {'required': ['mitigationOperationRef', 'recoveryEvidenceRef', 'followUpTaskId'], 'properties': {'status': {'const': 'incomplete'}}}})
    D['OutcomeManifest']['allOf'].append({
        'if': {'required': ['outcomeKind'], 'properties': {'outcomeKind': {'enum': ['no_change_compliant', 'no_change_not_applicable']}}},
        'then': {'required': ['recipeOutcomeRef', 'prReviewStateRef', 'gateEvaluationRefs'], 'not': {'required': ['candidateRef']},
                 'properties': {'status': {'const': 'succeeded'}, 'deliveryScope': {'const': 'pr'}, 'providerHandles': {'maxItems': 0}, 'gateEvaluationRefs': {'minItems': 1}}},
    })
    fields('WorkflowCheckpoint', {'prReviewStateRef': AR, 'pendingFactoryDecisionRefs': ARS})
    D['StageKind']['enum'].append('pr_review')
    D['GateId']['enum'].append('delivery_complete')

    define('StructureComponent', {'id': text(), 'repositoryId': UUID, 'paths': array(text(), 1), 'change': text(), 'signatures': array(text()), 'interfaceChanges': array(text()), 'dataChanges': array(text())}, ('repositoryId',))
    define('StructureSlice', {'id': text(), 'outcome': text(), 'componentIds': array(text(), 1), 'criterionIds': array(text(), 1)})
    define('StructureOutline', {'components': array(ref('StructureComponent'), 1), 'slices': array(ref('StructureSlice'), 1), 'exclusions': array(text()), 'contractRefs': ARS})
    fields('PlanReviewPacket', {'structureOutline': ref('StructureOutline')})

    define('BehaviorRelease', {'schemaVersion': {'const': '2.0'}, 'id': text(), 'adapterProfileRefs': array(AR, 1), 'modelProfileRefs': array(AR, 1), 'promptPackageRef': AR, 'instructionPackageRef': AR, 'toolSetRef': AR, 'evaluatorRef': AR, 'tierPolicyRef': AR, 'qualificationRef': AR, 'previousReleaseRef': AR}, ('previousReleaseRef',))
    define('AutonomyScope', {'applicationId': UUID, 'workType': ref('WorkType'), 'changeClass': text(), 'assurance': ref('Assurance'), 'pathProfileRef': AR, 'behaviorReleaseRef': AR})
    basispoints = integer(); basispoints['maximum'] = 10000
    define('GateModeRule', {'gateId': ref('GateId'), 'mode': ref('GateMode'), 'sampleBasisPoints': basispoints, 'humanFloor': BOOL})
    D['GateModeRule']['allOf'] = [
        {'if': {'properties': {'humanFloor': {'const': True}}}, 'then': {'properties': {'mode': {'const': 'human'}}}},
        {'if': {'properties': {'gateId': {'enum': list(MANDATORY_HUMAN_GATES)}}}, 'then': {'properties': {'mode': {'const': 'human'}, 'humanFloor': {'const': True}}}},
    ]
    define('AutonomyPolicyDecision', {'schemaVersion': {'const': '2.0'}, 'id': UUID, 'scope': ref('AutonomyScope'), 'policyRevision': integer(1), 'previousPolicyRef': AR, 'gateModes': array(ref('GateModeRule'), 1), 'direction': enum('establish', 'relax', 'tighten'), 'actorKind': enum('human', 'authorized_rule'), 'actorId': text(), 'authorityRef': AR, 'ledgerRefs': array(AR, 1), 'minimumSampleCount': integer(1), 'observationDays': integer(1), 'degradationRuleRef': AR, 'reason': text(), 'expiresAt': TIME}, ('previousPolicyRef',))
    D['AutonomyPolicyDecision']['allOf'] = [{'if': {'properties': {'direction': {'const': 'relax'}}}, 'then': {'properties': {'actorKind': {'const': 'human'}}}}]
    define('HealthMetric', {'name': enum('rewrite_30d', 'rewrite_90d', 'merged', 'abandoned', 'architecture_findings', 'escaped_defects', 'reverts', 'review_latency_seconds', 'open_reviews', 'sample_misses'), 'numerator': {'type': 'number', 'minimum': 0}, 'denominator': integer(), 'unit': text(), 'maturity': enum('mature', 'immature', 'unavailable'), 'attribution': enum('exact', 'estimated', 'unknown'), 'notes': text(0)})
    define('ApplicationHealthSample', {'schemaVersion': {'const': '2.0'}, 'id': UUID, 'scope': ref('AutonomyScope'), 'metricVersion': text(), 'windowStart': TIME, 'windowEnd': TIME, 'observedAt': TIME, 'sampleCount': integer(), 'metrics': array(ref('HealthMetric'), 1), 'sourceRefs': array(AR, 1)})
    define('ApplicationHealthPage', {'items': array(ref('ApplicationHealthSample')), 'nextCursor': text()}, ('nextCursor',))
    fields('PolicyProfile', {'gateModeRules': array(ref('GateModeRule')), 'maxOpenPRsPerApplication': integer(1), 'maxDiffLinesPerPR': integer(1), 'behaviorReleaseRef': AR})
    fields('PolicyProfile', {'stageWallSecondsByTimeoutClass': obj({kind: integer(1) for kind in DEFAULT_STAGE_WALL_SECONDS}, tuple(DEFAULT_STAGE_WALL_SECONDS))})

    define('PRHeadObservation', {'repositoryId': UUID, 'providerId': text(), 'externalId': text(), 'expectedHead': ref('GitOid'), 'observedHead': ref('GitOid'), 'state': enum('open', 'merged', 'closed'), 'draft': BOOL, 'reviewState': enum('pending', 'changes_requested', 'approved'), 'requiredReviewPolicyRef': AR, 'observationRef': AR, 'observedAt': TIME, 'mergedCommit': ref('GitOid')}, ('mergedCommit', 'draft'))
    define('PRReviewState', {'schemaVersion': {'const': '2.0'}, 'taskId': UUID, 'revision': integer(1), 'completionPolicy': ref('PRCompletionPolicy'), 'phase': enum('reconciling', 'preview_only', 'waiting_review', 'rework', 'head_conflict', 'completed', 'completed_no_change', 'abandoned', 'handed_over'), 'pullRequests': array(ref('PRHeadObservation')), 'reviewRound': integer(), 'processedReviewKeys': array(text()), 'findingRefs': ARS, 'pendingDecisionIds': array(UUID), 'deadline': TIME, 'lastCandidateRef': AR, 'previousStateRef': AR, 'recipeOutcomeRef': AR, 'gateEvaluationRefs': ARS}, ('previousStateRef', 'lastCandidateRef', 'recipeOutcomeRef', 'gateEvaluationRefs'))
    D['PRReviewState']['allOf'] = [{
        'if': {'properties': {'phase': {'const': 'completed_no_change'}}},
        'then': {'required': ['recipeOutcomeRef', 'gateEvaluationRefs'], 'not': {'required': ['lastCandidateRef']},
                 'properties': {'pullRequests': {'maxItems': 0}, 'reviewRound': {'const': 0}, 'findingRefs': {'maxItems': 0}, 'pendingDecisionIds': {'maxItems': 0}, 'gateEvaluationRefs': {'minItems': 1}}},
        'else': {'required': ['lastCandidateRef'], 'properties': {'pullRequests': {'minItems': 1}}},
    }]
    define('PRReviewView', {'taskId': UUID, 'stateRef': AR, 'state': ref('PRReviewState')})
    fields('TaskView', {'prReview': ref('PRReviewView')})
    define('FailureSignatureProfile', {'schemaVersion': {'const': '2.0'}, 'id': text(), 'framework': text(), 'frameworkVersion': text(), 'parserRef': AR, 'scenarioIds': array(text(), 1), 'intendedAssertionMatchers': array(text(), 1), 'minimumExecutedTests': integer(1), 'rejectedClasses': array(enum('compile', 'setup', 'discovery', 'network', 'timeout'), 5), 'shimRef': AR, 'oracleReviewRef': AR}, ('shimRef',))

    # Agent-supplied fields never include identity, role grants or gate verdicts.
    define('DiscoverySubmission', {'role': {'const': 'discovery'}, 'findingsRef': AR, 'hypothesesRef': AR, 'unresolvedQuestionRefs': ARS})
    define('PlannerSubmission', {'role': {'const': 'planner'}, 'packetRef': AR, 'executionPlanRef': AR})
    define('CriteriaSubmission', {'role': {'const': 'criteria_author'}, 'packageRef': AR, 'criteriaRef': AR, 'oracleProposalRef': AR})
    define('ImplementerSubmission', {'role': {'const': 'implementer'}, 'changeSummaryRef': AR, 'workspaceSourceDigest': ref('Digest'), 'limitations': array(text())})
    define('ReviewerSubmission', {'role': {'const': 'reviewer'}, 'reviewReportRef': AR})
    define('AdversarialSubmission', {'role': {'const': 'adversarial_tester'}, 'packageRef': AR, 'hypothesesRef': AR})
    define('KnowledgeSubmission', {'role': {'const': 'knowledge_curator'}, 'proposalRefs': ARS})
    D['FactorySubmission'] = {'oneOf': [ref(n) for n in ('DiscoverySubmission', 'PlannerSubmission', 'CriteriaSubmission', 'ImplementerSubmission', 'ReviewerSubmission', 'AdversarialSubmission', 'KnowledgeSubmission')]}
    define('VerifyToolInput', {'callId': UUID, 'visiblePackageRef': AR, 'recipeIds': array(text(), 1)})
    define('FeedbackFailure', {'scenarioId': text(), 'message': {'type': 'string', 'maxLength': 2000}})
    failures = array(ref('FeedbackFailure')); failures['maxItems'] = 10
    define('VerifyToolOutput', {'callId': UUID, 'classification': {'const': 'feedback_only'}, 'contentTrust': {'const': 'untrusted_data'}, 'snapshotRef': AR, 'discovered': integer(), 'executed': integer(), 'passed': integer(), 'failed': integer(), 'skipped': integer(), 'firstFailures': failures, 'logRef': AR, 'wallSeconds': integer(), 'status': enum('passed', 'failed', 'inconclusive', 'infrastructure_error')})
    define('SubmitResultToolInput', {'callId': UUID, 'output': ref('FactorySubmission')})
    define('SubmitResultToolOutput', {'receiptId': UUID, 'stageRunId': ref('LogicalStageRunId'), 'state': enum('proposal_received', 'finalizing', 'finalized', 'rejected'), 'requestHash': ref('Digest'), 'resultRef': AR, 'reason': text()}, ('resultRef', 'reason'))
    D['SubmitResultToolOutput']['allOf'] = [{'if': {'properties': {'state': {'const': 'finalized'}}}, 'then': {'required': ['resultRef']}}]
    options = array(text()); options['maxItems'] = 5
    define('RequestDecisionToolInput', {'callId': UUID, 'question': {'type': 'string', 'minLength': 1, 'maxLength': 2000}, 'whyItMatters': text(), 'options': options, 'blocking': BOOL, 'sourceRefs': ARS})
    define('RequestDecisionToolOutput', {'receiptId': UUID, 'requestId': UUID, 'state': enum('pending_pause', 'recorded_nonblocking'), 'questionHash': ref('Digest')})
    maxbytes = integer(1); maxbytes['maximum'] = 32768
    define('GetEvidenceToolInput', {'callId': UUID, 'artifactRefs': array(AR, 1), 'maxBytes': maxbytes, 'cursor': text()}, ('cursor',))
    # Live queries are separately versioned and constrained by server-owned grants.
    D['GetEvidenceArtifactInputV12'] = copy.deepcopy(D['GetEvidenceToolInput'])
    D['GetEvidenceArtifactInputV12']['properties']['sourceKind'] = {'const': 'artifact'}
    D['GetEvidenceArtifactInputV12']['required'].append('sourceKind')
    maxresults = integer(1); maxresults['maximum'] = 100
    define('EvidenceTimeRange', {'start': TIME, 'end': TIME})
    define('EvidencePathScope', {'repositoryId': UUID, 'commit': ref('GitOid'), 'paths': array(text(), 1)})
    define('GetEvidenceQueryInputV12', {'callId': UUID, 'sourceKind': enum('ci', 'error_tracking', 'logs', 'traces', 'metrics', 'feature_flags', 'deploy_inventory', 'issue_tracker', 'code_history', 'docs'), 'sourceId': text(), 'queryTemplateId': text(), 'parameters': {'type': 'object', 'additionalProperties': {'type': 'string', 'maxLength': 2000}}, 'timeRange': ref('EvidenceTimeRange'), 'pathScope': ref('EvidencePathScope'), 'maxResults': maxresults, 'maxBytes': maxbytes, 'cursor': text()}, ('timeRange', 'pathScope', 'cursor'))
    D['GetEvidenceQueryInputV12']['allOf'] = [{'oneOf': [{'required': ['timeRange']}, {'required': ['pathScope']}]}]
    D['GetEvidenceToolInputV12'] = {'oneOf': [ref('GetEvidenceArtifactInputV12'), ref('GetEvidenceQueryInputV12')]}
    define('EvidenceExcerpt', {'sourceRef': AR, 'text': {'type': 'string', 'maxLength': 32768}, 'contentTrust': {'const': 'untrusted_data'}})
    define('GetEvidenceToolOutput', {'items': array(ref('EvidenceExcerpt')), 'nextCursor': text(), 'truncated': BOOL}, ('nextCursor',))
    define('FactoryToolError', {'code': enum('stale_epoch', 'forbidden', 'invalid_schema', 'conflict', 'cap_exhausted', 'infrastructure_error'), 'retryable': BOOL, 'message': text(), 'receiptId': UUID}, ('receiptId',))


def write_tools(C):
    pairs = {'verify': ('VerifyToolInput', 'VerifyToolOutput'), 'submit_result': ('SubmitResultToolInput', 'SubmitResultToolOutput'), 'request_decision': ('RequestDecisionToolInput', 'RequestDecisionToolOutput'), 'get_evidence': ('GetEvidenceToolInput', 'GetEvidenceToolOutput')}
    tools = {}
    for name, (input_name, output_name) in pairs.items():
        tools[name] = {'inputSchema': {'$ref': './domain.schema.json#/$defs/'+input_name}, 'outputSchema': {'$ref': './domain.schema.json#/$defs/'+output_name}}
    contract = {'$schema': 'https://json-schema.org/draft/2020-12/schema', '$id': 'https://factory.example/spec/factory-tools/1.0.0', 'title': 'Factory tool-set contract manifest', 'type': 'object', 'additionalProperties': False, 'properties': {'toolSetVersion': {'const': '1.0.0'}}, 'required': ['toolSetVersion'], 'x-tools': tools, 'x-errorSchema': {'$ref': './domain.schema.json#/$defs/FactoryToolError'}}
    (C/'factory-tools.schema.json').write_text(json.dumps(contract, indent=2)+'\n')


def examples(E, write, uid, art, task):
    completion = {'mode': 'review_completed', 'maxReviewRounds': 3, 'maxWaitSeconds': 604800}
    request = copy.deepcopy(task); request['prCompletion'] = completion
    write(E/'review-followthrough-task.json', request)
    write(E/'factory-submit-result.json', {'callId': uid(201), 'output': {'role': 'implementer', 'changeSummaryRef': art(202), 'workspaceSourceDigest': 'd'*64, 'limitations': []}})
    write(E/'factory-submit-receipt.json', {'receiptId': uid(203), 'stageRunId': 'task-2/plan-1/implement/attempt-1', 'state': 'proposal_received', 'requestHash': 'e'*64})
    write(E/'factory-verify-feedback.json', {'callId': uid(204), 'classification': 'feedback_only', 'contentTrust': 'untrusted_data', 'snapshotRef': art(205), 'discovered': 4, 'executed': 4, 'passed': 3, 'failed': 1, 'skipped': 0, 'firstFailures': [{'scenarioId': 'S2', 'message': 'Repeated request emitted two events.'}], 'logRef': art(206), 'wallSeconds': 19, 'status': 'failed'})
    write(E/'failure-signature-profile.json', {'schemaVersion': '2.0', 'id': 'fixture-assertion-v1', 'framework': 'fixture-test-runner', 'frameworkVersion': '1.0.0', 'parserRef': art(207), 'scenarioIds': ['duplicate-reservation'], 'intendedAssertionMatchers': ['expected reservation count 1; observed 2'], 'minimumExecutedTests': 1, 'rejectedClasses': ['compile', 'setup', 'discovery', 'network', 'timeout'], 'oracleReviewRef': art(208)})
    state = {'schemaVersion': '2.0', 'taskId': uid(2), 'revision': 1, 'completionPolicy': completion, 'phase': 'waiting_review', 'pullRequests': [{'repositoryId': uid(20), 'providerId': 'github-reference', 'externalId': '184', 'expectedHead': 'a'*40, 'observedHead': 'a'*40, 'state': 'open', 'draft': False, 'reviewState': 'pending', 'requiredReviewPolicyRef': art(209), 'observationRef': art(210), 'observedAt': '2026-10-01T12:00:00Z'}], 'reviewRound': 0, 'processedReviewKeys': [], 'findingRefs': [], 'pendingDecisionIds': [], 'deadline': '2026-10-08T12:00:00Z', 'lastCandidateRef': art(211)}
    identity = {'providerId':'github-reference', 'installationRef':'installation:demo', 'externalId':'repo20'}
    state['pullRequests'][0].update(headRepository=copy.deepcopy(identity), baseRepository=copy.deepcopy(identity))
    write(E/'pr-review-state.json', state)
    preview_state = copy.deepcopy(state)
    preview_state['phase'] = 'preview_only'
    preview_state['pullRequests'][0]['draft'] = True
    write(E/'pr-review-preview-only.json', preview_state)
    binding = {'taskSpecVersion': 1, 'planVersion': 1, 'policyRef': art(2500), 'applicationSnapshotRef': art(2501), 'workflowTemplateRef': art(2502)}
    for index, (outcome, kind) in enumerate((('already_compliant', 'no_change_compliant'), ('not_applicable', 'no_change_not_applicable'))):
        record_ref, state_ref, gate_ref = (art(2510+index*10+n) for n in range(3))
        record = {'schemaVersion': '2.0', 'taskId': uid(2), 'recipeRef': art(2503), 'repositoryId': uid(20), 'sourceCommit': 'a'*40, 'inputBinding': binding, 'inputHash': 'c'*64, 'outcome': outcome, 'evidenceRefs': [art(2504)]}
        write(E/('recipe-'+outcome+'.json'), record)
        no_change_state = dict(state, completionPolicy=dict(completion, mode='pr_created'), phase='completed_no_change', pullRequests=[], recipeOutcomeRef=record_ref, gateEvaluationRefs=[gate_ref], deadline='2026-10-16T12:00:00Z')
        no_change_state.pop('lastCandidateRef')
        write(E/('pr-review-'+outcome+'.json'), no_change_state)
        write(E/('outcome-'+outcome+'.json'), {'schemaVersion': '2.0', 'taskId': uid(2), 'status': 'succeeded', 'deliveryScope': 'pr', 'outcomeKind': kind, 'recipeOutcomeRef': record_ref, 'prReviewStateRef': state_ref, 'deliveredArtifactRefs': [record_ref], 'providerHandles': [], 'gateEvaluationRefs': [gate_ref], 'decisionRefs': [], 'usage': [], 'limitations': ['Synthetic static fixture; runtime no-change completion is not yet proven.'], 'knowledgeProposalIds': [], 'cleanupObligationRefs': [], 'completedAt': '2026-10-09T12:00:00Z'})
    scope = {'applicationId': uid(10), 'workType': 'bug', 'changeClass': 'machine_reported_retry_bug', 'assurance': 'standard', 'pathProfileRef': art(212), 'behaviorReleaseRef': art(213)}
    write(E/'application-health-sample.json', {'schemaVersion': '2.0', 'id': uid(214), 'scope': scope, 'metricVersion': '1.0.0', 'windowStart': '2026-09-01T00:00:00Z', 'windowEnd': '2026-10-01T00:00:00Z', 'observedAt': '2026-10-01T12:00:00Z', 'sampleCount': 4, 'metrics': [{'name': 'rewrite_90d', 'numerator': 0, 'denominator': 0, 'unit': 'lines', 'maturity': 'immature', 'attribution': 'unknown', 'notes': 'Observation window has not matured; no autonomy relaxation permitted.'}], 'sourceRefs': [art(215)]})
    write(E/'autonomy-policy-decision.json', {'schemaVersion': '2.0', 'id': uid(216), 'scope': scope, 'policyRevision': 1, 'gateModes': [{'gateId': 'plan_peer_approved', 'mode': 'human', 'sampleBasisPoints': 10000, 'humanFloor': True}, {'gateId': 'oracle_accepted', 'mode': 'human', 'sampleBasisPoints': 10000, 'humanFloor': True}], 'direction': 'establish', 'actorKind': 'human', 'actorId': 'policy-owner:fixture', 'authorityRef': art(217), 'ledgerRefs': [art(218)], 'minimumSampleCount': 30, 'observationDays': 90, 'degradationRuleRef': art(219), 'reason': 'Establish conservative pilot floors; numerical sample targets are illustrative configuration, not sufficient qualification.', 'expiresAt': '2027-01-01T00:00:00Z'})

    security = {'allowPrivilegeEscalation': False, 'readOnlyRootFilesystem': True, 'capabilities': {'drop': ['ALL']}}
    resources = {'requests': {'cpu': '250m', 'memory': '256Mi', 'ephemeral-storage': '128Mi'}, 'limits': {'cpu': '1', 'memory': '512Mi', 'ephemeral-storage': '1Gi'}}
    supervisor = {'name': 'supervisor', 'image': 'registry.example/factory-supervisor@sha256:'+'c'*64, 'args': ['serve', '--allocation', 'example-g1', '--listen', '127.0.0.1:8765'], 'securityContext': dict(security, runAsUser=10002, runAsGroup=10002), 'resources': resources, 'volumeMounts': [{'name': 'workspace', 'mountPath': '/workspace', 'readOnly': True}, {'name': 'supervisor-tmp', 'mountPath': '/tmp'}, {'name': 'factory-identity', 'mountPath': '/var/run/factory-identity', 'readOnly': True}]}
    harness = {'name': 'harness', 'image': 'registry.example/factory-claude-harness@sha256:'+'d'*64, 'args': ['qualified-runner', '--factory-tools', 'http://127.0.0.1:8765/mcp', '--model-gateway', 'https://model-gateway.factory.example'], 'securityContext': dict(security, runAsUser=10001, runAsGroup=10001), 'resources': {'requests': {'cpu': '1', 'memory': '2Gi', 'ephemeral-storage': '2Gi'}, 'limits': {'cpu': '4', 'memory': '8Gi', 'ephemeral-storage': '10Gi'}}, 'volumeMounts': [{'name': 'workspace', 'mountPath': '/workspace'}, {'name': 'harness-tmp', 'mountPath': '/tmp'}, {'name': 'role-config', 'mountPath': '/etc/factory-role', 'readOnly': True}]}
    pod = {'restartPolicy': 'Never', 'terminationGracePeriodSeconds': RUNNER_TERMINATION_GRACE_SECONDS, 'serviceAccountName': 'factory-allocation-supervisor', 'automountServiceAccountToken': False, 'shareProcessNamespace': False, 'securityContext': {'runAsNonRoot': True, 'fsGroup': 10001, 'seccompProfile': {'type': 'RuntimeDefault'}}, 'containers': [supervisor, harness], 'volumes': [{'name': 'workspace', 'persistentVolumeClaim': {'claimName': 'factory-workspace-example-g1'}}, {'name': 'supervisor-tmp', 'emptyDir': {'sizeLimit': '256Mi'}}, {'name': 'harness-tmp', 'emptyDir': {'sizeLimit': '1Gi'}}, {'name': 'factory-identity', 'projected': {'defaultMode': 288, 'sources': [{'serviceAccountToken': {'path': 'token', 'audience': 'factory-control-plane', 'expirationSeconds': 600}}]}}, {'name': 'role-config', 'configMap': {'name': 'factory-role-example'}}]}
    # Topology example only: control transport, gateway token exchange and NetworkPolicy
    # are profile-specific M0 qualification obligations; no credentials are embedded.
    stage_run_id = f'task-{uid(2)}/plan-1/implement/attempt-1'
    spec_hash = 'e'*64
    labels = {'factory.example/task': uid(2), 'factory.example/allocation': 'example-g1', 'factory.example/stage-run': hashlib.sha256(stage_run_id.encode()).hexdigest()[:32], 'factory.example/generation': '1', 'factory.example/spec-hash': spec_hash[:32]}
    annotations = {'factory.example/org': uid(1), 'factory.example/task': uid(2), 'factory.example/stage-run-full': stage_run_id, 'factory.example/spec-hash-full': spec_hash, 'factory.example/owner-epoch': '1'}
    write(E/'kubernetes-job.json', {'apiVersion': 'batch/v1', 'kind': 'Job', 'metadata': {'name': 'factory-run-example-g1', 'namespace': 'factory-execution-example', 'labels': labels, 'annotations': annotations}, 'spec': {'backoffLimit': 0, 'activeDeadlineSeconds': DEFAULT_STAGE_WALL_SECONDS['execute'] + RUNNER_FINALISATION_GRACE_SECONDS, 'template': {'metadata': {'labels': labels, 'annotations': annotations}, 'spec': pod}}})
