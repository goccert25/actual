import React from 'react';
import { useTranslation } from 'react-i18next';

import { CodeAutomations } from './settings/CodeAutomations';
import { Page } from './Page';

export function AutomationsPage() {
  const { t } = useTranslation();

  return (
    <Page header={t('Automations')}>
      <CodeAutomations />
    </Page>
  );
}
