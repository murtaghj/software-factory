"""Generate reference contracts and consistent examples; no third-party packages."""
import json
import hashlib
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
C=ROOT/'contracts'; E=ROOT/'examples'
C.mkdir(exist_ok=True); E.mkdir(exist_ok=True)
API_VERSION='2.5.0'
D={}
def ref(n): return {'$ref':'#/$defs/'+n}
def text(minimum=1): return {'type':'string','minLength':minimum}
def integer(minimum=0): return {'type':'integer','minimum':minimum}
def array(item, minimum=0): return {'type':'array','items':item,'minItems':minimum}
def enum(*items): return {'type':'string','enum':list(items)}
def obj(props, optional=()): return {'type':'object','additionalProperties':False,'properties':props,'required':[k for k in props if k not in optional]}
def define(n,props,optional=()): D[n]=obj(props,optional); return ref(n)
def write(p,v): p.write_text(json.dumps(v,indent=2)+'\n')
UUID={'type':'string','format':'uuid'}; TIME={'type':'string','format':'date-time'}; BOOL={'type':'boolean'}
D['UUID']=UUID; D['Timestamp']=TIME; D['Digest']={'type':'string','pattern':'^[0-9a-f]{64}$'}
D['GitOid']={'type':'string','pattern':'^(?!0+$)([0-9a-f]{40}|[0-9a-f]{64})$'}
D['LogicalStageRunId']={'type':'string','pattern':'^task-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/plan-[1-9][0-9]*/[A-Za-z0-9][A-Za-z0-9_.-]*/attempt-[1-9][0-9]*$','description':'stage_run.logical_id; persistence resolves the tenant-qualified surrogate UUID before writing foreign keys.'}
D['WorkType']=enum('feature','bug','refactor','maintenance','performance','platform','documentation','investigation')
D['Assurance']=enum('fast','standard','enhanced'); D['DeliveryScope']=enum('report','patch','pr','preview','production')
D['TaskStatus']=enum('accepted','queued','running','waiting_input','waiting_decision','paused','cancelling','succeeded','incomplete','failed','cancelled')
D['StageStatus']=enum('pending','ready','running','awaiting_input','evaluating','passed','failed','inconclusive','skipped','cancelled')
D['Role']=enum('discovery','planner','criteria_author','implementer','reviewer','adversarial_tester','verifier','publisher','knowledge_curator')
define('ArtifactRef',{'artifactId':UUID,'sha256':ref('Digest'),'mediaType':text(),'schemaVersion':text(),'sizeBytes':integer()})
AR=ref('ArtifactRef'); ARS=array(AR)
define('Budget',{'maxMicroUsd':integer(),'maxActiveSeconds':integer(1),'maxCalendarSeconds':integer(1),'maxAuthoringInvocations':integer(1),'maxSemanticAttemptsPerNode':integer(1),'maxDesignReturns':integer(),'invocationMode':enum('one','bounded')})
define('TaskRequest',{'schemaVersion':{'const':'1.0'},'title':{'type':'string','minLength':1,'maxLength':200},'intent':{'type':'string','minLength':1,'maxLength':32000},'applicationIds':array(UUID,1),'repositoryIds':array(UUID),'workType':ref('WorkType'),'acceptanceCriteria':array(text(),1),'assurance':ref('Assurance'),'deliveryScope':ref('DeliveryScope'),'budget':ref('Budget'),'parentTaskId':UUID,'externalRef':text(),'requestedHarness':text()},('repositoryIds','parentTaskId','externalRef','requestedHarness'))
define('InputBinding',{'taskSpecVersion':integer(1),'planVersion':integer(1),'policyRef':AR,'applicationSnapshotRef':AR,'criteriaRef':AR,'candidateRef':AR,'canonicalPackageRef':AR,'setupProfileRef':AR,'environmentPlanRef':AR,'baselineRef':AR,'promptTemplateRef':AR,'adapterProfileRef':AR},('criteriaRef','candidateRef','canonicalPackageRef','setupProfileRef','environmentPlanRef','baselineRef','promptTemplateRef','adapterProfileRef'))
define('RunLimits',{'wallSeconds':integer(1),'maxTurns':integer(1),'maxToolCalls':integer(1),'maxOutputBytes':integer(1),'reservedMicroUsd':integer(),'maxInputTokens':integer(1),'maxOutputTokens':integer(1)},('maxInputTokens','maxOutputTokens'))
define('CapabilityGrant',{'grantId':UUID,'operation':text(),'resourceIds':array(text(),1),'environmentScope':text(),'expiresAt':TIME,'maxCalls':integer(1),'sideEffect':enum('read','workspace_write','environment_write','publish'),'allocationEpoch':integer(1)})
define('StageInput',{'schemaVersion':{'const':'1.0'},'orgId':UUID,'taskId':UUID,'stageRunId':ref('LogicalStageRunId'),'nodeId':text(),'semanticAttempt':integer(1),'role':ref('Role'),'inputBinding':ref('InputBinding'),'inputHash':ref('Digest'),'contextRef':AR,'workspaceId':UUID,'limits':ref('RunLimits'),'capabilityGrants':array(ref('CapabilityGrant')),'sessionPolicy':enum('fresh','resume','checkpoint'),'nativeSessionRef':AR},('workspaceId','nativeSessionRef'))
define('UsageObservation',{'provider':text(),'modelProfile':text(),'quality':enum('exact','estimated','unavailable'),'inputTokens':integer(),'outputTokens':integer(),'costMicroUsd':integer(),'priceCardRef':AR,'providerRequestId':text(),'source':text(),'intervalStart':TIME,'intervalEnd':TIME,'observedAt':TIME},('inputTokens','outputTokens','costMicroUsd','priceCardRef','providerRequestId','source','intervalStart','intervalEnd'))
define('HarnessRunResult',{'schemaVersion':{'const':'2.0'},'stageRunId':ref('LogicalStageRunId'),'adapterId':text(),'adapterVersion':text(),'allocationEpoch':integer(1),'terminationReason':enum('process_exit','cancelled','timeout','provider_error','needs_input','model_reported_unsuccessful'),'providerErrorClass':text(),'outputRefs':ARS,'checkpointRef':AR,'nativeStateRef':AR,'usage':array(ref('UsageObservation')),'diagnosticRef':AR,'producerKind':{'const':'adapter'}},('providerErrorClass','checkpointRef','nativeStateRef','diagnosticRef'))
define('StageResult',{'schemaVersion':{'const':'1.0'},'orgId':UUID,'taskId':UUID,'stageRunId':ref('LogicalStageRunId'),'inputHash':ref('Digest'),'allocationEpoch':integer(1),'status':enum('completed','product_failure','inconclusive','needs_input','infrastructure_error','cancelled'),'outputRefs':ARS,'checkpointRef':AR,'findingsRef':AR,'diagnosticRef':AR,'usage':array(ref('UsageObservation')),'producerId':text(),'completedAt':TIME},('checkpointRef','findingsRef','diagnosticRef'))
define('GateEvaluation',{'id':UUID,'taskId':UUID,'gateId':enum('scope_accepted','plan_accepted','oracle_accepted','baseline_valid','canonical_package_locked','outcome_verified','review_passed','adversarial_passed','integration_passed','release_authorized','deployed_verified','outcome_recorded'),'inputBinding':ref('InputBinding'),'inputHash':ref('Digest'),'verdict':enum('passed','failed','inconclusive','superseded'),'evidenceRefs':ARS,'evaluatorId':text(),'reasonCodes':array(text()),'evaluatedAt':TIME,'supersededBy':UUID},('supersededBy',))
define('Finding',{'id':UUID,'taskId':UUID,'gateEvaluationId':UUID,'subjectHash':ref('Digest'),'category':enum('implementation','design','scope','oracle','environment','missing_evidence'),'severity':enum('critical','high','medium','low'),'criterionIds':array(text()),'location':text(),'statement':text(),'evidenceRefs':ARS,'requiredAction':text(),'status':enum('open','fixed','rejected','accepted_risk'),'dispositionRef':AR,'consequence':text(),'confidence':enum('low','medium','high')},('location','dispositionRef','consequence','confidence'))
define('RepositoryCandidate',{'repositoryId':UUID,'baseCommit':ref('GitOid'),'candidateCommit':ref('GitOid'),'treeDigest':ref('Digest'),'changedPaths':array(text()),'sourceRef':AR})
define('CandidateManifest',{'schemaVersion':{'const':'1.0'},'candidateId':UUID,'taskId':UUID,'repositories':array(ref('RepositoryCandidate')),'artifactRefs':ARS,'profileRefs':ARS,'createdByStageRunId':ref('LogicalStageRunId'),'createdAt':TIME})
define('WorkspaceRecord',{'id':UUID,'orgId':UUID,'taskId':UUID,'repositoryId':UUID,'role':ref('Role'),'branch':text(),'baseCommit':ref('GitOid'),'candidateCommit':ref('GitOid'),'state':enum('allocated','active','quiescing','checkpointed','retained','releasing','released','quarantined'),'generation':integer(1),'ownerEpoch':integer(1),'stageRunId':ref('LogicalStageRunId'),'setupProfileRef':AR,'checkpointRef':AR},('branch','candidateCommit','checkpointRef'))
define('FileSnapshot',{'path':text(),'sha256':ref('Digest'),'mode':text(),'kind':enum('file','symlink','deleted'),'symlinkTarget':text()},('symlinkTarget',))
define('CheckpointManifest',{'schemaVersion':{'const':'1.0'},'workspaceId':UUID,'generation':integer(1),'ownerEpoch':integer(1),'repositoryId':UUID,'baseCommit':ref('GitOid'),'headCommit':ref('GitOid'),'sourceRef':AR,'prerequisiteRefs':ARS,'stagedPatchRef':AR,'unstagedPatchRef':AR,'untrackedArchiveRef':AR,'files':array(ref('FileSnapshot')),'setupProfileRef':AR,'handoffRef':AR,'nativeStateRef':AR,'createdAt':TIME},('stagedPatchRef','unstagedPatchRef','untrackedArchiveRef','nativeStateRef'))
define('StageContext',{'schemaVersion':{'const':'1.0'},'role':ref('Role'),'goal':text(),'criteriaRef':AR,'planRef':AR,'sourceRefs':ARS,'factRefs':ARS,'evidenceRefs':ARS,'supplementalRationaleRefs':ARS,'allowedOperations':array(text()),'exclusions':array(text()),'maxInputTokens':integer(1),'promptTemplateRef':AR,'createdAt':TIME})
define('Recipe',{'id':text(),'imageDigest':text(),'executable':text(),'args':array(text()),'cwd':text(),'environment':{'type':'object','additionalProperties':{'type':'string'}},'secretRefs':array(text()),'timeoutSeconds':integer(1),'outputPaths':array(text()),'networkProfile':text()})
define('ApplicationRepository',{'repositoryId':UUID,'subpath':text(0),'purpose':text()})
define('DependencySpec',{'applicationId':UUID,'mode':enum('deploy','snapshot','sandbox','stub','existing_read_only'),'releaseRef':text(),'contractRef':AR},('contractRef',))
define('InterfaceDefinition',{'schemaVersion':{'const':'2.0'},'interfaceId':text(),'protocol':enum('http','grpc','event','graphql','other'),'contractSource':obj({'repositoryId':UUID,'commit':ref('GitOid'),'path':text()}),'contractDigest':ref('Digest'),'compatibilityPolicy':enum('additive_only','semver','breaking_requires_migration'),'authMechanism':text(),'ownerApplicationId':UUID,'knownConsumerApplicationIds':array(UUID)})
define('ApplicationDefinition',{'schemaVersion':{'const':'1.0'},'applicationId':UUID,'key':text(),'name':text(),'ownerIds':array(text(),1),'lifecycle':enum('experimental','production','deprecated'),'repositories':array(ref('ApplicationRepository'),1),'providedInterfaceIds':array(text()),'consumedInterfaceIds':array(text()),'dependencies':array(ref('DependencySpec')),'telemetryServiceNames':array(text()),'setupProfileRef':AR,'verificationProfileRefs':ARS,'deploymentProfileRefs':ARS,'minimumAssurance':ref('Assurance'),'runbookPaths':array(text()),'secretRefs':array(text())})
define('PolicyProfile',{'schemaVersion':{'const':'1.0'},'id':text(),'revision':integer(1),'defaultAssurance':ref('Assurance'),'fastAllowedApplicationIds':array(UUID),'riskTriggers':array(text(),1),'nonwaivableGates':array(ref('GateId'),1),'nonwaivableInvariants':array(enum('bug_red_lock_green','exact_input_binding','independently_collected_evidence','authorized_delivery'),1),'defaultBudget':ref('Budget'),'productionEnabledApplicationIds':array(UUID),'decisionTtlSeconds':integer(1),'previewTtlSeconds':integer(1)})
define('ProviderCapabilities',{'providerId':text(),'adapterVersion':text(),'fresh':BOOL,'resume':BOOL,'fork':BOOL,'structuredOutput':BOOL,'usage':enum('exact','estimated','unavailable'),'tokenLimit':BOOL,'streaming':BOOL,'scopedTools':BOOL,'nativeStateExport':BOOL,'qualificationRef':AR},('qualificationRef',))
define('DeploymentCapabilities',{'providerId':text(),'adapterVersion':text(),'idempotentSubmit':BOOL,'operationLookup':BOOL,'authoritativeNotFound':BOOL,'cancellation':BOOL,'cleanup':BOOL,'readiness':BOOL,'deploymentInventory':BOOL,'snapshot':BOOL,'restore':BOOL,'promote':BOOL,'rollback':BOOL,'isolatedData':BOOL,'networkModes':array(text()),'hermetic':BOOL,'qualificationRef':AR},('snapshot','restore','promote','qualificationRef'))
define('PullRequestRevision',{'repositoryId':UUID,'pullRequestId':text(),'headCommit':ref('GitOid')})
define('GitRepositoryIdentity',{'providerId':text(),'installationRef':text(),'externalId':text()})
define('PullRequest',{'providerId':text(),'repositoryId':UUID,'externalId':text(),'url':text(),'baseBranch':text(),'baseCommit':ref('GitOid'),'headCommit':ref('GitOid'),'baseRepository':ref('GitRepositoryIdentity'),'headRepository':{'oneOf':[ref('GitRepositoryIdentity'),{'type':'null'}]},'state':enum('open','merged','closed'),'draft':BOOL,'labels':array(text()),'mergedCommit':ref('GitOid')},('mergedCommit',))
define('DeploymentStatus',{'operationState':enum('pending','succeeded','failed','unknown'),'environmentState':enum('provisioning','deployed','ready','retiring','retired','unknown'),'endpoints':array(text()),'observedReleaseRef':AR,'diagnosticRef':AR,'observedRevision':ref('GitOid'),'imageDigestVerification':enum('match','mismatch','unknown'),'previewUrl':text(),'queueReason':text()},('observedReleaseRef','diagnosticRef','observedRevision','imageDigestVerification','previewUrl','queueReason'))
define('Deployable',{'applicationId':UUID,'repositoryId':UUID,'sourceCommit':ref('GitOid'),'imageDigest':text(),'templateRef':AR,'configurationRef':AR,'dependencyIds':array(UUID),'secretRefs':array(text())})
define('EnvironmentPlan',{'schemaVersion':{'const':'1.0'},'environmentId':UUID,'orgId':UUID,'taskId':UUID,'providerId':text(),'profileRef':AR,'purpose':enum('baseline','preview','rehearsal','benchmark','production'),'candidateRef':AR,'deployables':array(ref('Deployable'),1),'fixtureRefs':ARS,'migrationRecipeRefs':ARS,'readinessRecipeRefs':ARS,'verificationRecipeRefs':ARS,'networkMode':text(),'seed':integer(),'clockProfile':text(),'expiresAt':TIME,'expectedCurrentRelease':text(),'pullRequestRevision':ref('PullRequestRevision'),'releaseManifestRef':AR},('seed','clockProfile','expectedCurrentRelease','pullRequestRevision','releaseManifestRef'))
define('OperationView',{'id':UUID,'providerId':text(),'kind':text(),'requestHash':ref('Digest'),'state':enum('reserved','submitted','reconciling','succeeded','failed','unknown','needs_operator'),'externalHandle':text(),'resultRef':AR,'lastObservedAt':TIME},('externalHandle','resultRef','lastObservedAt'))
define('CommandEnvelope',{'commandId':UUID,'expectedRevision':integer(1),'kind':enum('pause','resume','cancel','amend_spec','change_budget','change_harness','respond_decision','retry_stage','request_delivery','reassign_owner','take_over','hand_back'),'reason':text(),'specRef':AR,'budget':ref('Budget'),'harnessProfile':text(),'decisionId':UUID,'decisionOutcome':enum('approve','reject','request_changes'),'subjectHash':ref('Digest'),'nodeId':text(),'deliveryScope':ref('DeliveryScope'),'ownerPrincipalId':UUID},('specRef','budget','harnessProfile','decisionId','decisionOutcome','subjectHash','nodeId','deliveryScope','ownerPrincipalId'))
define('CommandReceipt',{'commandId':UUID,'taskId':UUID,'state':enum('queued','delivered','accepted','applied','rejected'),'statusUrl':text(),'reason':text(),'resultingRevision':integer(1)},('reason','resultingRevision'))
define('TaskAccepted',{'taskId':UUID,'operationId':UUID,'statusUrl':text(),'status':{'const':'accepted'}})
define('TaskView',{'id':UUID,'orgId':UUID,'creatorId':UUID,'ownerPrincipalId':UUID,'interactiveHolderPrincipalId':UUID,'spec':ref('TaskRequest'),'status':ref('TaskStatus'),'revision':integer(1),'planVersion':integer(1),'currentNodeId':text(),'projectionSequence':integer(),'projectedAt':TIME,'createdAt':TIME,'updatedAt':TIME,'workflowId':text(),'outcomeRef':AR,'cleanupState':enum('pending','running','complete','needs_operator'),'waitingReason':text()},('currentNodeId','workflowId','outcomeRef','waitingReason','interactiveHolderPrincipalId'))
define('RunView',{'id':ref('LogicalStageRunId'),'taskId':UUID,'nodeId':text(),'planVersion':integer(1),'semanticAttempt':integer(1),'status':ref('StageStatus'),'role':ref('Role'),'inputHash':ref('Digest'),'allocationGeneration':integer(),'resultRef':AR,'usage':array(ref('UsageObservation')),'startedAt':TIME,'completedAt':TIME,'supersededAt':TIME,'supersededByPlanVersion':integer(1),'supersededByStageRunId':ref('LogicalStageRunId')},('resultRef','startedAt','completedAt','supersededAt','supersededByPlanVersion','supersededByStageRunId'))
D['RunView']['allOf']=[{'if':{'required':[field]},'then':{'required':['supersededAt','supersededByPlanVersion']}} for field in ('supersededAt','supersededByPlanVersion','supersededByStageRunId')]
D['DecisionAction']=enum('confirm_intent','approve_plan','approve_rule_exception','reconcile_pr_head','handover_pr','propose_unreproduced_fix','confirm_application_owners','resume_campaign','lift_embargo','authorize_release','accept_residual_risk','approve_oracle','resolve_scope')
define('ReconcilePrHeadSubject',{'schemaVersion':{'const':'2.0'},'taskId':UUID,'repositoryId':UUID,'resolution':enum('adopt','handover'),'observedHead':ref('GitOid'),'expectedHead':ref('GitOid'),'candidateRef':AR,'policyRef':AR})
define('DecisionView',{'id':UUID,'taskId':UUID,'action':ref('DecisionAction'),'subjectHash':ref('Digest'),'subjectRef':AR,'policyRef':AR,'evidenceRefs':ARS,'eligibleRoles':array(text(),1),'state':enum('pending','approved','rejected','changes_requested','expired','superseded'),'reason':text(),'expiresAt':TIME,'deciderId':text()},('deciderId',))
define('DecisionResponse',{'commandId':UUID,'expectedRevision':integer(1),'subjectHash':ref('Digest'),'outcome':enum('approve','reject','request_changes'),'reason':text()})
define('TaskEvent',{'eventId':UUID,'orgId':UUID,'taskId':UUID,'sequence':integer(1),'eventType':text(),'occurredAt':TIME,'recordedAt':TIME,'source':text(),'correlationId':text(),'payloadRef':AR,'schemaVersion':{'const':'1.0'}})
define('ApplicationView',{'definition':ref('ApplicationDefinition'),'definitionRef':AR,'sourceRepositoryId':UUID,'sourceCommit':ref('GitOid'),'sourcePath':text(),'importStatus':enum('valid','stale','invalid_pending'),'lastImportedAt':TIME})
define('RelationshipView',{'id':UUID,'sourceId':text(),'targetId':text(),'kind':text(),'basis':enum('declared','observed'),'evidenceRef':AR,'environment':text(),'validFrom':TIME,'validUntil':TIME},('environment','validUntil'))
define('ImportRequest',{'repositoryId':UUID,'commit':ref('GitOid'),'path':text()})
define('ImportView',{'id':UUID,'state':enum('queued','validating','published','failed'),'source':ref('ImportRequest'),'definitionRefs':ARS,'findings':array(text()),'createdAt':TIME})
define('SnapshotRequest',{'applicationIds':array(UUID,1),'taskId':UUID,'role':ref('Role'),'definitionRefs':ARS})
define('AsyncReceipt',{'id':UUID,'status':enum('queued','running','succeeded','failed'),'statusUrl':text(),'resultRef':AR},('resultRef',))
define('FailureSignatureKeys',{'failureKind':text(),'normalizedFrames':array(text()),'endpointOrContractRef':text(),'normalizerVersion':text()},('endpointOrContractRef',))
define('FailureSignature',{'digest':ref('Digest'),'keys':ref('FailureSignatureKeys')})
define('KnowledgeProposal',{'kind':enum('declared_fact','observed_fact','design_decision','incident_lesson','failed_hypothesis','operational_recipe_reference','unresolved_question'),'scope':text(),'statement':text(),'sourceRefs':array(AR,1),'applicableVersions':array(text()),'environment':text(),'taskId':UUID,'expiresAt':TIME,'failureSignature':ref('FailureSignature'),'componentIds':array(UUID,1)},('environment','expiresAt','failureSignature','componentIds'))
D['KnowledgeProposal']['allOf']=[{'if':{'required':['failureSignature']},'then':{'required':['componentIds']}}]
define('KnowledgeView',{'id':UUID,'proposal':ref('KnowledgeProposal'),'status':enum('proposed','reviewed','verified','disputed','superseded','expired'),'verifiedAt':TIME,'supersededBy':UUID,'reviewRef':AR,'disputes':array(UUID)},('verifiedAt','supersededBy','reviewRef','disputes'))
define('ArtifactLinkView',{'taskId':UUID,'stageRunId':ref('LogicalStageRunId'),'candidateId':UUID,'purpose':text(),'retainUntil':TIME},('stageRunId','candidateId'))
define('ArtifactView',{'ref':AR,'classification':enum('ordinary','restricted','sensitive_session'),'producerId':text(),'links':array(ref('ArtifactLinkView')),'mediaType':text(),'sizeBytes':integer(),'createdAt':TIME,'retentionUntil':TIME})
define('ArtifactAccessRequest',{'purpose':text()})
define('ArtifactAccess',{'url':{'type':'string','format':'uri'},'expiresAt':TIME,'sha256':ref('Digest'),'contentDisposition':enum('attachment','isolated_preview')})
define('EnvironmentView',{'id':UUID,'taskId':UUID,'revision':integer(1),'planRef':AR,'providerId':text(),'externalHandle':text(),'state':enum('planned','provisioning','reconciling','deployed','preparing','ready','verifying','verified','verification_failed','retained','retiring','retired','needs_operator'),'endpoints':array(text()),'observedReleaseRef':AR,'verificationRef':AR,'expiresAt':TIME,'cleanupState':enum('pending','running','complete','needs_operator')},('externalHandle','observedReleaseRef','verificationRef'))
D['EnvironmentView']['properties'].update(generation=integer(1),currentOperationId=UUID,status=ref('DeploymentStatus'),statusObservedAt=TIME)
D['EnvironmentView']['allOf']=[{'if':{'required':[field]},'then':{'required':['status','statusObservedAt','generation','currentOperationId']}} for field in ('status','statusObservedAt')]
define('EnvironmentCommand',{'commandId':UUID,'expectedRevision':integer(1),'kind':enum('extend','retire'),'reason':text(),'expiresAt':TIME},('expiresAt',))
define('ProviderView',{'id':text(),'kind':enum('harness','git','deployment','observability','storage'),'adapterVersion':text(),'health':enum('healthy','degraded','unavailable','unqualified'),'capabilityNames':array(text()),'qualificationRef':AR},('qualificationRef',))
define('WebhookReceipt',{'accepted':{'const':True},'eventId':text()})
define('Health',{'status':{'const':'ok'},'requestId':text()})
define('HealthNotReady',{'status':{'const':'not_ready'},'requestId':text()})
define('Problem',{'type':text(),'title':text(),'status':integer(400),'code':text(),'detail':text(),'requestId':text(),'retryable':BOOL,'fieldErrors':array(text())},('fieldErrors',))
define('EventCursorExpired',dict(D['Problem']['properties'],status={'const':410},code={'const':'event_cursor_expired'},snapshotUrl={'type':'string','format':'uri-reference'},resumeAfterSequence=integer()),('fieldErrors',))
define('EmergencyStopRecord',{'schemaVersion':{'const':'2.0'},'orgId':UUID,'revision':integer(),'active':BOOL,'actorId':text(),'reason':text(),'changedAt':TIME,'previousStateRef':AR,'clearanceDecisionRef':AR},('previousStateRef','clearanceDecisionRef'))
define('EmergencyStopState',{'orgId':UUID,'revision':integer(),'active':BOOL,'stateRef':AR,'updatedAt':TIME})
define('EmergencyStopActivation',{'expectedRevision':integer(),'reason':text()})
define('EmergencyStopClearance',{'expectedRevision':integer(1),'subjectHash':ref('Digest'),'reason':text()})
define('EmergencyStopDecision',{'schemaVersion':{'const':'2.0'},'orgId':UUID,'action':{'const':'clear_emergency_stop'},'subjectRef':AR,'subjectHash':ref('Digest'),'policyRef':AR,'deciderId':UUID,'reason':text(),'decidedAt':TIME})
define('ReviewerCapacity',{'maxOpenPRs':integer(),'maxDiffLines':integer()})
D['ApplicationDefinition']['properties']['reviewerCapacity']=ref('ReviewerCapacity')
define('CampaignWave',{'targetApplicationIds':array(UUID,1),'maxConcurrency':integer(1)})
define('CampaignManifest',{'schemaVersion':{'const':'2.0'},'taskId':UUID,'revision':integer(1),'recipeRef':AR,'targetSnapshotRef':AR,'readinessRequirementsRef':AR,'waves':array(ref('CampaignWave'),1),'pauseThresholdsRef':AR,'policyRef':AR,'reviewBudgetsByOwner':{'type':'object','additionalProperties':integer()}})
define('CampaignState',{'manifestRef':AR,'waveIndex':integer(),'phase':enum('awaiting_approval','running','paused','waiting_decision','completed','cancelled'),'outcomeCounts':obj({name:integer() for name in ('changed','already_compliant','not_applicable','needs_judgement','deferred','failed')}),'reviewBacklogByOwner':{'type':'object','additionalProperties':integer()}})
D['TaskView']['properties']['campaign']=ref('CampaignState')
define('PlanNode',{'id':text(),'stageKind':text(),'role':ref('Role'),'dependsOn':array(text()),'inputArtifactRefs':ARS,'requiredGateIds':array(text()),'requiredCapabilities':array(text()),'timeoutClass':enum('resolve','execute','verify','provider','cleanup'),'sessionPolicy':enum('fresh','resume','checkpoint'),'returnTargets':array(text()),'mandatory':BOOL})
define('ExecutionPlan',{'schemaVersion':{'const':'1.0'},'taskId':UUID,'version':integer(1),'taskSpecVersion':integer(1),'workType':ref('WorkType'),'policyRef':AR,'applicationSnapshotRef':AR,'deliveryScope':ref('DeliveryScope'),'budget':ref('Budget'),'nodes':array(ref('PlanNode'),1),'acceptedReviewRef':AR},('acceptedReviewRef',))
define('TestPackage',{'schemaVersion':{'const':'1.0'},'packageId':UUID,'workType':ref('WorkType'),'criteriaIds':array(text(),1),'contentRef':AR,'recipeRefs':array(AR,1),'fixtureRefs':ARS,'helperRefs':ARS,'expectedBaseline':enum('intended_failure','passing','measurement','not_applicable'),'expectedScenarioIds':array(text()),'minimumExecutedTests':integer(),'allowedSkipIds':array(text()),'oracleReviewRef':AR})
define('SuiteResult',{'suiteId':text(),'recipeRef':AR,'exitCode':{'type':'integer'},'discovered':integer(),'executed':integer(),'passed':integer(),'failed':integer(),'skippedIds':array(text()),'assertionResultsRef':AR,'logRefs':ARS,'status':enum('passed','failed','infrastructure_error','inconclusive'),'reasonCodes':array(text())})
define('VerificationReport',{'schemaVersion':{'const':'1.0'},'reportId':UUID,'taskId':UUID,'inputBinding':ref('InputBinding'),'inputHash':ref('Digest'),'suites':array(ref('SuiteResult'),1),'environmentProvenanceRef':AR,'sourceIntegrityPassed':BOOL,'canonicalIntegrityPassed':BOOL,'supervisorIdentity':text(),'startedAt':TIME,'completedAt':TIME,'verdictProposal':enum('passed','failed','inconclusive')})
define('ReviewReport',{'schemaVersion':{'const':'1.0'},'reportId':UUID,'taskId':UUID,'inputHash':ref('Digest'),'reviewerIdentity':text(),'scopeReviewed':array(text(),1),'evidenceRefs':ARS,'findings':array(ref('Finding')),'unresolvedQuestions':array(text()),'verdictProposal':enum('passed','failed','inconclusive'),'completedAt':TIME})
define('OutcomeManifest',{'schemaVersion':{'const':'1.0'},'taskId':UUID,'status':ref('TaskStatus'),'deliveryScope':ref('DeliveryScope'),'candidateRef':AR,'deliveredArtifactRefs':ARS,'providerHandles':array(text()),'gateEvaluationRefs':ARS,'decisionRefs':ARS,'usage':array(ref('UsageObservation')),'limitations':array(text()),'knowledgeProposalIds':array(UUID),'cleanupObligationRefs':ARS,'completedAt':TIME},('candidateRef',))
define('WorkflowCheckpoint',{'schemaVersion':{'const':'1.0'},'taskId':UUID,'taskSpecVersion':integer(1),'controlRevision':integer(1),'planRef':AR,'taskStatus':ref('TaskStatus'),'projectionSequence':integer(),'activeRunIds':array(text()),'childWorkflowIds':array(text()),'environmentIds':array(UUID),'commandReceiptIndexRef':AR,'gateSetRef':AR,'budgetSnapshotRef':AR,'createdAt':TIME})
define('SignedEvidenceEnvelope',{'schemaVersion':{'const':'1.0'},'artifactRef':AR,'producerIdentity':text(),'inputHash':ref('Digest'),'allocationEpoch':integer(1),'issuedAt':TIME,'keyId':text(),'signatureFormat':enum('jws-detached'),'signature':text()})
D['TaskView']['properties']['lastEventSequence']=integer()
D['TaskView']['required'].append('lastEventSequence')
define('LogChunk',{'sequence':integer(1),'stream':enum('stdout','stderr','harness_event'),'artifactRef':AR,'firstOccurredAt':TIME,'lastOccurredAt':TIME,'redacted':BOOL})
define('RunLogPage',{'items':array(ref('LogChunk')),'nextCursor':text()},('nextCursor',))
D['Finding']['required'].remove('gateEvaluationId')
for name,key in [('Recipe','imageDigest'),('Deployable','imageDigest')]:
    D[name]['properties'][key]={'type':'string','pattern':'^[^\\s]+@sha256:[0-9a-f]{64}$'}
