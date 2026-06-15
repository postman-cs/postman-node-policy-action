import * as core from '@actions/core';

import { readPolicyOptionsFromAction, runNodePolicyAction } from './index.js';

runNodePolicyAction(readPolicyOptionsFromAction(core), core).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  core.setFailed(message);
});
