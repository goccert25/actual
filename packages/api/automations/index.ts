import type { Automation } from '../automation';

import { wealthfrontVenmoCleanupAutomation } from './wealthfrontVenmoCleanup';

export { wealthfrontVenmoCleanupAutomation };

export const availableAutomations = [
  wealthfrontVenmoCleanupAutomation,
] satisfies Automation[];