D['CommandEnvelope']['allOf']=[{'if':{'properties':{'kind':{'const':kind}}},'then':{'required':fields}} for kind,fields in [('amend_spec',['specRef']),('change_budget',['budget']),('change_harness',['harnessProfile']),('respond_decision',['decisionId','decisionOutcome','subjectHash']),('retry_stage',['nodeId']),('request_delivery',['deliveryScope']),('reassign_owner',['ownerPrincipalId'])]]
define('EpochTransfer',{'workspaceId':UUID,'expectedEpoch':integer(1),'checkpointRef':AR,'targetRef':text()})
D['CommandEnvelope']['properties']['epochTransfer']=ref('EpochTransfer')
for kind in ('take_over','hand_back'):
    D['CommandEnvelope']['allOf'].append({'if':{'properties':{'kind':{'const':kind}}},'then':{'required':['epochTransfer']}})
D['TaskRequest']['allOf']=[{'if':{'properties':{'workType':{'const':'investigation'}}},'then':{'properties':{'deliveryScope':{'const':'report'}}}},{'if':{'properties':{'workType':{'const':'documentation'}}},'then':{'properties':{'deliveryScope':enum('report','patch','pr')}}}]
D['EnvironmentCommand']['allOf']=[{'if':{'properties':{'kind':{'const':'extend'}}},'then':{'required':['expiresAt']}}]
for name,item in [('TaskPage','TaskView'),('RunPage','RunView'),('GatePage','GateEvaluation'),('FindingPage','Finding'),('DecisionPage','DecisionView'),('ApplicationPage','ApplicationView'),('RelationshipPage','RelationshipView'),('KnowledgePage','KnowledgeView'),('EnvironmentPage','EnvironmentView'),('ProviderPage','ProviderView')]:
    define(name,{'items':array(ref(item)),'nextCursor':text()},('nextCursor',))
