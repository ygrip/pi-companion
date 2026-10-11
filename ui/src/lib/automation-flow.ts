import type { Automation, AutomationAction } from './types.ts';

export type AutomationPhase = {
  id: 'preconditions' | 'actions' | 'postActions';
  label: string;
  note: string;
  end: string;
  failure: string;
  retry?: string;
  steps: AutomationAction[];
};

export function automationPhases(automation: Pick<Automation, 'preconditions' | 'actions' | 'postActions'> & Partial<Pick<Automation, 'maxRetries' | 'retryIntervalSeconds' | 'schedule'>>): AutomationPhase[] {
  const retries = automation.maxRetries ?? 0;
  const retry = retries > 0 ? `Retry only this failed action up to ${retries} more ${retries === 1 ? 'time' : 'times'}, waiting ${automation.retryIntervalSeconds ?? 10} seconds between attempts.${automation.schedule ? ' Skip retries if the next scheduled run is too close.' : ''}` : undefined;
  return [
    { id: 'preconditions', label: 'Preconditions', note: 'Check eligibility in order. A failed check skips the main actions.', end: 'Continue to main actions', failure: 'Skip main actions; continue to finalizers.', steps: automation.preconditions },
    { id: 'actions', label: 'Main actions', note: 'Run each action in order. A failure stops the remaining main actions.', end: 'Continue to finalizers', failure: 'Stop main actions; continue to finalizers.', retry, steps: automation.actions },
    { id: 'postActions', label: 'Finalizers', note: 'Run after success, failure, or a skip. Cancellation stops all steps.', end: 'Routine finished', failure: 'Stop remaining finalizers; mark the run failed.', steps: automation.postActions }
  ];
}

/** Plain text only: labels and diagrams never interpret a prompt as HTML or diagram syntax. */
export function automationStepText(step: AutomationAction): string {
  return step.type === 'command' ? [step.command, ...step.args].join(' ') : step.prompt;
}

export function automationStepLabel(step: AutomationAction): string {
  const text = automationStepText(step).replace(/\s+/g, ' ').trim();
  return text ? text.length > 100 ? text.slice(0, 99) + '…' : text : step.type === 'command' ? 'Shell command' : 'Pi task';
}
