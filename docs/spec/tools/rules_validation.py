"""Static revision 1.5 fixture predicates, not runtime policy or harness tests."""
import copy
from datetime import datetime


def validate_rules(ROOT, defs, validate, check, read):
    def reject(value, name, label, predicate=None):
        schema = defs[name]
        try:
            validate(value, schema)
            if predicate:
                predicate(value)
        except ValueError:
            check(True, 'Rejected rules fixture: '+label)
        else:
            raise AssertionError('Invalid rules fixture accepted: '+label)

    mappings = {
        'rule-definition.json': 'RuleDefinition',
        'standards-bundle.json': 'StandardsBundle',
        'rule-exception.json': 'RuleException',
        'rule-exception-grant.json': 'RuleExceptionGrant',
        'resolved-rules.json': 'ResolvedRules',
        'role-package.json': 'RolePackage',
        'compiled-role.json': 'CompiledRole',
        'role-delivery-attestation.json': 'RoleDeliveryAttestation',
        'skill-admission.json': 'SkillAdmission',
        'factory-verify-feedback-v1.1.json': 'VerifyToolOutputV11FrozenToolsV1',
        'factory-submit-result-v1.1.json': 'SubmitResultToolInputV11',
        'factory-submit-result-v1.2.json': 'SubmitResultToolInputV12',
        'factory-open-hypothesis.json': 'OpenHypothesisToolInput',
        'factory-evidence-query-v1.2.json': 'GetEvidenceToolInputV12',
        'implementation-task.json': 'ImplementationTask',
        'reuse-justification.json': 'ReuseJustification',
    }
    for filename, name in mappings.items():
        validate(read(ROOT/'examples'/filename), defs[name])
        check(True, 'Rules example: '+filename)
    manifest=read(ROOT/'contracts/factory-tools.schema.json')
    check(manifest['properties']['toolSetVersion']['const']=='1.2.0', 'Current tools require explicit 1.2 profile')
    check(manifest['x-tools']['submit_result']['inputSchema']['$ref'].endswith('/SubmitResultToolInputV12'), '1.2 submission shape selected')
    for name,pair in manifest['x-tools'].items():
        for field in ('inputSchema','outputSchema'):
            check(pair[field]['$ref'].split('/')[-1] in defs, '1.2 tool reference resolves: '+name+' '+field)
    retained=read(ROOT/'contracts/factory-tools.v1.1.schema.json')
    v10=read(ROOT/'contracts/factory-tools.v1.0.schema.json')
    check(retained['properties']['toolSetVersion']['const']=='1.1.0', '1.1 manifest retained')
    check(set(retained['x-tools'])==set(v10['x-tools']), '1.1 does not acquire ledger tools')
    for tool in ('get_evidence','request_decision'):
        check(retained['x-tools'][tool]==v10['x-tools'][tool], 'Shared legacy shape retained: '+tool)
    check(retained['x-tools']['submit_result']['inputSchema']['$ref'].endswith('/SubmitResultToolInputV11FrozenToolsV1'), '1.1 submission stays pinned')
    v12=read(ROOT/'examples/factory-submit-result-v1.2.json')
    reject(v12,'SubmitResultToolInputV11','1.2 missingContext silently used with 1.1')
    check(defs['StageInput']['properties']['factoryToolSetVersion']['enum']==['1.0.0','1.1.0','1.2.0'], 'Stage admission versions explicit')
    check(defs['RolePackage']['properties']['toolSetVersion']['enum']==['1.1.0','1.2.0'], 'Role package versions explicit')
    legacy=read(ROOT/'examples/factory-submit-result.json')
    validate(legacy,defs['SubmitResultToolInput'])
    reject(legacy,'SubmitResultToolInputV11','legacy submission presented as 1.1')
    current=read(ROOT/'examples/factory-submit-result-v1.1.json')
    reject(current,'SubmitResultToolInput','1.1 silently negotiated as 1.0')
    empty=copy.deepcopy(current);empty.update(feedbackClaims=[],deferredWork=[])
    empty['output']['limitations']=[]
    validate(empty,defs['SubmitResultToolInputV11'])
    check(True,'Empty declarations are valid without inventing evidence')
    for key in ('feedbackClaims','deferredWork'):
        bad=copy.deepcopy(current);bad.pop(key)
        reject(bad,'SubmitResultToolInputV11','missing '+key)
    feedback=read(ROOT/'examples/factory-verify-feedback-v1.1.json')
    bad=copy.deepcopy(feedback);bad['classification']='gate_evidence'
    reject(bad,'VerifyToolOutputV11FrozenToolsV1','feedback claims gate authority')
    bad=copy.deepcopy(current);bad['allocationEpoch']=3
    reject(bad,'SubmitResultToolInputV11','agent supplies allocation authority')

    # Illustrative trusted receipt lookup. Real implementation must authenticate the
    # producer, task, allocation, input and artifact digest; these are synthetic refs.
    source=feedback['workspaceSourceDigest']
    receipt_ref=current['feedbackClaims'][0]['receiptRef']
    def claims_match(value, runs=None, final_source=source):
        runs=runs or [feedback]
        for claim in value['feedbackClaims']:
            matches=[r for r in runs if r['verificationRunId']==claim['verificationRunId']]
            if len(matches)!=1 or claim['receiptRef']!=receipt_ref:
                raise ValueError('unknown or mismatched receipt')
            receipt=matches[0]
            for key in ('workspaceSourceDigest','visiblePackageRef','recipeRefs','status'):
                if claim[key]!=receipt[key]:
                    raise ValueError('claim contradicts receipt '+key)
            if receipt['stageRunId']!=feedback['stageRunId'] or receipt['inputHash']!=feedback['inputHash']:
                raise ValueError('wrong authenticated input')
            if claim['scope']=='current_source':
                if claim['workspaceSourceDigest']!=final_source:
                    raise ValueError('stale source')
                for recipe in claim['recipeRefs']:
                    relevant=[r for r in runs if r['workspaceSourceDigest']==final_source and
                              r['inputHash']==feedback['inputHash'] and r['visiblePackageRef']==claim['visiblePackageRef'] and
                              recipe in r['recipeRefs']]
                    latest=max(relevant,key=lambda r:r['completedAt'])
                    if claim['status']=='passed' and latest['status']!='passed':
                        raise ValueError('concealed later nonpass')
    claims_match(current)
    check(True,'Honest failure claim matches source-bound synthetic receipt')
    for field,value in [('status','passed'),('workspaceSourceDigest','e'*64),('verificationRunId','00000000-0000-4000-8000-000000999999')]:
        bad=copy.deepcopy(current);bad['feedbackClaims'][0][field]=value
        reject(bad,'SubmitResultToolInputV11','forged '+field,claims_match)
    bad=copy.deepcopy(current);bad['feedbackClaims'][0]['visiblePackageRef']['sha256']='e'*64
    reject(bad,'SubmitResultToolInputV11','changed package revision',claims_match)
    bad=copy.deepcopy(current);bad['feedbackClaims'][0]['recipeRefs'][0]['sha256']='e'*64
    reject(bad,'SubmitResultToolInputV11','changed recipe revision',claims_match)
    reject(current,'SubmitResultToolInputV11','source changed before finalization',
           lambda v:claims_match(v,final_source='e'*64))
    historical=copy.deepcopy(current);historical['feedbackClaims'][0]['scope']='historical'
    claims_match(historical,final_source='e'*64)
    check(True,'Historical failure can be cited without asserting current source')
    passing=copy.deepcopy(feedback);passing.update(status='passed',passed=4,failed=0,firstFailures=[])
    passing_claim=copy.deepcopy(current);passing_claim['feedbackClaims'][0]['status']='passed'
    claims_match(passing_claim,[passing])
    for status in ('failed','inconclusive','infrastructure_error'):
        later=copy.deepcopy(feedback);later.update(verificationRunId='00000000-0000-4000-8000-000000999998',completedAt='2026-10-02T12:01:00Z',status=status)
        reject(passing_claim,'SubmitResultToolInputV11','later '+status+' concealed',lambda v:claims_match(v,[passing,later]))
    bad_receipt=copy.deepcopy(feedback);bad_receipt['inputHash']='e'*64
    reject(current,'SubmitResultToolInputV11','receipt from another input',lambda v:claims_match(v,[bad_receipt]))

    rule=read(ROOT/'examples/rule-definition.json')
    exception=read(ROOT/'examples/rule-exception.json')
    scope=read(ROOT/'examples/resolved-rules.json')['scope']
    def exception_valid(value, definition=rule, approver=None, revoked=False):
        approver=approver or definition['ownerPrincipalId']
        if not definition['waivable'] or definition['ruleId'].startswith('invariant.'):
            raise ValueError('nonwaivable')
        if value['ruleId']!=definition['ruleId'] or value['ruleRevision']!=definition['revision']:
            raise ValueError('wrong rule revision')
        if value['scope']!=scope or approver!=definition['ownerPrincipalId'] or revoked:
            raise ValueError('invalid scope or authority')
        now=datetime.fromisoformat('2026-10-02T12:00:00+00:00')
        if not datetime.fromisoformat(value['validFrom'].replace('Z','+00:00'))<=now<datetime.fromisoformat(value['expiresAt'].replace('Z','+00:00')):
            raise ValueError('outside validity interval')
    exception_valid(exception)
    check(True,'Synthetic valid exception has exact scope owner and interval')
    for key,value in [('expiresAt','2026-10-02T00:00:00Z'),('validFrom','2026-10-03T00:00:00Z'),('ruleRevision',2)]:
        bad=copy.deepcopy(exception);bad[key]=value
        reject(bad,'RuleException',key,exception_valid)
    bad=copy.deepcopy(exception);bad['scope']['environment']='production'
    reject(bad,'RuleException','exception scope widening',exception_valid)
    reject(exception,'RuleException','wrong approving principal',lambda v:exception_valid(v,approver='wrong-owner'))
    reject(exception,'RuleException','revoked exception',lambda v:exception_valid(v,revoked=True))
    nonwaivable=copy.deepcopy(rule);nonwaivable['waivable']=False
    reject(exception,'RuleException','nonwaivable exception',lambda v:exception_valid(v,definition=nonwaivable))
    grant=read(ROOT/'examples/rule-exception-grant.json');grant['decisionRefs']=[]
    reject(grant,'RuleExceptionGrant','grant without decisions')

    reuse=read(ROOT/'examples/reuse-justification.json')
    bad=copy.deepcopy(reuse);bad['kind']='dependency'
    reject(bad,'ReuseJustification','new dependency without supply-chain review')
    check_strategy=read(ROOT/'examples/implementation-task.json')['checkStrategy']
    bad=copy.deepcopy(check_strategy);bad['recipeRefs']=[]
    reject(bad,'TaskCheckStrategy','executable task without check')
    bad=copy.deepcopy(check_strategy);bad['kind']='human_review'
    reject(bad,'TaskCheckStrategy','human task without evidence requirement')
    human=copy.deepcopy(bad);human['recipeRefs']=[];human['evidenceRequirementRefs']=[receipt_ref]
    validate(human,defs['TaskCheckStrategy'])
    check(True,'Non-executable work permits explicit human evidence')
    packet=read(ROOT/'examples/plan-review-packet.json')
    task1=read(ROOT/'examples/implementation-task.json')
    check(task1==packet['implementationTasks'][0],'Standalone T1 matches the review packet task and recipe')
    duplicate=next(s for s in packet['scenarios'] if s['id']=='S2')
    check(duplicate['criterionIds']==['C2'],'Review packet maps duplicate retries to C2/S2')
    for filename in ('factory-verify-feedback.json','factory-verify-feedback-v1.1.json'):
        check(read(ROOT/'examples'/filename)['firstFailures'][0]['scenarioId']==duplicate['id'],'Duplicate feedback maps to the packet scenario: '+filename)
    check(current['deferredWork'][0]['criterionIds']==duplicate['criterionIds'],'Deferred duplicate work maps to the packet criterion')
    def task_graph(value):
        if 'implementationTasks' not in value:
            raise ValueError('missing implementation tasks')
        ids={t['id'] for t in value['implementationTasks']}
        seen=set();criteria={c['id'] for c in value['criteria']}
        if len(ids)!=len(value['implementationTasks']) or not ids:
            raise ValueError('missing or duplicate task')
        for task in value['implementationTasks']:
            if not set(task['dependsOn'])<=seen or not set(task['criterionIds'])<=criteria:
                raise ValueError('unordered dependency or invalid criterion')
            seen.add(task['id'])
        if 'reuseJustifications' not in value or 'resolvedRulesRef' not in value:
            raise ValueError('missing profile fields')
    task_graph(packet)
    check(True,'Review fixture has ordered checked tasks and reuse rationale')
    bad=copy.deepcopy(packet);bad['implementationTasks'][0]['dependsOn']=[bad['implementationTasks'][-1]['id']]
    reject(bad,'PlanReviewPacket','cyclic or forward task dependency',task_graph)
    finding_props=defs['Finding']['properties']
    check('unnecessary_code' in finding_props['findingKind']['enum'] and 'unnecessary_code' not in finding_props['category']['enum'], 'Finding subtype preserves controller routes')
    check('decisionRefs' not in defs['RuleException']['properties'], 'Exception proposal hash is independent of later decisions')
    check('rolePackageRefs' in defs['BehaviorRelease']['properties'], 'Behavior identity covers canonical roles')
    work={p['id']:p for p in read(ROOT/'backlog.json')['packages']}
    check(work['W-089']['milestone']=='M2' and work['W-090']['milestone']=='M2', 'Rules and content prerequisites precede pilot')
    check(work['W-091']['milestone']=='M4' and 'W-091' not in work['W-033']['dependsOn'], 'Optional forensics does not block M3')

    # Revision 1.11 static contract fixtures; no runtime policy or provider claims.
    opened=read(ROOT/'examples/factory-open-hypothesis.json')
    for key in ('prediction','killCriterion','plannedExperiment','timebox'):
        bad=copy.deepcopy(opened);bad.pop(key)
        reject(bad,'OpenHypothesisToolInput','ledger declaration missing '+key)
    bad=copy.deepcopy(opened);bad['timebox']['extensionsUsed']=0
    reject(bad,'OpenHypothesisToolInput','caller owns ledger extension counter')
    bad=copy.deepcopy(opened);bad['stageRunId']='agent-selected-run'
    reject(bad,'OpenHypothesisToolInput','caller supplies ledger identity')
    artifact=read(ROOT/'examples/factory-submit-result-v1.1.json')['output']['changeSummaryRef']
    extension={'callId':opened['callId'],'hypothesisId':opened['callId'],'reason':'A new fixture became available.','expectedEvidence':'A discriminating response trace.','extension':{'toolCalls':2,'minutes':3}}
    validate(extension,defs['ExtendHypothesisToolInput'])
    bad=copy.deepcopy(extension);bad['extension']['extensionsUsed']=0
    reject(bad,'ExtendHypothesisToolInput','extension resets counter')
    reopened={k:copy.deepcopy(opened[k]) for k in ('callId','prediction','killCriterion','plannedExperiment','timebox')}
    reopened.update(failedHypothesisRef=artifact,newEvidenceRefs=[artifact])
    validate(reopened,defs['ReopenHypothesisToolInput'])
    bad=copy.deepcopy(reopened);bad['newEvidenceRefs']=[]
    reject(bad,'ReopenHypothesisToolInput','bare reopen')
    query=read(ROOT/'examples/factory-evidence-query-v1.2.json')
    reject(query,'GetEvidenceToolInput','live query silently selected for legacy tool')
    for key,value in [('sourceKind','shell'),('maxResults',101),('maxBytes',32769),('stageRunId','forged')]:
        bad=copy.deepcopy(query);bad[key]=value
        reject(bad,'GetEvidenceToolInputV12','invalid live query '+key)
    bad=copy.deepcopy(query);bad.pop('timeRange')
    reject(bad,'GetEvidenceToolInputV12','unbounded query')
    path={'repositoryId':opened['callId'],'commit':'a'*40,'paths':['src/reservations']}
    bad=copy.deepcopy(query);bad['pathScope']=path
    reject(bad,'GetEvidenceToolInputV12','ambiguous time and path scopes')
    for source in defs['GetEvidenceQueryInputV12']['properties']['sourceKind']['enum']:
        sample=copy.deepcopy(query);sample['sourceKind']=source
        if source in ('code_history','docs'):
            sample.pop('timeRange');sample['pathScope']=path
        validate(sample,defs['GetEvidenceToolInputV12'])
    check(True,'All declared evidence source shapes validate; grant enforcement remains AC-241')
    artifact_read={'callId':opened['callId'],'artifactRefs':[artifact],'maxBytes':100}
    validate(artifact_read,defs['GetEvidenceToolInput'])
    validate(dict(artifact_read,sourceKind='artifact'),defs['GetEvidenceToolInputV12'])
    check(True,'New evidence discriminator preserves the legacy artifact-only shape')

    security={'severity':'high','sourceRef':artifact,'embargoed':True,'securityGroupId':opened['callId']}
    task=read(ROOT/'examples/bug-task.json');task.update(priorityClass='incident',security=security,incidentRef=artifact)
    validate(task,defs['TaskRequest'])
    bad=copy.deepcopy(task);bad['security'].pop('securityGroupId')
    reject(bad,'TaskRequest','embargo without group')
    bad=copy.deepcopy(task);bad['workType']='feature'
    reject(bad,'TaskRequest','security on non-design feature without an embargoed design source')
    bad=copy.deepcopy(task);bad['changeClass']='caller-selected'
    reject(bad,'TaskRequest','caller chooses readiness class')
    bad=copy.deepcopy(task);bad['priorityClass']='urgent'
    reject(bad,'TaskRequest','unknown incident priority')
    outcome={'schemaVersion':'2.0','taskId':opened['callId'],'status':'incomplete','deliveryScope':'production','outcomeKind':'mitigated','deliveredArtifactRefs':[],'providerHandles':[],'gateEvaluationRefs':[],'decisionRefs':[],'usage':[],'limitations':['Bug is not yet reproduced or fixed.'],'knowledgeProposalIds':[],'cleanupObligationRefs':[],'completedAt':'2026-10-09T12:00:00Z','mitigationOperationRef':artifact,'recoveryEvidenceRef':artifact,'followUpTaskId':artifact['artifactId']}
    validate(outcome,defs['OutcomeManifest'])
    for key in ('mitigationOperationRef','recoveryEvidenceRef','followUpTaskId'):
        bad=copy.deepcopy(outcome);bad.pop(key)
        reject(bad,'OutcomeManifest','mitigation missing '+key)
    bad=copy.deepcopy(outcome);bad['status']='succeeded'
    reject(bad,'OutcomeManifest','mitigation claims fixed task success')
    target={'schemaVersion':'2.0','taskId':opened['callId'],'sourceRepositoryId':opened['callId'],'publicationRepositoryId':artifact['artifactId'],'baseBranch':'main','mode':'private_fork','securityGroupId':opened['callId'],'assignmentPolicyRef':artifact}
    validate(target,defs['PublicationTarget'])
    bad=copy.deepcopy(target);bad.pop('securityGroupId')
    reject(bad,'PublicationTarget','confidential publication without security group')
    sql=(ROOT/'contracts/schema.sql').read_text()
    import re
    names=re.search(r'tool_name text NOT NULL CHECK\(tool_name IN \(([^)]+)\)\)',sql)[1]
    check(set(re.findall(r"'([^']+)'",names))==set(manifest['x-tools']), 'SQL tool constraint agrees with current manifest')
    for table in ('task','artifact','outbox','inbox','audit_event','idempotency_record'):
        check(f'CREATE POLICY {table}_embargo ON {table} AS RESTRICTIVE' in sql,'Restrictive embargo policy: '+table)
    for table in ('task_event','artifact_link','knowledge_record','factory_tool_call','execution_allocation','checkpoint_job','decision','budget_ledger'):
        check(f'CREATE POLICY {table}_task_visibility ON {table} AS RESTRICTIVE' in sql,'Derived task visibility: '+table)
    check('GRANT SELECT, INSERT ON security_group_member TO factory_runtime' not in sql and 'GRANT UPDATE (revoked_at, updated_at) ON security_group_member TO factory_runtime' not in sql,'Runtime cannot self-grant security membership')
    check('403' in read(ROOT/'contracts/api.openapi.json')['paths']['/tasks']['post']['responses'],'Incident/security admission has explicit 403 response')
    check(work['W-126']['milestone']=='M7' and {'W-042','W-052'}<=set(work['W-126']['dependsOn']), 'Mitigation depends on qualified environment and production delivery')