define('ProfilePage',{'items':ARS,'nextCursor':text()},('nextCursor',))
# Revision 1.1: explicit target context, draft registration and journey templates.
D['WorkflowTemplateId']=enum('greenfield','existing_feature','bug_fix','refactor','maintenance','performance','platform','documentation','investigation')
D['StageKind']=enum('discover','plan','criteria','execute','verify','review','adversarial','integrate','deliver','learn_close','product_brief','foundation_design','bootstrap_repository','scaffold','verify_foundation','activate_application','vertical_slice','compose_children','integrated_verify','feature_impact','compatibility_verify','diagnose','author_regression','baseline_red','lock_regression','candidate_green','characterize','compatibility_matrix','measure_baseline','measure_candidate','rehearsal','validate_document','investigate')
D['GateId']=D['GateEvaluation']['properties']['gateId']
D['GateId']['enum']+=['architecture_accepted','bootstrap_ready','foundation_verified','application_registered','vertical_slice_verified','parent_outcome_verified']
D['GateEvaluation']['properties']['gateId']=ref('GateId')
D['PlanNode']['properties']['stageKind']=ref('StageKind')
D['PlanNode']['properties']['requiredGateIds']=array(ref('GateId'))
define('NewRepositoryIntent',{'kind':{'const':'new_repository'},'providerId':text(),'installationRef':text(),'namespace':text(),'name':text(),'visibility':enum('private','internal','public'),'defaultBranch':text()})
define('ExistingRepositoryIntent',{'kind':{'const':'existing_repository'},'repositoryId':UUID,'baseCommit':ref('GitOid'),'subpath':text(0),'rootAdoption':obj({'retainedBootstrapReceiptRef':AR})},('rootAdoption',))
D['ExistingRepositoryIntent']['allOf']=[{'if':{'properties':{'subpath':{'const':''}}},'then':{'required':['rootAdoption']}},{'if':{'required':['rootAdoption']},'then':{'properties':{'subpath':{'const':''}}}}]
D['RepositoryIntent']={'oneOf':[ref('NewRepositoryIntent'),ref('ExistingRepositoryIntent')]}
define('ExistingApplicationTarget',{'kind':{'const':'existing_application'},'applicationId':UUID})
define('NewApplicationTarget',{'kind':{'const':'new_application'},'applicationId':UUID,'draftRevision':integer(1),'draftRef':AR,'repositoryIntent':ref('RepositoryIntent')},('repositoryIntent',))
D['TargetContext']={'oneOf':[ref('ExistingApplicationTarget'),ref('NewApplicationTarget')]}
define('ApplicationDraftRequest',{'schemaVersion':{'const':'2.0'},'key':text(),'name':text(),'ownerIds':array(text(),1),'purpose':text(),'constraints':array(text()),'providedInterfaceIntents':array(text()),'dependencyApplicationIds':array(UUID),'minimumAssurance':ref('Assurance')})
define('ApplicationDraftRevisionRequest',{'expectedRevision':integer(1),'draft':ref('ApplicationDraftRequest')})
define('ApplicationDraftView',{'applicationId':UUID,'revision':integer(1),'draft':ref('ApplicationDraftRequest'),'draftRef':AR,'state':enum('draft','onboarding','registered','needs_operator'),'bootstrapTaskId':UUID},('bootstrapTaskId',))
define('ApplicationDraftPage',{'items':array(ref('ApplicationDraftView')),'nextCursor':text()},('nextCursor',))
define('ApplicationSnapshot',{'schemaVersion':{'const':'2.0'},'snapshotId':UUID,'targetContext':ref('TargetContext'),'applicationDefinitionRefs':ARS,'applicationDraftRefs':ARS,'interfaceDefinitionRefs':ARS,'createdAt':TIME},('interfaceDefinitionRefs',))
define('WorkflowTemplateRef',{'id':ref('WorkflowTemplateId'),'version':{'type':'string','pattern':r'^\d+\.\d+\.\d+$'},'definitionRef':AR})
define('WorkflowTemplateDefinition',{'schemaVersion':{'const':'2.0'},'id':ref('WorkflowTemplateId'),'version':{'type':'string','pattern':r'^\d+\.\d+\.\d+$'},'workType':ref('WorkType'),'targetKind':enum('new_application','existing_application'),'nodes':array(ref('PlanNode'),1)})
define('BootstrapPlan',{'schemaVersion':{'const':'2.0'},'id':UUID,'taskId':UUID,'target':ref('NewApplicationTarget'),'architectureRef':AR,'applicationSnapshotRef':AR,'initializationTemplateRef':AR,'setupProfileRef':AR,'allowedPaths':array(text(),1),'repositoryOperationId':UUID,'initializationOperationId':UUID})
define('BootstrapReceipt',{'schemaVersion':{'const':'2.0'},'taskId':UUID,'applicationId':UUID,'planRef':AR,'repositoryId':UUID,'baseCommit':ref('GitOid'),'sourceRef':AR,'createdRepository':BOOL,'operationIds':array(UUID),'completedAt':TIME})
define('GitCapabilities',{'providerId':text(),'adapterVersion':text(),'repositoryCreate':BOOL,'initializeEmptyRepository':BOOL,'operationLookup':BOOL,'conditionalRefUpdate':BOOL,'pullRequests':BOOL,'qualificationRef':AR},('qualificationRef',))
D['BootstrapPlan']['allOf']=[{'properties':{'target':{'required':['repositoryIntent']}}}]
D['TaskRequest']['properties']['targetContext']=ref('TargetContext')
D['TaskRequest']['required'].append('targetContext')
D['TaskRequest']['allOf'].append({'if':{'properties':{'targetContext':{'properties':{'kind':{'const':'new_application'}}}}},'then':{'properties':{'workType':{'const':'feature'}}}})
D['TaskView']['properties']['resolvedWorkflowTemplate']=ref('WorkflowTemplateRef')
for name in ['ExecutionPlan','WorkflowTemplateDefinition']:
    if name=='ExecutionPlan':
        D[name]['properties']['targetContext']=ref('TargetContext');D[name]['required'].append('targetContext')
        D[name]['properties']['workflowTemplate']=ref('WorkflowTemplateRef');D[name]['required'].append('workflowTemplate')
