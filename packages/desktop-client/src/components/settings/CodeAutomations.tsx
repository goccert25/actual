import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Dialog,
  Modal as AriaModal,
  ModalOverlay as AriaModalOverlay,
} from 'react-aria-components';
import { Trans, useTranslation } from 'react-i18next';
import { format as formatDate, parseISO } from 'date-fns';

import { Button, ButtonWithLoading } from '@actual-app/components/button';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import type { Handlers } from '@actual-app/core/types/handlers';
import type { AutomationPreviewTableRow } from '@actual-app/core/types/automations';

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
  if (row.status === 'error') return t('Error');
  if (row.status === 'skipped') return t('Skipped');

  switch (row.operationType) {
    case 'update-transaction':
      return row.rowRole === 'before' ? t('Update: Before') : t('Update: After');
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
  if (row.status === 'error') return theme.errorBackground;
  if (row.status === 'skipped') return theme.warningBackground;
  if (row.operationType === 'delete-transaction') return theme.errorBackground;
  if (row.rowRole === 'after') return theme.noticeBackgroundLight;
  return theme.tableBackground;
}

function HeaderCell({
  children,
  flex = 1,
}: {
  children: ReactNode;
  flex?: number;
}) {
  return (
    <View
      style={{
        backgroundColor: theme.tableHeaderBackground,
        borderBottom: `1px solid ${theme.tableBorder}`,
        flex,
        flexShrink: 0,
        justifyContent: 'center',
        padding: '8px 10px',
      }}
    >
      <Text
        style={{
          ...styles.smallText,
          color: theme.tableHeaderText,
          fontWeight: 600,
        }}
      >
        {children}
      </Text>
    </View>
  );
}

