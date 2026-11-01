"""Revision 1.5 additive domain contracts; tool 1.0 shapes remain unchanged."""
import copy
import json


def extend(D, define, ref, obj, text, integer, array, enum, UUID, TIME, BOOL, AR, ARS):
    def fields(name, values):
        D[name]['properties'].update(values)

    define('RuleDefinition', {'schemaVersion': {'const': '2.0'}, 'ruleId': text(), 'revision': integer(1), 'ownerPrincipalId': UUID, 'layer': enum('factory', 'organization', 'application', 'repository'), 'statement': text(), 'authoritativeSourceRef': AR, 'applicabilityRef': AR, 'severity': enum('blocking', 'advisory'), 'waivable': BOOL, 'enforcementRefs': array(AR, 1)})
    define('StandardsBundle', {'schemaVersion': {'const': '2.0'}, 'id': text(), 'revision': integer(1), 'sourceRef': AR, 'ruleRefs': array(AR, 1), 'reviewRef': AR})
    define('RuleScope', {'taskId': UUID, 'applicationIds': array(UUID, 1), 'resourceIds': array(text(), 1), 'workType': ref('WorkType'), 'environment': text()})
    define('RuleException', {'schemaVersion': {'const': '2.0'}, 'id': UUID, 'ruleId': text(), 'ruleRevision': integer(1), 'ruleRef': AR, 'scope': ref('RuleScope'), 'requestedRelaxation': text(), 'reason': text(), 'compensatingControlsRef': AR, 'validFrom': TIME, 'expiresAt': TIME})
    define('RuleExceptionGrant', {'schemaVersion': {'const': '2.0'}, 'exceptionRef': AR, 'decisionRefs': array(AR, 1)})
    define('ResolvedRules', {'schemaVersion': {'const': '2.0'}, 'scope': ref('RuleScope'), 'resolverVersion': text(), 'bundleRefs': array(AR, 1), 'ruleRefs': array(AR, 1), 'exceptionRefs': ARS})
    define('RolePackage', {'schemaVersion': {'const': '2.0'}, 'id': text(), 'revision': integer(1), 'role': ref('Role'), 'objective': text(), 'completionContractRef': AR, 'requiredContentRef': AR, 'toolSetVersion': enum('1.1.0', '1.2.0'), 'standardsBundleRefs': ARS, 'optionalSkillAdmissionRefs': ARS})
    define('CompiledRole', {'schemaVersion': {'const': '2.0'}, 'rolePackageRef': AR, 'resolvedRulesRef': AR, 'adapterProfileRef': AR, 'compilerVersion': text(), 'factoryConfigurationRef': AR, 'deliveredContentRef': AR, 'mechanism': enum('prompt_append', 'deterministic_injection', 'instruction_file')})
    define('RoleDeliveryAttestation', {'schemaVersion': {'const': '2.0'}, 'compiledRoleRef': AR, 'adapterProfileRef': AR, 'modelProfileRef': AR, 'fixtureRef': AR, 'observedContentDigest': ref('Digest'), 'requestCaptureRef': AR, 'observedAt': TIME, 'producerId': text()})
    define('SkillAdmission', {'schemaVersion': {'const': '2.0'}, 'id': UUID, 'sourceUrl': {'type': 'string', 'format': 'uri'}, 'sourceCommit': ref('GitOid'), 'license': text(), 'sourceTreeDigest': ref('Digest'), 'adaptedContentRef': AR, 'inventoryRef': AR, 'reviewRef': AR, 'qualificationRef': AR, 'allowedRoles': array(ref('Role'), 1), 'executableContent': BOOL})
    define('SkillAdmissionState', {'schemaVersion': {'const': '2.0'}, 'admissionRef': AR, 'state': enum('admitted', 'revoked'), 'decisionRef': AR, 'effectiveAt': TIME, 'reason': text()})
    define('TaskCheckStrategy', {'kind': enum('recipe', 'human_review', 'controller_evidence'), 'recipeRefs': ARS, 'evidenceRequirementRefs': ARS, 'rationale': text()})
    D['TaskCheckStrategy']['allOf'] = [
        {'if': {'properties': {'kind': {'const': 'recipe'}}}, 'then': {'properties': {'recipeRefs': array(AR, 1)}}},
        {'if': {'properties': {'kind': enum('human_review', 'controller_evidence')}}, 'then': {'properties': {'evidenceRequirementRefs': array(AR, 1)}}},
    ]
    define('ImplementationTask', {'id': text(), 'outcome': text(), 'dependsOn': array(text()), 'pathsOrResources': array(text(), 1), 'criterionIds': array(text(), 1), 'checkStrategy': ref('TaskCheckStrategy')})
    define('ReuseJustification', {'id': text(), 'kind': enum('component', 'dependency'), 'name': text(), 'neededBecause': text(), 'existingCode': text(), 'standardLibrary': text(), 'platform': text(), 'existingDependencies': text(), 'choice': text(), 'tradeoffs': text(), 'supplyChainReviewRef': AR}, ('supplyChainReviewRef',))
    D['ReuseJustification']['allOf'] = [{'if': {'properties': {'kind': {'const': 'dependency'}}}, 'then': {'required': ['supplyChainReviewRef']}}]
    define('SuggestedDeletion', {'path': text(), 'symbolOrRange': text(), 'reason': text()})
    define('DeferredWork', {'id': text(), 'kind': enum('deferred', 'shortcut', 'limitation'), 'description': text(), 'impact': text(), 'criterionIds': array(text()), 'ruleIds': array(text()), 'evidenceRefs': ARS})
    define('DeferredWorkLedger', {'schemaVersion': {'const': '2.0'}, 'stageRunId': ref('LogicalStageRunId'), 'submissionReceiptRef': AR, 'items': array(ref('DeferredWork'))})

    fields('ApplicationDefinition', {'standardsBundleRefs': ARS})
    fields('ApplicationSnapshot', {'resolvedRulesRef': AR})
    fields('ExecutionPlan', {'resolvedRulesRef': AR, 'contentQualificationProfile': {'const': 'rules-role-content/1.0'}})
    fields('InputBinding', {'resolvedRulesRef': AR, 'rolePackageRef': AR, 'compiledRoleRef': AR})
    fields('StageContext', {'resolvedRulesRef': AR, 'rolePackageRef': AR})
    fields('BehaviorRelease', {'rolePackageRefs': ARS, 'standardsBundleRefs': ARS, 'skillAdmissionRefs': ARS, 'compilerProfileRefs': ARS, 'contentQualificationProfile': {'const': 'rules-role-content/1.0'}})
    for name in ('BehaviorRelease', 'ExecutionPlan'):
        fields(name, {'investigationQualificationProfile': {'const': 'investigation-discipline/1.0'}})
    fields('PlanReviewPacket', {'implementationTasks': array(ref('ImplementationTask')), 'reuseJustifications': array(ref('ReuseJustification')), 'resolvedRulesRef': AR})
    fields('Finding', {'findingKind': enum('unnecessary_code', 'rule_conflict', 'check_conflict', 'unsupported_claim'), 'ruleIds': array(text()), 'suggestedDeletions': array(ref('SuggestedDeletion'))})
    D['Finding']['allOf'] = [{'if': {'required': ['findingKind'], 'properties': {'findingKind': {'const': 'unnecessary_code'}}}, 'then': {'required': ['suggestedDeletions'], 'properties': {'category': enum('implementation', 'design'), 'suggestedDeletions': array(ref('SuggestedDeletion'), 1)}}}]
    fields('OutcomeManifest', {'deferredWorkRefs': ARS})
    D['StageInput']['properties']['factoryToolSetVersion'] = enum('1.0.0', '1.1.0', '1.2.0')
    D['DecisionView']['allOf'].append({'if': {'properties': {'action': {'const': 'approve_rule_exception'}}}, 'then': {'required': ['requiredPrincipalId']}})

    # V1.1 adds explicit provenance without mutating the preserved V1.0 shapes.
    D['VerifyToolOutputV11'] = copy.deepcopy(D['VerifyToolOutput'])
    provenance = {'verificationRunId': UUID, 'stageRunId': ref('LogicalStageRunId'), 'inputHash': ref('Digest'), 'workspaceSourceDigest': ref('Digest'), 'visiblePackageRef': AR, 'recipeRefs': array(AR, 1), 'completedAt': TIME}
    D['VerifyToolOutputV11']['properties'].update(provenance)
    D['VerifyToolOutputV11']['required'] += list(provenance)
    define('FeedbackClaim', {'verificationRunId': UUID, 'receiptRef': AR, 'workspaceSourceDigest': ref('Digest'), 'visiblePackageRef': AR, 'recipeRefs': array(AR, 1), 'status': enum('passed', 'failed', 'inconclusive', 'infrastructure_error'), 'scope': enum('current_source', 'historical')})
    define('SubmitResultToolInputV11', {'callId': UUID, 'output': ref('FactorySubmission'), 'feedbackClaims': array(ref('FeedbackClaim')), 'deferredWork': array(ref('DeferredWork'))})

    # 1.2 is additive; never widen inputs selected by the retained manifests.
    D['SubmitResultToolInputV12'] = copy.deepcopy(D['SubmitResultToolInputV11'])
    missing = array({'type': 'string', 'minLength': 1, 'maxLength': 2000})
    missing.update(maxItems=20, description='Untrusted agent text; proposes no authority or automatic context change.')
    D['SubmitResultToolInputV12']['properties']['missingContext'] = missing
    define('HypothesisTimebox', {'toolCalls': integer(1), 'minutes': integer(1)})
    define('HypothesisEvidence', {'ref': AR, 'relation': enum('supports', 'contradicts', 'neutral')})
    define('Hypothesis', {'hypothesisId': UUID, 'statement': text(), 'prediction': text(), 'killCriterion': text(), 'plannedExperiment': text(), 'timebox': obj({'toolCalls': integer(1), 'minutes': integer(1), 'extensionsUsed': integer()}), 'state': enum('open', 'confirmed', 'ruled_out', 'inconclusive'), 'evidence': array(ref('HypothesisEvidence'))})
    define('OpenHypothesisToolInput', {'callId': UUID, 'statement': text(), 'prediction': text(), 'killCriterion': text(), 'plannedExperiment': text(), 'timebox': ref('HypothesisTimebox')})
    define('RecordEvidenceToolInput', {'callId': UUID, 'hypothesisIds': array(UUID, 1), 'ref': AR, 'relation': enum('supports', 'contradicts', 'neutral')})
    define('CloseHypothesisToolInput', {'callId': UUID, 'hypothesisId': UUID, 'state': enum('confirmed', 'ruled_out', 'inconclusive'), 'decidingEvidence': ARS})
    D['CloseHypothesisToolInput']['allOf'] = [{'if': {'properties': {'state': enum('confirmed', 'ruled_out')}}, 'then': {'properties': {'decidingEvidence': array(AR, 1)}}}]
    define('ExtendHypothesisToolInput', {'callId': UUID, 'hypothesisId': UUID, 'reason': text(), 'expectedEvidence': text(), 'extension': ref('HypothesisTimebox'), 'authorizationRef': AR}, ('authorizationRef',))
    define('ReopenHypothesisToolInput', {'callId': UUID, 'failedHypothesisRef': AR, 'newEvidenceRefs': array(AR, 1), 'prediction': text(), 'killCriterion': text(), 'plannedExperiment': text(), 'timebox': ref('HypothesisTimebox')})
    define('HypothesisToolOutput', {'receiptRef': AR, 'hypotheses': array(ref('Hypothesis'), 1), 'contentTrust': {'const': 'untrusted_data'}, 'classification': {'const': 'advisory_only'}})