D['InputBinding']['properties'].update({'workflowTemplateRef':AR,'bootstrapPlanRef':AR,'foundationRef':AR})
D['InputBinding']['required'].append('workflowTemplateRef')
D['WorkflowCheckpoint']['properties']['bootstrapStateRef']=AR
D['SnapshotRequest']['properties'].update({'targetContext':ref('TargetContext'),'draftRefs':ARS})
D['SnapshotRequest']['required'] += ['targetContext','draftRefs']
# Controller stages have operation authority, not a fictitious pod allocation epoch.
D['StageResult']['properties']['producerKind']={'const':'runner'}
D['StageResult']['required'].append('producerKind')
import copy
D['ControllerStageResult']=copy.deepcopy(D['StageResult'])
D['ControllerStageResult']['properties'].pop('allocationEpoch')
D['ControllerStageResult']['required'].remove('allocationEpoch')
D['ControllerStageResult']['properties']['producerKind']={'const':'controller'}
D['StageOutcome']={'oneOf':[ref('StageResult'),ref('ControllerStageResult')]}
# Revision 1.2: adaptive human interview and exact-subject intent confirmation.
D['StageKind']['enum'] += ['intent_interview','intent_challenge','intent_confirmation']
D['GateId']['enum'].append('intent_aligned')
D['IntentTopic']=enum('problem_outcome','users_ownership','journeys_failures','scope_non_goals','data_permissions','dependencies','experience_accessibility','operational_constraints','delivery_budget','success_measures')
define('IntentJourney',{'id':text(),'actor':text(),'trigger':text(),'steps':array(text(),1),'successExamples':array(text(),1),'failureExamples':array(text(),1)})
define('IntentCriterion',{'id':text(),'statement':text(),'journeyIds':array(text(),1)})
define('IntentAssumption',{'id':text(),'statement':text(),'impact':enum('low','high'),'reversible':BOOL,'status':enum('proposed','accepted'),'ownerId':UUID,'validationPlan':text(),'acceptanceEvidenceRef':AR},('acceptanceEvidenceRef',))
define('IntentIssue',{'id':text(),'kind':enum('ambiguity','contradiction','missing_answer','unverified_fact'),'statement':text(),'blocking':BOOL,'status':enum('open','resolved','deferred'),'sourceRefs':ARS,'resolutionRef':AR},('resolutionRef',))
define('IntentCoverage',{'topic':ref('IntentTopic'),'status':enum('unknown','answered','accepted_assumption','not_applicable'),'reason':text(),'evidenceRefs':ARS})
define('IntentBrief',{'schemaVersion':{'const':'2.0'},'taskId':UUID,'revision':integer(1),'applicationDraftRef':AR,'problem':text(0),'targetUsers':array(text()),'desiredOutcomes':array(text()),'journeys':array(ref('IntentJourney')),'criteria':array(ref('IntentCriterion')),'firstSliceJourneyIds':array(text()),'nonGoals':array(text()),'constraints':array(text()),'tradeoffs':array(text()),'assumptions':array(ref('IntentAssumption')),'issues':array(ref('IntentIssue')),'coverage':array(ref('IntentCoverage')),'intentOwnerIds':array(UUID,1),'humanAnswerRefs':ARS,'proposedTaskSpecRef':AR})
define('IntentQuestion',{'id':text(),'topic':ref('IntentTopic'),'prompt':text(),'whyItMatters':text(),'blocking':BOOL,'sourceRefs':ARS,'suggestedAnswers':array(text())},('suggestedAnswers',))
define('IntentAnswer',{'questionId':text(),'kind':enum('answer','unknown','defer'),'text':text()})
answers=array(ref('IntentAnswer'),1);answers['maxItems']=3
questions=array(ref('IntentQuestion'));questions['maxItems']=3
define('IntentAnswerRequest',{'commandId':UUID,'expectedRevision':integer(1),'interviewRevision':integer(1),'answers':answers})
define('IntentAnswerRecord',{'schemaVersion':{'const':'2.0'},'taskId':UUID,'commandId':UUID,'interviewRevision':integer(1),'actorId':UUID,'actorKind':{'const':'human'},'answers':answers,'occurredAt':TIME})
phase=enum('interviewing','challenging','awaiting_confirmation','aligned','waiting_input','superseded')
define('IntentInterviewState',{'schemaVersion':{'const':'2.0'},'taskId':UUID,'revision':integer(1),'phase':phase,'briefRef':AR,'pendingQuestions':questions,'answerRefs':ARS,'priorStateRef':AR,'reviewRef':AR,'pendingDecisionIds':array(UUID),'acceptedDecisionRef':AR},('briefRef','priorStateRef','reviewRef','pendingDecisionIds','acceptedDecisionRef'))
define('IntentInterviewView',{'taskId':UUID,'revision':integer(1),'phase':phase,'stateRef':AR,'briefRef':AR,'pendingQuestions':questions,'blockingIssueCount':integer(),'alignmentDecisionIds':array(UUID)},('briefRef','alignmentDecisionIds'))
define('IntentConfirmationSubject',{'schemaVersion':{'const':'2.0'},'taskId':UUID,'interviewRevision':integer(1),'baseTaskSpecVersion':integer(1),'briefRef':AR,'reviewRef':AR})
define('IntentApprovalSet',{'schemaVersion':{'const':'2.0'},'taskId':UUID,'confirmationSubjectRef':AR,'requiredOwnerIds':array(UUID,1),'decisionRefs':array(AR,1)})
D['CommandEnvelope']['properties']['kind']['enum'].append('answer_intent')
D['CommandEnvelope']['properties'].update({'interviewRevision':integer(1),'answers':answers})
D['CommandEnvelope']['allOf'].append({'if':{'properties':{'kind':{'const':'answer_intent'}}},'then':{'required':['interviewRevision','answers']}})
D['DecisionView']['properties']['requiredPrincipalId']=UUID
D['DecisionView']['allOf']=[{'if':{'properties':{'action':{'const':'confirm_intent'}}},'then':{'required':['requiredPrincipalId']}}]
D['TaskView']['properties']['intent']=ref('IntentInterviewView')
D['InputBinding']['properties'].update({'intentBriefRef':AR,'intentDecisionRef':AR})
D['ExecutionPlan']['properties'].update({'intentBriefRef':AR,'intentDecisionRef':AR})
D['WorkflowCheckpoint']['properties']['intentStateRef']=AR
# Revision 1.3: full engineering packets and human peer sign-off.
D['StageKind']['enum'].append('plan_peer_review')
D['GateId']['enum'].append('plan_peer_approved')
D['PlanSectionId']=enum('intent_scope','current_state','design','interfaces_data','implementation','acceptance_tests','quality_security','delivery_recovery','operations','risks_decisions','definition_of_done','review_ownership')
short=lambda limit: {'type':'string','minLength':1,'maxLength':limit}
define('PlanDecisionSummary',{'outcome':short(240),'approach':short(300),'impact':short(240),'verification':short(240),'delivery':short(180),'decisionRequested':short(180)})
define('PlanSection',{'id':ref('PlanSectionId'),'title':text(),'summary':short(300),'status':enum('complete','incomplete','not_applicable'),'contentRef':AR,'applicabilityReason':text()},('applicabilityReason',))
D['PlanSection']['allOf']=[{'if':{'properties':{'status':{'const':'not_applicable'}}},'then':{'required':['applicabilityReason']}}]
define('PlanCriterion',{'id':text(),'statement':text(),'sourceRefs':array(AR,1)})
define('PlannedScenario',{'id':text(),'criterionIds':array(text(),1),'category':enum('happy_path','negative','boundary','security','contract','regression','recovery','performance','accessibility'),'given':text(),'when':text(),'then':text(),'testLevel':enum('unit','integration','end_to_end','manual','static'),'environmentRef':AR,'baselineExpectation':enum('intended_failure','passing','measurement','not_applicable'),'status':{'const':'planned'}})
define('DefinitionOfDoneItem',{'id':text(),'condition':text(),'criterionIds':array(text()),'evidenceKinds':array(enum('verification','review','artifact','delivery','cleanup'),1),'requiredGateIds':array(ref('GateId'),1)})
define('PlanRisk',{'id':text(),'statement':text(),'severity':enum('critical','high','medium','low'),'mitigation':text(),'ownerId':UUID,'state':enum('open','mitigation_planned','accepted_residual'),'blocking':BOOL,'scenarioIds':array(text()),'evidenceRefs':ARS})
define('PlanReviewPacket',{'schemaVersion':{'const':'2.0'},'taskId':UUID,'revision':integer(1),'taskSpecVersion':integer(1),'workType':ref('WorkType'),'targetContext':ref('TargetContext'),'authorPrincipalIds':array(UUID),'summary':ref('PlanDecisionSummary'),'sections':array(ref('PlanSection'),1),'criteria':array(ref('PlanCriterion'),1),'scenarios':array(ref('PlannedScenario'),1),'definitionOfDone':array(ref('DefinitionOfDoneItem'),1),'risks':array(ref('PlanRisk')),'intentBriefRef':AR,'previousPacketRef':AR},('intentBriefRef','previousPacketRef'))
define('PeerReviewSlot',{'id':text(),'principalId':UUID,'kind':enum('primary','specialist'),'sectionIds':array(ref('PlanSectionId'),1),'reason':text()})
define('PlanReviewAssignment',{'schemaVersion':{'const':'2.0'},'taskId':UUID,'packetRef':AR,'policyRef':AR,'requiredPeers':array(ref('PeerReviewSlot'),1)})
define('PlanReviewSubject',{'schemaVersion':{'const':'2.0'},'taskId':UUID,'packetRef':AR,'assignmentRef':AR,'policyRef':AR})
define('PlanApprovalSet',{'schemaVersion':{'const':'2.0'},'taskId':UUID,'subjectRef':AR,'decisionRefs':array(AR,1)})
define('PlanReviewNote',{'sectionId':ref('PlanSectionId'),'targetId':text(),'kind':enum('blocking','question','suggestion'),'body':short(8000)},('targetId',))
define('PlanReviewCommentRequest',{'commandId':UUID,'expectedRevision':integer(1),'subjectHash':ref('Digest'),'note':ref('PlanReviewNote')})
define('PlanReviewComment',{'id':UUID,'taskId':UUID,'subjectHash':ref('Digest'),'authorId':UUID,'note':ref('PlanReviewNote'),'state':enum('open','resolved','superseded'),'createdAt':TIME,'resolutionRef':AR},('resolutionRef',))
define('PlanReviewCommentPage',{'items':array(ref('PlanReviewComment')),'nextCursor':text()},('nextCursor',))
define('PlanReviewView',{'taskId':UUID,'revision':integer(1),'phase':enum('drafting','in_review','changes_requested','approved','superseded'),'packetRef':AR,'subjectRef':AR,'assignmentRef':AR,'requiredDecisionIds':array(UUID),'blockingFindingRefs':ARS,'eligibleToRespond':BOOL},('subjectRef','assignmentRef'))
define('PlanReviewState',{'schemaVersion':{'const':'2.0'},'taskId':UUID,'revision':integer(1),'phase':enum('drafting','in_review','changes_requested','approved','superseded'),'packetRef':AR,'subjectRef':AR,'assignmentRef':AR,'requiredDecisionIds':array(UUID),'commentSequence':integer(),'pendingCommandIds':array(UUID),'approvalSetRef':AR,'previousStateRef':AR},('subjectRef','assignmentRef','approvalSetRef','previousStateRef'))
D['TaskView']['properties']['planReview']=ref('PlanReviewView')
for envelope in ('InputBinding','ExecutionPlan'):
    D[envelope]['properties'].update({'reviewPacketRef':AR,'planApprovalSetRef':AR})
