"""Static ai-review/1.0 shape and authority fixtures, not reviewer efficacy tests."""
import copy
from datetime import datetime
from review_mode_contracts import (REPLACEABLE_REVIEW_GATES, AI_MARKER, PLAN_GATES, PLAN_SECTIONS,
                                   REVIEW_OUTPUTS, REVIEW_RECORD_BINDINGS, review_field_role)


def instant(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def require(condition, message):
    if not condition:
        raise ValueError(message)


def qualification_ready(value):
    require(value['result'] == 'passed', 'unqualified reviewer')
    require({r['kind'] for r in value['results']} == {'plan', 'pr'} and len(value['results']) == 2,
            'clean and seeded plans AND PRs required')
    for result in value['results']:
        seeded = result['seededDefectCount']
        require(result['cleanCount'] > 0 and seeded > 0, 'empty qualification corpus')
        require(0 <= result['caughtDefects'] <= seeded and 0 <= result['falseApprovals'] <= seeded,
                'invalid qualification denominators')
        require(result['caughtDefects'] * 10000 >= value['minimumCatchBasisPoints'] * seeded,
                'catch-rate threshold failed')
        require(result['falseApprovals'] * 10000 <= value['maximumFalseApprovalBasisPoints'] * seeded,
                'false-approval threshold failed')


def in_force(bundle):
    decision = bundle.get('decision')
    require(decision is not None and bundle['reviewMode'] == 'ai_only', 'missing ai_only decision')
    require(bundle['state'] == 'active' and not bundle['emergencyStop'], 'inactive decision or emergency stop')
    require(not bundle['embargoed'] and not bundle['urgentHotfix'], 'excluded work')
    require(instant(decision['validFrom']) <= instant(bundle['now']) < instant(decision['expiresAt']), 'decision expired or premature')
    require(decision['qualificationCohortRef'] == bundle['currentCohortRef'], 'configuration changed')
    approvals = decision['ownerApprovals']
    require(len(approvals) == 2 and {a['role'] for a in approvals} == {'policy_owner', 'application_owner'}, 'both human owners required')
    for approval in approvals:
        require(approval['actorKind'] == 'human' and approval['subjectRef'] == decision['subjectRef']
                and approval['subjectHash'] == decision['subjectHash'] == decision['subjectRef']['sha256'], 'owner authority/subject mismatch')
        require(instant(approval['approvedAt']) <= instant(decision['validFrom']) <= instant(bundle['now']),
                'both owner approvals must precede establishment and evaluation')
    scope = decision['scope']; assignment = bundle['assignment']
    require(scope['applicationId'] == assignment['applicationId'] and bundle['workType'] in scope['workTypes']
            and bundle['changeClass'] in scope['changeClasses'] and bundle['pathProfileRef'] == scope['pathProfileRef']
            and assignment['assurance'] in scope['assuranceTiers'], 'decision scope mismatch')
    require(assignment['reviewModeDecisionRef'] == bundle['decisionRef'], 'wrong decision reference')
    require(assignment['gateId'] in REPLACEABLE_REVIEW_GATES, 'release authority is human')
    require(assignment['policyRef'] == decision['policyRef'], 'policy binding mismatch')
    return decision


def repository_ready(bundle, defs, validate):
    """Review authority may precede bootstrap; PR/merge authority never does."""
    decision = in_force(bundle)
    validate(decision, defs['ReviewModeDecision'])
    if decision['repositoryBindingState'] == 'bound':
        return decision
    binding = bundle.get('repositoryBinding')
    require(binding is not None, 'pre-repository decision has no merge authority')
    validate(binding, defs['ReviewModeRepositoryBinding'])
    require(binding['applicationId'] == decision['scope']['applicationId']
            and binding['reviewModeDecisionRef'] == bundle['decisionRef']
            and binding['repositoryIntentPolicyRef'] == decision['repositoryIntentPolicyRef']
            and binding['devBranch'] == decision['devBranch']
            and binding['factoryGitIdentityRef'] == decision['factoryGitIdentityRef'], 'repository binding scope mismatch')
    require(instant(decision['validFrom']) <= instant(binding['boundAt']) <= instant(bundle['now']), 'repository binding not effective')
    # The bootstrap controller resolves the receipt and namespace policy through
    # ArtifactStore/provider evidence, and rechecks live protection before effects.
    return binding


def review_records(value, name, defs, validate, with_context=False):
    """Walk typed records, including wrappers/arrays/unions, without a type allowlist."""
    def walk(value, shape, name, ancestors=()):
        if '$ref' in shape:
            name = shape['$ref'].rsplit('/', 1)[-1]
            shape = defs[name]
        if isinstance(value, dict):
            yield (name, value, ancestors) if with_context else (name, value)
            for field, item in value.items():
                if review_field_role(name, field) == 'citation':
                    continue
                child = shape.get('properties', {}).get(field)
                if child:
                    yield from walk(item, child, '', ancestors + ((name, value),))
        elif isinstance(value, list):
            for item in value:
                yield from walk(item, shape.get('items', {}), '', ancestors)
        for choice in shape.get('oneOf', []) + shape.get('anyOf', []):
            try:
                validate(value, choice)
            except ValueError:
                continue
            yield from walk(value, choice, name, ancestors)
            break
    yield from walk(value, defs[name], name)


def human_provenance_ready(bundle, defs, validate, output=None, name=None):
    """Check 1: resolve ALL human authority positions; never promote citations."""
    bundles = [bundle] + bundle.get('reviewBundles', [])
    ai_ids = set()
    artifacts = {}
    identifiers = {}
    for evidence in bundles:
        for entry in evidence.get('decisions', []) + evidence.get('priorDecisions', []):
            ai_ids.add(entry['ref']['artifactId'])
            if entry['value'].get('id'):
                ai_ids.add(entry['value']['id'])
        ai_ids.add(evidence['approvalSetRef']['artifactId'])
        for record in evidence.get('humanArtifacts', []):
            key = record['ref']['artifactId']
            require(key not in artifacts or artifacts[key] == record, 'ambiguous human artifact reference')
            artifacts[key] = record
            for identifier in (key, record['value'].get('id')):
                if identifier is not None:
                    require(identifier not in identifiers or identifiers[identifier] == record,
                            'ambiguous human decision identifier')
                    identifiers[identifier] = record
    resolved = []

    def human_shape(value, evidence):
        if 'decisionRefs' in value:
            kind = 'IntentApprovalSet' if 'confirmationSubjectRef' in value else 'PlanApprovalSet'
        else:
            kind = 'DecisionResponse' if 'outcome' in value else 'DecisionView'
        validate(value, defs[kind])
        require(value.get('actorKind') == 'human', 'non-human approval artifact')
        require(value.get('decisionKind') != 'ai_review' and value.get('id') not in ai_ids,
                'AI decision presented as human approval')
        check_scope(value, kind, evidence, defs, validate)
        check_identity(value, kind, evidence, defs, validate)
        check_chronology(evidence, defs, validate, value, kind, human_only=True)
        return kind

    def authority(value, evidence, active=frozenset(), approved=True):
        if isinstance(value, list):
            for item in value:
                authority(item, evidence, active, approved)
            return
        key = value if isinstance(value, str) else value.get('artifactId') if isinstance(value, dict) else None
        require(key not in ai_ids and not (isinstance(value, dict) and value.get('decisionKind') == 'ai_review'),
                'AI decision presented as human approval')
        if key is not None:
            require(key in identifiers, 'unknown or cyclic human approval reference')
            record = identifiers[key]; canonical = record['ref']['artifactId']
            require(canonical not in active, 'unknown or cyclic human approval reference')
            if isinstance(value, dict):
                require(all(value.get(k) == v for k, v in record['ref'].items()), 'human artifact ref mismatch')
            value = record['value']; active = active | {canonical}
        require(isinstance(value, dict), 'unresolved human approval')
        kind = human_shape(value, evidence)
        if approved and kind == 'DecisionView':
            require(value['state'] == 'approved', 'human decision does not approve')
        if approved and kind == 'DecisionResponse':
            require(value['outcome'] == 'approve', 'human response does not approve')
        resolved.append(value)
        for field, item in value.items():
            if review_field_role(kind, field) == 'human_authority':
                authority(item, evidence, active, approved)

    for evidence in bundles:
        for human in evidence.get('humanApprovals', []) + evidence.get('voluntaryHumanReviews', []):
            authority(human, evidence)
    if output is not None:
        # The public helper also supports untyped callers; field roles stay shared.
        def untyped(value):
            if isinstance(value, dict):
                yield '', value, ()
                for field, item in value.items():
                    if review_field_role('', field) not in ('citation', 'human_authority'):
                        yield from untyped(item)
            elif isinstance(value, list):
                for item in value:
                    yield from untyped(item)
        records = review_records(output, name, defs, validate, with_context=True) if name else untyped(output)
        for kind, record, ancestors in records:
            evidence, _ = evidence_for(record, ancestors, bundle, kind)
            if kind in ('DecisionView', 'DecisionResponse', 'PlanApprovalSet', 'IntentApprovalSet'):
                human_shape(record, evidence)
                resolved.append(record)
            for field, item in record.items():
                if review_field_role(kind, field) == 'human_authority':
                    pending = field in ('pendingDecisionIds', 'pendingFactoryDecisionRefs', 'decisionId')
                    pending = pending or (field in ('requiredDecisionIds', 'alignmentDecisionIds')
                                          and record.get('phase') not in ('approved', 'aligned'))
                    authority(item, evidence, approved=not pending)
    return resolved


def qualified_configuration(bundle, config_ref, defs, validate, qualification_ref=None):
    configs = [v for v in bundle['configurations'] if v['ref'] == config_ref]
    quals = [v for v in bundle['qualifications'] if v['value']['configurationRef'] == config_ref
             and (qualification_ref is None or v['ref'] == qualification_ref)]
    require(len(configs) == len(quals) == 1, 'missing or ambiguous configuration/qualification')
    config, qualification = configs[0]['value'], quals[0]
    validate(config, defs['ReviewerConfiguration']); validate(qualification['value'], defs['ReviewerQualification'])
    require(config['qualificationCohortRef'] == qualification['value']['qualificationCohortRef'] == bundle['currentCohortRef'],
            'new qualification cohort required')
    require(qualification['ref'] in bundle['decision']['reviewerQualificationRefs'], 'qualification not authorized')
    require(instant(qualification['value']['evaluatedAt']) <= min(instant(a['approvedAt']) for a in bundle['decision']['ownerApprovals']),
            'qualification must precede establishment')
    qualification_ready(qualification['value'])
    return config


def adjudication_ready(value, finding_ref, finding, bundle, defs, validate):
    validate(value, defs['AIReviewAdjudication'])
    assignment = bundle['assignment']
    assignments = bundle['priorAssignments'] + [{'ref': bundle['assignmentRef'], 'value': assignment}]
    original = next(a['value'] for a in assignments if a['ref'] == finding['assignmentRef'])
    panel = [s['configurationRef'] for s in original['slots']]
    require(value['taskId'] == assignment['taskId'] == finding['taskId']
            and value['subjectRef'] == finding['subjectRef']
            and value['subjectHash'] == finding['subjectRef']['sha256']
            and value['assignmentRef'] == finding['assignmentRef']
            and value['reviewModeDecisionRef'] == bundle['decisionRef']
            and value['findingRef'] == finding_ref and value['reviewRound'] == finding['round'], 'adjudication binding mismatch')
    require(value['authorConfigurationRef'] == original['authorConfigurationRef']
            and value['panelConfigurationRefs'] == panel, 'adjudication independence evidence mismatch')
    participants = panel + [original['authorConfigurationRef'], assignment['authorConfigurationRef']]
    participants += [s['configurationRef'] for s in assignment['slots']]
    excluded = {r['artifactId'] for r in participants}
    excluded_hashes = {r['sha256'] for r in participants}
    require(value['adjudicatorConfigurationRef']['artifactId'] not in excluded
            and value['adjudicatorConfigurationRef']['sha256'] not in excluded_hashes, 'author/panel cannot adjudicate own finding')
    config = qualified_configuration(bundle, value['adjudicatorConfigurationRef'], defs, validate, value['qualificationRef'])
    require(config['modelFamily'] == value['modelFamily'], 'adjudicator family mismatch')
    require(value['outcome'] == 'rejected', 'adjudication upheld or escalated; human resolution required')
    require(value['reviewRound'] < assignment['round'], 'fresh review round required after adjudication')


def findings_ready(bundle, defs, validate):
    """Reconcile the trusted finding ledger with all retained rounds, never a caller's empty list."""
    findings = bundle['findings']; history = bundle['priorDecisions'] + bundle['decisions']
    assignments = bundle['priorAssignments'] + [{'ref': bundle['assignmentRef'], 'value': bundle['assignment']}]
    require(len({a['ref']['artifactId'] for a in assignments}) == len(assignments), 'duplicate historical assignment')
    for assignment in assignments:
        validate(assignment['value'], defs['AIReviewPanelAssignment'])
    refs = [entry['ref'] for entry in findings]
    require(len({r['artifactId'] for r in refs}) == len(refs), 'duplicate finding')
    for vote in history:
        validate(vote['value'], defs['AIReviewDecision'])
        require(vote['value']['taskId'] == bundle['assignment']['taskId'], 'foreign historical vote')
        original = [a['value'] for a in assignments if a['ref'] == vote['value']['assignmentRef']]
        require(len(original) == 1 and original[0]['round'] == vote['value']['round'], 'missing historical assignment/round')
        require(original[0]['taskId'] == vote['value']['taskId']
                and original[0]['gateId'] == vote['value']['gateId'] == bundle['assignment']['gateId']
                and original[0]['applicationId'] == bundle['assignment']['applicationId']
                and original[0]['reviewModeDecisionRef'] == bundle['decisionRef']
                and original[0]['policyRef'] == bundle['decision']['policyRef'], 'historical authority mismatch')
        slot = [s for s in original[0]['slots'] if s['id'] == vote['value']['reviewerSlotId']]
        require(len(slot) == 1 and slot[0]['configurationRef'] == vote['value']['reviewerConfigurationRef'], 'historical reviewer identity mismatch')
        configuration = qualified_configuration(bundle, slot[0]['configurationRef'], defs, validate)
        require(configuration['modelFamily'] == slot[0]['modelFamily'] == vote['value']['modelFamily'], 'historical family provenance mismatch')
        for ref in vote['value']['findingRefs']:
            require(ref in refs, 'reviewer finding omitted from ledger')
    require(len(bundle['adjudications']) <= 1, 'adjudication bound exceeded; escalate to human')
    open_refs = []
    used_dispositions = []
    for entry in findings:
        finding = entry['value']; validate(finding, defs['AIReviewFinding'])
        sources = [v['value'] for v in history if entry['ref'] in v['value']['findingRefs']]
        require(sources and all(v['subjectRef'] == finding['subjectRef'] and v['assignmentRef'] == finding['assignmentRef']
                and v['round'] == finding['round'] and v['taskId'] == finding['taskId'] for v in sources), 'finding source binding mismatch')
        if finding['status'] == 'open':
            if finding['blocking']: open_refs.append(entry['ref'])
            continue
        records = bundle['adjudications'] if finding['status'] == 'rejected' else bundle['findingResolutions']
        dispositions = [a for a in records if a['ref'] == finding['dispositionRef']]
        require(len(dispositions) == 1, 'missing finding disposition')
        disposition = dispositions[0]['value']; used_dispositions.append(dispositions[0]['ref'])
        if finding['status'] == 'rejected':
            adjudication_ready(disposition, entry['ref'], finding, bundle, defs, validate)
        else:
            validate(disposition, defs['AIReviewFindingResolution'])
            require(disposition['taskId'] == finding['taskId'] and disposition['findingRef'] == entry['ref']
                    and disposition['originalSubjectRef'] == finding['subjectRef']
                    and disposition['correctedSubjectRef'] == bundle['subjectRef'] != finding['subjectRef']
                    and finding['round'] < bundle['assignment']['round'], 'fix requires verified changed subject and fresh round')
    require(all(a['ref'] in used_dispositions for a in bundle['adjudications'] + bundle['findingResolutions']), 'orphan disposition')
    require(bundle['openBlockingFindings'] == open_refs, 'blocking finding projection differs from ledger')
    require(not open_refs, 'unresolved blocking finding')


def panel_ready(bundle, defs, validate):
    decision = in_force(bundle)
    validate(decision, defs['ReviewModeDecision'])
    assignment = bundle['assignment']; validate(assignment, defs['AIReviewPanelAssignment'])
    subject = bundle['subjectRef']; subject_hash = subject['sha256']
    bound = bundle['subject']; validate(bound, defs['AIReviewSubject'])
    require(bound['contentRef'] == assignment['contentRef'] and bound['assignmentRef'] == bundle['assignmentRef']
            and bound['policyRef'] == assignment['policyRef'] and bound['taskId'] == assignment['taskId']
            and bound['gateId'] == assignment['gateId'], 'subject/assignment binding mismatch')
    require(subject['sha256'] == subject_hash, 'subject hash mismatch')
    require(bundle.get('reviewMarker') == AI_MARKER, 'missing AI marker')
    human_provenance_ready(bundle, defs, validate)
    if assignment['gateId'] == 'pr_review':
        repository = repository_ready(bundle, defs, validate)
        require(bound['repositoryId'] == repository['devRepositoryId'], 'PR outside bound repository')
        identity = repository['devRepositoryIdentity']
        require(bound['providerId'] == identity['providerId'] and bound['headRepository'] == bound['baseRepository'] == identity,
                'panel repository identity or fork mismatch')
    slots = assignment['slots']
    require(len({s['id'] for s in slots}) == len(slots), 'duplicate panel member')
    require(len({s['configurationRef']['sha256'] for s in slots}) == len(slots), 'configuration reused across slots')
    require(all(s['configurationRef']['artifactId'] != assignment['authorConfigurationRef']['artifactId']
                and s['configurationRef']['sha256'] != assignment['authorConfigurationRef']['sha256'] for s in slots), 'author cannot review own work')
    families = {s['modelFamily'] for s in slots}
    require(len(families) >= 2 and families - {assignment['authorModelFamily']}, 'single-family panel')
    base = [s for s in slots if s['role'] in ('primary', 'peer')]
    require(len(base) >= (3 if assignment['assurance'] == 'enhanced' else 2), 'panel too small')
    if assignment['gateId'] in ('plan_accepted', 'plan_peer_approved', 'oracle_accepted'):
        require(any(s['role'] == 'adversarial' for s in slots), 'missing adversarial reviewer')
    require(set(assignment['requiredSpecialistRoles']) <= {s.get('specialistRole') for s in slots if s['role'] == 'specialist'}, 'missing specialist')
    require(set(assignment['requiredSpecialistRoles']) == set(bundle['requiredSpecialistScopes']), 'trusted specialist requirements dropped')
    for role, sections in bundle['requiredSpecialistScopes'].items():
        require(any(s['role'] == 'specialist' and s.get('specialistRole') == role and set(sections) <= set(s['sectionIds']) for s in slots),
                'specialist scope omitted')
    if assignment['gateId'] in PLAN_GATES:
        primary = [s for s in slots if s['role'] == 'primary']
        require(len(primary) == 1 and set(PLAN_SECTIONS) <= set(primary[0]['sectionIds']), 'primary must cover complete packet')
    check_chronology(bundle, defs, validate)
    findings_ready(bundle, defs, validate)
    for slot in slots:
        configuration = qualified_configuration(bundle, slot['configurationRef'], defs, validate)
        require(configuration['modelFamily'] == slot['modelFamily'], 'family provenance mismatch')
    approval = bundle['approvalSet']; validate(approval, defs['AIReviewApprovalSet'])
    require(approval['subjectRef'] == subject and approval['subjectHash'] == subject_hash
            and approval['assignmentRef'] == bundle['assignmentRef'] and approval['reviewModeDecisionRef'] == bundle['decisionRef']
            and approval['taskId'] == assignment['taskId'] and approval['gateId'] == assignment['gateId']
            and approval['round'] == assignment['round'], 'approval set binding mismatch')
    votes = bundle['decisions']
    require(len(votes) == len(slots) and len(approval['aiDecisionRefs']) == len(slots), 'every panel member must approve')
    require({v['value']['reviewerSlotId'] for v in votes} == {s['id'] for s in slots}, 'missing/duplicate member vote')
    require(approval['aiDecisionRefs'] == [v['ref'] for v in votes], 'approval set omits a vote')
    for vote in votes:
        value = vote['value']; validate(value, defs['AIReviewDecision'])
        slot = next(s for s in slots if s['id'] == value['reviewerSlotId'])
        require(value['verdict'] == 'approve', 'majority-only approval')
        require(value['subjectRef'] == subject and value['subjectHash'] == subject_hash
                and value['assignmentRef'] == bundle['assignmentRef'] and value['taskId'] == assignment['taskId']
                and value['gateId'] == assignment['gateId'] and value['round'] == assignment['round'], 'stale vote')
        require(value['reviewerConfigurationRef'] == slot['configurationRef'] and value['modelFamily'] == slot['modelFamily'], 'reviewer identity mismatch')
        require(set(slot['sectionIds']) <= set(value['reviewedSectionIds']), 'vote omits assigned review scope')


def resolve_gate(rule, bundle, defs, validate):
    validate(rule, defs['GateModeRule'])
    if rule['gateId'] == 'oracle_accepted' and bundle['assignment']['assurance'] == 'enhanced':
        require(rule['mode'] in ('human', 'ai_panel'), 'enhanced oracle requires human or in-force AI panel')
    if rule['mode'] == 'ai_panel':
        in_force(bundle)
        require(rule['gateId'] == bundle['assignment']['gateId']
                and rule['reviewModeDecisionRef'] == bundle['decisionRef'], 'gate authority mismatch')
        panel_ready(bundle, defs, validate)
    return rule['mode']


def check_scope(value, name, bundle, defs, validate, task=None, human_records=(), active_ai=False):
    """Check 2: reconcile actual scope, nested task ownership and human release."""
    task_id = value.get('id') if name == 'TaskView' else value.get('taskId')
    if task_id is not None:
        require(task_id == bundle['assignment']['taskId'] == bundle['subject']['taskId'], 'output task mismatch')
    if active_ai or value.get('reviewMode') == 'ai_only':
        decision = in_force(bundle)
        scope = decision['scope']; assignment = bundle['assignment']
        actual = value.get('spec', value)
        if 'applicationIds' in actual:
            require(actual['applicationIds'] and set(actual['applicationIds']) == {scope['applicationId']},
                    'actual task application outside decision scope')
        target = actual.get('targetContext', {})
        if 'applicationId' in target:
            require(target['applicationId'] == scope['applicationId'], 'actual target application outside decision scope')
        if actual.get('repositoryIds'):
            repository = repository_ready(bundle, defs, validate)
            require(set(actual['repositoryIds']) <= {repository['devRepositoryId']}, 'actual task repository outside decision scope')
        if 'workType' in actual:
            require(actual['workType'] == bundle['workType'] and actual['workType'] in scope['workTypes'], 'actual task work type mismatch')
        if 'assurance' in actual:
            require(actual['assurance'] == assignment['assurance'] and actual['assurance'] in scope['assuranceTiers'],
                    'actual task assurance mismatch')
        for record in (value, actual):
            if 'changeClass' in record:
                require(record['changeClass'] == bundle['changeClass'] and record['changeClass'] in scope['changeClasses'],
                        'actual task change class mismatch')
            require(not record.get('security', {}).get('embargoed') and not record.get('embargoed'), 'actual task embargoed')
            require(record.get('priorityClass') != 'incident' and not record.get('incidentRef')
                    and not record.get('urgentHotfix') and not record.get('hotfix'), 'actual task incident or hotfix')
        # A human outer projection cannot lend its scope to a nested AI output.
        if task is not None and task is not value:
            check_scope(dict(task, reviewMode='ai_only'), 'TaskView', bundle, defs, validate, human_records=human_records)
    actual = value.get('spec', value)
    production = actual.get('deliveryScope') == 'production'
    effect = value.get('status', value.get('taskStatus')) == 'succeeded' or value.get('outcomeKind') == 'delivered'
    if production and effect:
        require(any(v.get('actorKind') == 'human' and v.get('action') == 'authorize_release'
                    and v.get('state') == 'approved' and v.get('taskId') == bundle['assignment']['taskId']
                    and v.get('subjectRef') == bundle['subjectRef'] for v in human_records),
                'production delivery requires human release_authorized evidence')
    if task is not None and name == 'OutcomeManifest':
        require(value['deliveryScope'] == task['spec']['deliveryScope'], 'output delivery target differs from actual task')


def check_identity(value, name, bundle, defs, validate):
    """Check 3: exact subject/content and provider/repository/head identity."""
    subject = bundle['subject']
    if 'subjectHash' in value:
        ref = value.get('subjectRef', bundle['subjectRef'])
        require(value['subjectHash'] == ref['sha256'], 'subject hash mismatch')
    if name in ('DecisionView', 'DecisionResponse', 'PlanApprovalSet', 'IntentApprovalSet'):
        ref = value.get('subjectRef', value.get('confirmationSubjectRef', bundle['subjectRef']))
        require(ref == bundle['subjectRef'] and value.get('subjectHash', ref['sha256']) == bundle['subjectRef']['sha256'],
                'human approval subject mismatch')
    if 'reviewSubjectRef' in value:
        require(value['reviewSubjectRef'] == bundle['subjectRef'], 'output subject mismatch')
    for field, item in value.items():
        if review_field_role(name, field) == 'content':
            require(item == subject['contentRef'], 'output content differs from reviewed subject hash')
    gates = {'PlanReviewView': PLAN_GATES, 'PlanReviewState': PLAN_GATES,
             'IntentInterviewView': ('intent_aligned',), 'IntentInterviewState': ('intent_aligned',),
             'PullRequest': ('pr_review',), 'PRReviewState': ('pr_review',), 'PRHeadObservation': ('pr_review',)}
    if name in gates:
        require(subject['gateId'] in gates[name], 'PR output requires pr_review panel' if 'pr_review' in gates[name] else 'output review gate mismatch')
    if name in ('PlanReviewView', 'PlanReviewState'):
        require(value.get('subjectRef') == bundle['subjectRef'] and value.get('assignmentRef') == bundle['assignmentRef'],
                'output plan subject mismatch')
    if name == 'PRReviewState':
        require(len(value['pullRequests']) == 1, 'PR output requires one exact PR subject')
    if name in ('PullRequest', 'PRHeadObservation'):
        repository = repository_ready(bundle, defs, validate)
        head = value.get('headCommit', value.get('observedHead'))
        require(value['repositoryId'] == subject['repositoryId'] == repository['devRepositoryId']
                and value['externalId'] == subject['pullRequestId'] and head == subject['expectedHead']
                and value.get('baseCommit') == subject['expectedBase'] and value.get('baseBranch') == subject['baseBranch'],
                'output PR subject mismatch')
        identity = repository['devRepositoryIdentity']
        require(subject.get('headRepository') == subject.get('baseRepository') == identity
                and value['providerId'] == subject.get('providerId') == identity['providerId'], 'PR provider or repository identity mismatch')
        require(value.get('headRepository') == value.get('baseRepository') == identity,
                'PR fork or unknown repository identity')
        if name == 'PRHeadObservation':
            require(value['expectedHead'] == subject['expectedHead'], 'output expected head mismatch')
        if value['state'] == 'merged':
            require(not value.get('draft', True) and value['baseBranch'] == repository['devBranch'],
                    'AI merge requires configured dev branch and non-draft PR')


def check_chronology(bundle, defs, validate, output=None, name=None, human_only=False):
    """Check 4: one partial order for authority, history, dispositions and effects."""
    now = instant(bundle['now'])
    if human_only:
        if output and 'expiresAt' in output:
            require(now < instant(output['expiresAt']), 'human decision expired')
        return
    decision = bundle['decision']; start = instant(decision['validFrom'])
    history = bundle['priorDecisions'] + bundle['decisions']
    assignments = bundle['priorAssignments'] + [{'ref': bundle['assignmentRef'], 'value': bundle['assignment']}]
    repository = None
    for entry in history:
        vote = entry['value']; submitted = instant(vote['submittedAt'])
        require(start <= submitted <= now, 'vote outside authority or evaluation time')
        require(vote['subjectHash'] == vote['subjectRef']['sha256'], 'historical subject hash mismatch')
        if vote['gateId'] == 'pr_review':
            repository = repository_ready(bundle, defs, validate)
            require(instant(repository.get('boundAt', decision['validFrom'])) <= submitted, 'PR vote predates repository binding')
    for finding in bundle['findings']:
        value = finding['value']
        if value['status'] == 'open':
            continue
        records = bundle['adjudications'] if value['status'] == 'rejected' else bundle['findingResolutions']
        matches = [r['value'] for r in records if r['ref'] == value['dispositionRef']]
        require(len(matches) == 1, 'missing finding disposition')
        disposition = matches[0]; key = 'completedAt' if value['status'] == 'rejected' else 'resolvedAt'
        require(key in disposition, 'missing finding disposition time')
        when = instant(disposition[key])
        sources = [v['value'] for v in history if finding['ref'] in v['value']['findingRefs']]
        require(sources and all(instant(v['submittedAt']) < when for v in sources), 'finding vote must precede disposition')
        require(start <= when <= now, 'disposition outside authority')
        require(all(when < instant(v['value']['submittedAt']) for v in bundle['decisions']),
                'fresh votes required after disposition')
    current_round = bundle['assignment']['round']
    require(all(v['value']['round'] < current_round for v in bundle['priorDecisions']), 'historical vote is not from an earlier round')
    require(all(a['value']['round'] < current_round for a in bundle['priorAssignments']), 'current approval is not latest retained round')
    require(len({a['value']['round'] for a in assignments}) == len(assignments), 'ambiguous historical round')
    subjects = {}
    for entry in history:
        vote = entry['value']; key = vote['assignmentRef']['artifactId']
        require(key not in subjects or subjects[key] == vote['subjectRef'], 'retained round subject mismatch')
        subjects[key] = vote['subjectRef']
        for later in history:
            if vote['round'] < later['value']['round']:
                require(instant(vote['submittedAt']) < instant(later['value']['submittedAt']), 'retained rounds out of order')
    if output is None:
        return
    for field in ('completedAt', 'observedAt'):
        if field not in output:
            continue
        when = instant(output[field])
        require(start <= when <= now, 'output observation/completion outside authority or evaluation time')
        require(when < instant(decision['expiresAt']), 'output outside authority lifetime')
        if name in ('OutcomeManifest', 'PRHeadObservation'):
            require(all(instant(v['value']['submittedAt']) <= when for v in bundle['decisions']), 'output observation precedes panel approval')
        if name == 'PRHeadObservation':
            repository = repository or repository_ready(bundle, defs, validate)
            require(instant(repository.get('boundAt', decision['validFrom'])) <= when, 'merge observation predates repository binding')


def evidence_for(record, ancestors, bundle, kind):
    """Nearest authority-bearing record selects its resolved task/gate bundle."""
    owners = [(kind, record)] + list(reversed(ancestors))
    selected = next(((k, v) for k, v in owners if v.get('reviewMode') == 'ai_only' or k in REVIEW_RECORD_BINDINGS), None)
    if selected is None:
        return bundle, False
    owner_kind, owner = selected
    candidates = [bundle] + bundle.get('reviewBundles', [])
    matches = [b for b in candidates if owner.get('reviewModeDecisionRef', b['decisionRef']) == b['decisionRef']
               and owner.get('reviewSubjectRef', b['subjectRef'] if owner_kind == 'ReviewModeDecision' else owner.get('subjectRef', b['subjectRef'])) == b['subjectRef']]
    if len(matches) > 1:
        refs = owner.get('aiReviewApprovalSetRefs', [owner.get('aiReviewApprovalSetRef')])
        matches = [b for b in matches if b['approvalSetRef'] in refs]
    require(len(matches) == 1, 'output authority mismatch or output subject mismatch')
    return matches[0], True


def output_ready(value, name, bundle, defs, validate):
    """Apply the four generic checks to every schema record, including nested views."""
    require(name in defs, 'unknown review output schema')
    validate(value, defs[name])
    human_records = human_provenance_ready(bundle, defs, validate, value, name)
    root_task = value if name == 'TaskView' else bundle.get('taskView')
    if root_task is not None:
        validate(root_task, defs['TaskView'])
    checked = set()
    for kind, record, ancestors in review_records(value, name, defs, validate, with_context=True):
        if kind == 'ArtifactRef' or not kind:
            continue
        evidence, ai = evidence_for(record, ancestors, bundle, kind)
        explicit_ai = record.get('reviewMode') == 'ai_only' or kind in REVIEW_RECORD_BINDINGS
        ai_fields = [f for f in record if review_field_role(kind, f) == 'ai_authority']
        require(not ai_fields or ai, 'AI approval requires explicit AI provenance')
        if explicit_ai or ai_fields:
            for field, item in record.items():
                if review_field_role(kind, field) == 'mode_authority':
                    require(item == evidence['decisionRef'], 'output authority mismatch')
            require(root_task is not None, 'actual task snapshot required for output acceptance')
            key = (id(evidence), record.get('completedAt', evidence['now']))
            if key not in checked:
                evaluation = copy.deepcopy(evidence)
                if kind == 'OutcomeManifest':
                    require(instant(record['completedAt']) <= instant(evidence['now']), 'future outcome completion')
                    evaluation['now'] = record['completedAt']
                panel_ready(evaluation, defs, validate)
                checked.add(key)
            refs = []
            for field in ai_fields:
                item = record[field]
                refs.extend(item if isinstance(item, list) else [item])
            if kind in REVIEW_RECORD_BINDINGS:
                expected = evidence.get(REVIEW_RECORD_BINDINGS[kind])
                records = [v['value'] for v in expected] if isinstance(expected, list) else [expected]
                require(record in records, 'authority record differs from resolved evidence')
            else:
                require(refs == [evidence['approvalSetRef']] or (not refs and kind == 'PullRequest'
                        and record['state'] == 'open' and record['draft']), 'missing or unknown output approval')
        check_scope(record, kind, evidence, defs, validate, root_task, human_records, active_ai=ai)
        carries_authority = any(review_field_role(kind, f) in ('human_authority', 'ai_authority') for f in record)
        if ai or carries_authority or kind in ('DecisionView', 'DecisionResponse', 'PlanApprovalSet', 'IntentApprovalSet'):
            check_identity(record, kind, evidence, defs, validate)
            check_chronology(evidence, defs, validate, record, kind, human_only=not ai)


def audit_selection_ready(value, bundle, defs, validate):
    validate(value, defs['ReviewAuditSelection'])
    evaluation = copy.deepcopy(bundle); evaluation['now'] = value['selectedAt']
    decision = in_force(evaluation)
    require(value['taskId'] == bundle['assignment']['taskId'] and value['applicationId'] == decision['scope']['applicationId']
            and value['reviewModeDecisionRef'] == bundle['decisionRef']
            and value['sampleBasisPoints'] == decision['auditSampleBasisPoints'], 'audit rate/authority mismatch')
    require(instant(value['selectedAt']) < instant(bundle['executionStartedAt']), 'audit must be selected before execution')


def validate_review_mode(ROOT, defs, validate, check, read, template_semantics):
    for name, schema in defs.items():
        if name.endswith('FrozenToolsV1'):
            continue
        for field, shape in schema.get('properties', {}).items():
            role = review_field_role(name, field)
            if role:
                check(shape.get('x-review-field-role') == role, 'Shared review field role: '+name+'.'+field)
    from build_backlog import D5_RUNTIME_CORPUS
    backlog = read(ROOT/'backlog.json')['packages']
    acceptance = read(ROOT/'acceptance.json')['scenarios']
    for work_id, ac_id in (('W-141','AC-280'), ('W-143','AC-299')):
        check(D5_RUNTIME_CORPUS in next(w['deliverable'] for w in backlog if w['id'] == work_id), 'Runtime corpus deliverable: '+work_id)
        check(D5_RUNTIME_CORPUS in next(a['then'] for a in acceptance if a['id'] == ac_id), 'Runtime corpus acceptance: '+ac_id)
    folder = ROOT/'examples/ai-review'
    bundle = read(folder/'in-force.json')
    panel_ready(bundle, defs, validate); check(True, 'In-force ai_only exact-subject unanimous panel accepted')
    rule = {'gateId': 'plan_peer_approved', 'mode': 'ai_panel', 'humanFloor': False,
            'sampleBasisPoints': 0, 'reviewModeDecisionRef': bundle['decisionRef']}
    check(resolve_gate(rule, bundle, defs, validate) == 'ai_panel', 'GateModeRule resolves AI only with current authority')
    for filename, name in [('application-review-policy.json','ApplicationReviewPolicy'), ('gate-mode-rule.json','GateModeRule'),
            ('outcome-manifest.json','OutcomeManifest'), ('draft-preview-pr.json','PullRequest'),
            ('ai-review-subject.json','AIReviewSubject'), ('reviewer-qualification.json','ReviewerQualification')]:
        validate(read(folder/filename),defs[name]);check(True,'AI profile fixture: '+filename)
    for filename,name in [('outcome-manifest.json','OutcomeManifest'),('draft-preview-pr.json','PullRequest')]:
        output_ready(read(folder/filename), name, read(folder/'pr-panel.json') if name=='PullRequest' else bundle, defs, validate)
        check(True, 'AI output authority and chronology: '+name)
        value=read(folder/filename);value.pop('reviewMarker')
        try:validate(value,defs[name])
        except ValueError:check(True,'AI marker cannot be omitted: '+name)
        else:raise AssertionError('Unmarked AI output accepted: '+name)
    value=read(ROOT/'examples/autonomy-policy-decision.json')
    value.update(actorKind='authorized_rule',direction='establish',gateModes=[rule])
    try:validate(value,defs['AutonomyPolicyDecision'])
    except ValueError:check(True,'A rule cannot establish AI panel authority')
    else:raise AssertionError('Rule establishment accepted')
    for path in sorted(folder.glob('invalid-*.json')):
        try:
            resolve_gate(rule, read(path), defs, validate)
        except ValueError:
            check(True, 'Rejected AI review fixture: '+path.stem)
        else:
            raise AssertionError('Invalid AI review accepted: '+path.stem)
    for path in sorted(folder.glob('negative-*.json')):
        case=read(path);kind=case['kind'];value=case['value']
        try:
            if kind in REVIEW_OUTPUTS or kind in ('DecisionView', 'DecisionResponse', 'PlanReviewState', 'IntentInterviewState', 'InputBinding', 'ExecutionPlan', 'WorkflowCheckpoint'): output_ready(value,kind,case.get('bundle',bundle),defs,validate)
            elif kind=='panel': panel_ready(value,defs,validate)
            elif kind=='gate': resolve_gate(value['rule'],value['bundle'],defs,validate)
            elif kind=='audit': audit_selection_ready(value,bundle,defs,validate)
            elif kind=='repository': repository_ready(value,defs,validate)
            else: validate(value,defs[kind])
        except ValueError as error:
            check('error' not in case or case['error'] in str(error), 'Intended rejection: '+path.stem+'; '+str(error))
            check(True,'Rejected targeted AI fixture: '+path.stem)
        else: raise AssertionError('Invalid targeted AI fixture accepted: '+path.stem)
    for path in sorted((folder/'adversarial').glob('*.json')):
        case = read(path)
        # Negative corpus cases must have valid wire shapes: prove semantic rejection.
        if case['kind'] != 'panel':
            # The actor-forgery case deliberately violates the human wire contract.
            if path.stem != 'negative-N13-citation-cannot-change-actor':
                validate(case['value'], defs[case['kind']])
        try:
            if case['kind'] == 'panel': panel_ready(case['value'], defs, validate)
            else: output_ready(case['value'], case['kind'], case['bundle'], defs, validate)
        except ValueError as error:
            check(case['expected'] == 'reject', 'Adversarial control rejected: '+path.stem+'; '+str(error))
        else:
            check(case['expected'] == 'accept', 'Adversarial negative accepted: '+path.stem)
    for path in sorted(folder.glob('positive-output-*.json')):
        case=read(path);output_ready(case['value'],case['kind'],case['bundle'],defs,validate)
        check(True,'Resolved output positive: '+path.stem)
    output_ready(read(folder/'merged-dev-pr.json'),'PullRequest',read(folder/'pr-panel.json'),defs,validate)
    check(True,'Exact PR subject permits ai_only dev merge')
    preview=read(folder/'draft-preview-pr.json');preview['baseBranch']='main'
    evidence=read(folder/'pr-panel.json');evidence['subject']['baseBranch']='main'
    output_ready(preview,'PullRequest',evidence,defs,validate)
    check(True,'Preliminary main-branch draft with empty refs still validates its qualified panel')
    for filename in ('adjudicated.json','fixed-finding.json','voluntary-human-review.json','pre-repository.json','repository-bound.json','pr-panel.json'):
        panel_ready(read(folder/filename),defs,validate);check(True,'AI positive: '+filename)
    validate(read(folder/'voluntary-human-review.json')['humanArtifacts'][0]['value'],defs['DecisionView'])
    check(True,'Voluntary human review has a separate valid human decision record')
    repository_ready(read(folder/'repository-bound.json'),defs,validate)
    check(True,'Post-bootstrap binding enables repository authority')
    for gate in ('intent_aligned','architecture_accepted','pr_review'):
        value=read(folder/('repository-bound.json' if gate=='pr_review' else 'pre-repository.json'))
        value['assignment']['gateId']=gate;value['approvalSet']['gateId']=gate;value['subject']['gateId']=gate
        for vote in value['decisions']: vote['value']['gateId']=gate
        if gate=='pr_review': value['subject'].update(repositoryId=value['repositoryBinding']['devRepositoryId'],pullRequestId='123',baseBranch='dev',expectedHead='a'*40,expectedBase='b'*40)
        panel_ready(value,defs,validate);check(True,'Greenfield phased authority: '+gate)
    audit_selection_ready(read(folder/'audit-selection.json'),bundle,defs,validate)
    check(True,'Audit sample rate matches authorizing decision before execution')
    human_oracle={'gateId':'oracle_accepted','mode':'human','humanFloor':True,'sampleBasisPoints':0}
    enhanced=copy.deepcopy(bundle);enhanced['assignment']['assurance']='enhanced';enhanced['decision']=None
    check(resolve_gate(human_oracle,enhanced,defs,validate)=='human','Enhanced oracle retains human floor without D5')
    for gate in REPLACEABLE_REVIEW_GATES:
        value = copy.deepcopy(bundle);value['assignment']['gateId']=gate;value['approvalSet']['gateId']=gate;value['subject']['gateId']=gate
        if gate=='pr_review':value['subject'].update(repositoryId=value['decision']['devRepositoryId'],pullRequestId='123',baseBranch='dev',expectedHead='a'*40,expectedBase='b'*40)
        for item in value['decisions']:item['value']['gateId']=gate
        panel_ready(value, defs, validate);check(True, 'D5 replacement gate: '+gate)
    value=copy.deepcopy(bundle);value['assignment']['assurance']='fast';panel_ready(value,defs,validate)
    check(True, 'D5 is eligible at fast assurance')
    value=copy.deepcopy(bundle);value['assignment']['assurance']='enhanced'
    slot=copy.deepcopy(value['assignment']['slots'][1]);slot['id']='enhanced-peer'
    config=copy.deepcopy(value['configurations'][1]);config['ref']['artifactId']='00000000-0000-4000-8000-000000001799';config['ref']['sha256']='e'*64
    slot['configurationRef']=config['ref'];value['assignment']['slots'].append(slot);value['configurations'].append(config)
    q=copy.deepcopy(value['qualifications'][1]);q['ref']=dict(q['ref'],artifactId='00000000-0000-4000-8000-000000001798',sha256='d'*64);q['value']['configurationRef']=config['ref']
    value['qualifications'].append(q);value['decision']['reviewerQualificationRefs'].append(q['ref'])
    vote=copy.deepcopy(value['decisions'][1]);vote['ref']=dict(vote['ref'],artifactId='00000000-0000-4000-8000-000000001797',sha256='c'*64)
    vote['value'].update(reviewerSlotId=slot['id'],reviewerConfigurationRef=config['ref'])
    value['decisions'].append(vote);value['approvalSet']['aiDecisionRefs'].append(vote['ref'])
    panel_ready(value,defs,validate);check(True,'Enhanced requires a larger panel plus adversarial and specialists')
    value['assignment']['gateId']='oracle_accepted';value['approvalSet']['gateId']='oracle_accepted';value['subject']['gateId']='oracle_accepted'
    for vote in value['decisions']: vote['value']['gateId']='oracle_accepted'
    oracle_rule=dict(rule,gateId='oracle_accepted')
    check(resolve_gate(oracle_rule,value,defs,validate)=='ai_panel','Enhanced oracle accepts only an in-force complete AI panel')
    for name in ('DecisionResponse','PlanApprovalSet','IntentApprovalSet'):
        check(defs[name]['properties']['actorKind']=={'const':'human'}, 'Human-only provenance: '+name)
    for name in ('greenfield','existing_feature','bug_fix'):
        legacy=read(ROOT/'examples/templates'/(name+'.json'))
        current=read(ROOT/'examples/templates/ai_only'/(name+'.json'))
        template_semantics(current)
        for variant in ('missing-profile','old-version'):
            bad=copy.deepcopy(current)
            if variant=='missing-profile':bad.pop('reviewQualificationProfile')
            else:bad['version']=legacy['version']
            try:template_semantics(bad)
            except ValueError:check(True,'Rejected AI template '+variant+': '+name)
            else:raise AssertionError('AI template lost its authority version pin')
        check(current['version']==('5.0.0' if name=='greenfield' else '4.0.0') and current['nodes']==legacy['nodes'],
              'AI template changes authority pin without removing gates: '+name)
    api=read(ROOT/'contracts/api.openapi.json')
    introduction=(ROOT/'03-api-events.md').read_text().split('## ',2)[1]
    check('API description version '+api['info']['version']+'.' in introduction, 'Chapter 03 introduction matches generated API version')
    journeys=(ROOT/'17-project-journeys.md').read_text()
    for name,human,ai in [('greenfield','4.0.0','5.0.0'),('existing_feature','3.0.0','4.0.0'),('bug_fix','3.0.0','4.0.0')]:
        check(f'{name}: human {human}; ai_only {ai} (ai-review/1.0)' in journeys, 'Journey table pins both authority profiles: '+name)
    check((ROOT/'14-build-backlog.md').read_text().count('W-141–W-143 are optional for human-mode launch and all are required before ai_only enablement, which is a joint human decision and is never earned automatically.')==1,
          'Backlog introduction contains one D5 enablement sentence')
    reader=(ROOT.parent/'implementation-plan.html').read_text()
    for chapter,stale,current in [
        ('23-readiness-recipes-campaigns.md','<td>An earned automatic merge action after current-head human PR approval', 'In human mode, an earned automatic merge action'),
        ('25-data-security-operational-safeguards.md','Human decisions are gates throughout the factory:', 'In human mode, human decisions gate')]:
        check(stale not in reader and current in reader and current in (ROOT/chapter).read_text(), 'Mode-qualified chapter and regenerated reader: '+chapter)
    for path in ('/tasks','/applications'):
        check(any(p['name']=='reviewMode' for p in api['paths'][path]['get']['parameters']), 'ReviewMode filter: '+path)
    sql=(ROOT/'contracts/schema.sql').read_text()
    for table in ('review_mode_decision','review_mode_repository_binding','review_mode_transition','ai_review_decision','review_audit_selection','review_audit_result'):
        check('CREATE POLICY '+table+'_org_scope' in sql and 'ALTER TABLE '+table+' FORCE ROW LEVEL SECURITY' in sql,
              'AI review storage has forced tenant RLS: '+table)
        check('GRANT SELECT, INSERT ON '+table+' TO factory_runtime;' in sql and ' ON '+table+' TO factory_runtime;' not in '\n'.join(l for l in sql.splitlines() if l.startswith('GRANT UPDATE')),
              'AI review storage append-only grants: '+table)
    for table in ('ai_review_decision','review_audit_selection','review_audit_result'):
        check('CREATE POLICY '+table+'_task_visibility' in sql, 'AI review task visibility: '+table)
    check('REFERENCES review_mode_decision(org_id,application_id,id,audit_sample_basis_points)' in sql,
          'Stored audit rate is constrained to the authorizing decision')
    check("repository_binding_state='pre_repository' AND repository_intent_policy_ref IS NOT NULL" in sql
          and 'AND dev_repository_id IS NULL AND branch_protection_evidence_ref IS NULL' in sql,
          'Pre-repository SQL requires policy without fabricated repository evidence')