def write_tools(C):
    legacy = json.loads((C/'factory-tools.schema.json').read_text())
    current = copy.deepcopy(legacy)
    current['$id'] = 'https://factory.example/spec/factory-tools/1.1.0'
    current['properties']['toolSetVersion']['const'] = '1.1.0'
    current['x-tools']['verify']['outputSchema']['$ref'] = './domain.schema.json#/$defs/VerifyToolOutputV11'
    current['x-tools']['submit_result']['inputSchema']['$ref'] = './domain.schema.json#/$defs/SubmitResultToolInputV11'
    current = copy.deepcopy(current)
    current['$id'] = 'https://factory.example/spec/factory-tools/1.2.0'
    current['properties']['toolSetVersion']['const'] = '1.2.0'
    current['x-tools']['submit_result']['inputSchema']['$ref'] = './domain.schema.json#/$defs/SubmitResultToolInputV12'
    current['x-tools']['get_evidence']['inputSchema']['$ref'] = './domain.schema.json#/$defs/GetEvidenceToolInputV12'
    for name, schema in [('open_hypothesis', 'OpenHypothesisToolInput'), ('record_evidence', 'RecordEvidenceToolInput'), ('close_hypothesis', 'CloseHypothesisToolInput'), ('extend_hypothesis', 'ExtendHypothesisToolInput'), ('reopen_hypothesis', 'ReopenHypothesisToolInput')]:
        current['x-tools'][name] = {'inputSchema': {'$ref': './domain.schema.json#/$defs/'+schema}, 'outputSchema': {'$ref': './domain.schema.json#/$defs/HypothesisToolOutput'}}
    (C/'factory-tools.schema.json').write_text(json.dumps(current, indent=2)+'\n')
    from frozen_tool_contracts import write_tools as write_frozen_tools
    write_frozen_tools(C)