D['WorkflowCheckpoint']['properties']['planReviewStateRef']=AR
D['DecisionView']['allOf']=[{'if':{'properties':{'action':enum('confirm_intent','approve_plan')}},'then':{'required':['requiredPrincipalId']}}]
D['DecisionResponse']['properties'].update({'reviewedSectionIds':array(ref('PlanSectionId')),'reviewNotes':array(ref('PlanReviewNote'))})
D['CommandEnvelope']['properties']['kind']['enum'].append('comment_plan')
D['CommandEnvelope']['properties']['reviewNote']=ref('PlanReviewNote')
D['CommandEnvelope']['allOf'].append({'if':{'properties':{'kind':{'const':'comment_plan'}}},'then':{'required':['subjectHash','reviewNote']}})
D['CommandEnvelope']['properties']['kind']['enum'].append('resolve_plan_comment')
D['CommandEnvelope']['properties'].update({'commentId':UUID,'resolutionRef':AR})
D['CommandEnvelope']['allOf'].append({'if':{'properties':{'kind':{'const':'resolve_plan_comment'}}},'then':{'required':['subjectHash','commentId','resolutionRef']}})
D['PlanNode']['properties']['timeoutClass']['enum'].append('human_wait')
from operational_contracts import extend as extend_operational, write_tools, examples as operational_examples, MANDATORY_HUMAN_GATES, DEFAULT_STAGE_WALL_SECONDS, RUNNER_FINALISATION_GRACE_SECONDS, RUNNER_TERMINATION_GRACE_SECONDS
extend_operational(D, define, ref, obj, text, integer, array, enum, UUID, TIME, BOOL, AR, ARS)
from rules_contracts import extend as extend_rules, write_tools as write_rules_tools, examples as rules_examples
extend_rules(D, define, ref, obj, text, integer, array, enum, UUID, TIME, BOOL, AR, ARS)
from frozen_tool_contracts import definitions as frozen_tool_definitions
D.update(frozen_tool_definitions())

# Revision 1.11: admission metadata, allocation classification and confidential delivery.
D['PriorityClass']=enum('incident','normal','background')
D['PriorityClass']['default']='normal'
D['DataClassification']=text()
define('TaskSecurity',{'severity':enum('critical','high','medium','low'),'sourceRef':AR,'responseTargetAt':TIME,'embargoed':BOOL,'securityGroupId':UUID},('responseTargetAt','securityGroupId'))
D['TaskSecurity']['allOf']=[{'if':{'properties':{'embargoed':{'const':True}}},'then':{'required':['securityGroupId']}}]
D['TaskRequest']['properties'].update({'priorityClass':ref('PriorityClass'),'security':ref('TaskSecurity'),'incidentRef':AR})
# Security metadata applies to bug/maintenance work, to a design-scope task of an eligible
# type, or (design-delivery/1.0) to a build that inherits the embargo of the design it names;
# the service checks that group equals the design's. Branches are disjoint by type/scope.
D['TaskRequest']['allOf'].append({'if':{'required':['security']},'then':{'oneOf':[{'properties':{'workType':enum('bug','maintenance')}},{'properties':{'deliveryScope':{'const':'design'},'workType':enum('feature','refactor','performance','platform')}},{'required':['designSource'],'properties':{'deliveryScope':enum('patch','pr','preview','production'),'workType':enum('feature','refactor','performance','platform'),'security':{'properties':{'embargoed':{'const':True}}}}}]}})
D['TaskView']['properties'].update({'priorityClass':ref('PriorityClass'),'security':ref('TaskSecurity'),'incidentRef':AR,'changeClass':text(),'publicationTargetRefs':ARS})
D['TaskView']['required']+=['priorityClass','changeClass']
define('PublicationTarget',{'schemaVersion':{'const':'2.0'},'taskId':UUID,'sourceRepositoryId':UUID,'publicationRepositoryId':UUID,'baseBranch':text(),'mode':enum('ordinary','private_fork','separate_repo'),'securityGroupId':UUID,'assignmentPolicyRef':AR},('securityGroupId',))
D['PublicationTarget']['allOf']=[{'if':{'properties':{'mode':enum('private_fork','separate_repo')}},'then':{'required':['securityGroupId']}}]
D['GitCapabilities']['properties']['confidentialPublication']=enum('none','private_fork','separate_repo')
D['GitCapabilities']['required'].append('confidentialPublication')
define('PublicationAccessCheck',{'targetRef':AR,'readPrincipalIds':array(UUID),'securityGroupId':UUID,'membershipRevision':text(),'providerEnforced':BOOL,'observedAt':TIME,'providerEvidenceRef':AR})
define('EmbargoLiftSubject',{'schemaVersion':{'const':'2.0'},'taskId':UUID,'securityGroupId':UUID,'taskSpecVersion':integer(1),'publicationTargetRefs':ARS,'disclosureScopeRef':AR,'policyRef':AR})
for name in ('ApplicationDefinition','ApplicationRepository'):
    D[name]['properties']['dataClassification']=ref('DataClassification')
