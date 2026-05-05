import React from 'react';
import { useTranslation } from 'react-i18next';

import { View } from '@actual-app/components/view';

import { Page } from './Page';
import { AmazonOrderImport } from './settings/AmazonOrderImport';
import { CodeAutomations } from './settings/CodeAutomations';

export function AutomationsPage() {
  const { t } = useTranslation();

  return (
    <Page header={t('Automations')}>
      <View
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
          paddingBottom: 20,
        }}
      >
        <AmazonOrderImport />
        <CodeAutomations />
      </View>
    </Page>
  );
}
