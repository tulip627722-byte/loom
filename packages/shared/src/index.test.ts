import assert from 'node:assert/strict';
import test from 'node:test';
import { agentRoles } from './index.ts';

test('agent roles remain stable', () => {
  assert.deepEqual(agentRoles, ['planner', 'executor', 'ui', 'research', 'reviewer']);
});