define('EvidenceSourceDescriptor',{'sourceId':text(),'kind':D['GetEvidenceQueryInputV12']['properties']['sourceKind'],'dataClassification':ref('DataClassification'),'applicationIds':array(UUID,1),'queryTemplateRefs':array(AR,1),'policyRef':AR})
define('ProviderEligibilityBinding',{'dataClassification':ref('DataClassification'),'sourceDescriptorRefs':array(AR,1),'policyRef':AR,'eligibleModelProfileIds':array(text(),1),'decisionRef':AR})
D['StageInput']['properties']['providerEligibility']=ref('ProviderEligibilityBinding')
D['InputBinding']['properties']['providerEligibilityRef']=AR
D['StageInput'].setdefault('allOf',[]).append({'if':{'required':['providerEligibility']},'then':{'properties':{'inputBinding':{'required':['providerEligibilityRef']}}}})
D['ArtifactView']['properties']['classification']['description']='Artifact retention/access class; distinct from provider-policy dataClassification.'
D['ArtifactView']['properties']['dataClassification']=ref('DataClassification')

from review_mode_contracts import extend as extend_review_mode, examples as review_mode_examples, annotate_review_fields
extend_review_mode(D, define, ref, obj, text, integer, array, enum, UUID, TIME, BOOL, AR, ARS)
from design_delivery_contracts import extend as extend_design, examples as design_examples, DESIGN_ROUTES
extend_design(D, define, ref, obj, text, integer, array, enum, UUID, TIME, BOOL, AR, ARS)
annotate_review_fields(D)

# All versioned domain envelopes move together for the breaking reference draft.
for definition in D.values():
    field=definition.get('properties',{}).get('schemaVersion')
    if field and 'const' in field:field['const']='2.0'

schema={'$schema':'https://json-schema.org/draft/2020-12/schema','$id':'https://factory.example/spec/domain/2.0','title':'Software factory reference domain contracts','$defs':D}
write(C/'domain.schema.json',schema)
write_tools(C)
write_rules_tools(C)

# These schemas express wire shapes; cross-field/authority predicates are in the specification.
def ts(s):
    if 'oneOf' in s:return ' | '.join(ts(branch) for branch in s['oneOf'])
    if '$ref' in s:return s['$ref'].split('/')[-1]
    if 'const' in s:return json.dumps(s['const'])
    if 'enum' in s:return ' | '.join(json.dumps(x) for x in s['enum'])
    t=s.get('type')
    if t=='array':return 'Array<'+ts(s['items'])+'>'
    if t=='object':
        if 'properties' not in s:return 'Record<string, '+ts(s['additionalProperties'])+'>'
        return '{ '+ '; '.join(json.dumps(k)+('' if k in s.get('required',[]) else '?')+': '+ts(v) for k,v in s['properties'].items())+' }'
    return {'string':'string','integer':'number','number':'number','boolean':'boolean','null':'null'}.get(t,'unknown')
(C/'schemas.generated.ts').write_text('// Generated from domain.schema.json by build_contracts.py. Validate at runtime.\n'+'\n'.join('export type '+n+' = '+ts(v)+';' for n,v in D.items())+'\n')

ROUTES=[
('get','/applications/{applicationId}/review-mode',None,'ReviewModeStatus',200),
('get','/tasks/{taskId}/ai-reviews',None,'AIReviewPage',200),
('get','/tasks/{taskId}/pr-review',None,'PRReviewView',200),('get','/applications/{applicationId}/health-ledger',None,'ApplicationHealthPage',200),
('get','/tasks/{taskId}/plan-review',None,'PlanReviewView',200),('get','/tasks/{taskId}/plan-review/comments',None,'PlanReviewCommentPage',200),('post','/tasks/{taskId}/plan-review/comments','PlanReviewCommentRequest','CommandReceipt',202),
('get','/tasks/{taskId}/intent',None,'IntentInterviewView',200),('post','/tasks/{taskId}/intent/answers','IntentAnswerRequest','CommandReceipt',202),
('post','/application-drafts','ApplicationDraftRequest','ApplicationDraftView',201),('get','/application-drafts',None,'ApplicationDraftPage',200),('get','/application-drafts/{applicationId}',None,'ApplicationDraftView',200),('post','/application-drafts/{applicationId}/revisions','ApplicationDraftRevisionRequest','ApplicationDraftView',201),
('post','/tasks','TaskRequest','TaskAccepted',202),('get','/tasks',None,'TaskPage',200),('get','/tasks/{taskId}',None,'TaskView',200),
('post','/tasks/{taskId}/commands','CommandEnvelope','CommandReceipt',202),('get','/commands/{commandId}',None,'CommandReceipt',200),
('get','/tasks/{taskId}/events',None,'TaskEvent',200),('get','/tasks/{taskId}/runs',None,'RunPage',200),('get','/runs/{runId}',None,'RunView',200),('get','/runs/{runId}/logs',None,'RunLogPage',200),
('get','/tasks/{taskId}/gates',None,'GatePage',200),('get','/tasks/{taskId}/findings',None,'FindingPage',200),
('get','/decisions',None,'DecisionPage',200),('get','/decisions/{decisionId}',None,'DecisionView',200),('post','/decisions/{decisionId}/responses','DecisionResponse','CommandReceipt',202),
('get','/applications',None,'ApplicationPage',200),('get','/applications/{applicationId}',None,'ApplicationView',200),('get','/applications/{applicationId}/relationships',None,'RelationshipPage',200),('get','/applications/{applicationId}/profiles',None,'ProfilePage',200),
('post','/registry/imports','ImportRequest','ImportView',202),('get','/registry/imports/{importId}',None,'ImportView',200),
('post','/context-snapshots','SnapshotRequest','AsyncReceipt',202),('get','/operations/{operationId}',None,'AsyncReceipt',200),
('get','/knowledge',None,'KnowledgePage',200),('post','/knowledge/proposals','KnowledgeProposal','AsyncReceipt',202),
('get','/artifacts/{artifactId}',None,'ArtifactView',200),('post','/artifacts/{artifactId}/access','ArtifactAccessRequest','ArtifactAccess',200),
('get','/environments',None,'EnvironmentPage',200),('get','/environments/{environmentId}',None,'EnvironmentView',200),('post','/environments/{environmentId}/commands','EnvironmentCommand','CommandReceipt',202),
('get','/providers',None,'ProviderPage',200),('get','/policies/{policyId}',None,'PolicyProfile',200),
('post','/webhooks/{provider}',None,'WebhookReceipt',202),('get','/health/live',None,'Health',200),('get','/health/ready',None,'Health',200)]
ROUTES+=DESIGN_ROUTES
import re
def aref(n):return {'$ref':'./domain.schema.json#/$defs/'+n}
paths={}
for method,path,request,response,status in ROUTES:
    opid=method+'_'+re.sub('[^a-zA-Z0-9]+','_',path).strip('_')
    params=[{'name':n,'in':'path','required':True,'schema':text()} for n in re.findall(r'\{(.*?)\}',path)]
    if method=='post' and not path.startswith('/webhooks'):
        params.append({'name':'Idempotency-Key','in':'header','required':True,'schema':text()})
    if request in ('CommandEnvelope','DecisionResponse','EnvironmentCommand','ApplicationDraftRevisionRequest','IntentAnswerRequest','PlanReviewCommentRequest'):
        params.append({'name':'If-Match','in':'header','required':True,'schema':text()})
    if response.endswith('Page'):
        params += [{'name':'cursor','in':'query','schema':text()},{'name':'limit','in':'query','schema':{'type':'integer','minimum':1,'maximum':100,'default':50}}]
    filters={'/tasks':{'reviewMode':ref('ReviewMode'),'deliveryScope':ref('DeliveryScope'),'applicationId':UUID,'workType':ref('WorkType'),'targetKind':enum('new_application','existing_application'),'workflowTemplateId':ref('WorkflowTemplateId'),'status':ref('TaskStatus'),'creatorId':UUID,'ownerPrincipalId':UUID,'createdAfter':TIME,'createdBefore':TIME},'/tasks/{taskId}/runs':{'nodeId':text(),'status':ref('StageStatus')},'/tasks/{taskId}/gates':{'inputHash':ref('Digest'),'includeHistorical':BOOL},'/tasks/{taskId}/findings':{'severity':enum('critical','high','medium','low'),'status':enum('open','fixed','rejected','accepted_risk')},'/decisions':{'applicationId':UUID,'taskId':UUID,'state':enum('pending','approved','rejected','changes_requested','expired','superseded')},'/applications':{'query':text(),'reviewMode':ref('ReviewMode')},'/applications/{applicationId}':{'definitionId':UUID},'/applications/{applicationId}/relationships':{'direction':enum('in','out','both'),'depth':{'type':'integer','minimum':1,'maximum':3},'environment':text()},'/applications/{applicationId}/profiles':{'purpose':text(),'environment':text()},'/knowledge':{'scope':text(),'query':text(),'applicableVersion':text(),'status':enum('proposed','reviewed','verified','disputed','superseded','expired')},'/environments':{'taskId':UUID,'applicationId':UUID,'state':text(),'expiresBefore':TIME},'/providers':{'kind':enum('harness','git','deployment','observability','storage')},'/policies/{policyId}':{'revision':integer(1)}}
    if method=='get':
        for name,field in filters.get(path,{}).items():
            if '$ref' in field:field=aref(field['$ref'].split('/')[-1])
            params.append({'name':name,'in':'query','schema':field})
    content={'application/json':{'schema':aref(response)}}
    if path.endswith('/events'):
        params.append({'name':'Last-Event-ID','in':'header','schema':text()})
        params.append({'name':'after','in':'query','schema':integer(),'description':'Resume after this task event sequence; ignored when Last-Event-ID is present.'})
        content={'text/event-stream':{'schema':{'type':'string'}}}
    op={'operationId':opid,'summary':opid.replace('_',' '),'parameters':params,'responses':{str(status):{'description':'Accepted command/resource' if status==202 else 'Successful read/result','content':content},'default':{'description':'Structured failure','content':{'application/problem+json':{'schema':aref('Problem')}}}}}
    if path.endswith('/events'):
        op['description']='SSE data fields are serialized TaskEvent records; id is per-task sequence.'
        op['responses']['410']={'description':'Cursor predates retained events; fetch the snapshot and resume from its sequence','headers':{'Location':{'schema':{'type':'string','format':'uri-reference'}}},'content':{'application/problem+json':{'schema':aref('EventCursorExpired')}}}
    if path=='/health/ready':
        op['responses']['503']={'description':'Dependencies cannot accept work','headers':{'Retry-After':{'schema':text()}},'content':{'application/json':{'schema':aref('HealthNotReady')}}}
    if request:op['requestBody']={'required':True,'content':{'application/json':{'schema':aref(request)}}}
    if path=='/tasks' and method=='post':
        op['responses']['403']={'description':'Incident priority or security scope is not authorized for the authenticated caller. No task is admitted.','content':{'application/problem+json':{'schema':aref('Problem')}}}
    if path.startswith('/health'):op['security']=[]
    if path.startswith('/webhooks'):
        op['security']=[];op['description']='Provider-specific signature and installation validation is mandatory before inbox persistence. Raw body schema is provider-owned, not trusted domain input.'
        op['requestBody']={'required':True,'content':{'application/octet-stream':{'schema':{'type':'string','format':'binary'}}}}
    paths.setdefault(path,{})[method]=op
