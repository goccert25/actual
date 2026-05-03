import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { format as formatDate, parseISO } from 'date-fns';

import { ButtonWithLoading } from '@actual-app/components/button';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import type { Handlers } from '@actual-app/core/types/handlers';
import type { AutomationPreviewTableRow } from '@actual-app/core/types/automations';
import { css } from '@emotion/css';

import { useDateFormat } from '#hooks/useDateFormat';
import { useFormat } from '#hooks/useFormat';

import { Setting } from './UI';

type AutomationListResult = Awaited<
  ReturnType<Handlers['automations-get']>
>['automations'];
type AutomationRunResult = Awaited<ReturnType<Handlers['automations-run']>>;

function formatPreviewDate(value: string | null | undefined, dateFormat: string) {
  if (!value) {
    return '-';
  }

  return formatDate(parseISO(value), dateFormat);
}

function getChangeLabel(
  row: AutomationPreviewTableRow,
  t: ReturnType<typeof useTranslation>['t'],
) {
  if (row.status === 'error') {
    return t('Error');
  }

  if (row.status === 'skipped') {
    return t('Skipped');
  }

  switch (row.operationType) {
    case 'update-transaction':
      return row.rowRole === 'before'
        ? t('Update: Before')
        : t('Update: After');
    case 'delete-transaction':
      return t('Delete');
    case 'link-transfer': {
      const side = row.transferSide === 'to' ? t('To') : t('From');
      const phase = row.rowRole === 'before' ? t('Before') : t('After');
      return t('Transfer: {{side}} {{phase}}', { phase, side });
    }
    case 'skip':
      return t('Skipped');
    default:
      return t('Change');
  }
}

function getRowBackground(row: AutomationPreviewTableRow) {
  if (row.status === 'error') {
    return theme.errorBackground;
  }

  if (row.status === 'skipped') {
    return theme.warningBackground;
  }

  if (row.operationType === 'delete-transaction') {
    return theme.noticeBackgroundLight;
  }

  if (row.rowRole === 'after') {
    return theme.noticeBackgroundLight;
  }

  return theme.tableBackground;
}

function GridCell({
  align = 'left',
  children,
  changed = false,
}: {
  align?: 'left' | 'right';
  children: React.ReactNode;
  changed?: boolean;
}) {
  return (
    <View
      style={{
        padding: '8px 10px',
        borderBottom: `1px solid ${theme.tableBorder}`,
        minHeight: 44,
        justifyContent: 'center',
        backgroundColor: changed
          ? theme.tableRowBackgroundHighlight
          : 'transparent',
      }}
    >
      <Text
        style={{
          ...styles.smallText,
          textAlign: align,
          whiteSpace: 'pre-wrap',
          color: changed ? theme.tableRowBackgroundHighlightText : theme.tableText,
        }}
      >
        {children}
      </Text>
    </View>
  );
}

