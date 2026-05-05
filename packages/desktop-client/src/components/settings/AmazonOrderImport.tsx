import { useRef, useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import {
  Dialog,
  Modal as AriaModal,
  ModalOverlay as AriaModalOverlay,
  TextArea,
} from 'react-aria-components';
import { Trans, useTranslation } from 'react-i18next';

import { Button, ButtonWithLoading } from '@actual-app/components/button';
import { baseInputStyle } from '@actual-app/components/input';
import { styles } from '@actual-app/components/styles';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import type { Handlers } from '@actual-app/core/types/handlers';
import { format as formatDate, parseISO } from 'date-fns';

import { useDateFormat } from '#hooks/useDateFormat';
import { useFormat } from '#hooks/useFormat';

import { Setting } from './UI';

type AmazonOrderImportResult = {
  applied: boolean;
  orders: Array<{
    items: Array<{
      productName: string;
      quantity: number;
      totalAmount: number;
    }>;
    match: {
      accountName: string | null;
      date: string;
      isChild: boolean;
      isParent: boolean;
      payeeName: string | null;
      reconciled: boolean;
      totalAmount: number;
      transactionId: string;
    } | null;
    orderDate: string | null;
    orderId: string;
    reason: string;
    status: 'matched' | 'already-split' | 'ambiguous' | 'unmatched' | 'invalid';
    totalAmount: number | null;
  }>;
  summary: {
    alreadySplitOrders: number;
    ambiguousOrders: number;
    appliedOrders: number;
    invalidOrders: number;
    matchedOrders: number;
    totalOrders: number;
    unmatchedOrders: number;
  };
};

function formatPreviewDate(value: string | null, dateFormat: string) {
  if (!value) {
    return '-';
  }

  return formatDate(parseISO(value), dateFormat);
}

function getRowBackground(
  status: AmazonOrderImportResult['orders'][number]['status'],
) {
  switch (status) {
    case 'matched':
      return theme.noticeBackgroundLight;
    case 'already-split':
    case 'ambiguous':
    case 'invalid':
      return theme.warningBackground;
    default:
      return theme.tableBackground;
  }
}

function HeaderCell({
  align = 'left',
  children,
  flex,
  minWidth,
  width,
}: {
  align?: 'left' | 'right';
  children: ReactNode;
  flex?: number;
  minWidth?: number;
  width?: number;
}) {
  return (
    <View
      style={{
        backgroundColor: theme.tableHeaderBackground,
        borderBottom: `1px solid ${theme.tableBorder}`,
        flex: flex ?? 0,
        flexShrink: 0,
        justifyContent: 'center',
        minWidth,
        padding: '8px 10px',
        width,
      }}
    >
      <Text
        style={{
          ...styles.smallText,
          color: theme.tableHeaderText,
          fontWeight: 600,
          textAlign: align,
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
  flex,
  minWidth,
  width,
}: {
  align?: 'left' | 'right';
  children: ReactNode;
  flex?: number;
  minWidth?: number;
  width?: number;
}) {
  return (
    <View
      style={{
        borderBottom: `1px solid ${theme.tableBorder}`,
        flex: flex ?? 0,
        flexShrink: 0,
        justifyContent: 'center',
        minHeight: 52,
        minWidth,
        padding: '8px 10px',
        width,
      }}
    >
      <Text
        style={{
          ...styles.smallText,
          textAlign: align,
          whiteSpace: 'pre-wrap',
        }}
      >
        {children}
      </Text>
    </View>
  );
}

function AmazonOrderPreviewTable({
  result,
}: {
  result: AmazonOrderImportResult;
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
          <HeaderCell flex={1}>{t('Order date')}</HeaderCell>
          <HeaderCell flex={1}>{t('Order ID')}</HeaderCell>
          <HeaderCell flex={1}>{t('Matched transaction')}</HeaderCell>
          <HeaderCell flex={1}>{t('Order total')}</HeaderCell>
          <HeaderCell flex={3}>{t('Items')}</HeaderCell>
        </View>

        {[...result.orders]
          .sort((a, b) => {
            if (!a.orderDate) return 1;
            if (!b.orderDate) return -1;
            return b.orderDate.localeCompare(a.orderDate);
          })
          .map(order => {
            const rowBackground = getRowBackground(order.status);
            const itemsLabel =
              order.items.length === 0
                ? '-'
                : order.items
                    .map(item => {
                      const quantityLabel =
                        item.quantity > 1 ? ` x${item.quantity}` : '';
                      return `${item.productName}${quantityLabel} - ${format(
                        item.totalAmount,
                        'financial',
                      )}`;
                    })
                    .join('\n');
            const transactionLabel = order.match
              ? [
                  order.match.payeeName || t('Unknown payee'),
                  order.match.accountName || t('Unknown account'),
                  formatPreviewDate(order.match.date, dateFormat),
                  order.match.reconciled ? t('Reconciled') : null,
                ]
                  .filter(Boolean)
                  .join('\n')
              : '-';

            return (
              <View
                key={`${order.orderId}-${order.reason}`}
                style={{
                  backgroundColor: rowBackground,
                  flexDirection: 'row',
                  flexShrink: 0,
                }}
              >
                <GridCell flex={1}>
                  {formatPreviewDate(order.orderDate, dateFormat)}
                </GridCell>
                <GridCell flex={1}>{order.orderId}</GridCell>
                <GridCell flex={1}>{transactionLabel}</GridCell>
                <GridCell flex={1}>
                  {order.totalAmount == null
                    ? '-'
                    : format(order.totalAmount, 'financial')}
                </GridCell>
                <GridCell flex={3}>{itemsLabel}</GridCell>
              </View>
            );
          })}
      </View>
    </View>
  );
}

export function AmazonOrderImport() {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [csvText, setCsvText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [latestPreviewText, setLatestPreviewText] = useState<string | null>(
    null,
  );
  const [latestResult, setLatestResult] =
    useState<AmazonOrderImportResult | null>(null);

  async function sendAmazonImport(
    name: 'automations-amazon-preview' | 'automations-amazon-apply',
  ) {
    return send(
      name as keyof Handlers,
      {
        csvText,
      } as never,
    ) as Promise<AmazonOrderImportResult>;
  }

  async function runPreview() {
    setError(null);
    setIsPreviewing(true);

    try {
      const result = await sendAmazonImport('automations-amazon-preview');
      setLatestResult(result);
      setLatestPreviewText(csvText);
      setIsPreviewOpen(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t('Unable to preview the import.'),
      );
    } finally {
      setIsPreviewing(false);
    }
  }

  async function runApply() {
    setError(null);
    setIsApplying(true);

    try {
      const result = await sendAmazonImport('automations-amazon-apply');
      setLatestResult(result);
      setLatestPreviewText(csvText);
      setIsPreviewOpen(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t('Unable to apply the import.'),
      );
    } finally {
      setIsApplying(false);
    }
  }

  async function onChooseFile(event: ChangeEvent<HTMLInputElement>) {
    const [file] = Array.from(event.target.files ?? []);
    if (!file) {
      return;
    }

    setError(null);
    setCsvText(await file.text());
    event.target.value = '';
  }

  const canApply =
    latestResult &&
    latestResult.applied === false &&
    latestPreviewText === csvText &&
    latestResult.summary.matchedOrders > 0;

  return (
    <View style={{ gap: 20, width: '100%' }}>
      <Setting>
        <Text style={{ fontWeight: 600 }}>
          <Trans>Amazon order split import</Trans>
        </Text>
        <Text style={{ color: theme.pageTextSubdued }}>
          <Trans>
            Paste the Amazon order history CSV here or load a local CSV file.
            Actual will look for transactions whose payee contains Amazon or
            Amzn, whose amount matches the order total, and whose date is within
            10 days before or after the order date.
          </Trans>
        </Text>
        <TextArea
          aria-label={t('Amazon CSV')}
          onChange={event => setCsvText(event.target.value)}
          placeholder={t('Paste the Amazon CSV export here')}
          style={{
            ...baseInputStyle,
            height: 220,
            resize: 'vertical',
            width: '100%',
          }}
          value={csvText}
        />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          <input
            accept=".csv,text/csv"
            hidden
            onChange={onChooseFile}
            ref={fileInputRef}
            type="file"
          />
          <Button onPress={() => fileInputRef.current?.click()}>
            <Trans>Choose CSV file</Trans>
          </Button>
          <ButtonWithLoading
            isDisabled={!csvText.trim()}
            isLoading={isPreviewing}
            onPress={() => void runPreview()}
            variant="primary"
          >
            <Trans>Preview matches</Trans>
          </ButtonWithLoading>
          <ButtonWithLoading
            isDisabled={!canApply}
            isLoading={isApplying}
            onPress={() => void runApply()}
          >
            <Trans>Apply matched orders</Trans>
          </ButtonWithLoading>
          {latestResult && (
            <Button onPress={() => setIsPreviewOpen(true)}>
              <Trans>View last results</Trans>
            </Button>
          )}
        </View>
        {!canApply &&
        latestResult?.summary.matchedOrders === 0 &&
        latestResult ? (
          <Text style={{ color: theme.pageTextSubdued }}>
            <Trans>No uniquely matched orders are ready to apply.</Trans>
          </Text>
        ) : !canApply ? (
          <Text style={{ color: theme.pageTextSubdued }}>
            <Trans>Run a preview first before applying.</Trans>
          </Text>
        ) : (
          <Text style={{ color: theme.noticeTextLight }}>
            <Trans>
              Apply will rerun this import and write only the uniquely matched
              orders.
            </Trans>
          </Text>
        )}
        {error && <Text style={{ color: theme.errorText }}>{error}</Text>}
      </Setting>

      {latestResult && (
        <AriaModalOverlay
          isDismissable
          isOpen={isPreviewOpen}
          onOpenChange={setIsPreviewOpen}
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
                  ? t('Amazon import applied')
                  : t('Amazon import preview')
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
                  maxWidth: 1400,
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
                      {latestResult.applied ? (
                        <Trans>Amazon import applied</Trans>
                      ) : (
                        <Trans>Amazon import preview</Trans>
                      )}
                    </Text>
                    <Text style={{ color: theme.pageTextSubdued }}>
                      {t(
                        'Orders: {{total}}, matched: {{matched}}, applied: {{applied}}, already split: {{alreadySplit}}, ambiguous: {{ambiguous}}, unmatched: {{unmatched}}, invalid: {{invalid}}',
                        {
                          alreadySplit: latestResult.summary.alreadySplitOrders,
                          ambiguous: latestResult.summary.ambiguousOrders,
                          applied: latestResult.summary.appliedOrders,
                          invalid: latestResult.summary.invalidOrders,
                          matched: latestResult.summary.matchedOrders,
                          total: latestResult.summary.totalOrders,
                          unmatched: latestResult.summary.unmatchedOrders,
                        },
                      )}
                    </Text>
                  </View>
                  <Button onPress={() => setIsPreviewOpen(false)}>
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
                  <AmazonOrderPreviewTable result={latestResult} />
                </View>
              </View>
            </Dialog>
          </AriaModal>
        </AriaModalOverlay>
      )}
    </View>
  );
}