write(C/'api.openapi.json',{'openapi':'3.1.0','info':{'title':'Software factory API','version':API_VERSION,'description':'Reference API contract. Authentication issuer, provider webhooks and deployment binding are installation configuration.'},'servers':[{'url':'/v2'}],'security':[{'bearerAuth':[]}],'paths':paths,'components':{'securitySchemes':{'bearerAuth':{'type':'http','scheme':'bearer','bearerFormat':'JWT'}}}})

def uid(n):return f'00000000-0000-4000-8000-{n:012d}'
def art(n):return {'artifactId':uid(n),'sha256':format(n,'064x'),'mediaType':'application/json','schemaVersion':'2.0','sizeBytes':1024}
budget={'maxMicroUsd':25000000,'maxActiveSeconds':14400,'maxCalendarSeconds':604800,'maxAuthoringInvocations':8,'maxSemanticAttemptsPerNode':3,'maxDesignReturns':2,'invocationMode':'bounded'}
task={'schemaVersion':'2.0','title':'Add order cancellation','intent':'Allow an authorized customer to cancel an unfulfilled order while preserving audit history.','applicationIds':[uid(10)],'targetContext':{'kind':'existing_application','applicationId':uid(10)},'workType':'feature','acceptanceCriteria':['Authorized customer can cancel an unfulfilled order.','Repeated cancellation is idempotent.','Another customer cannot cancel the order.','Audit history remains queryable.'],'assurance':'enhanced','deliveryScope':'pr','prCompletion':{'mode':'pr_created','maxReviewRounds':3,'maxWaitSeconds':604800},'budget':budget}
write(E/'feature-task.json',task)
write(E/'application.json',{'schemaVersion':'2.0','applicationId':uid(10),'key':'orders-api','name':'Orders API','ownerIds':['team:commerce'],'lifecycle':'production','repositories':[{'repositoryId':uid(20),'subpath':'services/orders','purpose':'service'}],'providedInterfaceIds':['orders-http-v1'],'consumedInterfaceIds':['inventory-http-v1'],'dependencies':[{'applicationId':uid(11),'mode':'deploy','releaseRef':'inventory-compatible-v4'}],'telemetryServiceNames':['orders-api'],'setupProfileRef':art(30),'verificationProfileRefs':[art(31)],'deploymentProfileRefs':[art(32)],'minimumAssurance':'standard','runbookPaths':['docs/runbooks/orders.md'],'secretRefs':['secret:orders-preview-db']})
write(E/'interface.json',{'schemaVersion':'2.0','interfaceId':'orders-http-v1','protocol':'http','contractSource':{'repositoryId':uid(20),'commit':'a'*40,'path':'contracts/orders.openapi.json'},'contractDigest':'b'*64,'compatibilityPolicy':'additive_only','authMechanism':'OIDC bearer token','ownerApplicationId':uid(10),'knownConsumerApplicationIds':[uid(11)]})
write(E/'application-snapshot.json',{'schemaVersion':'2.0','snapshotId':uid(42),'targetContext':{'kind':'existing_application','applicationId':uid(10)},'applicationDefinitionRefs':[art(43)],'applicationDraftRefs':[],'interfaceDefinitionRefs':[art(44),art(47)],'createdAt':'2026-10-09T12:00:00Z'})
write(E/'policy.json',{'schemaVersion':'2.0','id':'organization-default','revision':1,'defaultAssurance':'standard','fastAllowedApplicationIds':[],'riskTriggers':['public_api','authentication_authorization','payment','sensitive_data','persistent_migration','several_services','unknown_blast_radius','critical_application','privileged_infrastructure','performance_resource_risk'],'nonwaivableGates':list(MANDATORY_HUMAN_GATES),'nonwaivableInvariants':['bug_red_lock_green','exact_input_binding','independently_collected_evidence','authorized_delivery'],'gateModeRules':[{'gateId':gate,'mode':'human','sampleBasisPoints':10000,'humanFloor':True} for gate in (*MANDATORY_HUMAN_GATES,'oracle_accepted')],'stageWallSecondsByTimeoutClass':DEFAULT_STAGE_WALL_SECONDS,'maxOpenPRsPerApplication':5,'maxDiffLinesPerPR':400,'defaultBudget':budget,'productionEnabledApplicationIds':[],'decisionTtlSeconds':259200,'previewTtlSeconds':86400})
binding={'behaviorReleaseRef':art(220),'resolvedGatePolicyRef':art(221),'factoryToolSetRef':art(222),'workflowTemplateRef':art(90),'taskSpecVersion':1,'planVersion':1,'policyRef':art(40),'applicationSnapshotRef':art(41),'criteriaRef':art(42),'candidateRef':art(43),'canonicalPackageRef':art(44),'setupProfileRef':art(30)}
input_hash=hashlib.sha256(json.dumps(binding,sort_keys=True,separators=(',',':')).encode()).hexdigest()
write(E/'stage-result.json',{'schemaVersion':'2.0','orgId':uid(1),'taskId':uid(2),'stageRunId':f'task-{uid(2)}/plan-1/implement/attempt-1','producerKind':'runner','inputHash':input_hash,'allocationEpoch':3,'status':'completed','outputRefs':[art(43)],'checkpointRef':art(45),'usage':[{'provider':'example-harness','modelProfile':'standard-author','quality':'unavailable','observedAt':'2026-09-28T12:00:00Z'}],'producerId':'runner-checkpoint:allocation-3','completedAt':'2026-09-28T12:00:00Z'})
write(E/'harness-run-result.json',{'schemaVersion':'2.0','stageRunId':f'task-{uid(2)}/plan-1/implement/attempt-1','adapterId':'example-harness','adapterVersion':'1.0.0','allocationEpoch':3,'terminationReason':'provider_error','providerErrorClass':'unavailable','outputRefs':[],'usage':[{'provider':'example-harness','modelProfile':'standard-author','quality':'unavailable','source':'adapter-events','intervalStart':'2026-10-09T11:59:00Z','intervalEnd':'2026-10-09T12:00:00Z','observedAt':'2026-10-09T12:00:00Z'}],'diagnosticRef':art(46),'producerKind':'adapter'})
write(E/'gate-evaluation.json',{'id':uid(50),'taskId':uid(2),'gateId':'outcome_verified','inputBinding':binding,'inputHash':input_hash,'verdict':'passed','evidenceRefs':[art(51)],'evaluatorId':'trusted-verifier:v1','reasonCodes':['required_checks_passed'],'evaluatedAt':'2026-09-28T12:10:00Z'})
write(E/'environment-plan.json',{'schemaVersion':'2.0','environmentId':uid(60),'orgId':uid(1),'taskId':uid(2),'providerId':'internal-mcp-deployer','profileRef':art(32),'purpose':'preview','candidateRef':art(43),'deployables':[{'applicationId':uid(10),'repositoryId':uid(20),'sourceCommit':'a'*40,'imageDigest':'registry.example/orders@sha256:'+'b'*64,'templateRef':art(61),'configurationRef':art(62),'dependencyIds':[],'secretRefs':['secret:orders-preview-db']}],'fixtureRefs':[art(63)],'migrationRecipeRefs':[art(64)],'readinessRecipeRefs':[art(65)],'verificationRecipeRefs':[art(31)],'networkMode':'restricted-preview','expiresAt':'2026-09-29T12:00:00Z'})

# Illustrative profile bindings and observations, not real-cluster evidence.
preview_plan=json.loads((E/'environment-plan.json').read_text())
preview_plan.update(providerId='argocd-pr-preview',pullRequestRevision={'repositoryId':uid(20),'pullRequestId':'123','headCommit':'a'*40},releaseManifestRef=art(66),expiresAt='2026-10-27T12:00:00Z')
write(E/'branch-preview-plan.json',preview_plan)
write(E/'deployment-status.json',{'operationState':'succeeded','environmentState':'ready','endpoints':['https://orders-r20-pr123.preview.example'],'previewUrl':'https://orders-r20-pr123.preview.example','observedRevision':'a'*40,'imageDigestVerification':'match','observedReleaseRef':art(67)})
queued_environment={'id':uid(60),'taskId':uid(2),'revision':2,'generation':2,'currentOperationId':uid(68),'planRef':art(69),'providerId':'argocd-pr-preview','externalHandle':'repo20-pr123','state':'provisioning','endpoints':[],'expiresAt':'2026-10-27T12:00:00Z','cleanupState':'pending','status':{'operationState':'pending','environmentState':'provisioning','endpoints':[],'queueReason':'Application preview capacity is full. Waiting for confirmed cleanup.','imageDigestVerification':'unknown'},'statusObservedAt':'2026-10-26T12:00:00Z'}
write(E/'queued-environment.json',queued_environment)
write(E/'queued-environments.json',{'items':[queued_environment]})
repository_identity={'providerId':'github-reference','installationRef':'installation:demo','externalId':'repo20'}
write(E/'draft-preview-pr.json',{'providerId':'github-reference','repositoryId':uid(20),'externalId':'123','url':'https://github.example/example/orders/pull/123','baseBranch':'main','baseCommit':'b'*40,'headCommit':'a'*40,'baseRepository':repository_identity,'headRepository':repository_identity,'state':'open','draft':True,'labels':['factory-preview','team:orders']})