function PreviewTable({
  rows,
}: {
  rows: AutomationRunResult['tableRows'];
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const dateFormat = useDateFormat() || 'MM/dd/yyyy';

  return (
    <View
      style={{
        width: '100%',
        overflowX: 'auto',
        border: `1px solid ${theme.tableBorder}`,
        borderRadius: 4,
        backgroundColor: theme.tableBackground,
      }}
    >
      <View
        className={css({
          minWidth: 1250,
          display: 'grid',
          gridTemplateColumns:
            '110px 180px 150px 180px 150px minmax(260px, 2fr) 120px 120px 240px',
        })}
      >
        {[
          t('Date'),
          t('Account'),
          t('Change'),
          t('Payee'),
          t('Category'),
          t('Notes'),
          t('Payment'),
          t('Deposit'),
          t('Reason'),
        ].map(header => (
          <View
            key={header}
            style={{
              padding: '8px 10px',
              borderBottom: `1px solid ${theme.tableBorder}`,
              backgroundColor: theme.tableHeaderBackground,
            }}
          >
            <Text
              style={{
                ...styles.smallText,
                color: theme.tableHeaderText,
                fontWeight: 600,
              }}
            >
              {header}
            </Text>
          </View>
        ))}

        {rows.map(row => {
          const changeLabel = getChangeLabel(row, t);
          const rowBackground = getRowBackground(row);

          return (
            <View
              key={row.id}
              style={{
                display: 'contents',
                backgroundColor: rowBackground,
              }}
            >
              <View style={{ backgroundColor: rowBackground }}>
                <GridCell changed={row.changedFields.includes('date')}>
                  {formatPreviewDate(row.date, dateFormat)}
                </GridCell>
              </View>
              <View style={{ backgroundColor: rowBackground }}>
                <GridCell changed={row.changedFields.includes('accountName')}>
                  {row.accountName || '-'}
                </GridCell>
              </View>
              <View style={{ backgroundColor: rowBackground }}>
                <GridCell>{changeLabel}</GridCell>
              </View>
              <View style={{ backgroundColor: rowBackground }}>
                <GridCell changed={row.changedFields.includes('payeeName')}>
                  {row.payeeName || '-'}
                </GridCell>
              </View>
              <View style={{ backgroundColor: rowBackground }}>
                <GridCell changed={row.changedFields.includes('categoryName')}>
                  {row.categoryName || '-'}
                </GridCell>
              </View>
              <View style={{ backgroundColor: rowBackground }}>
                <GridCell changed={row.changedFields.includes('notes')}>
                  {row.notes || '-'}
                </GridCell>
              </View>
              <View style={{ backgroundColor: rowBackground }}>
                <GridCell
                  align="right"
                  changed={row.changedFields.includes('paymentAmount')}
                >
                  {row.paymentAmount == null
                    ? '-'
                    : format(row.paymentAmount, 'financial')}
                </GridCell>
              </View>
              <View style={{ backgroundColor: rowBackground }}>
                <GridCell
                  align="right"
                  changed={row.changedFields.includes('depositAmount')}
                >
                  {row.depositAmount == null
                    ? '-'
                    : format(row.depositAmount, 'financial')}
                </GridCell>
              </View>
              <View style={{ backgroundColor: rowBackground }}>
                <GridCell>{row.error ?? row.reason}</GridCell>
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function PreviewSummary({ result }: { result: AutomationRunResult }) {
  const { t } = useTranslation();

  return (
    <View style={{ gap: 6 }}>
      <Text style={{ fontWeight: 600 }}>
        {result.applied
          ? t('Applied "{{name}}"', { name: result.automationName })
          : t('Dry run preview for "{{name}}"', {
              name: result.automationName,
            })}
      </Text>
      <Text style={{ color: theme.pageTextSubdued }}>
        {t(
          'Updates: {{updates}}, deletes: {{deletes}}, transfers: {{transfers}}, skips: {{skips}}, errors: {{errors}}',
          {
            deletes: result.summary.deletes,
            errors: result.summary.errors,
            skips: result.summary.skips,
            transfers: result.summary.transferLinks,
            updates: result.summary.updates,
          },
        )}
      </Text>
      {!result.applied && (
        <Text style={{ color: theme.noticeTextLight }}>
          <Trans>This preview is read-only.</Trans>
        </Text>
      )}
    </View>
  );
}

export function CodeAutomations() {
  const { t } = useTranslation();
  const [automations, setAutomations] = useState<AutomationListResult>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [runningName, setRunningName] = useState<string | null>(null);
  const [applyingName, setApplyingName] = useState<string | null>(null);
  const [latestResult, setLatestResult] = useState<AutomationRunResult | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;

    async function loadAutomations() {
      setIsLoading(true);
      setError(null);

      try {
        const result = await send('automations-get');
        if (!cancelled) {
          setAutomations(result.automations);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : t('Unable to load automations.'));
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadAutomations();

    return () => {
      cancelled = true;
    };
  }, [t]);

  async function runAutomation(name: string, dryRun: boolean) {
    setError(null);

    if (dryRun) {
      setRunningName(name);
    } else {
      setApplyingName(name);
    }

    try {
      const result = await send('automations-run', { dryRun, name });
      setLatestResult(result);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t('Unable to run automation.'),
      );
    } finally {
      setRunningName(current => (current === name ? null : current));
      setApplyingName(current => (current === name ? null : current));
    }
  }

  function canApply(name: string) {
    return (
      latestResult?.automationName === name &&
      latestResult.dryRun &&
      latestResult.summary.errors === 0
    );
  }

  function getApplyMessage(name: string) {
    if (runningName === name || applyingName === name) {
      return null;
    }

    if (latestResult?.automationName !== name || !latestResult.dryRun) {
      return t('Run a dry run first.');
    }

    if (latestResult.summary.errors > 0) {
      return t('The latest dry run has preview errors, so apply is disabled.');
    }

    return t('Apply will rerun this automation and then write the changes.');
  }

  return (
    <Setting>
      <Text>
        <Trans>
          <strong>Code automations</strong> run checked-in transaction cleanup
          scripts against the currently open budget. The same controls work
          whether you opened the budget locally or through a Docker-hosted sync
          server because the automation runs inside the app against the loaded
          budget.
        </Trans>
      </Text>
      <Text style={{ color: theme.pageTextSubdued }}>
        <Trans>
          Dry run is the default. Review the preview first, then apply when it
          looks correct.
        </Trans>
      </Text>

      <View style={{ gap: 12, width: '100%' }}>
        {isLoading ? (
          <Text>
            <Trans>Loading automations...</Trans>
          </Text>
        ) : automations.length === 0 ? (
          <Text>
            <Trans>No automations are currently registered.</Trans>
          </Text>
        ) : (
          automations.map(automation => {
            const applyMessage = getApplyMessage(automation.name);

            return (
              <View
                key={automation.name}
                style={{
                  width: '100%',
                  gap: 10,
                  padding: 12,
                  border: `1px solid ${theme.tableBorder}`,
                  borderRadius: 4,
                  backgroundColor: theme.tableBackground,
                }}
              >
                <View style={{ gap: 4 }}>
                  <Text style={{ fontWeight: 600 }}>{automation.name}</Text>
                  {automation.description && (
                    <Text style={{ color: theme.pageTextSubdued }}>
                      {automation.description}
                    </Text>
                  )}
                  {automation.version && (
                    <Text style={{ color: theme.pageTextSubdued }}>
                      {t('Version: {{version}}', {
                        version: automation.version,
                      })}
                    </Text>
                  )}
                </View>

                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  <ButtonWithLoading
                    isLoading={runningName === automation.name}
                    onPress={() => {
                      void runAutomation(automation.name, true);
                    }}
                  >
                    <Trans>Dry run</Trans>
                  </ButtonWithLoading>
                  <ButtonWithLoading
                    variant="primary"
                    isLoading={applyingName === automation.name}
                    isDisabled={!canApply(automation.name)}
                    onPress={() => {
                      void runAutomation(automation.name, false);
                    }}
                  >
                    <Trans>Apply</Trans>
                  </ButtonWithLoading>
                </View>

                {applyMessage && (
                  <Text style={{ color: theme.pageTextSubdued }}>
                    {applyMessage}
                  </Text>
                )}
              </View>
            );
          })
        )}

        {error && (
          <Text style={{ color: theme.errorText, whiteSpace: 'pre-wrap' }}>
            {error}
          </Text>
        )}

        {latestResult && (
          <View style={{ gap: 12, width: '100%' }}>
            <PreviewSummary result={latestResult} />
            {latestResult.tableRows.length > 0 ? (
              <PreviewTable rows={latestResult.tableRows} />
            ) : (
              <Text>
                <Trans>No preview rows were generated for this automation.</Trans>
              </Text>
            )}
          </View>
        )}
      </View>
    </Setting>
  );
}
