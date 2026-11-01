"""Generated adversarial reference corpus. Runtime conformance is a separate obligation."""
import copy
import json
from review_mode_contracts import AI_MARKER


def examples(E, write, uid, art):
    source = E/'ai-review'
    folder = source/'adversarial'; folder.mkdir(exist_ok=True)
    def read(path):
        return json.loads(path.read_text())
    plan = read(source/'in-force.json'); pr = read(source/'pr-panel.json')
    intent = copy.deepcopy(plan)
    for record in [intent['assignment'], intent['subject'], intent['approvalSet']] + [v['value'] for v in intent['decisions']]:
        record['gateId'] = 'intent_aligned'
    def mark(value, b):
        return dict(value, reviewMode='ai_only', reviewMarker=AI_MARKER,
                    reviewModeDecisionRef=b['decisionRef'], reviewSubjectRef=b['subjectRef'],
                    aiReviewApprovalSetRefs=[b['approvalSetRef']], voluntaryHumanReviewRefs=[])
    pv = mark(dict(taskId=plan['assignment']['taskId'], revision=1, phase='approved',
                   packetRef=plan['subject']['contentRef'], subjectRef=plan['subjectRef'], assignmentRef=plan['assignmentRef'],
                   requiredDecisionIds=[], blockingFindingRefs=[], eligibleToRespond=False), plan)
    iv = read(E/'intent-interview.json')
    iv.update(taskId=intent['assignment']['taskId'], briefRef=intent['subject']['contentRef'],
              phase='aligned', blockingIssueCount=0, alignmentDecisionIds=[])
    iv = mark(iv, intent)
    ps = read(E/'pr-review-state.json')
    ps.update(taskId=pr['assignment']['taskId'], phase='completed', reviewRound=1, pendingDecisionIds=[], findingRefs=[])
    ps['completionPolicy']['mode'] = 'merged'
    ps['pullRequests'][0].update(repositoryId=pr['subject']['repositoryId'], externalId=pr['subject']['pullRequestId'],
        expectedHead=pr['subject']['expectedHead'], observedHead=pr['subject']['expectedHead'],
        baseBranch=pr['subject']['baseBranch'], baseCommit=pr['subject']['expectedBase'], state='merged',
        draft=False, reviewState='approved', observedAt=pr['now'], mergedCommit='c'*40)
    ps = mark(ps, pr)
    spec = read(E/'feature-task.json')
    spec.update(assurance=plan['assignment']['assurance'], repositoryIds=[plan['decision']['devRepositoryId']])
    tv = mark(dict(id=plan['assignment']['taskId'], orgId=uid(1), creatorId=uid(1), ownerPrincipalId=uid(1),
        spec=spec, status='running', revision=1, planVersion=1, projectionSequence=1, projectedAt=plan['now'],
        createdAt=plan['decision']['validFrom'], updatedAt=plan['now'], cleanupState='pending',
        lastEventSequence=1, priorityClass='normal', changeClass='fixture'), plan)
    bases = {'TaskView': (tv, plan), 'PlanReviewView': (pv, plan), 'IntentInterviewView': (iv, intent),
             'PRReviewState': (ps, pr), 'PullRequest': (read(source/'draft-preview-pr.json'), pr),
             'OutcomeManifest': (read(source/'outcome-manifest.json'), plan)}
    def case(label, kind, mutate=lambda v,b: None, expected='reject', base=None):
        value, bundle = copy.deepcopy(base or bases[kind])
        mutate(value, bundle)
        write(folder/(('negative-' if expected == 'reject' else 'positive-') + label + '.json'),
              {'kind': kind, 'value': value, 'bundle': bundle, 'expected': expected})
    def panel(label, filename, mutate):
        value = read(source/filename); mutate(value)
        write(folder/('negative-'+label+'.json'), {'kind': 'panel', 'value': value, 'expected': 'reject'})
    def human_mode(v, mode):
        for f in ('reviewMode', 'reviewModeDecisionRef', 'reviewSubjectRef', 'reviewMarker', 'aiReviewApprovalSetRefs'):
            v.pop(f, None)
        if mode != 'legacy': v['reviewMode'] = mode
    for kind in bases:
        case('baseline-'+kind, kind, expected='accept')
    for label, mutate in {
        'application': lambda v,b: v['spec'].update(applicationIds=[uid(999)], targetContext={'kind':'existing_application','applicationId':uid(999)}),
        'additional-application': lambda v,b: v['spec']['applicationIds'].append(uid(999)),
        'repository': lambda v,b: v['spec'].update(repositoryIds=[uid(999)]),
        'change-class': lambda v,b: v.update(changeClass='unapproved'),
        'assurance': lambda v,b: v['spec'].update(assurance='enhanced'),
        'embargo': lambda v,b: v.update(security={'severity':'critical','sourceRef':b['subjectRef'],'embargoed':True,'securityGroupId':uid(999)}),
        'hotfix': lambda v,b: v.update(priorityClass='incident', incidentRef=b['subjectRef']),
    }.items(): case('N6-'+label, 'TaskView', mutate)
    def production(v,b):
        v.update(deliveryScope='production', outcomeKind='delivered', providerHandles=['production:fixture'])
        v.pop('recipeOutcomeRef', None); v.pop('prReviewStateRef', None)
    case('N6-production-no-release', 'OutcomeManifest', production)
    case('N6-production-request-pending', 'TaskView', lambda v,b:(v['spec'].update(deliveryScope='production'),v['spec'].pop('prCompletion',None)), expected='accept')
    case('N7-foreign-task', 'TaskView', lambda v,b:v.update(planReview=dict(pv, taskId=uid(999))))
    case('N7-unknown-approval', 'TaskView', lambda v,b:v.update(planReview=dict(pv, aiReviewApprovalSetRefs=[art(1798)])))
    case('N7-nested-head', 'TaskView', lambda v,b:v.update(prReview={'taskId':v['id'],'stateRef':b['subjectRef'],
         'state':dict(ps, pullRequests=[dict(ps['pullRequests'][0], observedHead='f'*40)])}))
    case('N7-human-parent-revoked', 'TaskView', lambda v,b:(human_mode(v,'human'),v.update(planReview=pv),b.update(state='revoked')))
    case('N7-nested-valid', 'TaskView', lambda v,b:v.update(planReview=pv), expected='accept')
    case('N7-human-parent-valid', 'TaskView', lambda v,b:(human_mode(v,'human'),v.update(planReview=pv)), expected='accept')
    for kind, field in [('PlanReviewView','requiredDecisionIds'),('IntentInterviewView','alignmentDecisionIds'),('PRReviewState','pendingDecisionIds')]:
        for mode in ('ai_only','human','legacy'):
            for identity in ('ai','unknown'):
                def launder(v,b,mode=mode,field=field,identity=identity):
                    if mode != 'ai_only': human_mode(v, mode)
                    v[field] = [b['decisions'][0]['ref']['artifactId'] if identity=='ai' else uid(999)]
                case('N8-'+kind+'-'+mode+'-'+identity, kind, launder)
    for label, mutate in {
        'provider': lambda v,b:v.update(providerId='foreign'),
        'unknown-head': lambda v,b:v.update(headRepository=None),
        'fork': lambda v,b:v['headRepository'].update(externalId='foreign-fork'),
        'foreign-base': lambda v,b:v['baseRepository'].update(externalId='foreign-repository'),
        'same-foreign-repositories': lambda v,b:(v['headRepository'].update(externalId='foreign'),v['baseRepository'].update(externalId='foreign')),
        'installation': lambda v,b:v['headRepository'].update(installationRef='foreign-installation'),
        'head': lambda v,b:v.update(headCommit='f'*40),
    }.items(): case('N9-'+label, 'PullRequest', mutate)
    for label, when in [('before-binding','2026-10-29T10:00:00Z'), ('before-votes','2026-10-29T11:30:00Z'), ('future','2026-11-01T00:00:00Z')]:
        case('N10-'+label, 'PRReviewState', lambda v,b,t=when:v['pullRequests'][0].update(observedAt=t))
    for filename in ('adjudicated.json', 'fixed-finding.json'):
        panel('N11-'+filename[:-5]+'-hash', filename, lambda b:b['priorDecisions'][0]['value'].update(subjectHash='f'*64))
    def later_round(b):
        a = copy.deepcopy({'ref':b['assignmentRef'],'value':b['assignment']})
        a['ref'] = art(1798); a['value']['round']=2
        vote = copy.deepcopy(b['decisions'][0]); vote['ref']=art(1799)
        vote['value'].update(assignmentRef=a['ref'], round=2, verdict='reject', submittedAt='2026-10-29T12:00:30Z')
        b.update(priorAssignments=[a], priorDecisions=[vote])
    panel('N11-obsolete-unanimous-round', 'in-force.json', later_round)
    for kind, field in [('PlanReviewView','packetRef'),('IntentInterviewView','briefRef')]:
        case('N12-'+field, kind, lambda v,b,f=field:v.update({f:art(1798)}))
    human = read(source/'positive-output-human.json')
    human_base = (human['value'], human['bundle'])
    case('N12-human-task', 'OutcomeManifest', lambda v,b:b['humanArtifacts'][0]['value'].update(taskId=uid(999)), base=human_base)
    case('N12-human-subject', 'OutcomeManifest', lambda v,b:b['humanArtifacts'][0]['value'].update(subjectRef=art(1798),subjectHash=art(1798)['sha256']), base=human_base)
    case('N13-ai-citation', 'OutcomeManifest', lambda v,b:b['humanArtifacts'][0]['value'].update(evidenceRefs=[b['decisions'][0]['ref']]), expected='accept', base=human_base)
    case('N13-citation-cannot-supply-authority', 'OutcomeManifest', lambda v,b:(b['humanArtifacts'][0]['value'].update(evidenceRefs=[b['decisions'][0]['ref']]),v.update(decisionRefs=[b['decisions'][0]['ref']])), base=human_base)
    case('N13-citation-cannot-change-actor', 'OutcomeManifest', lambda v,b:b['humanArtifacts'][0]['value'].update(actorKind='ai',evidenceRefs=[b['decisions'][0]['ref']]), base=human_base)
    # True production release authority must be linked, current, human and exact-subject.
    def release(v,b):
        production(v,b)
        b['taskView']['spec']['deliveryScope'] = 'production'
        b['taskView']['spec'].pop('prCompletion', None)
        record = copy.deepcopy(human['bundle']['humanArtifacts'][0])
        record['value'].update(action='authorize_release')
        b['humanArtifacts'] = [record]; v['decisionRefs'] = [record['ref']]
    case('N6-human-production-release', 'OutcomeManifest', release, expected='accept')
    case('N6-wrong-release-action', 'OutcomeManifest', lambda v,b:(release(v,b),b['humanArtifacts'][0]['value'].update(action='approve_plan')))
    case('N6-expired-release', 'OutcomeManifest', lambda v,b:(release(v,b),b['humanArtifacts'][0]['value'].update(expiresAt='2026-10-29T12:00:00Z')))
    # UUIDs resolve by the DecisionView ID as well as the ArtifactRef identity.
    def human_id(v,b):
        record = copy.deepcopy(human['bundle']['humanArtifacts'][0]);record['value']['id']=uid(1798)
        b['humanArtifacts']=[record];v['requiredDecisionIds']=[uid(1798)]
    case('N8-real-human-uuid', 'PlanReviewView', human_id, expected='accept')
    case('N8-pending-is-not-approved', 'PlanReviewView', lambda v,b:(human_id(v,b),b['humanArtifacts'][0]['value'].update(state='pending')))
    # Direct DecisionView and workflow-state authority take the same resolver path.
    decision = human['bundle']['humanArtifacts'][0]['value']
    case('N12-direct-decision-task', 'DecisionView', lambda v,b:v.update(taskId=uid(999)), base=(decision,human['bundle']))
    case('N13-direct-decision-citation', 'DecisionView', lambda v,b:v.update(evidenceRefs=[b['decisions'][0]['ref']]), expected='accept', base=(decision,human['bundle']))
    state = dict(pv, schemaVersion='2.0', commentSequence=0, pendingCommandIds=[],
                 aiReviewApprovalSetRef=plan['approvalSetRef'], reviewQualificationProfile='ai-review/1.0')
    for f in ('blockingFindingRefs','eligibleToRespond','reviewSubjectRef','reviewMarker','aiReviewApprovalSetRefs','voluntaryHumanReviewRefs'):
        state.pop(f)
    case('N7-workflow-state-unknown-set', 'PlanReviewState', lambda v,b:v.update(aiReviewApprovalSetRef=art(1798)), base=(state,plan))
    case('N7-workflow-state-valid', 'PlanReviewState', expected='accept', base=(state,plan))
    # Resolve a second gate's bundle through the nested subject, then validate
    # its PR observations in that context (including under a human parent).
    def nested_pr(v,b):
        evidence = copy.deepcopy(pr)
        evidence['subjectRef'] = art(1790); evidence['approvalSetRef'] = art(1791)
        for record in [evidence['approvalSet']] + [r['value'] for r in evidence['decisions']]:
            record.update(subjectRef=evidence['subjectRef'], subjectHash=evidence['subjectRef']['sha256'])
        state = copy.deepcopy(ps)
        state.update(reviewSubjectRef=evidence['subjectRef'], aiReviewApprovalSetRefs=[evidence['approvalSetRef']])
        b['reviewBundles'] = [evidence]
        v['prReview'] = {'taskId':v['id'], 'stateRef':art(1792), 'state':state}
    case('N7-resolved-nested-pr', 'TaskView', nested_pr, expected='accept')
    case('N7-resolved-nested-pr-head', 'TaskView', lambda v,b:(nested_pr(v,b),v['prReview']['state']['pullRequests'][0].update(observedHead='f'*40)))
    case('N7-human-parent-nested-pr', 'TaskView', lambda v,b:(nested_pr(v,b),human_mode(v,'human')), expected='accept')
    case('N7-human-parent-nested-pr-head', 'TaskView', lambda v,b:(nested_pr(v,b),human_mode(v,'human'),v['prReview']['state']['pullRequests'][0].update(observedHead='f'*40)))
    case('N7-human-parent-embargo', 'TaskView', lambda v,b:(nested_pr(v,b),human_mode(v,'human'),v.update(security={'severity':'critical','sourceRef':b['subjectRef'],'embargoed':True,'securityGroupId':uid(999)})))
    case('N9-observation-fork', 'PRReviewState', lambda v,b:v['pullRequests'][0]['headRepository'].update(externalId='fork'))
    case('N9-observation-missing-identity', 'PRReviewState', lambda v,b:v['pullRequests'][0].pop('headRepository'))
    panel('N11-retained-current-round', 'in-force.json', lambda b:b['priorDecisions'].append(copy.deepcopy(b['decisions'][0])))
    case('N6-output-missing-task-snapshot', 'OutcomeManifest', lambda v,b:b.pop('taskView'))
    case('N6-output-trusted-task-embargo', 'OutcomeManifest', lambda v,b:b['taskView'].update(security={'severity':'critical','sourceRef':b['subjectRef'],'embargoed':True,'securityGroupId':uid(999)}))
    for kind, record in [('AIReviewDecision',plan['decisions'][0]['value']), ('AIReviewApprovalSet',plan['approvalSet'])]:
        case('direct-'+kind, kind, expected='accept', base=(record,plan))
        case('N12-direct-'+kind+'-subject', kind, lambda v,b:v.update(subjectHash='f'*64), base=(record,plan))
    for kind in bases:
        if kind != 'PullRequest': case('empty-refs-'+kind,kind,lambda v,b:v.update(aiReviewApprovalSetRefs=[]))
        case('stale-qualification-'+kind,kind,lambda v,b:b.update(currentCohortRef=art(1798)))