draft={'schemaVersion':'2.0','key':'returns-service','name':'Returns service','ownerIds':['team:commerce'],'purpose':'Let customers request and track a return.','constraints':['Reuse the existing identity service.','No production writes in the initial slice.'],'providedInterfaceIntents':['Returns HTTP API'],'dependencyApplicationIds':[uid(11)],'minimumAssurance':'standard'}
write(E/'application-draft.json',draft)
new_target={'kind':'new_application','applicationId':uid(70),'draftRevision':1,'draftRef':art(71),'repositoryIntent':{'kind':'new_repository','providerId':'git-reference','installationRef':'installation:demo','namespace':'example-org','name':'returns-service','visibility':'private','defaultBranch':'main'}}
greenfield=dict(task,title='Build a returns service',intent=draft['purpose'],applicationIds=[uid(70),uid(11)],targetContext=new_target,acceptanceCriteria=['An authorized customer can request a return.','The customer can read the return status.','An unauthorized customer cannot access another return.'])
write(E/'greenfield-task.json',greenfield)
import copy
monorepo=copy.deepcopy(greenfield);monorepo['targetContext']['repositoryIntent']={'kind':'existing_repository','repositoryId':uid(20),'baseCommit':'a'*40,'subpath':'services/returns'}
write(E/'greenfield-monorepo-task.json',monorepo)
root_adoption=copy.deepcopy(monorepo);root_adoption['targetContext']['repositoryIntent'].update(subpath='',rootAdoption={'retainedBootstrapReceiptRef':art(83)})
write(E/'greenfield-root-adoption-task.json',root_adoption)
bug=copy.deepcopy(task);bug.update(title='Prevent duplicate stock reservation',intent='Repair retry handling after an uncertain reservation response.',workType='bug',acceptanceCriteria=['A repeated logical request reserves stock only once.'])
write(E/'bug-task.json',bug)
write(E/'bootstrap-plan.json',{'schemaVersion':'2.0','id':uid(72),'taskId':uid(73),'target':new_target,'architectureRef':art(74),'applicationSnapshotRef':art(75),'initializationTemplateRef':art(76),'setupProfileRef':art(82),'allowedPaths':['README.md','.gitignore','services/returns','docs','package.json','pnpm-lock.yaml','.github'],'repositoryOperationId':uid(77),'initializationOperationId':uid(78)})
write(E/'bootstrap-receipt.json',{'schemaVersion':'2.0','taskId':uid(73),'applicationId':uid(70),'planRef':art(79),'repositoryId':uid(80),'baseCommit':'c'*40,'sourceRef':art(81),'createdRepository':True,'operationIds':[uid(77),uid(78)],'completedAt':'2026-09-30T12:00:00Z'})
T=E/'templates';T.mkdir(exist_ok=True)
def node(id,kind,role,deps,gates,returns=(),capabilities=()):
    return {'id':id,'stageKind':kind,'role':role,'dependsOn':list(deps),'inputArtifactRefs':[],'requiredGateIds':list(gates),'requiredCapabilities':list(capabilities),'timeoutClass':'human_wait' if kind in ('intent_interview','intent_confirmation','plan_peer_review','pr_review') else 'provider' if kind in ('bootstrap_repository','deliver') else 'verify' if role=='verifier' else 'execute','sessionPolicy':'fresh','returnTargets':list(returns),'mandatory':True}
templates={
 'greenfield':('feature','new_application',[
 node('brief','product_brief','discovery',[],[]),
 node('interview','intent_interview','discovery',['brief'],[],['brief']),
 node('challenge','intent_challenge','reviewer',['interview'],[],['interview']),
 node('confirm_intent','intent_confirmation','publisher',['challenge'],['intent_aligned','scope_accepted'],['interview']),
 node('design','foundation_design','planner',['confirm_intent'],[],['interview']),
 node('design_review','plan_peer_review','reviewer',['design'],['architecture_accepted','plan_accepted','plan_peer_approved'],['design','interview']),
 node('bootstrap','bootstrap_repository','publisher',['design_review'],['bootstrap_ready'],['design']),
 node('scaffold','scaffold','implementer',['bootstrap'],[],['design']),
 node('foundation','verify_foundation','verifier',['scaffold'],['foundation_verified'],['scaffold','design']),
 node('register','activate_application','publisher',['foundation'],['application_registered'],['scaffold']),
 node('slice_criteria','criteria','criteria_author',['register'],['oracle_accepted'],['design']),
 node('slice','vertical_slice','implementer',['slice_criteria'],[],['design']),
 node('slice_verify','verify','verifier',['slice'],['vertical_slice_verified'],['slice','slice_criteria','design']),
 node('children','compose_children','planner',['slice_verify'],[],['design']),
 node('integrated','integrated_verify','verifier',['children'],['parent_outcome_verified'],['children','design']),
 node('review','review','reviewer',['integrated'],['review_passed'],['children','design']),
 node('deliver','deliver','publisher',['review'],[],['integrated'])]),
 'existing_feature':('feature','existing_application',[
 node('impact','feature_impact','discovery',[],['scope_accepted']),
 node('plan','plan','planner',['impact'],[],['impact']),
 node('plan_review','plan_peer_review','reviewer',['plan'],['plan_accepted','plan_peer_approved'],['plan']),
 node('criteria','criteria','criteria_author',['plan_review'],['oracle_accepted'],['plan']),
 node('implement','execute','implementer',['criteria'],[],['plan']),
 node('verify','verify','verifier',['implement'],['outcome_verified'],['implement','criteria']),
 node('compatibility','compatibility_verify','verifier',['verify'],['integration_passed'],['implement','plan']),
 node('review','review','reviewer',['compatibility'],['review_passed'],['implement','plan']),
 node('deliver','deliver','publisher',['review'],[],['compatibility'])]),
 'bug_fix':('bug','existing_application',[
 node('diagnose','diagnose','discovery',[],['scope_accepted']),
 node('plan','plan','planner',['diagnose'],[],['diagnose']),
 node('plan_review','plan_peer_review','reviewer',['plan'],['plan_accepted','plan_peer_approved'],['plan','diagnose']),
 node('oracle','author_regression','criteria_author',['plan_review'],['oracle_accepted'],['diagnose']),
 node('red','baseline_red','verifier',['oracle'],['baseline_valid'],['oracle','diagnose']),
 node('lock','lock_regression','verifier',['red'],['canonical_package_locked'],['oracle']),
 node('repair','execute','implementer',['lock'],[],['diagnose']),
 node('green','candidate_green','verifier',['repair'],['outcome_verified'],['repair','oracle']),
 node('regression','compatibility_verify','verifier',['green'],['integration_passed'],['repair','diagnose']),
 node('review','review','reviewer',['regression'],['review_passed'],['repair','diagnose']),
 node('deliver','deliver','publisher',['review'],[],['regression'])])}
pr_review_returns={'existing_feature':['impact','plan','criteria','implement'],'bug_fix':['diagnose','plan','oracle','repair'],'greenfield':['interview','design','slice_criteria','slice']}
for id,(work_type,target_kind,nodes) in templates.items():
    nodes.append(node('pr_review','pr_review','publisher',['deliver'],['delivery_complete'],pr_review_returns[id]))
    nodes.append(node('close','learn_close','knowledge_curator',['pr_review'],['outcome_recorded']))
    write(T/(id+'.json'),{'schemaVersion':'2.0','id':id,'version':'4.0.0' if id=='greenfield' else '3.0.0','workType':work_type,'targetKind':target_kind,'nodes':nodes})
intent_brief={'schemaVersion':'2.0','taskId':uid(73),'revision':3,'applicationDraftRef':art(71),
 'problem':'Customers currently ask support to request and track eligible returns.',
 'targetUsers':['Authenticated customer','Returns support operator'],
 'desiredOutcomes':['A customer can submit an eligible return and see its recorded status.'],
 'journeys':[{'id':'return-request','actor':'Authenticated customer','trigger':'Customer opens an eligible fulfilled order','steps':['Choose an eligible item','Submit a return request','Read the recorded return status'],'successExamples':['One return record is visible to the customer after submission.','A repeated logical request shows the same return.'],'failureExamples':['Another customer cannot read or return the item.','An expired item is rejected with an explanation.','An unavailable order source leaves no accepted return and allows a safe retry.']}],
 'criteria':[{'id':'return-create','statement':'An eligible item produces one visible return record, including repeated requests.','journeyIds':['return-request']},{'id':'return-access','statement':'Unauthorized or expired requests are rejected and upstream failure cannot produce a false accepted return.','journeyIds':['return-request']}],
 'firstSliceJourneyIds':['return-request'],'nonGoals':['Execute refunds','Arrange shipping','Write production data in the initial PR'],
 'constraints':['Use the existing identity and order contracts.','Return eligibility is supplied by the order service.','The requested outcome is a reviewed PR with independent fixture evidence.'],
 'tradeoffs':['Use current order-service eligibility rules; custom return policy is deferred.'],
 'assumptions':[], 'issues':[],
 'coverage':[{'topic':topic,'status':'answered','reason':reason,'evidenceRefs':[art(109)]} for topic,reason in [
 ('problem_outcome','Support-mediated returns are the problem; self-service request and tracking is the first outcome.'),
 ('users_ownership','Customer and support roles are distinguished; the named product owner resolves scope.'),
 ('journeys_failures','Eligible, expired, duplicate, unauthorized and upstream-unavailable scenarios are included.'),
 ('scope_non_goals','One request/status journey is in scope; refunds and shipping are excluded.'),
 ('data_permissions','Customer identity scopes access to their own order and return; fixture data is synthetic.'),
 ('dependencies','Identity and order eligibility contracts are supplied as pinned discovery inputs.'),
 ('experience_accessibility','Use existing app interaction patterns with keyboard access and explicit error/status text.'),
 ('operational_constraints','Initial acceptance uses representative fixture load; production sizing is a later explicitly excluded release concern.'),
 ('delivery_budget','PR delivery under the accepted bounded task budget; no implicit merge or deployment.'),
 ('success_measures','Acceptance demonstrates the listed journeys; support workload reduction is a later product measure.')]],
 'intentOwnerIds':[uid(100)],'humanAnswerRefs':[art(109)],'proposedTaskSpecRef':art(110)}
write(E/'intent-brief.json',intent_brief)
question={'id':'refund-boundary-v1','topic':'scope_non_goals','prompt':'Should this first slice execute refunds or only record and track a return?','whyItMatters':'Refund execution changes payment authority, integration and acceptance scope.','blocking':True,'sourceRefs':[art(71)],'suggestedAnswers':['Record and track only','Include refund execution']}
write(E/'intent-interview.json',{'taskId':uid(73),'revision':2,'phase':'waiting_input','stateRef':art(112),'briefRef':art(113),'pendingQuestions':[question],'blockingIssueCount':1})
answer_request={'commandId':uid(114),'expectedRevision':2,'interviewRevision':2,'answers':[{'questionId':'refund-boundary-v1','kind':'answer','text':'Record and track only; refund execution is outside this first slice.'}]}
write(E/'intent-answer.json',answer_request)
write(E/'intent-confirmation.json',{'schemaVersion':'2.0','taskId':uid(73),'interviewRevision':3,'baseTaskSpecVersion':1,'briefRef':art(115),'reviewRef':art(116)})
operational_examples(E, write, uid, art, task)
rules_examples(E, write, uid, art, task)
review_mode_examples(E, write, uid, art, task)
design_examples(E, write, uid, art, task)
example_count=len(list(E.rglob('*.json')))
print(f'Generated {len(D)} schemas, {len(ROUTES)} API operations and {example_count} examples')
