"""Revision 1.4 static fixture checks; no runtime/provider qualification is implied."""
import copy
import hashlib
import re
from operational_contracts import MANDATORY_HUMAN_GATES, DEFAULT_STAGE_WALL_SECONDS, RUNNER_FINALISATION_GRACE_SECONDS, RUNNER_TERMINATION_GRACE_SECONDS


def validate_operational(ROOT, defs, validate, check, read):
    def reject(value, name, label, predicate=None):
        schema = defs[name]
        try:
            validate(value, schema)
            if predicate:
                predicate(value)
        except ValueError:
            check(True, 'Rejected operational fixture: '+label)
        else:
            raise AssertionError('Invalid operational fixture accepted: '+label)

    mappings = {
        'review-followthrough-task.json': 'TaskRequest',
        'factory-submit-result.json': 'SubmitResultToolInput',
        'factory-submit-receipt.json': 'SubmitResultToolOutputFrozenToolsV1',
        'factory-verify-feedback.json': 'VerifyToolOutput',
        'failure-signature-profile.json': 'FailureSignatureProfile',
        'pr-review-state.json': 'PRReviewState',
        'application-health-sample.json': 'ApplicationHealthSample',
        'autonomy-policy-decision.json': 'AutonomyPolicyDecision',
        'harness-run-result.json': 'HarnessRunResult',
        'interface.json': 'InterfaceDefinition',
        'application-snapshot.json': 'ApplicationSnapshot',
    }
    for filename, name in mappings.items():
        validate(read(ROOT/'examples'/filename), defs[name])
        check(True, 'Operational example: '+filename)

    diagnostic=read(ROOT/'examples/harness-run-result.json')
    bad=copy.deepcopy(diagnostic);bad['status']='completed'
    reject(bad,'HarnessRunResult','adapter asserts accepted status')
    bad=copy.deepcopy(diagnostic);bad['producerKind']='runner'
    reject(bad,'HarnessRunResult','adapter claims runner authority')
    reject(diagnostic,'StageResult','adapter diagnostics used as accepted result')
    interface=read(ROOT/'examples/interface.json')
    bad=copy.deepcopy(interface);bad['contractSource']['commit']='main'
    reject(bad,'InterfaceDefinition','floating interface contract source')
    bad=copy.deepcopy(interface);bad.pop('contractDigest')
    reject(bad,'InterfaceDefinition','interface contract without digest')
    snapshot=read(ROOT/'examples/application-snapshot.json');snapshot.pop('interfaceDefinitionRefs')
    validate(snapshot,defs['ApplicationSnapshot'])
    check(True,'Older application snapshots remain readable without interface refs')
    usage=diagnostic['usage'][0]
    for field in ('source','intervalStart','intervalEnd'):
        bad=copy.deepcopy(usage);bad[field]=42
        reject(bad,'UsageObservation','invalid usage provenance: '+field)
    finding={'id':interface['ownerApplicationId'],'taskId':interface['knownConsumerApplicationIds'][0],'subjectHash':'a'*64,'category':'implementation','severity':'high','criterionIds':[],'statement':'Duplicate reservation.','evidenceRefs':[],'requiredAction':'Repair retry behavior.','status':'open','consequence':'A retry can charge twice.','confidence':'high'}
    validate(finding,defs['Finding'])
    bad=copy.deepcopy(finding);bad['confidence']=0.9
    reject(bad,'Finding','numeric finding confidence instead of qualitative label')
    finding.pop('consequence');finding.pop('confidence');validate(finding,defs['Finding'])
    knowledge={'id':interface['ownerApplicationId'],'proposal':{'kind':'observed_fact','scope':'application','statement':'A retry can duplicate a reservation.','sourceRefs':[diagnostic['diagnosticRef']],'applicableVersions':['1.0'],'taskId':finding['taskId']},'status':'disputed','disputes':[finding['taskId']]}
    validate(knowledge,defs['KnowledgeView'])
    bad=copy.deepcopy(knowledge);bad['disputes']=['not-a-record-id']
    reject(bad,'KnowledgeView','malformed dispute reference')
    knowledge.pop('disputes');validate(knowledge,defs['KnowledgeView'])
    check(True,'Optional finding and knowledge metadata preserve older payloads')
    signature={'digest':'a'*64,'keys':{'failureKind':'DuplicateReservation','normalizedFrames':['orders.reserve'],
                                     'normalizerVersion':'fixture-v1'}}
    validate(signature,defs['FailureSignature'])
    knowledge['proposal'].update(failureSignature=signature,componentIds=[finding['taskId']])
    validate(knowledge,defs['KnowledgeView'])
    check(True,'Canonical failure signature permits an unknown endpoint and separate component ownership')
    signature['keys']['endpointOrContractRef']='orders.reserve.v1'
    validate(signature,defs['FailureSignature'])
    bad=dict(signature['keys'],digest=signature['digest'],componentId=finding['taskId'])
    reject(bad,'FailureSignature','obsolete flat IncidentMemory signature')
    bad=copy.deepcopy(signature);bad['keys']['endpointOrContractRef']=''
    reject(bad,'FailureSignature','empty invented endpoint')
    bad=copy.deepcopy(knowledge['proposal']);bad.pop('componentIds')
    reject(bad,'KnowledgeProposal','signature without affected component scope')

    tools = read(ROOT/'contracts/factory-tools.v1.0.schema.json')
    check(tools['properties']['toolSetVersion']['const']=='1.0.0', 'Factory tool-set version pinned')
    check(set(tools['x-tools'])=={'verify','submit_result','request_decision','get_evidence'}, 'Four bounded factory tools')
    for name, pair in tools['x-tools'].items():
        for field in ('inputSchema','outputSchema'):
            check(pair[field]['$ref'].split('/')[-1] in defs, 'Factory tool schema resolves: '+name+' '+field)

    proposal=read(ROOT/'examples/factory-submit-result.json')
    bad=copy.deepcopy(proposal);bad['output']['gateVerdict']='passed'
    reject(bad,'SubmitResultToolInput','author-supplied gate verdict')
    bad=copy.deepcopy(proposal);bad['allocationEpoch']=99
    reject(bad,'SubmitResultToolInput','caller-supplied allocation authority')
    bad=copy.deepcopy(proposal);bad['output']['role']='verifier'
    reject(bad,'SubmitResultToolInput','model acts as trusted verifier')
    bad=copy.deepcopy(proposal);bad['output'].pop('workspaceSourceDigest')
    reject(bad,'SubmitResultToolInput','implementation submission lacks source claim')
    receipt=read(ROOT/'examples/factory-submit-receipt.json')
    check(receipt['state']=='proposal_received' and 'resultRef' not in receipt, 'Example receipt is not completion')
    bad=copy.deepcopy(receipt);bad['state']='finalized'
    reject(bad,'SubmitResultToolOutputFrozenToolsV1','finalized receipt without accepted result')
    feedback=read(ROOT/'examples/factory-verify-feedback.json')
    bad=copy.deepcopy(feedback);bad['classification']='gate_evidence'
    reject(bad,'VerifyToolOutput','feedback promoted to gate evidence')
    bad=copy.deepcopy(feedback);bad['firstFailures']*=11
    reject(bad,'VerifyToolOutput','unbounded feedback failures')
    task=read(ROOT/'examples/review-followthrough-task.json')
    bad=copy.deepcopy(task);bad['deliveryScope']='report'
    reject(bad,'TaskRequest','PR completion policy on non-PR request')
    bad=copy.deepcopy(task);bad['prCompletion']['maxReviewRounds']=0
    reject(bad,'TaskRequest','unbounded or zero review rounds')

    def human_pr_ready(state):
        """Retained human-mode completion fixtures; ai-review/1.0 is checked separately."""
        validate(state,defs['PRReviewState'])
        if state['reviewRound']>state['completionPolicy']['maxReviewRounds']:
            raise ValueError('round cap exceeded')
        if state['phase']!='completed':
            return
        mode=state['completionPolicy']['mode']
        for pr in state['pullRequests']:
            if pr['expectedHead']!=pr['observedHead']:
                raise ValueError('head conflict')
            if pr['state']=='closed':
                raise ValueError('unmerged close')
            if mode in ('review_completed','merged') and pr['reviewState']!='approved':
                raise ValueError('missing current-head approval')
            if mode=='merged' and (pr['state']!='merged' or 'mergedCommit' not in pr):
                raise ValueError('missing observed merge')
        if state['findingRefs'] or state['pendingDecisionIds']:
            raise ValueError('unresolved review')
    state=read(ROOT/'examples/pr-review-state.json');human_pr_ready(state)
    complete=copy.deepcopy(state);complete['phase']='completed';complete['pullRequests'][0]['reviewState']='approved';human_pr_ready(complete)
    check(True,'PR review fixture can complete at approved exact head')
    for label, mutate in [
        ('stale approval head',lambda s:s['pullRequests'][0].update(observedHead='b'*40)),
        ('unmerged close',lambda s:s['pullRequests'][0].update(state='closed')),
        ('missing human approval',lambda s:s['pullRequests'][0].update(reviewState='pending')),
        ('merge target before merge',lambda s:s['completionPolicy'].update(mode='merged')),
        ('exceeded review cap',lambda s:s.update(reviewRound=4)),
    ]:
        bad=copy.deepcopy(complete);mutate(bad);reject(bad,'PRReviewState',label,human_pr_ready)

    # Static no-change shapes and cross-artifact predicates, not runtime qualification.
    def no_change_ready(record, review, manifest, subject):
        for value, name in ((record, 'RecipeOutcomeRecord'), (review, 'PRReviewState'), (manifest, 'OutcomeManifest')):
            validate(value, defs[name])
        kinds = {'already_compliant': 'no_change_compliant', 'not_applicable': 'no_change_not_applicable'}
        if not subject['acceptedNoChange'] or subject['workType']=='bug' or subject['targetKind']!='existing_application':
            raise ValueError('no accepted no-change recipe branch')
        if subject['branchPresent'] or subject['pendingPublication'] or not subject['independentEvidencePassed']:
            raise ValueError('publication or evidence unresolved')
        for field in ('taskId', 'recipeRef', 'repositoryId', 'sourceCommit', 'inputBinding', 'inputHash'):
            if record[field]!=subject[field]:
                raise ValueError('stale no-change binding: '+field)
        if 'candidateRef' in record['inputBinding'] or manifest['outcomeKind']!=kinds.get(record['outcome']):
            raise ValueError('not a matching no-change outcome')
        if review['phase']!='completed_no_change' or review['taskId']!=record['taskId'] or manifest['taskId']!=record['taskId']:
            raise ValueError('no-change state/task mismatch')
        if review['recipeOutcomeRef']!=subject['recordRef'] or manifest['recipeOutcomeRef']!=subject['recordRef'] or manifest['prReviewStateRef']!=subject['stateRef']:
            raise ValueError('no-change artifact mismatch')
        if review['gateEvaluationRefs']!=subject['gateEvaluationRefs'] or manifest['gateEvaluationRefs']!=subject['gateEvaluationRefs']:
            raise ValueError('missing current gate evidence')

    for outcome in ('already_compliant', 'not_applicable'):
        record=read(ROOT/'examples'/('recipe-'+outcome+'.json'))
        review=read(ROOT/'examples'/('pr-review-'+outcome+'.json'))
        manifest=read(ROOT/'examples'/('outcome-'+outcome+'.json'))
        subject={field:copy.deepcopy(record[field]) for field in ('taskId','recipeRef','repositoryId','sourceCommit','inputBinding','inputHash')}
        subject.update(acceptedNoChange=True, workType='maintenance', targetKind='existing_application', branchPresent=False, pendingPublication=False, independentEvidencePassed=True,
                       recordRef=manifest['recipeOutcomeRef'], stateRef=manifest['prReviewStateRef'], gateEvaluationRefs=manifest['gateEvaluationRefs'])
        for mode in ('pr_created','review_completed','merged'):
            review['completionPolicy']['mode']=mode
            no_change_ready(record,review,manifest,subject)
            check(True,'Evidence-bound no-change completion: '+outcome+'/'+mode)
        for field in ('recipeOutcomeRef','prReviewStateRef','gateEvaluationRefs'):
            bad=copy.deepcopy(manifest);bad.pop(field)
            reject(bad,'OutcomeManifest','no-change missing '+field)
        for field,value in (('candidateRef',subject['recordRef']),('providerHandles',['github:184']),('gateEvaluationRefs',[]),('deliveryScope','production'),('status','incomplete')):
            bad=copy.deepcopy(manifest);bad[field]=value
            reject(bad,'OutcomeManifest','invalid no-change '+field)
        for field,value in (('lastCandidateRef',subject['recordRef']),('pullRequests',state['pullRequests']),('pendingDecisionIds',[record['taskId']]),('findingRefs',[subject['recordRef']]),('gateEvaluationRefs',[])):
            bad=copy.deepcopy(review);bad[field]=value
            reject(bad,'PRReviewState','invalid no-change review '+field)
        bad=copy.deepcopy(review);bad.pop('recipeOutcomeRef')
        reject(bad,'PRReviewState','no-change review without outcome evidence')
        bad=copy.deepcopy(record);bad['evidenceRefs']=[]
        reject(bad,'RecipeOutcomeRecord','no-change without independent evidence')
        bad=copy.deepcopy(record);bad['inputBinding']['candidateRef']=subject['recordRef']
        reject(bad,'RecipeOutcomeRecord','no-change bound to a candidate')
        for field,value in (('sourceCommit','b'*40),('recipeRef',subject['stateRef']),('inputHash','d'*64),('outcome','needs_judgement'),('outcome','changed')):
            bad=copy.deepcopy(record);bad[field]=value
            reject(bad,'RecipeOutcomeRecord','no-change semantic '+field+'/'+str(value),lambda r:no_change_ready(r,review,manifest,subject))
        for field,value in (('acceptedNoChange',False),('workType','bug'),('targetKind','new_application'),('branchPresent',True),('pendingPublication',True),('independentEvidencePassed',False)):
            bad_subject=dict(subject);bad_subject[field]=value
            reject(record,'RecipeOutcomeRecord','ineligible no-change '+field,lambda r:no_change_ready(r,review,manifest,bad_subject))
    bad=copy.deepcopy(complete);bad['pullRequests']=[]
    reject(bad,'PRReviewState','ordinary completed PR task without a PR')
    bad=copy.deepcopy(complete);bad.pop('lastCandidateRef')
    reject(bad,'PRReviewState','ordinary PR completion without candidate')

    policy=read(ROOT/'examples/autonomy-policy-decision.json')
    bad=copy.deepcopy(policy);bad.update(direction='relax',actorKind='authorized_rule')
    reject(bad,'AutonomyPolicyDecision','automatic autonomy relaxation')
    bad=copy.deepcopy(policy);bad['gateModes'][0]['mode']='automated'
    reject(bad,'AutonomyPolicyDecision','explicit human floor bypass')
    for gate in MANDATORY_HUMAN_GATES:
        for mode in ('automated','human_sampled','human'):
            bad=copy.deepcopy(policy);bad['gateModes'][0].update(gateId=gate,mode=mode,humanFloor=False)
            reject(bad,'AutonomyPolicyDecision','human floor hidden by flag: '+gate+'/'+mode)
            bad=read(ROOT/'examples/policy.json');bad['gateModeRules'][0].update(gateId=gate,mode=mode,humanFloor=False)
            reject(bad,'PolicyProfile','profile human floor hidden by flag: '+gate+'/'+mode)
    profile=read(ROOT/'examples/policy.json')
    check(set(MANDATORY_HUMAN_GATES)<=set(profile['nonwaivableGates']), 'Policy example names every mandatory human gate')
    check(set(MANDATORY_HUMAN_GATES)<={rule['gateId'] for rule in profile['gateModeRules'] if rule['mode']=='human' and rule['humanFloor']}, 'Policy example retains every human mode floor')
    bad=copy.deepcopy(profile);bad['nonwaivableGates'].append('bug_red_lock_green')
    reject(bad,'PolicyProfile','invariant label used as a gate')
    check(set(profile['riskTriggers'])=={'public_api','authentication_authorization','payment','sensitive_data','persistent_migration','several_services','unknown_blast_radius','critical_application','privileged_infrastructure','performance_resource_risk'}, 'Organization-default risk triggers cover chapter 05')
    check(profile['stageWallSecondsByTimeoutClass']==DEFAULT_STAGE_WALL_SECONDS, 'Policy wall caps match timeout defaults')
    for invalid_caps in ({'execute':0},{'human_wait':2700},{'unknown':600}):
        bad=copy.deepcopy(profile);bad['stageWallSecondsByTimeoutClass']=invalid_caps
        reject(bad,'PolicyProfile','invalid stage wall caps: '+str(invalid_caps))
    bad=copy.deepcopy(profile);bad.pop('stageWallSecondsByTimeoutClass');validate(bad,defs['PolicyProfile'])
    job=read(ROOT/'examples/kubernetes-job.json')
    check(job['spec']['activeDeadlineSeconds']==profile['stageWallSecondsByTimeoutClass']['execute']+RUNNER_FINALISATION_GRACE_SECONDS, 'Job deadline derives from execute cap plus finalisation grace')
    check(job['spec']['template']['spec']['terminationGracePeriodSeconds']==RUNNER_TERMINATION_GRACE_SECONDS==15, 'Job has chapter 06 termination grace')
    metadata=job['metadata'];pod_metadata=job['spec']['template']['metadata']
    for key in ('stage-run','generation','spec-hash'):
        label='factory.example/'+key
        check(metadata['labels'][label]==pod_metadata['labels'][label], 'Job/pod ownership label agrees: '+key)
    for value in metadata['labels'].values():
        check(len(value)<=63 and re.fullmatch(r'[a-zA-Z0-9](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9])?',value), 'Job ownership label is Kubernetes-safe')
    annotations=metadata['annotations']
    validate(annotations['factory.example/stage-run-full'],defs['LogicalStageRunId'])
    validate(annotations['factory.example/spec-hash-full'],defs['Digest'])
    check(metadata['labels']['factory.example/stage-run']==hashlib.sha256(annotations['factory.example/stage-run-full'].encode()).hexdigest()[:32], 'Stage-run label binds full annotated identity')
    check(annotations['factory.example/spec-hash-full'].startswith(metadata['labels']['factory.example/spec-hash']), 'Spec label prefixes full annotated digest')
    check(int(annotations['factory.example/owner-epoch'])>0 and int(metadata['labels']['factory.example/generation'])>0, 'Job generation and owner epoch are positive')
    check(annotations==pod_metadata['annotations'], 'Job and pod full ownership bindings agree')
    bad=copy.deepcopy(policy);bad['gateModes'][0]['sampleBasisPoints']=10001
    reject(bad,'AutonomyPolicyDecision','invalid audit sampling probability')
    sample=read(ROOT/'examples/application-health-sample.json')
    check(sample['metrics'][0]['maturity']=='immature' and sample['metrics'][0]['denominator']==0,
          'Health fixture honestly reports immature denominator')
    profile=read(ROOT/'examples/failure-signature-profile.json')
    check(set(profile['rejectedClasses'])=={'compile','setup','discovery','network','timeout'}, 'Failure profile excludes infrastructure red')
    bad=copy.deepcopy(profile);bad['intendedAssertionMatchers']=[]
    reject(bad,'FailureSignatureProfile','baseline parser without intended matcher')

    pod=read(ROOT/'examples/kubernetes-job.json')['spec']['template']['spec']
    containers={c['name']:c for c in pod['containers']}
    check(set(containers)=={'supervisor','harness'}, 'Separate code and supervisor containers')
    check(any(v['name']=='workspace' and 'persistentVolumeClaim' in v for v in pod['volumes']), 'Workspace retained after whole-pod stop')
    check(not pod['automountServiceAccountToken'] and not pod['shareProcessNamespace'], 'No automatic token or shared process namespace')
    for name,container in containers.items():
        mounted={v['name'] for v in container['volumeMounts']}
        check(('factory-identity' in mounted)==(name=='supervisor'), 'Supervisor-only identity mount: '+name)
        check(container['securityContext']['readOnlyRootFilesystem'] and not container['securityContext']['allowPrivilegeEscalation'], 'Hardened container example: '+name)
        check(all({'cpu','memory','ephemeral-storage'}<=set(container['resources'][kind]) for kind in ('requests','limits')), 'Explicit factory resource bounds: '+name)
    check(any(v['name']=='workspace' and v.get('readOnly') for v in containers['supervisor']['volumeMounts']), 'Supervisor does not run mutable candidate workspace')
    check(containers['harness']['securityContext']['runAsUser']!=containers['supervisor']['securityContext']['runAsUser'], 'Distinct container user IDs')

    sql=(ROOT/'contracts/schema.sql').read_text()
    check('WHERE proposal_accepted;' in sql, 'Invalid submissions do not consume accepted proposal identity')
    check("'stopping','finalizing'" in sql, 'Allocation claim survives expected pod stop and finalisation')
    work={p['id']:p for p in read(ROOT/'backlog.json')['packages']}
    check(work['W-035']['milestone']=='M3' and work['W-026']['milestone']=='M4', 'Claude pilot before Codex portability')
    check(work['W-025']['milestone']=='M2' and work['W-075']['milestone']=='M2', 'Context and factory tools ready in M2')
    check(work['W-077']['milestone']=='M0' and work['W-078']['milestone']=='M0', 'Provider feasibility spikes first')
    check(work['W-079']['milestone']=='M1' and work['W-088']['milestone']=='M2', 'Fault injection and admission precede real pilot')
    check('W-039' not in work['W-056']['dependsOn'] and 'W-056' not in work['W-058']['dependsOn'], 'Unrelated backup/security dependencies removed')
    check(work['W-126']['milestone']=='M7' and {'W-042','W-052','W-054'}<=set(work['W-126']['dependsOn']), 'Urgent hotfix follows qualified environment, production and capacity work')
    for package in work.values():
        for dependency in package['dependsOn']:
            check(int(work[dependency]['milestone'][1:])<=int(package['milestone'][1:]),
                  'Milestone prerequisite order: '+package['id']+' '+dependency)

