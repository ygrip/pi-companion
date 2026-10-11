import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { automationPhases, automationStepLabel, automationStepText } from '../ui/src/lib/automation-flow.ts';
import type { AutomationAction } from '../ui/src/lib/types.ts';

const command: AutomationAction = { type: 'command', command: 'npm', args: ['run', 'test'], cwd: '/repo', timeoutSeconds: 90 };
const prompt: AutomationAction = { type: 'pi', prompt: 'Review the result\nthen summarize it.', cwd: '/repo' };

test('automation flow keeps phase order, all steps and execution semantics', () => {
  const phases = automationPhases({ preconditions: [command], actions: [prompt, command], postActions: [] });
  assert.deepEqual(phases.map(phase => phase.id), ['preconditions', 'actions', 'postActions']);
  assert.deepEqual(phases.map(phase => phase.steps.length), [1, 2, 0]);
  assert.equal(phases[1].steps[0], prompt);
  assert.match(phases[0].note, /failed check skips/);
  assert.match(phases[1].note, /failure stops/);
  assert.match(phases[2].note, /Cancellation stops all steps/);
  assert.equal(phases[2].end, 'Routine finished');
  assert.match(phases[2].failure, /Stop remaining finalizers/);
  assert.equal(phases[1].retry, undefined);
  const withRetries = automationPhases({ preconditions: [], actions: [command], postActions: [], maxRetries: 2, schedule: '* * * * *' });
  assert.match(withRetries[1].retry!, /only this failed action up to 2 more times/);
  assert.match(withRetries[1].retry!, /waiting 10 seconds/);
  assert.match(withRetries[1].retry!, /next scheduled run/);
  assert.equal(withRetries[0].retry, undefined);
  assert.equal(withRetries[2].retry, undefined);
});

test('flow summaries are compact but detailed text stays intact and uninterpreted', () => {
  assert.equal(automationStepText(command), 'npm run test');
  assert.equal(automationStepLabel(prompt), 'Review the result then summarize it.');
  const malicious: AutomationAction = { type: 'pi', prompt: '<script>alert(1)</script>\nA --> B', cwd: '/repo' };
  assert.equal(automationStepText(malicious), malicious.prompt);
  const long: AutomationAction = { type: 'pi', prompt: 'x'.repeat(1000), cwd: '/repo' };
  assert.equal(automationStepLabel(long).length, 100);
  assert.equal(automationStepText(long).length, 1000);
  assert.equal(automationStepLabel({ type: 'pi', prompt: '  ', cwd: '/repo' }), 'Pi task');
});

test('automation detail opens native scrollable flowchart dialogs from compact phase cards', () => {
  const component = readFileSync(new URL('../ui/src/lib/AutomationFlow.svelte', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../ui/src/routes/automations/[id]/+page.svelte', import.meta.url), 'utf8');
  assert.match(page, /<AutomationFlow \{automation\} \/>/);
  assert.match(component, /aria-haspopup="dialog"/);
  assert.match(component, /dialog\?\.showModal\(\)/);
  assert.match(component, /onclose=\{closed\}/);
  assert.match(component, /oncancel=/);
  assert.match(component, /opener\.focus\(\)/);
  assert.match(component, /role="region" aria-label="Scrollable execution flowchart" tabindex="0"/);
  assert.match(component, /\.flow-scroll\s*\{[^}]*overflow: auto/s);
  assert.match(component, /min-height: 44px/);
  assert.match(component, /\{#each phase.steps as step, index\}/);
  assert.match(component, /\{automationStepText\(step\)\}/);
  assert.doesNotMatch(component, /\{@html|mermaid\.render/);
  assert.match(component, /\{phase.failure\}/);
  assert.match(component, /\{phase.retry\}/);
  assert.match(component, /Cancellation stops all remaining steps, including finalizers/);
});