function GridCell({
  align = 'left',
  children,
  changed = false,
  flex = 1,
}: {
  align?: 'left' | 'right';
  children: ReactNode;
  changed?: boolean;
  flex?: number;
}) {
  return (
    <View
      style={{
        backgroundColor: changed
          ? theme.tableRowBackgroundHighlight
          : 'transparent',
        borderBottom: `1px solid ${theme.tableBorder}`,
        flex,
        flexShrink: 0,
        justifyContent: 'center',
        minHeight: 44,
        padding: '8px 10px',
      }}
    >
      <Text
        style={{
          ...styles.smallText,
          color: changed
            ? theme.tableRowBackgroundHighlightText
            : theme.tableText,
          textAlign: align,
          whiteSpace: 'pre-wrap',
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
        backgroundColor: theme.tableBackground,
        border: `1px solid ${theme.tableBorder}`,
        borderRadius: 4,
        width: '100%',
      }}
    >
      <View style={{ flexShrink: 0 }}>
        <View
          style={{
            flexDirection: 'row',
            flexShrink: 0,
            position: 'sticky',
            top: 0,
            zIndex: 1,
          }}
        >
          <HeaderCell>{t('Date')}</HeaderCell>
          <HeaderCell>{t('Account')}</HeaderCell>
          <HeaderCell>{t('Change')}</HeaderCell>
          <HeaderCell>{t('Payee')}</HeaderCell>
          <HeaderCell>{t('Category')}</HeaderCell>
          <HeaderCell flex={2}>{t('Notes')}</HeaderCell>
          <HeaderCell>{t('Payment')}</HeaderCell>
          <HeaderCell>{t('Deposit')}</HeaderCell>
          <HeaderCell flex={2}>{t('Reason')}</HeaderCell>
        </View>

        {rows.map(row => {
          const changeLabel = getChangeLabel(row, t);
          const rowBackground = getRowBackground(row);

          return (
            <View
              key={row.id}
              style={{
                backgroundColor: rowBackground,
                flexDirection: 'row',
                flexShrink: 0,
              }}
            >
              <GridCell changed={row.changedFields.includes('date')}>
                {formatPreviewDate(row.date, dateFormat)}
              </GridCell>
              <GridCell changed={row.changedFields.includes('accountName')}>
                {row.accountName || '-'}
              </GridCell>
              <GridCell>{changeLabel}</GridCell>
              <GridCell changed={row.changedFields.includes('payeeName')}>
                {row.payeeName || '-'}
              </GridCell>
              <GridCell changed={row.changedFields.includes('categoryName')}>
                {row.categoryName || '-'}
              </GridCell>
              <GridCell
                changed={row.changedFields.includes('notes')}
                flex={2}
              >
                {row.notes || '-'}
              </GridCell>
              <GridCell
                align="right"
                changed={row.changedFields.includes('paymentAmount')}
              >
                {row.paymentAmount == null
                  ? '-'
                  : format(row.paymentAmount, 'financial')}
              </GridCell>
              <GridCell
                align="right"
                changed={row.changedFields.includes('depositAmount')}
              >
                {row.depositAmount == null
                  ? '-'
                  : format(row.depositAmount, 'financial')}
              </GridCell>
              <GridCell flex={2}>{row.error ?? row.reason}</GridCell>
            </View>
          );
        })}
      </View>
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
  const [isResultOpen, setIsResultOpen] = useState(false);
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
          setError(
            err instanceof Error
              ? err.message
              : t('Unable to load automations.'),
          );
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
      setIsResultOpen(true);
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
    <>
      <Setting>
        <Text>
          <Trans>
            <strong>Code automations</strong> run checked-in transaction cleanup
            scripts against the currently open budget. The same controls work
            whether you opened the budget locally or through a Docker-hosted
            sync server because the automation runs inside the app against the
            loaded budget.
          </Trans>
        </Text>
        <Text style={{ color: theme.pageTextSubdued }}>
          <Trans>
            Dry run is the default. Review the preview first, then apply when
            it looks correct.
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
                    backgroundColor: theme.tableBackground,
                    border: `1px solid ${theme.tableBorder}`,
                    borderRadius: 4,
                    gap: 10,
                    padding: 12,
                    width: '100%',
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

                  <View
                    style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}
                  >
                    <ButtonWithLoading
                      isLoading={runningName === automation.name}
                      onPress={() => {
                        void runAutomation(automation.name, true);
                      }}
                    >
                      <Trans>Dry run</Trans>
                    </ButtonWithLoading>
                    <ButtonWithLoading
                      isDisabled={!canApply(automation.name)}
                      isLoading={applyingName === automation.name}
                      onPress={() => {
                        void runAutomation(automation.name, false);
                      }}
                      variant="primary"
                    >
                      <Trans>Apply</Trans>
                    </ButtonWithLoading>
                    {latestResult?.automationName === automation.name && (
                      <Button onPress={() => setIsResultOpen(true)}>
                        <Trans>View last results</Trans>
                      </Button>
                    )}
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
        </View>
      </Setting>

      {latestResult && (
        <AriaModalOverlay
          isDismissable
          isOpen={isResultOpen}
          onOpenChange={setIsResultOpen}
          style={{
            alignItems: 'center',
            backdropFilter: 'blur(1px) brightness(0.9)',
            display: 'flex',
            inset: 0,
            justifyContent: 'center',
            position: 'fixed',
            zIndex: 3000,
          }}
        >
          <AriaModal style={{ outline: 'none' }}>
            <Dialog
              aria-label={
                latestResult.applied
                  ? t('Applied "{{name}}"', {
                      name: latestResult.automationName,
                    })
                  : t('Dry run preview for "{{name}}"', {
                      name: latestResult.automationName,
                    })
              }
              style={{ outline: 'none' }}
            >
              <View
                style={{
                  backgroundColor: theme.modalBackground,
                  borderRadius: 6,
                  boxShadow: '0 10px 40px rgba(0,0,0,0.4)',
                  flexDirection: 'column',
                  height: '85vh',
                  maxWidth: 1600,
                  width: '90vw',
                }}
              >
                {/* Header */}
                <View
                  style={{
                    alignItems: 'center',
                    borderBottom: `1px solid ${theme.tableBorder}`,
                    flexDirection: 'row',
                    flexShrink: 0,
                    justifyContent: 'space-between',
                    padding: '14px 20px',
                  }}
                >
                  <View style={{ gap: 4 }}>
                    <Text style={{ fontWeight: 600, fontSize: 16 }}>
                      {latestResult.applied
                        ? t('Applied "{{name}}"', {
                            name: latestResult.automationName,
                          })
                        : t('Dry run preview for "{{name}}"', {
                            name: latestResult.automationName,
                          })}
                    </Text>
                    <Text style={{ color: theme.pageTextSubdued }}>
                      {t(
                        'Updates: {{updates}}, deletes: {{deletes}}, transfers: {{transfers}}, skips: {{skips}}, errors: {{errors}}',
                        {
                          deletes: latestResult.summary.deletes,
                          errors: latestResult.summary.errors,
                          skips: latestResult.summary.skips,
                          transfers: latestResult.summary.transferLinks,
                          updates: latestResult.summary.updates,
                        },
                      )}
                    </Text>
                    {!latestResult.applied && (
                      <Text style={{ color: theme.noticeTextLight }}>
                        <Trans>This preview is read-only.</Trans>
                      </Text>
                    )}
                  </View>
                  <Button onPress={() => setIsResultOpen(false)}>
                    <Trans>Close</Trans>
                  </Button>
                </View>

                {/* Scrollable table area */}
                <View
                  style={{
                    flex: 1,
                    minHeight: 0,
                    overflow: 'auto',
                    padding: 20,
                  }}
                >
                  {latestResult.tableRows.length > 0 ? (
                    <PreviewTable rows={latestResult.tableRows} />
                  ) : (
                    <Text>
                      <Trans>
                        No preview rows were generated for this automation.
                      </Trans>
                    </Text>
                  )}
                </View>
              </View>
            </Dialog>
          </AriaModal>
        </AriaModalOverlay>
      )}
    </>
  );
}