def examples(E, write, uid, art, task):
    scope = {'taskId': uid(2), 'applicationIds': [uid(10)], 'resourceIds': ['repo-20/src/**'], 'workType': 'feature', 'environment': 'preview'}
    rule = {'schemaVersion': '2.0', 'ruleId': 'architecture.layer-direction', 'revision': 1, 'ownerPrincipalId': uid(1301), 'layer': 'organization', 'statement': 'Domain modules must not import transport handlers.', 'authoritativeSourceRef': art(1302), 'applicabilityRef': art(1303), 'severity': 'blocking', 'waivable': True, 'enforcementRefs': [art(1304)]}
    write(E/'rule-definition.json', rule)
    write(E/'standards-bundle.json', {'schemaVersion': '2.0', 'id': 'engineering-fixture', 'revision': 1, 'sourceRef': art(1302), 'ruleRefs': [art(1305)], 'reviewRef': art(1306)})
    write(E/'rule-exception.json', {'schemaVersion': '2.0', 'id': uid(1307), 'ruleId': rule['ruleId'], 'ruleRevision': 1, 'ruleRef': art(1305), 'scope': scope, 'requestedRelaxation': 'Permit the named legacy adapter for this preview task only.', 'reason': 'Fixture demonstrating scoped approval; not blanket production permission.', 'compensatingControlsRef': art(1308), 'validFrom': '2026-10-02T00:00:00Z', 'expiresAt': '2026-10-03T00:00:00Z'})
    write(E/'rule-exception-grant.json', {'schemaVersion': '2.0', 'exceptionRef': art(1331), 'decisionRefs': [art(1309)]})
    write(E/'resolved-rules.json', {'schemaVersion': '2.0', 'scope': scope, 'resolverVersion': '1.0.0', 'bundleRefs': [art(1310)], 'ruleRefs': [art(1305)], 'exceptionRefs': []})
    write(E/'role-package.json', {'schemaVersion': '2.0', 'id': 'implementer-fixture', 'revision': 1, 'role': 'implementer', 'objective': 'Implement the signed plan within granted scope.', 'completionContractRef': art(1311), 'requiredContentRef': art(1312), 'toolSetVersion': '1.1.0', 'standardsBundleRefs': [art(1310)], 'optionalSkillAdmissionRefs': []})
    write(E/'compiled-role.json', {'schemaVersion': '2.0', 'rolePackageRef': art(1313), 'resolvedRulesRef': art(1314), 'adapterProfileRef': art(1315), 'compilerVersion': '1.0.0', 'factoryConfigurationRef': art(1316), 'deliveredContentRef': art(1317), 'mechanism': 'prompt_append'})
    write(E/'role-delivery-attestation.json', {'schemaVersion': '2.0', 'compiledRoleRef': art(1318), 'adapterProfileRef': art(1315), 'modelProfileRef': art(1319), 'fixtureRef': art(1320), 'observedContentDigest': art(1317)['sha256'], 'requestCaptureRef': art(1321), 'observedAt': '2026-10-02T12:00:00Z', 'producerId': 'synthetic-qualification-fixture'})
    write(E/'skill-admission.json', {'schemaVersion': '2.0', 'id': uid(1322), 'sourceUrl': 'https://example.com/fixture-skill', 'sourceCommit': 'a'*40, 'license': 'MIT', 'sourceTreeDigest': 'b'*64, 'adaptedContentRef': art(1323), 'inventoryRef': art(1324), 'reviewRef': art(1325), 'qualificationRef': art(1326), 'allowedRoles': ['implementer', 'reviewer'], 'executableContent': False})
    feedback = json.loads((E/'factory-verify-feedback.json').read_text())
    feedback.update(verificationRunId=uid(1327), stageRunId='task-2/plan-1/implement/attempt-1', inputHash='c'*64, workspaceSourceDigest='d'*64, visiblePackageRef=art(1328), recipeRefs=[art(1401)], completedAt='2026-10-02T12:00:00Z')
    write(E/'factory-verify-feedback-v1.1.json', feedback)
    proposal = json.loads((E/'factory-submit-result.json').read_text())
    proposal.update(feedbackClaims=[{'verificationRunId': uid(1327), 'receiptRef': art(1330), 'workspaceSourceDigest': 'd'*64, 'visiblePackageRef': art(1328), 'recipeRefs': [art(1401)], 'status': 'failed', 'scope': 'current_source'}], deferredWork=[{'id': 'D1', 'kind': 'limitation', 'description': 'Duplicate request behavior still fails the visible check.', 'impact': 'Acceptance criterion C2 remains unmet; this is not a success claim.', 'criterionIds': ['C2'], 'ruleIds': [], 'evidenceRefs': [art(1330)]}])
    proposal['output']['limitations'] = ['Duplicate request behavior still fails the visible check.']
    write(E/'factory-submit-result-v1.1.json', proposal)
    v12 = copy.deepcopy(proposal)
    v12['missingContext'] = ['No authorized production trace was available; this is an untrusted context-gap report.']
    write(E/'factory-submit-result-v1.2.json', v12)
    write(E/'factory-open-hypothesis.json', {'callId': uid(1340), 'statement': 'Retry may duplicate the reservation.', 'prediction': 'A repeated logical request yields two reservations.', 'killCriterion': 'Both attempts resolve to the same stored reservation.', 'plannedExperiment': 'Run the granted duplicate-request fixture.', 'timebox': {'toolCalls': 5, 'minutes': 10}})
    write(E/'factory-evidence-query-v1.2.json', {'callId': uid(1341), 'sourceKind': 'ci', 'sourceId': 'fixture-ci', 'queryTemplateId': 'test-failures-v1', 'parameters': {'runId': 'fixture-17'}, 'timeRange': {'start': '2026-10-09T10:00:00Z', 'end': '2026-10-09T11:00:00Z'}, 'maxResults': 10, 'maxBytes': 8192})
    write(E/'implementation-task.json', {'id': 'T1', 'outcome': 'Add atomic cancellation, ownership and audit behavior.', 'dependsOn': [], 'pathsOrResources': ['services/orders', 'db/migrations'], 'criterionIds': ['C1', 'C2', 'C3', 'C4'], 'checkStrategy': {'kind': 'recipe', 'recipeRefs': [art(1401)], 'evidenceRequirementRefs': [], 'rationale': 'Visible transaction, ownership and audit checks.'}})
    write(E/'reuse-justification.json', {'id': 'R1', 'kind': 'component', 'name': 'Reservation deduplication helper', 'neededBecause': 'Two handlers share the accepted idempotence contract.', 'existingCode': 'Use the existing reservation store.', 'standardLibrary': 'No storage transaction boundary supplied.', 'platform': 'Existing database uniqueness is retained.', 'existingDependencies': 'Existing database client suffices.', 'choice': 'Extract a small internal helper; add no dependency.', 'tradeoffs': 'One shared module with explicit transaction ownership.'})

