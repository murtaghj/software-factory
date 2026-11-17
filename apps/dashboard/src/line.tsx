// The line and its lamps: the control-room direction's signature. One diagram of a plan's stations,
// scope to close, with a gate (two bars) where a person must decide. It is drawn at three sizes: all of
// a person's work on the home page, one task on its page and on the review, and a mark on a board card.
// Positions come from the server (stage descriptors and stations); nothing here works out what a stage is.
import type { Station, StageDescriptor } from '@factory/client';
import type { ReactNode } from 'react';
import type { PipelineStep } from './view-model.ts';

export type LampKind = 'amber' | 'red' | 'green' | 'else' | 'run';
export const LAMP_WORDS: Record<LampKind, string> = { amber: 'Held by you', red: 'Stopped', green: 'Finished', else: 'Waiting on someone else', run: 'Agent running' };

// A lamp. A number links it to its row in the table; the words are for screen readers and tooltips.
export function Tok({ kind, n, words, title }: { kind: LampKind; n?: number | undefined; words?: string | undefined; title?: string | undefined }) {
  const said = words ?? LAMP_WORDS[kind];
  // Without a number a lit lamp is a plain lamp; the number is what makes it a token for a table row.
  if (n === undefined && (kind === 'amber' || kind === 'red' || kind === 'green')) return <span className={`lamp ${kind}`} title={title ?? said}><span className="visually-hidden">{said}</span></span>;
  return <span className={n === undefined ? `tok ${kind}` : `tok ${kind} numbered`} title={title ?? said}>{n}<span className="visually-hidden">{n === undefined ? said : `, ${said.toLowerCase()}`}</span></span>;
}

const classes = (...names: string[]): string | undefined => names.filter((c) => c !== '').join(' ') || undefined;

export type Lamp = { key: string; kind: LampKind; n?: number | undefined; words?: string | undefined; title?: string | undefined };

export function LineLegend({ kinds }: { kinds: readonly LampKind[] }) {
  return <ul className="legend" aria-label="What the lamps mean">{kinds.map((k) => <li key={k}><span className={`tok ${k}`} aria-hidden="true" />{LAMP_WORDS[k]}</li>)}</ul>;
}

// All of a person's work on one line: lamps sit on the station each task has reached. A lamp whose
// station is not on this line is left off; its row in the table still lists it.
export function WorkLine({ stations, lamps, label }: { stations: Station[]; lamps: Record<string, Lamp[]>; label: string }) {
  if (stations.length === 0) return null;
  return (
    <ol className="line" aria-label={label} style={{ '--n': stations.length } as React.CSSProperties}>
      {stations.map((s) => {
        const here = lamps[s.nodeId] ?? [];
        return (
          <li key={s.nodeId} className={s.gate ? 'gate' : undefined} data-lamps={here.length > 0 ? 'true' : 'false'}>
            <div className="toks">{here.map((l) => <Tok key={l.key} kind={l.kind} n={l.n} words={l.words} title={l.title} />)}</div>
            <span className="mark" aria-hidden="true" />
            <span className="name">{s.label}</span>
            {s.gate ? <span className="sub">a person signs here</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

const STEP_WORD: Record<PipelineStep['state'], string> = { done: 'done', current: 'in progress', failed: 'did not pass', pending: 'not started' };
// One task on its own line. `holder` says who a current gate is waiting on ("held here by you").
export function TaskLine({ steps, holder, label = 'Stages of this task' }: { steps: PipelineStep[]; holder?: string | undefined; label?: string }) {
  if (steps.length === 0) return null;
  return (
    <ol className="line compact" aria-label={label} style={{ '--n': steps.length } as React.CSSProperties}>
      {steps.map((s) => {
        const sub = s.state === 'current' && s.gate && holder ? `held here by ${holder}` : STEP_WORD[s.state];
        const attempts = s.attempts > 1 ? ` · attempt ${String(s.attempts)}` : '';
        return (
          <li key={s.id} className={classes(s.gate ? 'gate' : '', s.state === 'done' ? 'done' : '', s.state === 'current' ? 'here' : '', s.state === 'failed' ? 'failed' : '')} data-state={s.state} aria-current={s.state === 'current' ? 'step' : undefined}>
            <div className="toks" />
            <span className="mark" aria-hidden="true" />
            <span className="name">{s.label}</span>
            <span className="sub">{sub}{attempts}</span>
          </li>
        );
      })}
    </ol>
  );
}

// A card's mark: the line in miniature, filled up to the station the task has reached. It draws only the
// stations of the card's own plan (`stage.count` of them) and says so in words. The merged line is used
// only to place gates, and only when it is the same length as the card's plan; otherwise just the
// current station can be known to be a gate. Draws nothing when the server gave no position.
export function MiniLine({ stations, stage, finished, tone }: { stations: Station[]; stage?: StageDescriptor | undefined; finished?: boolean; tone?: 'stopped' | undefined }): ReactNode {
  if (!stage || stage.index < 1 || stage.index > stage.count) return null;
  const marks = stations.length === stage.count ? stations.map((s) => s.gate) : Array.from({ length: stage.count }, (_, i) => i + 1 === stage.index && stage.gate);
  const at = stage.index - 1;
  return (
    <span className="mini" role="img" aria-label={`Stage ${String(stage.index)} of ${String(stage.count)}: ${stage.label}`} {...(tone ? { 'data-tone': tone } : {})}>
      {marks.map((gate, i) => <i key={i} className={classes(gate ? 'gate' : '', i < at || (finished === true && i === at) ? 'done' : '', i === at && finished !== true ? 'here' : '')} />)}
    </span>
  );
}
